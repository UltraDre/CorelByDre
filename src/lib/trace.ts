/**
 * Bitmap → vector tracing (the PowerTRACE workflow).
 *
 * This is a deterministic contour tracer: threshold or colour quantise, extract
 * closed rings with the WASM `traceContours` kernel, simplify them with
 * Douglas-Peucker, then rebuild them as editable curves. There is no
 * machine-learning step and the same input always produces the same curves.
 */
import type { BitmapObject, Document, ID, VectorObject } from '../types'
import { createGroup, createVector, updateObject } from '../store/mutations'
import { ImageKernels, imageDataToBytes } from './wasm'
import { rgb } from './color'
import { pathFromPoints } from './util'

export interface TraceStyle {
  id: string
  label: string
  detail: string
  /** 0..255 luminance threshold for the monochrome passes. */
  threshold: number
  /** 0 = monochrome outline; >1 quantises to that many colours. */
  colours: number
  /** Douglas-Peucker tolerance in source pixels. */
  simplify: number
  /** Discard rings smaller than this many nodes. */
  minNodes: number
  /** Line art keeps the outline only; colour styles fill the shapes. */
  outlineOnly: boolean
  smoothing: number
}

export const IMAGE_TRACE_STYLES: TraceStyle[] = [
  { id: 'lineart', label: 'Line art', detail: 'Threshold + centreline curves. Best for logos and ink drawings.', threshold: 128, colours: 0, simplify: 1.2, minNodes: 8, outlineOnly: true, smoothing: 0.6 },
  { id: 'outline', label: 'Outline trace', detail: 'Keeps the outside contour of the subject only.', threshold: 140, colours: 0, simplify: 2.2, minNodes: 24, outlineOnly: true, smoothing: 1 },
  { id: 'detailed', label: 'Detailed trace', detail: 'High detail with many small shapes.', threshold: 118, colours: 0, simplify: 0.7, minNodes: 4, outlineOnly: false, smoothing: 0.4 },
  { id: 'smooth', label: 'Smooth trace', detail: 'Fewer nodes and rounder curves.', threshold: 132, colours: 0, simplify: 2.6, minNodes: 10, outlineOnly: false, smoothing: 1.4 },
  { id: 'poster8', label: 'Poster 8 colours', detail: 'Quantises to eight flat colour shapes.', threshold: 128, colours: 8, simplify: 1.6, minNodes: 12, outlineOnly: false, smoothing: 0.9 },
  { id: 'poster16', label: 'Poster 16 colours', detail: 'Sixteen flat colour shapes.', threshold: 128, colours: 16, simplify: 1.4, minNodes: 8, outlineOnly: false, smoothing: 0.8 },
  { id: 'blackwhite', label: 'Black & white', detail: 'Hard two-tone silhouette.', threshold: 128, colours: 0, simplify: 1.8, minNodes: 14, outlineOnly: false, smoothing: 0.5 },
]

/** Trace a bitmap object into fresh vector objects (in source/image space). */
export function traceBitmap(obj: BitmapObject, style: TraceStyle, palette: { r: number; g: number; b: number }[] = []): VectorObject[] {
  const canvas = document.createElement('canvas')
  canvas.width = obj.width
  canvas.height = obj.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  // The decode is synchronous once the image is in the element cache; callers
  // await `preloadBitmap` first.
  ctx.drawImage(getCached(obj.dataUrl), 0, 0, obj.width, obj.height)
  const img = ctx.getImageData(0, 0, obj.width, obj.height)
  const data = imageDataToBytes(img)
  const out: VectorObject[] = []
  const scaleX = obj.rect.w / obj.width
  const scaleY = obj.rect.h / obj.height

  const ringsToObject = (rings: { x: number; y: number }[][], color: { r: number; g: number; b: number; a: number }, outline: boolean) => {
    const paths = []
    for (const ring of rings) {
      if (ring.length < style.minNodes) continue
      const simplified = ImageKernels.simplify(ring, style.simplify)
      const pts = simplified.map((p) => ({ x: obj.rect.x + p.x * scaleX, y: obj.rect.y + p.y * scaleY }))
      if (pts.length < 3) continue
      paths.push(pathFromPoints(pts, true, style.smoothing))
    }
    for (const path of paths) {
      out.push(createVector({
        path,
        primitive: { type: 'trace' },
        fill: outline ? { type: 'none' } : { type: 'uniform', color },
        stroke: outline ? { color, width: Math.max(0.25, Math.min(obj.rect.w, obj.rect.h) / 400), cap: 'round', join: 'round', miterLimit: 10, behind: false } : null,
        name: `${obj.name} trace`,
      }))
    }
  }

  if (style.colours > 1) {
    const colours = palette.length >= style.colours ? palette.slice(0, style.colours) : ImageKernels.extractPalette(data, style.colours)
    for (const colour of colours) {
      const mask = new Uint8ClampedArray(data.length)
      for (let i = 0; i < data.length; i += 4) {
        const d = Math.abs(data[i] - colour.r) + Math.abs(data[i + 1] - colour.g) + Math.abs(data[i + 2] - colour.b)
        const on = d < 96
        mask[i] = on ? 255 : 0
        mask[i + 1] = on ? 255 : 0
        mask[i + 2] = on ? 255 : 0
        mask[i + 3] = 255
      }
      const rings = ImageKernels.traceContours(mask as never, obj.width, obj.height, 128)
      ringsToObject(rings, rgb(colour.r, colour.g, colour.b, 1), false)
    }
    return out
  }

  const rings = ImageKernels.traceContours(data, obj.width, obj.height, style.threshold)
  ringsToObject(rings, rgb(26, 28, 32, 1), style.outlineOnly)
  return out
}

/** Trace every selected bitmap in the document, replacing each with vectors. */
export function traceSelection(doc: Document, ids: ID[], styleId: string): { doc: Document; ids: ID[] } {
  const style = IMAGE_TRACE_STYLES.find((s) => s.id === styleId) ?? IMAGE_TRACE_STYLES[0]
  let next = doc
  const created: ID[] = []
  for (const id of ids) {
    const found = findBitmap(next, id)
    if (!found) continue
    const vectors = traceBitmap(found, style)
    if (!vectors.length) continue
    const group = vectors.length > 1 ? createGroup(vectors) : vectors[0]
    group.name = `${found.name} trace`
    group.transform = { ...found.transform }
    next = updateObject(next, found.id, () => group)
    created.push(group.id)
  }
  return { doc: next, ids: created }
}

function findBitmap(doc: Document, id: ID): BitmapObject | null {
  for (const page of doc.pages) {
    for (const layer of page.layers) {
      const found = search(layer.objects as never, id)
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

/* ------------------------------------------------------------- image cache -- */

const imageCache = new Map<string, HTMLImageElement>()

export function getCached(src: string): HTMLImageElement {
  const existing = imageCache.get(src)
  if (existing) return existing
  const img = new Image()
  img.src = src
  imageCache.set(src, img)
  if (imageCache.size > 24) {
    const first = imageCache.keys().next().value
    if (first) imageCache.delete(first)
  }
  return img
}

export function preloadBitmap(obj: BitmapObject): Promise<void> {
  const img = getCached(obj.dataUrl)
  if (img.complete && img.naturalWidth) return Promise.resolve()
  return img.decode().catch(() => undefined)
}
