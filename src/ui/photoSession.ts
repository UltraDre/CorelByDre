/**
 * Bridges document bitmaps and the PHOTO-PAINT working buffers.
 *
 * A `PhotoDocument` is opened lazily for the selected bitmap and cached while the
 * user keeps editing it, so successive brush strokes accumulate. Committing the
 * session bakes the pixels back into the object's data URL inside a normal undo
 * step — nothing is applied behind the document model's back.
 */
import type { BitmapObject, Document, ID } from '../types'
import { updateObject } from '../store/mutations'
import { createPhotoDocument, photoDataUrl, type PhotoDocument } from '../lib/photo'
import { imageDataToBytes } from '../lib/wasm'

interface Session {
  doc: PhotoDocument
  key: string
}

const sessions = new Map<ID, Session>()

export function sessionKey(obj: BitmapObject): string {
  return `${obj.id}:${obj.width}x${obj.height}:${obj.dataUrl.length}`
}

/** Open (or reuse) the working buffer for a bitmap object. */
export async function openSession(obj: BitmapObject): Promise<PhotoDocument> {
  const key = sessionKey(obj)
  const existing = sessions.get(obj.id)
  if (existing && existing.key === key) return existing.doc
  const image = new Image()
  image.src = obj.dataUrl
  await image.decode().catch(() => undefined)
  const canvas = document.createElement('canvas')
  canvas.width = obj.width
  canvas.height = obj.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  if (image.naturalWidth) ctx.drawImage(image, 0, 0, obj.width, obj.height)
  const pixels = ctx.getImageData(0, 0, obj.width, obj.height)
  const doc = createPhotoDocument(obj.width, obj.height, imageDataToBytes(pixels), obj.name)
  sessions.set(obj.id, { doc, key })
  return doc
}

export function peekSession(id: ID): PhotoDocument | undefined {
  return sessions.get(id)?.doc
}

export function closeSession(id: ID): void {
  sessions.delete(id)
}

/** Serialise the working buffer and return a document-updating function. */
export function bakeSession(obj: BitmapObject, photo: PhotoDocument): (doc: Document) => Document {
  const dataUrl = photoDataUrl(photo)
  const width = photo.w
  const height = photo.h
  return (doc) => updateObject(doc, obj.id, (o) => (o.kind === 'bitmap' ? { ...o, dataUrl, width, height, rect: { ...o.rect, w: width, h: height } } : o))
}

/**
 * Convenience for dockers: run an edit on the selected bitmap and commit it in
 * one undo step. Returns false when the selection is not a bitmap.
 */
export async function withBitmapSession(
  document: Document,
  id: ID,
  edit: (photo: PhotoDocument) => void | Promise<void>,
  commit: (label: string, updater: (doc: Document) => Document) => void,
  label: string,
): Promise<boolean> {
  const obj = findBitmap(document, id)
  if (!obj) return false
  const photo = await openSession(obj)
  await edit(photo)
  commit(label, bakeSession(obj, photo))
  return true
}

export function findBitmap(doc: Document, id: ID): BitmapObject | null {
  for (const page of doc.pages) {
    for (const layer of page.layers) {
      const found = search(layer.objects, id)
      if (found) return found
    }
  }
  return null
}

function search(objects: Document['pages'][number]['layers'][number]['objects'], id: ID): BitmapObject | null {
  for (const obj of objects) {
    if (obj.id === id && obj.kind === 'bitmap') return obj
    if (obj.kind === 'group') {
      const nested = search(obj.children as typeof objects, id)
      if (nested) return nested
    }
  }
  return null
}

/** Re-render the cached session after an external change (e.g. reset). */
export function invalidateSession(id: ID): void {
  sessions.delete(id)
}

export function sessionCount(): number {
  return sessions.size
}
