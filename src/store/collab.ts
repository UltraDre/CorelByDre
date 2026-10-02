/**
 * Collaboration store — session lifecycle, op transport, presence, comments and
 * the activity feed. Wraps `src/lib/collab.ts` with app state so the UI can
 * render peers, threads and sync status reactively.
 */
import { create } from 'zustand'
import { uid } from '../lib/util'
import { useStore } from './store'
import { loadMeta, saveMeta } from '../lib/storage'
import {
  Outbox,
  activityFrom,
  applyOps,
  broadcastTransport,
  compareClock,
  diffObjects,
  httpTransport,
  makeActor,
  makeOp,
  makeRoomId,
  mergeLogs,
  mentionName,
  newClock,
  notificationForMention,
  parseMentions,
  roomFromUrl,
  showNotification,
  shareUrl,
  tickClock,
  webSocketTransport,
  type ActivityEntry,
  type CollabActor,
  type CollabOp,
  type CollabTransport,
  type Comment,
  type HLC,
  type PresenceState,
} from '../lib/collab'

const ACTOR_KEY = 'corelbydre.actor'
const ROOM_KEY = 'corelbydre.room'
const ENDPOINT_KEY = 'corelbydre.collab.endpoint'
const LOG_LIMIT = 2000
const PRESENCE_TTL = 45_000

interface StoredActor { id: string; name: string }

function readActor(): CollabActor {
  try {
    const raw = localStorage.getItem(ACTOR_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StoredActor
      if (parsed.id && parsed.name) return makeActor(parsed.id, parsed.name)
    }
  } catch { /* fresh identity below */ }
  const actor = makeActor(uid('u'), 'You')
  try { localStorage.setItem(ACTOR_KEY, JSON.stringify({ id: actor.id, name: actor.name })) } catch { /* private mode */ }
  return actor
}

export function renameActor(name: string): void {
  const trimmed = name.trim().slice(0, 24)
  if (!trimmed) return
  const actor = { ...useCollab.getState().actor, name: trimmed }
  useCollab.setState({ actor })
  try { localStorage.setItem(ACTOR_KEY, JSON.stringify({ id: actor.id, name: actor.name })) } catch { /* ignore */ }
  void useCollab.getState().sendPresence()
}

export interface CollabState {
  actor: CollabActor
  room: string | null
  endpoint: string | null
  transportKind: CollabTransport['kind']
  /** True when a cloud endpoint accepted our last flush (broadcast-only rooms report true). */
  connected: boolean
  syncing: boolean
  lastSync: number | null
  outbox: number
  peers: Record<string, PresenceState>
  comments: Comment[]
  activity: ActivityEntry[]
  log: CollabOp[]
  /** Set while remote ops are being written into the document. */
  applyingRemote: boolean

  init: () => Promise<void>
  startSession: (room?: string, name?: string) => Promise<string>
  leaveSession: () => void
  setEndpoint: (url: string | null) => void
  flush: () => Promise<number>
  sendPresence: (patch?: Partial<PresenceState>) => Promise<void>
  /** Record a local document change as an op. */
  recordLocal: (before: unknown, after: unknown, label: string) => Promise<void>
  addComment: (pageId: string, x: number, y: number, body: string) => Promise<Comment | null>
  replyTo: (commentId: string, body: string) => Promise<Comment | null>
  setResolved: (commentId: string, resolved: boolean) => Promise<void>
  removeComment: (commentId: string) => Promise<void>
  commentById: (id: string) => Comment | undefined
  shareLink: () => string
}

const outbox = new Outbox()
let transport: CollabTransport | null = null
let unwire: (() => void) | null = null
let clock: HLC = newClock('local')
let baseline: unknown = null
let diffTimer: ReturnType<typeof setTimeout> | null = null
let presenceTimer: ReturnType<typeof setInterval> | null = null
const seen = new Set<string>()
const mentionNotified = new Set<string>()

function commentsOf(ops: readonly CollabOp[]): Comment[] {
  const map = new Map<string, Comment>()
  const ordered = [...ops].sort((a, b) => compareClock(a.clock, b.clock))
  for (const op of ordered) {
    if (op.kind === 'comment' && op.comment) map.set(op.comment.id, { ...op.comment })
    else if (op.kind === 'reply' && op.comment) map.set(op.comment.id, { ...op.comment })
    else if (op.kind === 'resolve' && op.commentId) {
      const existing = map.get(op.commentId)
      if (existing) map.set(op.commentId, { ...existing, resolved: op.value === true })
    } else if (op.kind === 'delete-comment' && op.commentId) map.delete(op.commentId)
  }
  return [...map.values()].sort((a, b) => a.created - b.created)
}

function adoptLog(log: CollabOp[]): void {
  useCollab.setState({
    log,
    comments: commentsOf(log),
    activity: activityFrom(log),
  })
}

async function persistLog(room: string, log: CollabOp[]): Promise<void> {
  if (log.length > LOG_LIMIT) log = log.slice(log.length - LOG_LIMIT)
  try { await saveMeta(`collab:${room}`, log) } catch { /* storage may be full or blocked */ }
}

export const useCollab = create<CollabState>()((set, get) => ({
  actor: readActor(),
  room: null,
  endpoint: null,
  transportKind: 'none',
  connected: true,
  syncing: false,
  lastSync: null,
  outbox: 0,
  peers: {},
  comments: [],
  activity: [],
  log: [],
  applyingRemote: false,

  async init() {
    try {
      const endpoint = localStorage.getItem(ENDPOINT_KEY)
      if (endpoint) set({ endpoint })
    } catch { /* ignore */ }
    const room = roomFromUrl(typeof location === 'undefined' ? '' : location.hash)
    const stored = await loadMeta<string>(ROOM_KEY).catch(() => undefined)
    const target = room ?? stored
    if (target) await get().startSession(target)

    window.addEventListener('online', () => { void get().flush() })
    window.addEventListener('offline', () => set({ connected: false }))
    // Share local edits as ops: diff the document on a trailing debounce so a
    // drag of 300 objects produces one batch instead of 300 streams.
    useStore.subscribe((s) => s.doc, (doc) => {
      if (!get().room || get().applyingRemote) { baseline = doc; return }
      if (diffTimer) clearTimeout(diffTimer)
      diffTimer = setTimeout(() => {
        const room = get().room
        if (!room) return
        const before = baseline ?? doc
        void get().recordLocal(before, doc, 'edited the document')
        baseline = doc
      }, 350)
    })
    // Presence follows the active tool/page/selection — collaboration cues.
    useStore.subscribe((s) => [s.tool, s.doc.activePageId, s.selection.join(',')].join('|'), () => {
      if (get().room) void get().sendPresence()
    })
  },

  async startSession(room, name) {
    const target = (room ?? get().room ?? makeRoomId()).trim()
    if (name) renameActor(name)
    get().leaveSession()
    set({ room: target, syncing: true })
    try { localStorage.setItem(ROOM_KEY, target) } catch { /* ignore */ }

    const actor = get().actor
    clock = newClock(actor.id)
    const stored = await loadMeta<CollabOp[]>(`collab:${target}`).catch(() => undefined)
    if (stored?.length) {
      adoptLog(mergeLogs(stored, []))
      baseline = useStore.getState().doc
      useStore.getState().replaceDocument(applyOps(useStore.getState().doc, stored), { markClean: true })
      for (const op of stored) seen.add(op.id)
    }
    baseline = useStore.getState().doc

    const endpoint = get().endpoint
    transport = endpoint
      ? endpoint.startsWith('ws')
        ? webSocketTransport(endpoint, target, actor.id)
        : httpTransport(endpoint, target, actor.id)
      : broadcastTransport(target)
    const off = transport.onMessage((ops, _from) => { void receive(ops) })
    unwire = off
    set({ transportKind: transport.kind, connected: transport.kind !== 'none' })
    await get().sendPresence()
    presenceTimer = setInterval(() => {
      void get().sendPresence()
      const now = Date.now()
      const peers = { ...get().peers }
      let changed = false
      for (const [id, p] of Object.entries(peers)) {
        if (now - p.updated > PRESENCE_TTL) { delete peers[id]; changed = true }
      }
      if (changed) set({ peers })
    }, 15_000)
    await get().flush()
    set({ syncing: false, lastSync: Date.now() })
    return target
  },

  leaveSession() {
    unwire?.(); unwire = null
    transport?.close(); transport = null
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
    set({ room: null, peers: {}, transportKind: 'none', syncing: false, connected: true })
  },

  setEndpoint(url) {
    const clean = url?.trim() || null
    set({ endpoint: clean })
    try { clean ? localStorage.setItem(ENDPOINT_KEY, clean) : localStorage.removeItem(ENDPOINT_KEY) } catch { /* ignore */ }
    const room = get().room
    if (room) void get().startSession(room)
  },

  async flush() {
    const room = get().room
    if (!room || !transport) return 0
    set({ syncing: true })
    const sent = await outbox.drain((ops) => transport!.send(ops))
    set({ syncing: false, outbox: outbox.size, lastSync: Date.now(), connected: transport.kind === 'broadcast' || sent > 0 || outbox.size === 0 })
    return sent
  },

  async sendPresence(patch = {}) {
    const room = get().room
    if (!room) return
    const actor = get().actor
    const app = useStore.getState()
    const presence: PresenceState = {
      actor: actor.id,
      name: actor.name,
      color: actor.color,
      tool: app.tool,
      pageId: app.doc.activePageId,
      selection: app.selection.slice(0, 32),
      updated: Date.now(),
      ...patch,
    }
    clock = tickClock(clock)
    const op = makeOp(actor.id, room, clock, 'presence', { presence })
    set({ peers: { ...get().peers, [actor.id]: presence } })
    outbox.push([op])
    await transport?.send([op])
    set({ outbox: outbox.size })
  },

  async recordLocal(before, after, label) {
    const room = get().room
    if (!room) return
    const patches = diffObjects(before, after)
    if (!patches.length) return
    const actor = get().actor
    const ops: CollabOp[] = []
    for (const patch of patches) {
      clock = tickClock(clock)
      ops.push(makeOp(actor.id, room, clock, 'patch', { path: patch.path, value: patch.value, label }))
    }
    adoptLog(mergeLogs(get().log, ops))
    outbox.push(ops)
    await transport?.send(ops)
    set({ outbox: outbox.size })
    void persistLog(room, get().log)
  },

  async addComment(pageId, x, y, body) {
    const room = get().room
    if (!room) return null
    const actor = get().actor
    clock = tickClock(clock)
    const comment: Comment = {
      id: uid('c'),
      room,
      pageId,
      x,
      y,
      body,
      author: actor.id,
      authorName: actor.name,
      created: Date.now(),
      resolved: false,
      mentions: parseMentions(body),
    }
    const op = makeOp(actor.id, room, clock, 'comment', { comment, label: 'commented' })
    adoptLog(mergeLogs(get().log, [op]))
    outbox.push([op])
    await transport?.send([op])
    set({ outbox: outbox.size })
    void persistLog(room, get().log)
    return comment
  },

  async replyTo(commentId, body) {
    const room = get().room
    const parent = get().commentById(commentId)
    if (!room || !parent) return null
    const actor = get().actor
    clock = tickClock(clock)
    const reply: Comment = {
      ...parent,
      id: uid('c'),
      parentId: parent.id,
      body,
      author: actor.id,
      authorName: actor.name,
      created: Date.now(),
      resolved: false,
      mentions: parseMentions(body),
    }
    const op = makeOp(actor.id, room, clock, 'reply', { comment: reply, label: 'replied' })
    adoptLog(mergeLogs(get().log, [op]))
    outbox.push([op])
    await transport?.send([op])
    set({ outbox: outbox.size })
    void persistLog(room, get().log)
    return reply
  },

  async setResolved(commentId, resolved) {
    const room = get().room
    if (!room) return
    const actor = get().actor
    clock = tickClock(clock)
    const op = makeOp(actor.id, room, clock, 'resolve', { commentId, value: resolved, label: resolved ? 'resolved a comment' : 'reopened a comment' })
    adoptLog(mergeLogs(get().log, [op]))
    outbox.push([op])
    await transport?.send([op])
    set({ outbox: outbox.size })
    void persistLog(room, get().log)
  },

  async removeComment(commentId) {
    const room = get().room
    if (!room) return
    const actor = get().actor
    clock = tickClock(clock)
    const op = makeOp(actor.id, room, clock, 'delete-comment', { commentId, label: 'deleted a comment' })
    adoptLog(mergeLogs(get().log, [op]))
    outbox.push([op])
    await transport?.send([op])
    set({ outbox: outbox.size })
    void persistLog(room, get().log)
  },

  commentById(id) {
    return get().comments.find((c) => c.id === id)
  },

  shareLink() {
    const room = get().room ?? makeRoomId()
    set({ room })
    return shareUrl(room)
  },
}))

/** Apply a batch of remote ops: merge into the log, patch the document. */
async function receive(ops: CollabOp[]): Promise<void> {
  const fresh = ops.filter((op) => !seen.has(op.id))
  if (!fresh.length) return
  for (const op of fresh) seen.add(op.id)

  for (const op of fresh) {
    if (op.kind === 'presence' && op.presence) {
      const peers = { ...useCollab.getState().peers, [op.presence.actor]: op.presence }
      useCollab.setState({ peers })
      continue
    }
    if (op.kind === 'comment' && op.comment) {
      const mine = op.comment.mentions.includes(useCollab.getState().actor.id) && op.comment.author !== useCollab.getState().actor.id
      if (mine && !mentionNotified.has(op.comment.id)) {
        mentionNotified.add(op.comment.id)
        void showNotification(notificationForMention(op.comment, op.comment.authorName))
      }
    }
  }

  const room = useCollab.getState().room
  const documentOps = fresh.filter((op) => op.kind === 'patch' || op.kind === 'add' || op.kind === 'remove')
  if (room && documentOps.length) {
    useCollab.setState({ applyingRemote: true })
    const app = useStore.getState()
    const before = app.doc
    const merged = applyOps(before, documentOps)
    if (merged !== before) app.commit('Collaboration update', () => merged, { selection: app.selection })
    baseline = useStore.getState().doc
    useCollab.setState({ applyingRemote: false })
  }

  adoptLog(mergeLogs(useCollab.getState().log, fresh))
  if (room) void persistLog(room, useCollab.getState().log)
  useCollab.setState({ connected: true, lastSync: Date.now() })
}

/** Mention helpers used by the comments UI. */
export function mentionsIn(body: string, actors: readonly CollabActor[]): CollabActor[] {
  return mentionName(body, actors)
}

export type { CollabActor, Comment, PresenceState }
