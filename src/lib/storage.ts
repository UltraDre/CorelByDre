/**
 * Local persistence and file I/O.
 *
 *  - IndexedDB stores documents, recent files, settings, the sync queue and
 *    captured masks, so the editor is fully usable offline and survives reloads.
 *  - The File System Access API is used when available (desktop Chromium) so
 *    users can open/save straight to disk; the download/upload path is the
 *    fallback everywhere else.
 *  - The sync queue is drained by Background Sync when connectivity returns.
 */

const DB_NAME = 'corelbydre'
const DB_VERSION = 1
const STORE_DOCS = 'documents'
const STORE_META = 'meta'
const STORE_QUEUE = 'syncQueue'

export interface StoredDocument {
  id: string
  name: string
  modifiedAt: number
  size: number
  pageCount: number
  thumbnail?: string
  /** Serialised document payload. */
  payload: string
}

export interface SyncJob {
  id: string
  kind: 'doc-save' | 'export' | 'comment' | 'preset'
  documentId: string
  createdAt: number
  attempts: number
  payload: unknown
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        const store = db.createObjectStore(STORE_DOCS, { keyPath: 'id' })
        store.createIndex('modifiedAt', 'modifiedAt')
      }
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const queue = db.createObjectStore(STORE_QUEUE, { keyPath: 'id' })
        queue.createIndex('createdAt', 'createdAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode)
    const objectStore = transaction.objectStore(store)
    let request: IDBRequest<T> | null = null
    try {
      request = fn(objectStore)
    } catch (error) {
      reject(error)
      return
    }
    transaction.oncomplete = () => resolve(request ? request.result : undefined)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/* ------------------------------------------------------------ documents ---- */

export async function saveDocumentLocal(doc: StoredDocument): Promise<void> {
  await tx(STORE_DOCS, 'readwrite', (s) => s.put(doc))
}

export async function loadDocumentLocal(id: string): Promise<StoredDocument | undefined> {
  return tx<StoredDocument>(STORE_DOCS, 'readonly', (s) => s.get(id))
}

export async function deleteDocumentLocal(id: string): Promise<void> {
  await tx(STORE_DOCS, 'readwrite', (s) => s.delete(id))
}

export async function listDocuments(): Promise<StoredDocument[]> {
  const all = await tx<StoredDocument[]>(STORE_DOCS, 'readonly', (s) => s.getAll())
  return (all ?? []).sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function saveMeta(key: string, value: unknown): Promise<void> {
  await tx(STORE_META, 'readwrite', (s) => s.put({ key, value }))
}

export async function loadMeta<T>(key: string): Promise<T | undefined> {
  const row = await tx<{ key: string; value: T }>(STORE_META, 'readonly', (s) => s.get(key))
  return row?.value
}

/* ----------------------------------------------------------- sync queue ---- */

export async function enqueueSync(job: SyncJob): Promise<void> {
  await tx(STORE_QUEUE, 'readwrite', (s) => s.put(job))
  await requestBackgroundSync()
}

export async function listSyncJobs(): Promise<SyncJob[]> {
  const all = await tx<SyncJob[]>(STORE_QUEUE, 'readonly', (s) => s.getAll())
  return (all ?? []).sort((a, b) => a.createdAt - b.createdAt)
}

export async function completeSyncJob(id: string): Promise<void> {
  await tx(STORE_QUEUE, 'readwrite', (s) => s.delete(id))
}

export async function updateSyncJob(job: SyncJob): Promise<void> {
  await tx(STORE_QUEUE, 'readwrite', (s) => s.put(job))
}

/**
 * Ask the service worker to run a background sync. Browsers that do not support
 * it fall back to flushing on the next `online` event (see pwa/sync.ts).
 */
export async function requestBackgroundSync(tag = 'corelbydre-sync'): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker?.ready
    const sync = (registration as ServiceWorkerRegistration & { sync?: { register: (t: string) => Promise<void> } }).sync
    if (sync) {
      await sync.register(tag)
      return true
    }
  } catch {
    /* not supported */
  }
  return false
}

export async function requestPeriodicSync(tag = 'corelbydre-autosave', minInterval = 60 * 60 * 1000): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker?.ready
    const periodic = (registration as ServiceWorkerRegistration & {
      periodicSync?: { register: (t: string, o: { minInterval: number }) => Promise<void> }
    }).periodicSync
    if (periodic) {
      await periodic.register(tag, { minInterval })
      return true
    }
  } catch {
    /* permission or support missing */
  }
  return false
}

/* --------------------------------------------------- File System Access ---- */

export const supportsFileSystemAccess = typeof window !== 'undefined' && 'showSaveFilePicker' in window

export const PICKER_TYPES: Record<string, { description: string; accept: Record<string, string[]> }> = {
  cbd: { description: 'CorelByDre document', accept: { 'application/json': ['.cbd'] } },
  svg: { description: 'SVG vector', accept: { 'image/svg+xml': ['.svg'] } },
  pdf: { description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } },
  eps: { description: 'Encapsulated PostScript', accept: { 'application/postscript': ['.eps'] } },
  dxf: { description: 'AutoCAD DXF', accept: { 'image/vnd.dxf': ['.dxf'] } },
  png: { description: 'PNG image', accept: { 'image/png': ['.png'] } },
  jpg: { description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
  webp: { description: 'WebP image', accept: { 'image/webp': ['.webp'] } },
  avif: { description: 'AVIF image', accept: { 'image/avif': ['.avif'] } },
  ai: { description: 'Adobe Illustrator (PDF-compatible)', accept: { 'application/pdf': ['.ai'] } },
}

export async function pickSaveHandle(suggestedName: string, kind: keyof typeof PICKER_TYPES | string): Promise<FileSystemFileHandle | null> {
  if (!supportsFileSystemAccess) return null
  const ext = kind === 'jpg' ? 'jpg' : kind
  try {
    const handle = await (window as unknown as {
      showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle>
    }).showSaveFilePicker({
      suggestedName,
      types: PICKER_TYPES[ext] ? [PICKER_TYPES[ext]] : undefined,
    })
    return handle
  } catch {
    return null
  }
}

export async function pickOpenHandles(multiple = false): Promise<FileSystemFileHandle[]> {
  if (!supportsFileSystemAccess) return []
  try {
    const handles = await (window as unknown as {
      showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>
    }).showOpenFilePicker({
      multiple,
      types: [
        { description: 'CorelByDre document', accept: { 'application/json': ['.cbd'] } },
        { description: 'Design files', accept: { 'image/svg+xml': ['.svg'], 'application/pdf': ['.pdf', '.ai'], 'application/postscript': ['.eps'], 'image/vnd.dxf': ['.dxf'], 'image/vnd.corel-draw': ['.cdr'], 'image/vnd.dwg': ['.dwg'] } },
        { description: 'Images', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/heic': ['.heic', '.heif'], 'image/tiff': ['.tif', '.tiff'], 'image/avif': ['.avif'], 'image/x-adobe-dng': ['.dng', '.cr2', '.nef', '.arw', '.raf', '.rw2', '.orf'] } },
      ],
    })
    return handles
  } catch {
    return []
  }
}

/** Fallback picker using a hidden <input type="file">. */
export function pickFilesFallback(multiple = false, accept?: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    if (accept) input.accept = accept
    input.style.display = 'none'
    input.onchange = () => resolve(input.files ? Array.from(input.files) : [])
    input.oncancel = () => resolve([])
    document.body.appendChild(input)
    input.click()
    setTimeout(() => input.remove(), 60_000)
  })
}

export async function writeToHandle(handle: FileSystemFileHandle, data: Blob | string): Promise<boolean> {
  try {
    const writable = await handle.createWritable()
    await writable.write(data)
    await writable.close()
    return true
  } catch (error) {
    console.warn('[fs] write failed', error)
    return false
  }
}

export async function readFromHandle(handle: FileSystemFileHandle): Promise<Blob> {
  const file = await handle.getFile()
  return file
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: mime }), filename)
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Query permission state for a stored handle (used on reopen). */
export async function ensurePermission(handle: FileSystemFileHandle, mode: 'read' | 'readwrite' = 'readwrite'): Promise<boolean> {
  const anyHandle = handle as FileSystemFileHandle & {
    queryPermission?: (o: { mode: string }) => Promise<PermissionState>
    requestPermission?: (o: { mode: string }) => Promise<PermissionState>
  }
  try {
    if (!anyHandle.queryPermission) return true
    const current = await anyHandle.queryPermission({ mode })
    if (current === 'granted') return true
    const requested = await anyHandle.requestPermission?.({ mode })
    return requested === 'granted'
  } catch {
    return false
  }
}

/* ------------------------------------------------------------- storage ----- */

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  try {
    const est = await navigator.storage?.estimate?.()
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 }
  } catch {
    return { usage: 0, quota: 0 }
  }
}

export async function persistStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
