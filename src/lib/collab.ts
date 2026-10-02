/**
 * Collaboration core (phase 4) — offline-first by construction.
 *
 * Design notes
 * ------------
 * • Every change is an operation carrying a hybrid logical clock (wall time +
 *   logical counter + actor). Ops are totally ordered by that clock, so all
 *   peers converge on the same document without a central coordinator. This is
 *   the CRDT-flavoured conflict resolution CorelByDre uses: per-path
 *   last-writer-wins with a deterministic tie-break (clock, then actor, then id)
 *   which makes merges commutative and idempotent — applying the same op twice
 *   or in any order yields the same result.
 * • Transport is pluggable. Same-origin tabs talk over BroadcastChannel, which
 *   works with no network at all. A cloud endpoint (WebSocket) can be attached
 *   later; when it is unreachable ops simply stay in the outbox and the editor
 *   keeps working — cloud features degrade gracefully, never block editing.
 * • Comments, mentions and presence ride the same op log, so comment threads
 *   merge with the same guarantees and work offline.
 * • No machine learning anywhere: mentions are parsed with an explicit token
 *   grammar and presence colours come from a hash of the actor id.
 */

import { withTimeout } from './storage'

/* ============================================================== clocks ==== */

export type ActorID = string

export interface HLC {
  /** Wall-clock milliseconds. */
  wall: number
  /** Logical counter for same-millisecond ordering. */
  counter: number
  actor: ActorID
}

export function newClock(actor: ActorID, now = Date.now()): HLC {
  return { wall: now, counter: 0, actor }
}

/** Advance a local clock, taking any remote clock we have seen into account. */
export function tickClock(local: HLC, remote?: HLC | null, now = Date.now()): HLC {
  const wall = Math.max(now, local.wall, remote?.wall ?? 0)
  let counter = 0
  if (wall === local.wall) counter = Math.max(counter, local.counter + 1)
  if (remote && wall === remote.wall) counter = Math.max(counter, remote.counter + 1)
  return { wall, counter, actor: local.actor }
}

/** Total order: negative when a precedes b. */
export function compareClock(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall - b.wall
  if (a.counter !== b.counter) return a.counter - b.counter
  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0
}

export function mergeClocks(local: HLC, remote: HLC): HLC {
  return tickClock(local, remote, Date.now())
}

/* ========================================================== op model ==== */

export type OpKind =
  | 'patch'          // set a value at a JSON path inside the document
  | 'add'            // insert an object into an array path
  | 'remove'         // remove an object by id from an array path
  | 'comment'        // create a comment
  | 'reply'          // reply to a comment
  | 'resolve'        // resolve/unresolve a comment thread
  | 'delete-comment'
  | 'presence'       // presence heartbeat (never stored in the document)

export type JSONPath = (string | number)[]

export interface Comment {
  id: string
  room: string
  pageId: string
  /** Document coordinates of the pin. */
  x: number
  y: number
  body: string
  author: ActorID
  authorName: string
  created: number
  resolved: boolean
  mentions: ActorID[]
  parentId?: string
}

export interface PresenceState {
  actor: ActorID
  name: string
  color: string
  tool?: string
  pageId?: string
  selection?: string[]
  /** Live canvas cursor in document coordinates (for remote pointer rendering). */
  cursor?: { x: number; y: number }
  updated: number
}

export interface CollabOp {
  id: string
  room: string
  actor: ActorID
  clock: HLC
  kind: OpKind
  /** Document path for patch/add/remove. */
  path?: JSONPath
  value?: unknown
  /** Comment payloads. */
  comment?: Comment
  commentId?: string
  /** Presence payload. */
  presence?: PresenceState
  /** Human readable label for the activity feed. */
  label?: string
}

export interface CollabActor {
  id: ActorID
  name: string
  color: string
}

let opCounter = 0
function opId(actor: ActorID, clock: HLC): string {
  opCounter += 1
  return `${clock.wall.toString(36)}-${clock.counter.toString(36)}-${actor}-${opCounter.toString(36)}`
}

export function makeOp(
  actor: ActorID,
  room: string,
  clock: HLC,
  kind: OpKind,
  payload: Partial<CollabOp> = {},
): CollabOp {
  return { id: opId(actor, clock), room, actor, clock, kind, ...payload }
}

/* ======================================================== doc merge ===== */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJSON<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => cloneJSON(v)) as unknown as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = cloneJSON(value[key])
    return out as unknown as T
  }
  return value
}

function readPath(root: unknown, path: JSONPath): unknown {
  let cursor: unknown = root
  for (const key of path) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = (cursor as Record<string | number, unknown>)[key]
  }
  return cursor
}

function writePath(root: unknown, path: JSONPath, value: unknown): void {
  if (!path.length) return
  let cursor = root as Record<string | number, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    const next = cursor[key]
    if (next === null || next === undefined || typeof next !== 'object') {
      cursor[key] = typeof path[i + 1] === 'number' ? [] : {}
    }
    cursor = cursor[key] as Record<string | number, unknown>
  }
  const last = path[path.length - 1]
  if (Array.isArray(cursor) && typeof last === 'number') cursor[last] = value
  else (cursor as Record<string | number, unknown>)[last] = value
}

/**
 * Apply an op log to a document snapshot. Deterministic: ops are sorted by
 * clock before being applied, so any peer that has seen the same set of ops
 * produces byte-identical documents.
 */
export function applyOps<T>(base: T, ops: readonly CollabOp[]): T {
  const ordered = [...ops].sort((a, b) => compareClock(a.clock, b.clock) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out = cloneJSON(base)
  for (const op of ordered) {
    if (op.kind === 'presence' || op.kind === 'comment' || op.kind === 'reply' ||
        op.kind === 'resolve' || op.kind === 'delete-comment') continue
    if (!op.path || !op.path.length) continue
    if (op.kind === 'patch') {
      writePath(out, op.path, cloneJSON(op.value))
    } else if (op.kind === 'add') {
      const list = readPath(out, op.path)
      if (Array.isArray(list)) list.push(cloneJSON(op.value))
    } else if (op.kind === 'remove') {
      const list = readPath(out, op.path)
      const target = isPlainObject(op.value) ? (op.value as { id?: string }).id : op.value
      if (Array.isArray(list) && typeof target === 'string') {
        const index = list.findIndex((item) => isPlainObject(item) && (item as { id?: string }).id === target)
        if (index >= 0) list.splice(index, 1)
      }
    }
  }
  return out
}

/** Merge two op logs (deduplicated by op id, ordered by clock). */
export function mergeLogs(a: readonly CollabOp[], b: readonly CollabOp[]): CollabOp[] {
  const byId = new Map<string, CollabOp>()
  for (const op of [...a, ...b]) if (!byId.has(op.id)) byId.set(op.id, op)
  return [...byId.values()].sort((x, y) => compareClock(x.clock, y.clock) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

/** Diff a document against an op-log base, producing patch ops (used to share local edits). */
export function diffObjects(
  before: unknown,
  after: unknown,
  basePath: JSONPath = [],
  limit = 512,
): { path: JSONPath; value: unknown }[] {
  const out: { path: JSONPath; value: unknown }[] = []
  const walk = (a: unknown, b: unknown, path: JSONPath): void => {
    if (out.length >= limit) return
    if (a === b) return
    if (Array.isArray(a) && Array.isArray(b)) {
      const max = Math.max(a.length, b.length)
      for (let i = 0; i < max; i++) {
        if (i >= a.length) out.push({ path: [...path, i], value: cloneJSON(b[i]) })
        else if (i >= b.length) out.push({ path: [...path, i], value: null })
        else walk(a[i], b[i], [...path, i])
      }
      return
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const key of keys) walk(a[key], b[key], [...path, key])
      return
    }
    // Leaf: send whole subtree so patches stay small but apply atomically.
    out.push({ path, value: cloneJSON(b) })
  }
  walk(before, after, basePath)
  return out
}

/* ======================================================== comments ===== */

const MENTION_RE = /@([\w][\w.\-]*)/g

export function parseMentions(text: string): string[] {
  const out = new Set<string>()
  for (const match of text.matchAll(MENTION_RE)) out.add(match[1])
  return [...out]
}

export function mentionName(text: string, actors: readonly CollabActor[]): CollabActor[] {
  const names = new Set(parseMentions(text).map((n) => n.toLowerCase()))
  return actors.filter((a) => names.has(a.name.toLowerCase()) || names.has(a.id.toLowerCase()))
}

/* ======================================================== presence ===== */

const PEER_COLORS = [
  '#12a19a', '#e0713c', '#6c8ae4', '#c0568f', '#7bb241', '#d9a12b',
  '#4aa3d8', '#a86be0', '#d9564a', '#3fb98a', '#e08b2b', '#5c6bc0',
]

/** Deterministic colour per actor — same actor, same colour on every peer. */
export function presenceColor(actor: string): string {
  let hash = 2166136261
  for (let i = 0; i < actor.length; i++) {
    hash ^= actor.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length]
}

export function makeActor(id: string, name: string): CollabActor {
  return { id, name, color: presenceColor(id) }
}

/* ======================================================= transport ===== */

export interface CollabTransport {
  readonly kind: 'broadcast' | 'websocket' | 'none'
  send(ops: CollabOp[]): Promise<boolean>
  onMessage(handler: (ops: CollabOp[], from: ActorID) => void): () => void
  close(): void
}

/**
 * Same-origin, multi-tab transport. Needs no network and is always available in
 * browsers, which is what keeps collaboration "offline first".
 */
export function broadcastTransport(room: string): CollabTransport {
  const channel: BroadcastChannel | null =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`corelbydre-room-${room}`) : null
  return {
    kind: channel ? 'broadcast' : 'none',
    async send(ops) {
      channel?.postMessage({ ops })
      return Boolean(channel)
    },
    onMessage(handler) {
      if (!channel) return () => undefined
      const listener = (event: MessageEvent) => {
        const data = event.data as { ops?: CollabOp[]; from?: ActorID } | undefined
        if (data?.ops?.length) handler(data.ops, data.from ?? 'unknown')
      }
      channel.addEventListener('message', listener)
      return () => channel.removeEventListener('message', listener)
    },
    close() {
      channel?.close()
    },
  }
}

/**
 * HTTP long-poll transport for the bundled reference relay
 * (`server/sync-server.mjs`). Dependency free and firewall friendly: ops are
 * POSTed, and a rotating long-poll waits for the next batch. If the server is
 * unreachable `send` resolves false, so the outbox keeps every op for later.
 */
export function httpTransport(baseUrl: string, room: string, actor: ActorID): CollabTransport {
  const base = baseUrl.replace(/\/+$/, '')
  const url = `${base}/rooms/${encodeURIComponent(room)}/ops`
  const listeners = new Set<(ops: CollabOp[], from: ActorID) => void>()
  let since = 0
  let closed = false
  let controller: AbortController | null = null
  let failure = 0

  const dispatch = (ops: CollabOp[], from: ActorID) => {
    if (ops.length) for (const listener of listeners) listener(ops, from)
  }

  async function poll(): Promise<void> {
    while (!closed) {
      controller = new AbortController()
      try {
        const response = await fetch(`${url}?since=${since}&actor=${encodeURIComponent(actor)}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`relay responded ${response.status}`)
        const body = (await response.json()) as { seq?: number; ops?: CollabOp[] }
        failure = 0
        if (typeof body.seq === 'number') since = Math.max(since, body.seq)
        dispatch(Array.isArray(body.ops) ? body.ops : [], 'relay')
      } catch (error) {
        if (closed) return
        if ((error as Error).name === 'AbortError') continue
        failure += 1
        await new Promise((resolve) => setTimeout(resolve, backoffDelay(failure, 800, 30_000)))
      }
    }
  }

  // Bootstrap: replay everything the room already has so a fresh joiner is in sync.
  void (async () => {
    try {
      const response = await fetch(`${base}/rooms/${encodeURIComponent(room)}/snapshot`)
      if (!response.ok) return
      const body = (await response.json()) as { seq?: number; ops?: CollabOp[] }
      if (typeof body.seq === 'number') since = Math.max(since, body.seq)
      dispatch(Array.isArray(body.ops) ? body.ops : [], 'relay')
    } catch { /* offline start — the poll loop retries */ }
  })()
  void poll()

  return {
    kind: 'websocket',
    async send(ops) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actor, room, ops }),
        })
        if (!response.ok) return false
        const body = (await response.json()) as { seq?: number }
        if (typeof body.seq === 'number') since = Math.max(since, body.seq)
        failure = 0
        return true
      } catch {
        failure += 1
        return false
      }
    },
    onMessage(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    close() {
      closed = true
      controller?.abort()
      listeners.clear()
    },
  }
}

/**
 * Optional cloud transport. Never required: if the socket cannot be opened the
 * editor stays fully usable and ops queue in the outbox.
 */
export function webSocketTransport(url: string, room: string, actor: ActorID): CollabTransport {
  let socket: WebSocket | null = null
  const listeners = new Set<(ops: CollabOp[], from: ActorID) => void>()
  const queue: string[] = []
  try {
    socket = new WebSocket(url)
    socket.addEventListener('open', () => {
      socket?.send(JSON.stringify({ type: 'join', room, actor }))
      for (const message of queue.splice(0)) socket?.send(message)
    })
    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { ops?: CollabOp[]; from?: ActorID }
        if (data.ops?.length) for (const listener of listeners) listener(data.ops, data.from ?? 'remote')
      } catch { /* ignore malformed frames */ }
    })
  } catch { socket = null }
  const send = async (ops: CollabOp[]): Promise<boolean> => {
    const message = JSON.stringify({ type: 'ops', room, actor, ops })
    if (socket && socket.readyState === WebSocket.OPEN) { socket.send(message); return true }
    if (socket && socket.readyState === WebSocket.CONNECTING) { queue.push(message); return true }
    return false
  }
  return {
    kind: socket ? 'websocket' : 'none',
    send,
    onMessage(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    close() { try { socket?.close() } catch { /* already closed */ } },
  }
}

/* ========================================================== outbox ===== */

export interface OutboxEntry {
  ops: CollabOp[]
  attempts: number
  lastTry: number
}

/**
 * Persistent, retrying outbox. Failed sends are simply retried later; nothing
 * is ever dropped, so an offline session syncs completely on reconnect.
 */
export class Outbox {
  private entries: OutboxEntry[] = []

  get size(): number { return this.entries.reduce((sum, e) => sum + e.ops.length, 0) }

  push(ops: CollabOp[]): void {
    if (!ops.length) return
    const last = this.entries[this.entries.length - 1]
    if (last && Date.now() - last.lastTry < 50 && last.attempts === 0) last.ops.push(...ops)
    else this.entries.push({ ops: [...ops], attempts: 0, lastTry: 0 })
  }

  snapshot(): OutboxEntry[] { return this.entries.map((e) => ({ ...e, ops: [...e.ops] })) }

  restore(entries: readonly OutboxEntry[]): void { this.entries = entries.map((e) => ({ ...e, ops: [...e.ops] })) }

  clear(): void { this.entries = [] }

  /** Try to flush through the transport. Returns the number of ops accepted. */
  async drain(send: (ops: CollabOp[]) => Promise<boolean>): Promise<number> {
    let sent = 0
    const keep: OutboxEntry[] = []
    for (const entry of this.entries) {
      entry.lastTry = Date.now()
      entry.attempts += 1
      let ok = false
      try { ok = await send(entry.ops) } catch { ok = false }
      if (ok) sent += entry.ops.length
      else keep.push(entry)
    }
    this.entries = keep
    return sent
  }
}

/** Exponential backoff (capped) — retries offline work without hammering. */
export function backoffDelay(attempts: number, base = 1000, cap = 60_000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempts - 1))
}

/* ================================================= notifications ====== */

export type NotificationKind = 'invite' | 'mention' | 'export' | 'sync' | 'comment'

export interface AppNotification {
  kind: NotificationKind
  title: string
  body: string
  room?: string
  commentId?: string
  tag?: string
}

/** Ask the browser for permission once; never nag. */
export async function ensureNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try { return await Notification.requestPermission() } catch { return 'denied' }
}

/**
 * Show a notification through the service worker when one controls the page
 * (so it survives page focus changes), falling back to the Notification
 * constructor.
 */
export async function showNotification(payload: AppNotification): Promise<boolean> {
  const permission = await ensureNotificationPermission()
  if (permission !== 'granted') return false
  const options: NotificationOptions = {
    body: payload.body,
    tag: payload.tag ?? `corelbydre-${payload.kind}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    data: { room: payload.room, commentId: payload.commentId, kind: payload.kind },
  }
  try {
    const registration = await swRegistration()
    if (registration) { await registration.showNotification(payload.title, options); return true }
  } catch { /* fall through */ }
  try { new Notification(payload.title, options); return true } catch { return false }
}

export function notificationForMention(comment: Comment, actorName: string): AppNotification {
  const snippet = comment.body.replace(/\s+/g, ' ').slice(0, 90)
  return {
    kind: 'mention',
    title: `${actorName} mentioned you`,
    body: snippet,
    room: comment.room,
    commentId: comment.id,
    tag: `corelbydre-mention-${comment.id}`,
  }
}

export function notificationForInvite(room: string, actorName: string): AppNotification {
  return { kind: 'invite', title: `${actorName} invited you to collaborate`, body: `Room ${room}`, room, tag: `corelbydre-invite-${room}` }
}

export function notificationForExport(name: string, format: string): AppNotification {
  return { kind: 'export', title: 'Export complete', body: `${name} · ${format.toUpperCase()}`, tag: 'corelbydre-export' }
}

/* ============================================================ push ===== */

const VAPID_META = 'corelbydre-vapid-key'

/**
 * `serviceWorker.ready` never settles when no worker activates (blocked in an
 * embed, or the app is served without one), which would leave the notification
 * buttons spinning forever. Everything here is raced against a deadline so the
 * UI always gets an answer and can fall back to local notifications.
 */
const SW_TIMEOUT = 3_000

async function swReady(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined
  try {
    return await withTimeout(Promise.resolve(navigator.serviceWorker.ready), SW_TIMEOUT, 'serviceWorker.ready')
  } catch {
    return undefined
  }
}

async function swRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined
  try {
    return await withTimeout(
      Promise.resolve(navigator.serviceWorker.getRegistration()),
      SW_TIMEOUT,
      'serviceWorker.getRegistration',
    )
  } catch {
    return undefined
  }
}

/** VAPID public key, if the deployment configured one. */
export function vapidPublicKey(): string | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLMetaElement>(`meta[name="${VAPID_META}"]`)?.content || null
}

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined' &&
    Boolean(vapidPublicKey())
}

export interface PushSubscriptionInfo { endpoint: string; keys?: { p256dh: string; auth: string } }

/** Subscribe this device to server push (collaboration invites, mentions, exports). */
export async function subscribeToPush(): Promise<PushSubscriptionInfo | null> {
  if (!pushSupported()) return null
  const permission = await ensureNotificationPermission()
  if (permission !== 'granted') return null
  try {
    const registration = await swReady()
    if (!registration) return null
    const existing = await registration.pushManager.getSubscription()
    const subscription = existing ?? (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey()!).buffer as ArrayBuffer,
    }))
    const json = subscription.toJSON()
    return { endpoint: json.endpoint!, keys: json.keys as { p256dh: string; auth: string } | undefined }
  } catch { return null }
}

export async function unsubscribeFromPush(): Promise<boolean> {
  try {
    const registration = await swReady()
    if (!registration) return false
    const subscription = await registration.pushManager.getSubscription()
    return subscription ? await subscription.unsubscribe() : true
  } catch { return false }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  if (typeof atob !== 'function') return new Uint8Array(0)
  const raw = atob(normalized)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/* =========================================================== rooms ===== */

export function makeRoomId(seed = Date.now()): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  let out = ''
  let value = Math.abs(Math.floor(seed)) || 1
  for (let i = 0; i < 10; i++) {
    out += alphabet[value % alphabet.length]
    value = (value * 1103515245 + 12345) % 2147483647
  }
  return out
}

export function shareUrl(room: string): string {
  const base = typeof location === 'undefined' ? 'https://corelbydre.local/' : `${location.origin}${location.pathname}`
  return `${base}#room=${encodeURIComponent(room)}`
}

export function roomFromUrl(hash: string): string | null {
  const match = /(?:^|[#&])room=([\w-]+)/.exec(hash)
  return match ? decodeURIComponent(match[1]) : null
}

/* ======================================================== activity ===== */

export interface ActivityEntry { id: string; actor: ActorID; label: string; at: number }

export function describeOp(op: CollabOp): string {
  switch (op.kind) {
    case 'patch': return op.label ?? `edited ${op.path?.slice(-2).join('.') ?? 'document'}`
    case 'add': return op.label ?? 'added an object'
    case 'remove': return op.label ?? 'deleted an object'
    case 'comment': return 'commented'
    case 'reply': return 'replied'
    case 'resolve': return 'resolved a comment'
    case 'delete-comment': return 'deleted a comment'
    case 'presence': return 'is here'
  }
}

export function activityFrom(ops: readonly CollabOp[]): ActivityEntry[] {
  return ops
    .filter((op) => op.kind !== 'presence')
    .map((op) => ({ id: op.id, actor: op.actor, label: describeOp(op), at: op.clock.wall }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40)
}
