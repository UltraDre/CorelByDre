/* CorelByDre service worker — offline-first app shell + background sync + push.
 * Hand-written (no Workbox) so the caching contract is explicit and auditable.
 *
 * Strategies
 *  - App shell / navigation : network-first, fall back to precached index.html (offline editor).
 *  - Same-origin static     : cache-first, then revalidate in the background (SWR).
 *  - Cross-origin fonts     : stale-while-revalidate into the runtime cache.
 *  - API / sync endpoints   : network-only, with an offline queue drained by Background Sync.
 */

const VERSION = 'v1.0.0'
const SHELL_CACHE = `corelbydre-shell-${VERSION}`
const RUNTIME_CACHE = `corelbydre-runtime-${VERSION}`
const FONT_CACHE = `corelbydre-fonts-${VERSION}`
const IMAGE_CACHE = `corelbydre-media-${VERSION}`
const KNOWN_CACHES = [SHELL_CACHE, RUNTIME_CACHE, FONT_CACHE, IMAGE_CACHE]

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/offline.html',
  '/wasm/kernels.wasm',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/fonts.css',
]

const SYNC_TAG = 'corelbydre-sync'
const EXPORT_SYNC_TAG = 'corelbydre-export-jobs'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // Individually so one 404 never aborts the whole install.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => !KNOWN_CACHES.includes(k)).map((k) => caches.delete(k)))
      if ('navigationPreload' in self.registration) {
        try {
          await self.registration.navigationPreload.enable()
        } catch {
          /* not supported */
        }
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type === 'SKIP_WAITING') self.skipWaiting()
  if (data.type === 'PING') event.source?.postMessage({ type: 'PONG', version: VERSION })
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE)
        await Promise.all(
          data.urls
            .filter((u) => typeof u === 'string' && u.startsWith(self.location.origin))
            .map((u) => cache.add(u).catch(() => undefined)),
        )
      })(),
    )
  }
  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
        event.source?.postMessage({ type: 'CACHES_CLEARED' })
      })(),
    )
  }
  if (data.type === 'SYNC_NOW') {
    event.waitUntil(notifyClientsToSync(data.reason || 'manual'))
  }
})

async function notifyClientsToSync(reason) {
  const clientList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
  for (const client of clientList) {
    client.postMessage({ type: 'FLUSH_SYNC_QUEUE', reason })
  }
}

/* ---------------------------------------------------------------- fetch ---- */

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return // POST/PUT go straight to the network/queue

  const url = new URL(request.url)

  // Navigations: network-first so deploys are picked up, cached shell for offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const preload = await event.preloadResponse
          if (preload) return preload
          const fresh = await fetch(request)
          const cache = await caches.open(SHELL_CACHE)
          cache.put('/index.html', fresh.clone())
          return fresh
        } catch {
          const cache = await caches.open(SHELL_CACHE)
          return (
            (await cache.match('/index.html')) ||
            (await cache.match('/')) ||
            (await caches.match('/offline.html')) ||
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          )
        }
      })(),
    )
    return
  }

  // Never cache the sync API — that traffic is handled by the offline queue.
  if (url.pathname.startsWith('/api/sync')) return

  event.respondWith(
    (async () => {
      const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || /\.(woff2?|ttf|otf)$/.test(url.pathname)
      const isMedia = /\.(png|jpe?g|gif|webp|heic|heif|avif|svg|mp4)$/.test(url.pathname)
      const cacheName = isFont ? FONT_CACHE : isMedia ? IMAGE_CACHE : RUNTIME_CACHE
      const cache = await caches.open(cacheName)
      const cached = await cache.match(request)

      const network = fetch(request)
        .then((response) => {
          if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone())
          return response
        })
        .catch(() => undefined)

      if (cached) {
        event.waitUntil(network)
        return cached
      }
      const response = await network
      if (response) return response
      if (request.destination === 'document' || request.headers.get('accept')?.includes('text/html')) {
        const shell = await caches.open(SHELL_CACHE)
        return (await shell.match('/index.html')) || (await caches.match('/offline.html')) || Response.error()
      }
      return new Response('', { status: 504, statusText: 'Offline and not cached' })
    })(),
  )
})

/* --------------------------------------------------------- background sync - */

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG || event.tag === EXPORT_SYNC_TAG) {
    event.waitUntil(notifyClientsToSync(event.tag))
  }
})

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'corelbydre-autosave') {
    event.waitUntil(notifyClientsToSync('periodic'))
  }
})

/* ------------------------------------------------------------------ push -- */

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: 'CorelByDre', body: event.data ? event.data.text() : '' }
  }
  const title = payload.title || 'CorelByDre'
  const options = {
    body: payload.body || 'You have a new notification.',
    icon: payload.icon || '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: payload.tag || 'corelbydre-general',
    renotify: Boolean(payload.renotify),
    requireInteraction: false,
    silent: false,
    data: { url: payload.url || '/', kind: payload.kind || 'general', ...(payload.data || {}) },
    actions: payload.actions || [],
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/'
  const action = event.action
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', action, data: event.notification.data })
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    })(),
  )
})
