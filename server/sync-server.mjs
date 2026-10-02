/**
 * CorelByDre sync relay — a dependency-free Node reference server.
 *
 * The editor is offline-first: it works with no server at all. When you do run
 * one, this is the smallest thing that makes multi-device collaboration work:
 *
 *   node server/sync-server.mjs --port 8787 --data ./sync-data.json
 *
 * Then in the editor's Collaborate docker set the endpoint to
 * http://localhost:8787 and click Start session. Ops are exchanged by
 * long-polling, so no WebSocket library (and no dependency of any kind) is
 * required. Operations are opaque JSON blobs to this server: the conflict
 * resolution lives in the client (hybrid logical clocks + last-writer-wins per
 * document path), which is what keeps merges deterministic and offline-safe.
 */
import { createServer as createHttpServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'

const LONG_POLL_MS = 25_000
const MAX_OPS_PER_ROOM = 5_000
const DEDUPE_WINDOW = 4_000

export function createRelay({ dataPath = null, longPollMs = LONG_POLL_MS, maxOps = MAX_OPS_PER_ROOM } = {}) {
  /** room -> { ops: [], seq: 0, seen: Set<string>, waiters: Set<fn> } */
  const rooms = new Map()
  const started = Date.now()

  function room(id) {
    let entry = rooms.get(id)
    if (!entry) {
      entry = { ops: [], seq: 0, seen: new Set(), seenOrder: [], waiters: new Set(), presence: new Map() }
      rooms.set(id, entry)
    }
    return entry
  }

  function broadcast(entry, payload) {
    for (const waiter of [...entry.waiters]) {
      entry.waiters.delete(waiter)
      waiter(payload)
    }
  }

  function append(roomId, actor, ops) {
    const entry = room(roomId)
    const accepted = []
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue
      const id = typeof op.id === 'string' ? op.id : null
      if (id && entry.seen.has(id)) continue
      if (id) {
        entry.seen.add(id)
        entry.seenOrder.push(id)
        if (entry.seenOrder.length > DEDUPE_WINDOW) {
          const drop = entry.seenOrder.shift()
          if (drop) entry.seen.delete(drop)
        }
      }
      entry.seq += 1
      accepted.push({ ...op, seq: entry.seq })
    }
    if (accepted.length) {
      entry.ops.push(...accepted)
      if (entry.ops.length > maxOps) entry.ops.splice(0, entry.ops.length - maxOps)
      entry.presence.set(actor, Date.now())
      broadcast(entry, { seq: entry.seq, ops: accepted })
      void persist()
    }
    return accepted
  }

  async function persist() {
    if (!dataPath) return
    const snapshot = { savedAt: Date.now(), rooms: {} }
    for (const [id, entry] of rooms) snapshot.rooms[id] = { seq: entry.seq, ops: entry.ops }
    try {
      await writeFile(dataPath, JSON.stringify(snapshot))
    } catch {
      /* persistence is best effort — the relay is still fully functional in memory */
    }
  }

  async function load() {
    if (!dataPath) return
    try {
      const raw = JSON.parse(await readFile(dataPath, 'utf8'))
      for (const [id, entry] of Object.entries(raw.rooms ?? {})) {
        const target = room(id)
        target.ops = Array.isArray(entry.ops) ? entry.ops : []
        target.seq = Number(entry.seq) || target.ops.length
        for (const op of target.ops) if (op?.id) target.seen.add(op.id)
      }
    } catch {
      /* no snapshot yet */
    }
  }

  function cors(response) {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Access-Control-Max-Age', '600')
  }

  function json(response, status, body) {
    const payload = JSON.stringify(body)
    cors(response)
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
    response.end(payload)
  }

  async function readBody(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 8 * 1024 * 1024) throw new Error('payload too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (request.method === 'OPTIONS') {
      cors(response)
      response.writeHead(204)
      response.end()
      return
    }
    if (url.pathname === '/health') {
      json(response, 200, { ok: true, rooms: rooms.size, uptime: Date.now() - started })
      return
    }
    const match = /^\/rooms\/([\w-]{1,64})\/(ops|snapshot|presence)$/.exec(url.pathname)
    if (!match) {
      json(response, 404, { error: 'not found' })
      return
    }
    const [, roomId, action] = match
    const entry = room(roomId)

    if (action === 'ops' && request.method === 'POST') {
      try {
        const body = await readBody(request)
        const ops = Array.isArray(body.ops) ? body.ops : []
        const accepted = append(roomId, typeof body.actor === 'string' ? body.actor : 'remote', ops)
        json(response, 200, { ok: true, seq: entry.seq, accepted: accepted.length })
      } catch (error) {
        json(response, 400, { error: String(error?.message ?? error) })
      }
      return
    }

    if (action === 'ops' && request.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      const flush = () => {
        const ops = entry.ops.filter((op) => (op.seq ?? 0) > since)
        const presence = [...entry.presence.entries()]
          .filter(([, at]) => Date.now() - at < 60_000)
          .map(([actor, at]) => ({ actor, at }))
        json(response, 200, { seq: entry.seq, ops, presence })
      }
      if (entry.seq > since) {
        flush()
        return
      }
      const timer = setTimeout(() => {
        entry.waiters.delete(waiter)
        flush()
      }, longPollMs)
      const waiter = (payload) => {
        clearTimeout(timer)
        json(response, 200, { seq: payload.seq, ops: payload.ops, presence: [] })
      }
      entry.waiters.add(waiter)
      request.on('close', () => {
        clearTimeout(timer)
        entry.waiters.delete(waiter)
      })
      return
    }

    if (action === 'snapshot') {
      json(response, 200, { seq: entry.seq, ops: entry.ops, rooms: rooms.size })
      return
    }

    if (action === 'presence' && request.method === 'POST') {
      try {
        const body = await readBody(request)
        if (typeof body.actor === 'string') entry.presence.set(body.actor, Date.now())
        json(response, 200, { ok: true, presence: [...entry.presence.keys()] })
      } catch (error) {
        json(response, 400, { error: String(error?.message ?? error) })
      }
      return
    }

    json(response, 405, { error: 'method not allowed' })
  })

  server.on('clientError', (_error, socket) => {
    try { socket.destroy() } catch { /* already gone */ }
  })

  return {
    server,
    rooms,
    load,
    async listen(port = 8787, host = '0.0.0.0') {
      await load()
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      return server.address()
    },
    async close() {
      for (const entry of rooms.values()) {
        for (const waiter of [...entry.waiters]) {
          entry.waiters.delete(waiter)
          waiter({ seq: entry.seq, ops: [] })
        }
      }
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const argValue = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const port = Number(argValue('port', process.env.PORT ?? 8787))
  const dataPath = argValue('data', process.env.SYNC_DATA ?? null)
  const relay = createRelay({ dataPath })
  const address = await relay.listen(port)
  const shown = typeof address === 'object' && address ? address.port : port
  console.log(`[corelbydre-sync] relay listening on http://0.0.0.0:${shown}`)
  console.log('[corelbydre-sync] set this as the Collaborate endpoint in the editor')
  if (dataPath) console.log(`[corelbydre-sync] persisting rooms to ${dataPath}`)
  const shutdown = async () => {
    console.log('\n[corelbydre-sync] shutting down')
    await relay.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
