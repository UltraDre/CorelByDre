/**
 * File operations: new / open / save / autosave / export / place image / print.
 *
 * Everything uses the File System Access API when the browser provides it and
 * falls back to `<input type=file>` + downloads elsewhere, so the app works
 * fully offline either way. Autosaves land in IndexedDB and are queued for the
 * service worker's background sync when a cloud endpoint is configured.
 */
import type { Document } from '../types'
import { useStore } from '../store/store'
import {
  downloadBlob, downloadText, enqueueSync, ensurePermission, loadMeta, pickFilesFallback,
  pickOpenHandles, pickSaveHandle, readFromHandle, requestBackgroundSync, saveDocumentLocal, saveMeta, supportsFileSystemAccess, writeToHandle,
} from '../lib/storage'
import { importFile, type ImportResult } from '../lib/import'
import { uid } from '../lib/util'
import { DEFAULT_EXPORT, exportCDR, exportDXF, exportEPS, exportFileName, exportPDF, exportRaster, exportSVG, type ExportOptions } from '../lib/export'
import { renderPageInto } from '../engine/render'
import { createDocument, createGroup, PAGE_PRESETS } from '../store/mutations'
import { debounce, slugify } from '../lib/util'
import * as storage from '../lib/storage'
import { bytesToImageData } from '../lib/wasm'
import { DEFAULT_WEB_EXPORT, defaultWebRenderer, exportWeb, type WebExportOptions, type WebExportResult } from '../lib/webexport'
import type { SceneObject } from '../types'

export interface ExportRequest extends Partial<ExportOptions> {
  format: ExportOptions['format']
  /** Which pages to export; empty = the active page. */
  pages?: number[]
}

/* ------------------------------------------------------------------ open --- */

export async function openDocument(): Promise<void> {
  const store = useStore.getState()
  try {
    const handles = await pickOpenHandles(false)
    if (!handles.length) return
    const handle = handles[0]
    const file = await handle.getFile()
    const result = await importFile(file)
    store.replaceDocument(result.document, { fileHandle: handle, markClean: true })
    reportImport(result, file.name)
  } catch (error) {
    const fallback = await pickFilesFallback(false)
    if (!fallback.length) return
    const file = fallback[0]
    const result = await importFile(file)
    store.replaceDocument(result.document, { fileHandle: null, markClean: true })
    reportImport(result, file.name)
    void error
  }
}

export async function openRecent(id: string): Promise<void> {
  const loadDocumentLocal = storage.loadDocumentLocal
  const stored = await loadDocumentLocal(id)
  if (!stored) {
    useStore.getState().toast('warn', 'That document is no longer in local storage')
    return
  }
  useStore.getState().replaceDocument(JSON.parse(stored.payload) as Document, { fileHandle: null, markClean: true })
  useStore.getState().toast('success', `Opened ${stored.name}`)
}

export async function placeImage(): Promise<void> {
  const store = useStore.getState()
  try {
    const handles = await pickOpenHandles(true)
    if (!handles.length) return
    for (const handle of handles) {
      const file = await handle.getFile()
      const result = await importFile(file)
      placeImported(result)
    }
  } catch {
    const files = await pickFilesFallback(true)
    for (const file of files) {
      const result = await importFile(file)
      placeImported(result)
    }
  }
  void store
}

function placeImported(result: ImportResult): void {
  const store = useStore.getState()
  const objects: SceneObject[] = []
  for (const page of result.document.pages) {
    for (const layer of page.layers) objects.push(...layer.objects)
  }
  if (!objects.length) return
  const group = objects.length > 1 ? createGroup(objects) : objects[0]
  store.addObjectsToActiveLayer([group], `Place ${group.name}`)
  reportImport(result, group.name)
}

function reportImport(result: ImportResult, name: string): void {
  const store = useStore.getState()
  if (result.warnings.length) {
    store.toast('warn', `Imported ${name} with notes`, result.warnings.slice(0, 2).join(' '))
    for (const warning of result.warnings.slice(2)) console.info('[import]', warning)
  } else {
    store.toast('success', `Imported ${name}`, `${result.stats.objects} object(s), ${result.stats.bitmaps} bitmap(s), ${result.stats.text} text block(s).`)
  }
}

export const importIntoDocument = placeImage

/* ------------------------------------------------------------------ save --- */

export function serialiseDocument(doc: Document): string {
  return JSON.stringify({ ...doc, modifiedAt: Date.now() }, null, 2)
}

export async function saveDocument(saveAs = false, format: 'cdr' | 'cbd' = 'cdr'): Promise<void> {
  const store = useStore.getState()
  const doc = store.doc
  const jsonPayload = serialiseDocument(doc)
  try {
    let handle = store.fileHandle
    const existingIsCbd = Boolean(handle?.name && handle.name.toLowerCase().endsWith('.cbd'))
    const targetFormat: 'cdr' | 'cbd' = !saveAs && existingIsCbd ? 'cbd' : format
    if (!handle || saveAs) {
      if (supportsFileSystemAccess) {
        handle = await pickSaveHandle(exportFileName(doc, targetFormat), targetFormat)
        if (!handle) return
      }
    }
    const finalIsCbd = Boolean(handle?.name ? handle.name.toLowerCase().endsWith('.cbd') : targetFormat === 'cbd')
    const fileBlobOrText = finalIsCbd
      ? jsonPayload
      : new Blob([exportCDR(doc) as unknown as BlobPart], { type: 'application/vnd.corel-draw' })
    const ext = finalIsCbd ? 'cbd' : 'cdr'

    if (handle) {
      const allowed = await ensurePermission(handle, 'readwrite')
      if (!allowed) {
        store.toast('error', 'Write permission was denied')
        return
      }
      await writeToHandle(handle, fileBlobOrText)
      store.markSaved(handle)
      store.toast('success', 'Saved', `${doc.name}.${ext}`)
    } else {
      if (finalIsCbd) {
        downloadText(jsonPayload, exportFileName(doc, 'cbd'), 'application/json')
      } else {
        downloadBlob(fileBlobOrText as Blob, exportFileName(doc, 'cdr'))
      }
      store.markSaved(null)
      store.toast('success', 'Downloaded', `${doc.name}.${ext}`)
    }
    await saveLocalCopy(doc, jsonPayload)
    await saveMeta('lastDocument', doc.id)
  } catch (error) {
    store.toast('error', 'Save failed', (error as Error).message)
  }
}

/** Debounced autosave into IndexedDB; never blocks editing. */
export const autosave = debounce(async () => {
  const store = useStore.getState()
  if (!store.dirty) return
  try {
    await saveLocalCopy(store.doc, serialiseDocument(store.doc))
    await enqueueSync(makeJob('doc-save', store.doc.id, { name: store.doc.name }))
    await requestBackgroundSync()
  } catch {
    /* offline-first: autosave is best effort */
  }
}, 4000)

/**
 * Reopen the autosaved document from the previous session.
 *
 * Local storage can be slow or blocked, so the caller paints the shell on a
 * deadline rather than waiting for this. `shouldApply` is re-checked after every
 * await: if the user has already started working (new document, opened a file,
 * dismissed the home screen) the late restore must not clobber their work.
 */
export async function restoreLastSession(shouldApply: () => boolean = () => true): Promise<boolean> {
  const last = await loadMeta<string>('lastDocument')
  if (!last || !shouldApply()) return false
  const loadDocumentLocal = storage.loadDocumentLocal
  const stored = await loadDocumentLocal(last)
  if (!stored || !shouldApply()) return false
  useStore.getState().replaceDocument(JSON.parse(stored.payload) as Document, { fileHandle: null, markClean: true })
  useStore.getState().setHome(false)
  return true
}

/* ---------------------------------------------------------------- export --- */

export function renderPageForExport(ctx: CanvasRenderingContext2D, scale: number): void {
  const store = useStore.getState()
  const doc = store.doc
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  renderPageInto(ctx, {
    doc,
    page,
    scale,
    offsetX: 0,
    offsetY: 0,
    viewport: { x: 0, y: 0, w: page.size.w, h: page.size.h },
    quality: 'high',
    wireframe: false,
    effects: true,
  })
  ctx.restore()
}

export async function runExport(request: ExportRequest): Promise<void> {
  const store = useStore.getState()
  const doc = store.doc
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const options: ExportOptions = { ...DEFAULT_EXPORT, ...request }
  const name = slugify(doc.name)

  try {
    switch (request.format) {
      case 'cdr': {
        const bytes = exportCDR(doc, page, options)
        downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/vnd.corel-draw' }), `${name}.cdr`)
        break
      }
      case 'svg': {
        const svg = exportSVG(doc, page, options)
        downloadText(svg, `${name}.svg`, 'image/svg+xml')
        break
      }
      case 'eps': {
        downloadText(exportEPS(doc, page, options), `${name}.eps`, 'application/postscript')
        break
      }
      case 'dxf': {
        downloadText(exportDXF(doc, page), `${name}.dxf`, 'application/dxf')
        break
      }
      case 'ai': {
        // AI files that carry PDF compatibility are written as PDF with the
        // Illustrator interchange conventions — the documented interop path.
        const bytes = await exportPDF(doc, page, { ...options, pdfStandard: options.pdfStandard ?? 'none' })
        downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), `${name}.ai`)
        break
      }
      case 'pdf': {
        const bytes = await exportPDF(doc, page, options)
        downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), `${name}.pdf`)
        break
      }
      default: {
        const blob = await exportRaster(doc, page, renderPageForExport, options)
        const ext = request.format === 'jpg' ? 'jpg' : request.format
        downloadBlob(blob, `${name}.${ext}`)
      }
    }
    store.markSaved(store.fileHandle)
    await enqueueSync(makeJob('export', doc.id, { format: request.format }))
    await requestBackgroundSync()
    notify(`${doc.name} exported`, `${request.format.toUpperCase()} export finished.`)
    store.toast('success', 'Export complete', `${exportFileName(doc, request.format)}`)
  } catch (error) {
    store.toast('error', 'Export failed', (error as Error).message)
  }
}

/**
 * Pixel-precise web export: exact pixel sizes, density variants, slices, plus a
 * copy-pasteable snippet. Files download individually (no zip dependency) and
 * the snippet lands on the clipboard when the browser allows it.
 */
export async function runWebExport(options: Partial<WebExportOptions> = {}): Promise<WebExportResult> {
  const store = useStore.getState()
  const doc = store.doc
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const merged: WebExportOptions = { ...DEFAULT_WEB_EXPORT, ...options, slices: { ...DEFAULT_WEB_EXPORT.slices, ...(options.slices ?? {}) } }
  const result = await exportWeb(doc, page, merged, defaultWebRenderer, store.selectedObjects())
  for (const file of result.files) downloadBlob(file.bytes, file.name)
  const total = result.files.reduce((sum, file) => sum + file.bytes.size, 0)
  try {
    await navigator.clipboard?.writeText(`${result.snippet}\n\n${result.css}`)
    store.toast('success', `Web export — ${result.files.length} file(s)`, `${result.width} × ${result.height} CSS px · ${(total / 1024).toFixed(1)} KB · snippet copied to the clipboard`)
  } catch {
    store.toast('success', `Web export — ${result.files.length} file(s)`, `${result.width} × ${result.height} CSS px · ${(total / 1024).toFixed(1)} KB · snippet: ${result.snippet}`)
  }
  await enqueueSync(makeJob('export', doc.id, { format: merged.format, web: true }))
  await requestBackgroundSync()
  notify(`${doc.name} exported`, `${result.files.length} web asset(s) at ${result.width} CSS px.`)
  return result
}

/** Page thumbnails for the export/print dialogs and the home dashboard. */
export function thumbnailFor(pageIndex = 0, maxSize = 260): string {
  const store = useStore.getState()
  const doc = store.doc
  const page = doc.pages[pageIndex] ?? doc.pages[0]
  const scale = Math.min(maxSize / page.size.w, maxSize / page.size.h)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(page.size.w * scale))
  canvas.height = Math.max(1, Math.round(page.size.h * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.scale(scale, scale)
  renderPageInto(ctx, {
    doc,
    page,
    scale,
    offsetX: 0,
    offsetY: 0,
    viewport: { x: 0, y: 0, w: page.size.w, h: page.size.h },
    quality: 'draft',
    wireframe: false,
    effects: true,
  })
  ctx.restore()
  return canvas.toDataURL('image/png')
}

/* ----------------------------------------------------------------- print --- */

export async function printDocument(options: ExportRequest): Promise<void> {
  const store = useStore.getState()
  const doc = store.doc
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const bytes = await exportPDF(doc, page, { ...DEFAULT_EXPORT, ...options })
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.src = url
  frame.onload = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
      store.toast('info', 'Print dialog opened', 'Choose your printer or “Save as PDF”.')
    } catch {
      window.open(url, '_blank')
    }
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
      frame.remove()
    }, 60_000)
  }
  document.body.appendChild(frame)
}

export async function newDocument(presetId?: string): Promise<void> {
  const store = useStore.getState()
  const preset = PAGE_PRESETS.find((p) => p.id === presetId)
  if (store.dirty && !window.confirm('Discard unsaved changes and start a new document?')) return
  store.replaceDocument(createDocument('Untitled-1', preset), { markClean: true })
  store.setHome(false)
}

/* -------------------------------------------------------------- helpers --- */

function makeJob(kind: 'doc-save' | 'export' | 'comment' | 'preset', documentId: string, payload: unknown) {
  return { id: uid('sync'), kind, documentId, createdAt: Date.now(), attempts: 0, payload }
}

async function saveLocalCopy(doc: Document, payload: string): Promise<void> {
  let thumbnail: string | undefined
  try {
    thumbnail = thumbnailFor(0, 220)
  } catch {
    thumbnail = undefined
  }
  await saveDocumentLocal({
    id: doc.id,
    name: doc.name,
    modifiedAt: Date.now(),
    size: payload.length,
    pageCount: doc.pages.length,
    thumbnail,
    payload,
  })
}

/* -------------------------------------------------------------- downloads -- */

export function imageDataToBlobUrl(data: Uint8ClampedArray, w: number, h: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.putImageData(bytesToImageData(data as never, w, h), 0, 0)
  return canvas.toDataURL('image/png')
}

/* ------------------------------------------------------------ notification -- */

export function notify(title: string, body: string): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/icons/icon-192.png', tag: 'corelbydre-export' })
  } else if (Notification.permission !== 'denied') {
    void Notification.requestPermission()
  }
}

export type { ExportOptions }
