/**
 * Collaboration UI — share/invite panel, presence avatars, comments docker and
 * the notification centre. Everything here works offline: comments and edits
 * queue locally and sync when a peer or endpoint becomes reachable.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/store'
import { renameActor, useCollab } from '../store/collab'
import { Badge, Button, Col, IconButton, Row, TextField, Toggle } from './widgets'
import { Icon } from './icons'
import { objectBounds } from '../engine/render'
import { ensureNotificationPermission, pushSupported, subscribeToPush, unsubscribeFromPush, type Comment } from '../lib/collab'

function useNow(interval = 20_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  return now
}

function initials(name: string): string {
  return name.trim().split(/\s+/).map((part) => part[0]?.toUpperCase() ?? '').join('').slice(0, 2) || '?'
}

/* ========================================================== presence ==== */

export function PresenceAvatars({ compact = false }: { compact?: boolean }) {
  const peers = useCollab((s) => s.peers)
  const actor = useCollab((s) => s.actor)
  const room = useCollab((s) => s.room)
  const now = useNow(10_000)
  const others = Object.values(peers).filter((p) => p.actor !== actor.id && now - p.updated < 45_000)

  if (!room) return null
  return (
    <div className="presence" title={`${others.length + 1} in ${room}`}>
      <span className="avatar me" style={{ background: actor.color }}>{initials(actor.name)}</span>
      {others.slice(0, compact ? 3 : 6).map((peer) => (
        <span key={peer.actor} className="avatar" style={{ background: peer.color }} title={`${peer.name}${peer.tool ? ` · ${peer.tool}` : ''}`}>
          {initials(peer.name)}
        </span>
      ))}
      {others.length > (compact ? 3 : 6) ? <span className="avatar more">+{others.length - (compact ? 3 : 6)}</span> : null}
    </div>
  )
}

/* ============================================================== share ==== */

export function ShareDocker() {
  const room = useCollab((s) => s.room)
  const actor = useCollab((s) => s.actor)
  const connected = useCollab((s) => s.connected)
  const syncing = useCollab((s) => s.syncing)
  const outbox = useCollab((s) => s.outbox)
  const transportKind = useCollab((s) => s.transportKind)
  const endpoint = useCollab((s) => s.endpoint)
  const peers = useCollab((s) => s.peers)
  const activity = useCollab((s) => s.activity)
  const comments = useCollab((s) => s.comments)
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState(actor.name)
  const [server, setServer] = useState(endpoint ?? '')
  const [pushOn, setPushOn] = useState(false)
  const [permission, setPermission] = useState<string>(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission))
  const now = useNow()

  useEffect(() => { setPushOn(pushSupported()) }, [])
  const others = Object.values(peers).filter((p) => p.actor !== actor.id && now - p.updated < 45_000)

  const invite = () => {
    const link = useCollab.getState().shareLink()
    const text = `${actor.name} invites you to edit “${useStore.getState().doc.name}” in CorelByDre:\n${link}`
    void navigator.clipboard?.writeText(text).then(
      () => toast('success', 'Invite copied', 'Paste it into any chat — no account needed.'),
      () => toast('info', 'Invite link', link),
    )
  }

  return (
    <div className="col" style={{ padding: 10, gap: 10 }}>
      <Row gap={6}>
        <Icon name="users" size={15} />
        <strong style={{ fontSize: 12 }}>Collaborate</strong>
        <span className="spacer" />
        <span className={`badge ${room ? (connected ? 'ok' : 'warn') : ''}`}>
          {room ? (syncing ? 'syncing…' : connected ? 'live' : 'offline — queued') : 'solo'}
        </span>
      </Row>

      <TextField label="Your name" value={name} onChange={setName} onCommit={() => renameActor(name)} />

      {room ? (
        <>
          <Row gap={6}>
            <TextField label="Room" value={room} onChange={() => undefined} readOnly />
            <IconButton icon="link" title="Copy invite link" onClick={invite} />
          </Row>
          <span className="tiny">
            Transport: {transportKind === 'websocket' ? `server ${endpoint}` : 'same-origin tabs (no server needed)'} ·
            {' '}{others.length + 1} present · {outbox} queued op{outbox === 1 ? '' : 's'}
          </span>
          <Row gap={6}>
            <Button small onClick={invite} icon="share">Invite</Button>
            <Button small onClick={() => void useCollab.getState().flush()} icon="refresh">Sync now</Button>
            <Button small variant="ghost" onClick={() => useCollab.getState().leaveSession()}>Leave</Button>
          </Row>
        </>
      ) : (
        <>
          <TextField label="Server (optional)" value={server} onChange={setServer} placeholder="wss://sync.example.com/rooms" />
          <Row gap={6}>
            <Button small icon="share" onClick={() => {
              useCollab.getState().setEndpoint(server || null)
              void useCollab.getState().startSession().then(() => toast('success', 'Session started', 'Share the invite link to collaborate.'))
            }}>Start session</Button>
          </Row>
          <span className="tiny">
            With no server configured, collaborators on this origin (other tabs/windows) sync instantly and everything you
            do keeps working offline. Edits queue and flush when the server is reachable again.
          </span>
        </>
      )}

      <Row gap={6} style={{ alignItems: 'center' }}>
        <Icon name="bell" size={14} />
        <span className="tiny">Notifications</span>
        <span className="spacer" />
        {pushOn ? (
          <Button small variant="ghost" onClick={() => void unsubscribeFromPush().then(() => toast('info', 'Push disabled'))}>Disable push</Button>
        ) : (
          <Button small onClick={() => {
            void ensureNotificationPermission().then(async (result) => {
              setPermission(result)
              if (result !== 'granted') { toast('warn', 'Notifications blocked', 'Allow them in the browser to get mentions and invites.'); return }
              const sub = await subscribeToPush()
              toast('success', sub ? 'Push enabled' : 'Local notifications enabled', sub ? 'Invites, mentions and exports arrive even when the tab is closed.' : 'Mentions and export results will show while CorelByDre is open.')
            })
          }}>Enable</Button>
        )}
      </Row>
      <span className="tiny" style={{ opacity: 0.7 }}>
        Permission: {permission}. Collaboration invites, comment mentions and export completions are pushed through the
        service worker.
      </span>

      <hr className="rule" />
      <Row gap={6}><Icon name="history" size={14} /><span className="tiny">Recent activity</span></Row>
      {activity.length === 0 ? <span className="tiny" style={{ opacity: 0.7 }}>No activity yet this session.</span> : (
        <ul className="mini-list">
          {activity.slice(0, 8).map((entry) => (
            <li key={entry.id}>
              <span className="avatar xs" style={{ background: peers[entry.actor]?.color ?? '#12a19a' }}>
                {initials(peers[entry.actor]?.name ?? (entry.actor === actor.id ? actor.name : 'Peer'))}
              </span>
              <span className="tiny">{entry.label}</span>
              <span className="spacer" />
              <span className="tiny" style={{ opacity: 0.6 }}>{new Date(entry.at).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}
      <span className="tiny" style={{ opacity: 0.7 }}>{comments.filter((c) => !c.resolved).length} open comment thread(s)</span>
    </div>
  )
}

/* =========================================================== comments ==== */

function commentAnchor(): { pageId: string; x: number; y: number } {
  const state = useStore.getState()
  const page = state.activePage()
  const bounds = state.selectionBounds()
  if (bounds) {
    // Anchor to the last object in the selection so the pin follows the artwork.
    const last = state.selection[state.selection.length - 1]
    const object = last ? state.selectedObjects().find((o) => o.id === last) : undefined
    if (object) {
      const b = objectBounds(object, state.doc)
      if (b) return { pageId: page.id, x: Math.round(b.x + b.w), y: Math.round(b.y) }
    }
    return { pageId: page.id, x: Math.round(bounds.x + bounds.w), y: Math.round(bounds.y) }
  }
  return { pageId: page.id, x: Math.round(page.size.w / 2), y: Math.round(page.size.h / 2) }
}

function MentionTextarea({ value, onChange, onSubmit, placeholder }: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  placeholder?: string
}) {
  const peers = useCollab((s) => s.peers)
  const actor = useCollab((s) => s.actor)
  const [suggest, setSuggest] = useState<string[]>([])
  const known = useMemo(() => {
    const names = new Set<string>()
    for (const peer of Object.values(peers)) if (peer.actor !== actor.id) names.add(peer.name)
    names.add(actor.name)
    return [...names]
  }, [peers, actor])

  const update = (next: string) => {
    onChange(next)
    const match = /@([\w.\-]*)$/.exec(next)
    setSuggest(match ? known.filter((n) => n.toLowerCase().startsWith(match[1].toLowerCase())) : [])
  }
  const complete = (name: string) => {
    onChange(value.replace(/@([\w.\-]*)$/, `@${name.replace(/\s+/g, '')} `))
    setSuggest([])
  }

  return (
    <div className="col" style={{ gap: 4 }}>
      <textarea
        className="field textarea"
        rows={2}
        value={value}
        placeholder={placeholder ?? 'Leave a comment… use @name to mention a collaborator'}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit() }
        }}
      />
      {suggest.length ? (
        <Row gap={4} style={{ flexWrap: 'wrap' }}>
          {suggest.slice(0, 5).map((name) => (
            <Button key={name} small variant="ghost" onClick={() => complete(name)}>@{name}</Button>
          ))}
        </Row>
      ) : null}
      <Row>
        <span className="spacer" />
        <Button small onClick={onSubmit} disabled={!value.trim()}>Comment</Button>
      </Row>
    </div>
  )
}

export function CommentsDocker() {
  const room = useCollab((s) => s.room)
  const comments = useCollab((s) => s.comments)
  const actor = useCollab((s) => s.actor)
  const peers = useCollab((s) => s.peers)
  const toast = useStore((s) => s.toast)
  const doc = useStore((s) => s.doc)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [showResolved, setShowResolved] = useState(false)
  const addRef = useRef<Comment[]>([])

  const threads = useMemo(() => {
    const roots = comments.filter((c) => !c.parentId)
    return roots
      .map((root) => ({ root, replies: comments.filter((c) => c.parentId === root.id).sort((a, b) => a.created - b.created) }))
      .filter(({ root, replies }) => showResolved || !root.resolved || replies.some((r) => !r.resolved))
      .sort((a, b) => b.root.created - a.root.created)
  }, [comments, showResolved])

  addRef.current = comments

  const jumpTo = (comment: Comment) => {
    const store = useStore.getState()
    const page = doc.pages.find((p) => p.id === comment.pageId)
    if (!page) return
    if (doc.activePageId !== page.id) store.setActivePage(page.id)
    store.zoomTo(Math.max(store.view.zoom, 2), { x: comment.x, y: comment.y })
  }

  const submit = async () => {
    if (!room) { toast('warn', 'Start a session first', 'Comments are shared through a collaboration session.'); return }
    const anchor = commentAnchor()
    const created = await useCollab.getState().addComment(anchor.pageId, anchor.x, anchor.y, draft.trim())
    if (created) { setDraft(''); toast('success', 'Comment added', `@ ${Math.round(anchor.x)}, ${Math.round(anchor.y)}`) }
  }

  const authors = useMemo(() => {
    const map: Record<string, string> = { [actor.id]: actor.name }
    for (const peer of Object.values(peers)) map[peer.actor] = peer.name
    return map
  }, [peers, actor])

  return (
    <div className="col" style={{ padding: 10, gap: 10 }}>
      <Row gap={6}>
        <Icon name="comment" size={15} />
        <strong style={{ fontSize: 12 }}>Comments</strong>
        <span className="spacer" />
        <Badge>{comments.filter((c) => !c.resolved).length} open</Badge>
        <Toggle checked={showResolved} onChange={setShowResolved} label="Resolved" />
      </Row>
      <span className="tiny" style={{ opacity: 0.75 }}>
        Pins are anchored to document coordinates{useStore.getState().selection.length ? ' at the selection' : ' at the page centre'}.
        Mention a collaborator with @name to notify them.
      </span>

      <MentionTextarea value={draft} onChange={setDraft} onSubmit={() => void submit()} placeholder="Add a comment at the current selection…" />

      <hr className="rule" />
      {threads.length === 0 ? (
        <span className="tiny" style={{ opacity: 0.7 }}>No comments yet.</span>
      ) : threads.map(({ root, replies }) => (
        <div key={root.id} className={`comment ${root.resolved ? 'resolved' : ''}`}>
          <Row gap={6}>
            <span className="avatar xs" style={{ background: peers[root.author]?.color ?? '#12a19a' }}>
              {initials(authors[root.author] ?? root.authorName)}
            </span>
            <span className="tiny"><strong>{authors[root.author] ?? root.authorName}</strong> · {new Date(root.created).toLocaleString()}</span>
            <span className="spacer" />
            <IconButton icon="zoom-fit" title="Zoom to comment" onClick={() => jumpTo(root)} />
            <IconButton icon={root.resolved ? 'redo' : 'check'} title={root.resolved ? 'Reopen' : 'Resolve'} onClick={() => void useCollab.getState().setResolved(root.id, !root.resolved)} />
            <IconButton icon="delete" title="Delete thread" onClick={() => void useCollab.getState().removeComment(root.id)} />
          </Row>
          <p className="comment-body">{root.body}</p>
          {replies.map((reply) => (
            <div key={reply.id} className="comment-reply">
              <span className="tiny"><strong>{authors[reply.author] ?? reply.authorName}</strong> · {new Date(reply.created).toLocaleTimeString()}</span>
              <p className="comment-body">{reply.body}</p>
            </div>
          ))}
          {replyTo === root.id ? (
            <MentionTextarea
              value={replyDraft}
              onChange={setReplyDraft}
              placeholder="Reply…"
              onSubmit={() => {
                void useCollab.getState().replyTo(root.id, replyDraft.trim()).then(() => { setReplyDraft(''); setReplyTo(null) })
              }}
            />
          ) : (
            <Button small variant="ghost" onClick={() => setReplyTo(root.id)}>Reply</Button>
          )}
        </div>
      ))}
    </div>
  )
}

/* ======================================================== notification ==== */

export function NotificationCentre() {
  const activity = useCollab((s) => s.activity)
  const [open, setOpen] = useState(false)
  const [permission, setPermission] = useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission))
  const mentions = useCollab((s) => s.comments).filter((c) => c.mentions.length)

  return (
    <div className="popover-host">
      <IconButton icon="bell" title="Notifications" onClick={() => setOpen((v) => !v)} />
      {mentions.length ? <span className="dot" /> : null}
      {open ? (
        <div className="popover" onMouseLeave={() => setOpen(false)}>
          <Row gap={6}>
            <strong style={{ fontSize: 12 }}>Notifications</strong>
            <span className="spacer" />
            {permission !== 'granted' ? (
              <Button small onClick={() => void ensureNotificationPermission().then(setPermission)}>Enable</Button>
            ) : <span className="tiny">on</span>}
          </Row>
          <ul className="mini-list">
            {activity.slice(0, 10).map((entry) => (
              <li key={entry.id}><span className="tiny">{entry.label}</span><span className="spacer" /><span className="tiny" style={{ opacity: 0.6 }}>{new Date(entry.at).toLocaleTimeString()}</span></li>
            ))}
            {activity.length === 0 ? <li><span className="tiny" style={{ opacity: 0.7 }}>Nothing yet.</span></li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
