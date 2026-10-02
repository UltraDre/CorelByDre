/**
 * Collaboration tests: clock ordering, deterministic convergence, the diff →
 * op-log round trip, comments/mentions, the outbox retry path, and the bundled
 * reference relay's HTTP contract.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import {
  Outbox,
  activityFrom,
  applyOps,
  backoffDelay,
  broadcastTransport,
  compareClock,
  diffObjects,
  makeActor,
  makeOp,
  makeRoomId,
  mergeLogs,
  newClock,
  parseMentions,
  presenceColor,
  shareUrl,
  roomFromUrl,
  tickClock,
  type CollabOp,
  type Comment,
} from '../src/lib/collab'
import { createDocument, createVector, rectPathData } from '../src/store/mutations'

const ROOM = 'testroom'
const actorA = 'actor-a'
const actorB = 'actor-b'

function patchOp(actor: string, clock: ReturnType<typeof newClock>, path: (string | number)[], value: unknown): CollabOp {
  return makeOp(actor, ROOM, clock, 'patch', { path, value, label: 'edit' })
}

describe('hybrid logical clocks', () => {
  it('is monotonic across ticks and remote clocks', () => {
    let clock = newClock(actorA, 1000)
    const first = clock
    clock = tickClock(clock, null, 1000)
    expect(compareClock(clock, first)).toBeGreaterThan(0)
    const remote = { wall: 5000, counter: 3, actor: actorB }
    clock = tickClock(clock, remote, 1000)
    expect(clock.wall).toBe(5000)
    expect(compareClock(clock, remote)).toBeGreaterThan(0)
  })

  it('breaks ties by actor so all peers agree on the order', () => {
    const a = { wall: 10, counter: 0, actor: 'a' }
    const b = { wall: 10, counter: 0, actor: 'b' }
    expect(compareClock(a, b)).toBeLessThan(0)
    expect(compareClock(b, a)).toBeGreaterThan(0)
  })
})

describe('operation log', () => {
  it('converges to an identical document regardless of delivery order', () => {
    const base = createDocument('Collab')
    const c1 = newClock(actorA, 2000)
    const c2 = newClock(actorB, 2000)
    const opA = patchOp(actorA, c1, ['name'], 'From A')
    const opB = patchOp(actorB, tickClock(c2, c1, 2000), ['name'], 'From B')
    const first = applyOps(base, [opA, opB])
    const second = applyOps(base, [opB, opA])
    expect(first.name).toBe(second.name)
    expect(first.name).toBe('From B')
  })

  it('merges logs idempotently', () => {
    const clock = newClock(actorA, 3000)
    const op = patchOp(actorA, clock, ['name'], 'once')
    const merged = mergeLogs([op], [op, op])
    expect(merged).toHaveLength(1)
  })

  it('adds and removes objects by id at a path', () => {
    const doc = createDocument('Ops')
    const rect = createVector({ path: rectPathData(0, 0, 10, 10) })
    const add = makeOp(actorA, ROOM, newClock(actorA, 1), 'add', { path: ['pages', 0, 'layers', 0, 'objects'], value: rect })
    const withRect = applyOps(doc, [add])
    expect(withRect.pages[0].layers[0].objects.map((o) => o.id)).toContain(rect.id)
    const remove = makeOp(actorA, ROOM, newClock(actorA, 2), 'remove', { path: ['pages', 0, 'layers', 0, 'objects'], value: { id: rect.id } })
    const without = applyOps(withRect, [remove])
    expect(without.pages[0].layers[0].objects).toHaveLength(0)
  })

  it('round-trips a document diff through the op log', () => {
    const before = createDocument('Diff')
    const after = { ...before, name: 'Renamed', settings: { ...before.settings, gridStep: 25 } }
    const patches = diffObjects(before, after)
    expect(patches.length).toBeGreaterThan(0)
    const ops = patches.map((patch, index) => patchOp(actorA, newClock(actorA, 100 + index), patch.path, patch.value))
    expect(applyOps(before, ops)).toEqual(after)
  })

  it('caps diff size for very large documents', () => {
    const before = createDocument('Big')
    const after = { ...before, pages: before.pages.map((p) => ({ ...p, name: 'x'.repeat(200) })) }
    const patches = diffObjects(before, after, [], 1)
    expect(patches).toHaveLength(1)
  })
})

describe('comments and presence', () => {
  it('parses mentions from comment bodies', () => {
    expect(parseMentions('ping @dana and @sam.lee please')).toEqual(['dana', 'sam.lee'])
    expect(parseMentions('no mentions here')).toEqual([])
  })

  it('assigns stable colours per actor', () => {
    expect(presenceColor('abc')).toBe(presenceColor('abc'))
    expect(presenceColor('abc')).not.toBe(presenceColor('abd'))
  })

  it('builds shared room links and parses them back', () => {
    const room = makeRoomId(12345)
    const url = shareUrl(room)
    expect(roomFromUrl(url.slice(url.indexOf('#')))).toBe(room)
  })

  it('summarises activity from the op log', () => {
    const clock = newClock(actorA, 4000)
    const comment: Comment = {
      id: 'c1', room: ROOM, pageId: 'p1', x: 10, y: 20, body: 'hello @bob',
      author: actorA, authorName: 'Ada', created: 4000, resolved: false, mentions: ['bob'],
    }
    const ops = [makeOp(actorA, ROOM, clock, 'comment', { comment }), makeOp(actorA, ROOM, tickClock(clock), 'presence', { presence: { actor: actorA, name: 'Ada', color: '#fff', updated: 4000 } })]
    const feed = activityFrom(ops)
    expect(feed).toHaveLength(1)
    expect(feed[0].label).toBe('commented')
  })

  it('creates actors with deterministic ids and colours', () => {
    const actor = makeActor(actorA, 'Ada')
    expect(actor.id).toBe(actorA)
    expect(actor.color).toMatch(/^#/)
  })
})

describe('outbox', () => {
  it('keeps ops while the transport is down and flushes them later', async () => {
    const outbox = new Outbox()
    const clock = newClock(actorA, 5000)
    outbox.push([patchOp(actorA, clock, ['name'], 'offline edit')])
    expect(outbox.size).toBe(1)
    const failed = await outbox.drain(async () => false)
    expect(failed).toBe(0)
    expect(outbox.size).toBe(1)
    const delivered: CollabOp[] = []
    const sent = await outbox.drain(async (ops) => { delivered.push(...ops); return true })
    expect(sent).toBe(1)
    expect(delivered[0].value).toBe('offline edit')
    expect(outbox.size).toBe(0)
  })

  it('backs off exponentially up to a cap', () => {
    expect(backoffDelay(1)).toBe(1000)
    expect(backoffDelay(2)).toBe(2000)
    expect(backoffDelay(50)).toBe(60_000)
  })
})

describe('same-origin transport', () => {
  it('relays ops between two tabs through a BroadcastChannel', async () => {
    const a = broadcastTransport(ROOM)
    const b = broadcastTransport(ROOM)
    if (a.kind === 'none') return // environment without BroadcastChannel
    const received: CollabOp[] = []
    const off = b.onMessage((ops) => received.push(...ops))
    const clock = newClock(actorA, 6000)
    await a.send([patchOp(actorA, clock, ['name'], 'tab one')])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(received.map((op) => op.value)).toContain('tab one')
    off()
    a.close()
    b.close()
  })
})

/* ------------------------------------------------------------ relay tests -- */

// @ts-expect-error — plain JS module without type declarations
import { createRelay } from '../server/sync-server.mjs'

describe('reference sync relay', () => {
  let relay: Awaited<ReturnType<typeof createRelay>>
  let base = ''

  beforeAll(async () => {
    relay = createRelay()
    const address = await relay.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 8787}`
  })

  afterAll(async () => {
    await relay.close()
  })

  it('reports health', async () => {
    const response = await fetch(`${base}/health`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
  })

  it('accepts ops and serves them to another client', async () => {
    const clock = newClock(actorA, 7000)
    const op = patchOp(actorA, clock, ['name'], 'relayed')
    const post = await fetch(`${base}/rooms/${ROOM}/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: actorA, room: ROOM, ops: [op] }),
    })
    expect(post.status).toBe(200)
    const posted = await post.json()
    expect(posted.seq).toBeGreaterThan(0)

    const poll = await fetch(`${base}/rooms/${ROOM}/ops?since=0`)
    const body = await poll.json()
    expect(body.ops.map((entry: CollabOp) => entry.id)).toContain(op.id)
  })

  it('deduplicates ops by id', async () => {
    const clock = newClock(actorB, 8000)
    const op = patchOp(actorB, clock, ['name'], 'only once')
    const send = () => fetch(`${base}/rooms/dedupe/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: actorB, ops: [op] }),
    })
    await send()
    const second = await send()
    const body = await second.json()
    expect(body.accepted).toBe(0)
    const snapshot = await (await fetch(`${base}/rooms/dedupe/snapshot`)).json()
    expect(snapshot.ops.filter((entry: CollabOp) => entry.id === op.id)).toHaveLength(1)
  })

  it('returns a snapshot for a fresh joiner', async () => {
    const snapshot = await (await fetch(`${base}/rooms/${ROOM}/snapshot`)).json()
    expect(Array.isArray(snapshot.ops)).toBe(true)
    expect(snapshot.ops.length).toBeGreaterThan(0)
  })

  it('rejects unknown routes', async () => {
    const response = await fetch(`${base}/nope`)
    expect(response.status).toBe(404)
  })
})
