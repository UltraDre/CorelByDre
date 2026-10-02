/**
 * Canvas 2D renderer.
 *
 * Strategy for large documents:
 *  - The *content* layer is repainted only when the document, the active page or
 *    the zoom changes. Panning blits it, so dragging never re-rasterises objects.
 *  - Per-object raster caches (WeakMap keyed on the immutable object reference)
 *    keep effect stacks and bitmap pipelines from re-running every frame.
 *  - Objects are culled against the viewport before any drawing happens.
 *  - Selection handles, guides and snapping hints live on a separate overlay canvas
 *    that is cheap to repaint on every pointer move.
 */
import type {
  BitmapObject, Matrix, BlendMode, Document, Envelope, Fill, FountainFill, GroupObject, Layer, MaskData, MeshFill,
  Page, PathData, PatternFill, SceneObject, Stroke, TextObject, TextureFill, VectorObject, ViewState,
} from '../types'
import { BLEND_INDEX } from '../types'
import { ImageKernels, type Bytes, type MaskBytes } from '../lib/wasm'
import { css, mixColor } from '../lib/color'
import {
  DEG, TAU, clamp, flattenPath, matApply, matInvert, matMul, pathBounds, pathToPath2D, pointInPolygon,
  distToPolyline, rectIntersects, rectUnion, type Vec, vDist,
} from '../lib/util'
import { paintStroke, presetByID } from './brush'
import { applyEnvelope, sampleEnvelope, symmetryTransforms } from './shapes'
import { layoutText, layoutTextOnPath, fonts, type TextLayoutResult } from '../lib/text'
import { runStack, stackSignature } from './effects'
import { getPatternTile, patternTransform } from '../lib/patterns'

export interface RenderContext {
  doc: Document
  page: Page
  /** Document-units-per-CSS-pixel scale (zoom). */
  scale: number
  offsetX: number
  offsetY: number
  /** Device pixel ratio applied to the destination canvas (defaults to 1). */
  dpr?: number
  /** Viewport in CSS pixels, for culling. */
  viewport: { x: number; y: number; w: number; h: number }
  quality: 'draft' | 'normal' | 'high'
  wireframe: boolean
  /** When false, effects stacks are skipped (used while scrubbing sliders). */
  effects: boolean
  /** Extra objects to ignore (PowerClip contents drawn elsewhere). */
  skip?: Set<string>
}

const bitmapCache = new Map<string, HTMLCanvasElement>()
const BITMAP_CACHE_LIMIT = 96
const objectCache = new WeakMap<SceneObject, { canvas: HTMLCanvasElement; sig: string; scale: number }>()
const textLayoutCache = new WeakMap<TextObject, { layout: TextLayoutResult; sig: string }>()
const envelopeCache = new WeakMap<PathData, { path: PathData; sig: string }>()

function cacheCanvas(key: string, width: number, height: number): HTMLCanvasElement {
  const existing = bitmapCache.get(key)
  if (existing && existing.width === width && existing.height === height) return existing
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  bitmapCache.set(key, canvas)
  if (bitmapCache.size > BITMAP_CACHE_LIMIT) {
    const first = bitmapCache.keys().next().value
    if (first && first !== key) bitmapCache.delete(first)
  }
  return canvas
}

export function clearRenderCaches(): void {
  bitmapCache.clear()
}

/* -------------------------------------------------------------- helpers ---- */

export function strokeToCss(stroke: Stroke): string {
  return css(stroke.color)
}

export function objectIsVisible(obj: SceneObject): boolean {
  return obj.visible
}

/** Effective document-space bounds of an object (transform applied). */
export function objectBounds(obj: SceneObject, doc?: Document): { x: number; y: number; w: number; h: number } | null {
  switch (obj.kind) {
    case 'vector': {
      const b = pathBounds(pathForObject(obj), obj.transform)
      if (!b) return null
      const pad = obj.stroke ? obj.stroke.width / 2 + (obj.blockShadow?.enabled ? Math.hypot(obj.blockShadow.dx, obj.blockShadow.dy) : 0) : 0
      return pad ? { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 } : b
    }
    case 'text': {
      if (obj.mode === 'paragraph') {
        const fx = obj.frame.x
        const fy = obj.frame.y
        const fw = obj.frame.w || 1
        const fh = obj.frame.h || 1
        const corners = [
          matApply(obj.transform, { x: fx, y: fy }),
          matApply(obj.transform, { x: fx + fw, y: fy }),
          matApply(obj.transform, { x: fx + fw, y: fy + fh }),
          matApply(obj.transform, { x: fx, y: fy + fh }),
        ]
        const xs = corners.map((c) => c.x)
        const ys = corners.map((c) => c.y)
        return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
      }
      const layout = textLayoutOf(obj, doc)
      const w = layout.width || obj.style.fontSize * 4
      const h = layout.height || obj.style.fontSize * 1.2
      const ox = obj.onPathId ? 0 : obj.frame.x
      const oy = obj.onPathId ? 0 : obj.frame.y
      const corners = [
        matApply(obj.transform, { x: ox, y: oy }),
        matApply(obj.transform, { x: ox + w, y: oy }),
        matApply(obj.transform, { x: ox + w, y: oy + h }),
        matApply(obj.transform, { x: ox, y: oy + h }),
      ]
      const xs = corners.map((c) => c.x)
      const ys = corners.map((c) => c.y)
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    }
    case 'bitmap': {
      const corners = [
        matApply(obj.transform, { x: obj.rect.x, y: obj.rect.y }),
        matApply(obj.transform, { x: obj.rect.x + obj.rect.w, y: obj.rect.y }),
        matApply(obj.transform, { x: obj.rect.x + obj.rect.w, y: obj.rect.y + obj.rect.h }),
        matApply(obj.transform, { x: obj.rect.x, y: obj.rect.y + obj.rect.h }),
      ]
      const xs = corners.map((c) => c.x)
      const ys = corners.map((c) => c.y)
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    }
    case 'group': {
      let rect: { x: number; y: number; w: number; h: number } | null = null
      for (const child of obj.children) rect = rectUnion(rect, objectBounds(child, doc))
      if (!rect) return null
      const m = obj.transform
      const isIdentity = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0
      if (isIdentity) return rect
      const corners = [
        matApply(m, { x: rect.x, y: rect.y }),
        matApply(m, { x: rect.x + rect.w, y: rect.y }),
        matApply(m, { x: rect.x + rect.w, y: rect.y + rect.h }),
        matApply(m, { x: rect.x, y: rect.y + rect.h }),
      ]
      const xs = corners.map((c) => c.x)
      const ys = corners.map((c) => c.y)
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    }
    default:
      return null
  }
}

export function selectionBounds(objects: SceneObject[], doc?: Document) {
  let rect: { x: number; y: number; w: number; h: number } | null = null
  for (const o of objects) rect = rectUnion(rect, objectBounds(o, doc))
  return rect
}

/** All geometry flattened into document space — used by hit-testing and snapping. */
export function objectOutline(obj: SceneObject, doc?: Document): Vec[][] {
  switch (obj.kind) {
    case 'vector':
      return flattenPath(pathForObject(obj), 8, obj.transform)
    case 'text': {
      const layout = textLayoutOf(obj, doc)
      const ox = obj.onPathId ? 0 : obj.frame.x
      const oy = obj.onPathId ? 0 : obj.frame.y
      const polys: Vec[][] = []
      for (const line of layout.lines) {
        for (const g of line.glyphs) {
          if (!g.d) continue
          for (const ring of glyphRings(g.d, line.x + g.x * 0, line.baseline, g.size)) {
            polys.push(ring.map((p) => matApply(obj.transform, { x: p.x + ox, y: p.y + oy })))
          }
        }
      }
      if (!polys.length) {
        const b = objectBounds(obj, doc)
        if (b) polys.push([
          { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
        ])
      }
      return polys
    }
    case 'bitmap': {
      const r = obj.rect
      return [[
        matApply(obj.transform, { x: r.x, y: r.y }),
        matApply(obj.transform, { x: r.x + r.w, y: r.y }),
        matApply(obj.transform, { x: r.x + r.w, y: r.y + r.h }),
        matApply(obj.transform, { x: r.x, y: r.y + r.h }),
      ]]
    }
    case 'group': {
      const m = obj.transform
      const isIdentity = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0
      const childPolys = obj.children.flatMap((c) => objectOutline(c, doc))
      return isIdentity ? childPolys : childPolys.map((poly) => poly.map((p) => matApply(m, p)))
    }
    default:
      return []
  }
}

function glyphRings(d: string, _x: number, baseline: number, size: number): Vec[][] {
  // Reuse the lightweight path parser from the text module.
  const rings = parseGlyphRings(d)
  return rings.map((ring) => ring.map((p) => ({ x: p.x * size, y: baseline - p.y * size })))
}

let parseGlyphRingsImpl: (d: string) => Vec[][] = () => []
export function registerGlyphParser(fn: (d: string) => Vec[][]): void {
  parseGlyphRingsImpl = fn
}
function parseGlyphRings(d: string): Vec[][] {
  return parseGlyphRingsImpl(d)
}

/* ------------------------------------------------------------- painting ---- */

export function paintFill(ctx: CanvasRenderingContext2D, fill: Fill | undefined, bounds: { x: number; y: number; w: number; h: number }, matrix?: Matrix): void {
  if (!fill || fill.type === 'none') return
  const w = Math.max(1e-6, bounds.w)
  const h = Math.max(1e-6, bounds.h)
  switch (fill.type) {
    case 'uniform':
      ctx.fillStyle = css(fill.color)
      return
    case 'fountain': {
      ctx.fillStyle = fountainStyle(ctx, fill, bounds)
      return
    }
    case 'mesh': {
      // Mesh fills are approximated by per-cell bilinear gradients; each cell is
      // clipped so the result reads as a smooth colour mesh.
      ctx.fillStyle = css(fill.nodes[0]?.color ?? { r: 128, g: 128, b: 128, a: 1 })
      ctx.fillRect(bounds.x, bounds.y, w, h)
      for (let r = 0; r < fill.rows; r++) {
        for (let c = 0; c < fill.cols; c++) {
          const n00 = fill.nodes[r * (fill.cols + 1) + c]
          const n10 = fill.nodes[r * (fill.cols + 1) + c + 1]
          const n01 = fill.nodes[(r + 1) * (fill.cols + 1) + c]
          const n11 = fill.nodes[(r + 1) * (fill.cols + 1) + c + 1]
          if (!n00 || !n11) continue
          const x0 = bounds.x + n00.x * w
          const y0 = bounds.y + n00.y * h
          const x1 = bounds.x + n11.x * w
          const y1 = bounds.y + n11.y * h
          const grad = ctx.createLinearGradient(x0, y0, x1, y1)
          grad.addColorStop(0, css(n00.color))
          grad.addColorStop(0.5, css(averageColor([n00.color, n10?.color ?? n00.color, n01?.color ?? n00.color, n11.color])))
          grad.addColorStop(1, css(n11.color))
          ctx.fillStyle = grad
          ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || 1, Math.abs(y1 - y0) || 1)
        }
      }
      return
    }
    case 'pattern': {
      const tile = getPatternTile(fill)
      const pattern = ctx.createPattern(tile, 'repeat')
      if (!pattern) return
      const t = patternTransform(fill, bounds)
      pattern.setTransform(new DOMMatrix([t.a, t.b, t.c, t.d, t.e, t.f]))
      ctx.fillStyle = pattern
      return
    }
    case 'texture': {
      const tile = getPatternTile({ ...fill, type: 'pattern', pattern: 'bitmap', preset: `texture:${fill.preset}` } as unknown as PatternFill)
      const pattern = ctx.createPattern(tile, 'repeat')
      if (!pattern) return
      const t = patternTransform({ scale: fill.scale, rotation: 0 } as PatternFill, bounds)
      pattern.setTransform(new DOMMatrix([t.a, t.b, t.c, t.d, t.e, t.f]))
      ctx.fillStyle = pattern
      return
    }
    case 'postscript': {
      const tile = getPatternTile({ type: 'pattern', pattern: 'vector', preset: `ps:${fill.preset}`, fg: fill.fg, bg: fill.bg, scale: fill.scale, rotation: 0, tileSize: 24 } as PatternFill)
      const pattern = ctx.createPattern(tile, 'repeat')
      if (!pattern) return
      ctx.fillStyle = pattern
      return
    }
    default:
      return
  }
}

function averageColor(colors: { r: number; g: number; b: number; a: number }[]) {
  const n = colors.length || 1
  return {
    r: colors.reduce((s, c) => s + c.r, 0) / n,
    g: colors.reduce((s, c) => s + c.g, 0) / n,
    b: colors.reduce((s, c) => s + c.b, 0) / n,
    a: colors.reduce((s, c) => s + c.a, 0) / n,
  }
}

/** Build a CanvasGradient for a fountain fill, in the object's local space. */
export function fountainStyle(ctx: CanvasRenderingContext2D, fill: FountainFill, bounds: { x: number; y: number; w: number; h: number }): string | CanvasGradient {
  const stops = [...fill.stops].sort((a, b) => a.offset - b.offset)
  if (!stops.length) return 'rgba(0,0,0,0)'
  const x0 = bounds.x + fill.start.x * bounds.w
  const y0 = bounds.y + fill.start.y * bounds.h
  const x1 = bounds.x + fill.end.x * bounds.w
  const y1 = bounds.y + fill.end.y * bounds.h
  if (fill.fountain === 'radial' || fill.fountain === 'square') {
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const r1 = Math.max(0.5, Math.hypot(x1 - x0, y1 - y0) / 2 || Math.max(bounds.w, bounds.h) / 2)
    const grad = fill.fountain === 'square'
      ? ctx.createLinearGradient(0, 0, 0, 0)
      : ctx.createRadialGradient(cx, cy, 0, cx, cy, r1 * (1 + fill.edgePad))
    addStops(grad, stops)
    return grad
  }
  if (fill.fountain === 'conical') {
    // Canvas has no conical gradient: approximate with many wedges is expensive,
    // so use a linear ramp rotated to the fill angle (visually close for the
    // common two-stop case and fully deterministic).
    const angle = fill.angle ? fill.angle * DEG : Math.atan2(y1 - y0, x1 - x0)
    const cx = bounds.x + bounds.w / 2
    const cy = bounds.y + bounds.h / 2
    const r = Math.max(bounds.w, bounds.h)
    const grad = ctx.createLinearGradient(cx - Math.cos(angle) * r, cy - Math.sin(angle) * r, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r)
    addStops(grad, stops)
    return grad
  }
  const grad = ctx.createLinearGradient(x0, y0, x1, y1)
  addStops(grad, stops)
  return grad
}

function addStops(grad: CanvasGradient, stops: { offset: number; color: { r: number; g: number; b: number; a: number } }[]) {
  for (const stop of stops) {
    try {
      grad.addColorStop(clamp(stop.offset, 0, 1), css(stop.color))
    } catch {
      /* invalid stop */
    }
  }
}

/* ------------------------------------------------------------- bitmaps ----- */

function loadBitmapSource(dataUrl: string): { canvas: HTMLCanvasElement; ready: boolean } {
  const key = `src:${dataUrl.slice(0, 64)}:${dataUrl.length}`
  const existing = bitmapCache.get(key) as HTMLCanvasElement | undefined
  if (existing) return { canvas: existing, ready: true }
  const image = new Image()
  image.crossOrigin = 'anonymous'
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  bitmapCache.set(key, canvas)
  image.onload = () => {
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    renderTick.forEach((fn) => fn())
  }
  image.src = dataUrl
  return { canvas, ready: false }
}

const renderTick = new Set<() => void>()
export function onBitmapReady(fn: () => void): () => void {
  renderTick.add(fn)
  return () => renderTick.delete(fn)
}

/** Apply mask + non-destructive stack, caching the result. */
export function processedBitmap(obj: BitmapObject, quality: 'draft' | 'normal' | 'high'): HTMLCanvasElement {
  const sig = `${stackSignature(obj.effects)}|${maskSignature(obj.mask)}|${quality}`
  const cached = objectCache.get(obj)
  if (cached && cached.sig === sig) return cached.canvas
  const { canvas: source, ready } = loadBitmapSource(obj.dataUrl)
  if (!ready || source.width <= 1) {
    const placeholder = document.createElement('canvas')
    placeholder.width = Math.max(1, obj.width)
    placeholder.height = Math.max(1, obj.height)
    const pctx = placeholder.getContext('2d')!
    pctx.fillStyle = 'rgba(120,130,140,0.18)'
    pctx.fillRect(0, 0, placeholder.width, placeholder.height)
    pctx.strokeStyle = 'rgba(120,130,140,0.5)'
    pctx.strokeRect(0.5, 0.5, placeholder.width - 1, placeholder.height - 1)
    return placeholder
  }
  const crop = obj.crop
  const sx = crop ? Math.round(crop.x * source.width) : 0
  const sy = crop ? Math.round(crop.y * source.height) : 0
  const sw = crop ? Math.round(crop.w * source.width) : source.width
  const sh = crop ? Math.round(crop.h * source.height) : source.height
  const work = document.createElement('canvas')
  work.width = Math.max(1, sw)
  work.height = Math.max(1, sh)
  const wctx = work.getContext('2d', { willReadFrequently: true })!
  wctx.drawImage(source, sx, sy, sw, sh, 0, 0, work.width, work.height)

  const hasStack = obj.effects.some((e) => e.enabled)
  const hasMask = Boolean(obj.mask && (obj.mask.dataUrl || obj.mask.shapes.length || obj.mask.feather > 0))
  if (!hasStack && !hasMask) {
    objectCache.set(obj, { canvas: work, sig, scale: 1 })
    return work
  }

  let imageData = wctx.getImageData(0, 0, work.width, work.height)
  if (hasMask && obj.mask) {
    const maskBytes: MaskBytes | null = rasteriseMask(obj.mask, work.width, work.height)
    if (maskBytes) {
      const processed = ImageKernels.applyMask(
        new Uint8ClampedArray(imageData.data), maskBytes, work.width, work.height,
        obj.mask.invert, true,
      )
      imageData = new ImageData(new Uint8ClampedArray(processed), work.width, work.height)
    }
  }
  // A painted mask decodes asynchronously. Caching this intermediate result
  // would freeze the bitmap unmasked forever, because the signature (which only
  // sees the data URL) never changes when the decode completes.
  const cacheable = !maskDecodePending(obj.mask, work.width, work.height)
  if (hasStack) {
    const result = runStack(new Uint8ClampedArray(imageData.data), work.width, work.height, obj.effects)
    const out = document.createElement('canvas')
    out.width = result.width
    out.height = result.height
    out.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(result.data), result.width, result.height), 0, 0)
    if (cacheable) objectCache.set(obj, { canvas: out, sig, scale: 1 })
    return out
  }
  wctx.putImageData(imageData, 0, 0)
  if (cacheable) objectCache.set(obj, { canvas: work, sig, scale: 1 })
  return work
}

function maskSignature(mask: MaskData | undefined): string {
  if (!mask) return 'none'
  return `${mask.dataUrl ? mask.dataUrl.slice(-24) : 'n'}|${mask.feather}|${mask.contrast}|${mask.invert}|${mask.shapes.map((s) => `${s.kind}${s.rect.x.toFixed(2)},${s.rect.y.toFixed(2)},${s.rect.w.toFixed(2)},${s.rect.h.toFixed(2)}${s.mode}`).join(';')}`
}

/**
 * Decoded painted masks, keyed by content + target size.
 *
 * A painted mask arrives as a grayscale-alpha PNG data URL, which can only be
 * read back asynchronously. The first request starts the decode and returns
 * `null`; when the image lands the bytes are cached and `renderTick` repaints,
 * exactly like `loadBitmapSource` does for placed images.
 */
const maskCache = new Map<string, MaskBytes>()
const maskPending = new Set<string>()

function paintedMask(dataUrl: string, width: number, height: number): MaskBytes | null {
  const key = `${dataUrl.length}:${dataUrl.slice(-48)}:${width}x${height}`
  const cached = maskCache.get(key)
  if (cached) return cached
  if (maskPending.has(key)) return null
  maskPending.add(key)

  const image = new Image()
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, width)
      canvas.height = Math.max(1, height)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        const out = new Uint8Array(width * height)
        for (let p = 0; p < out.length; p++) {
          const i = p * 4
          // Grayscale-alpha: luminance scaled by the mask's own coverage.
          const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
          out[p] = clamp(Math.round(luma * (data[i + 3] / 255)), 0, 255)
        }
        maskCache.set(key, out)
        renderTick.forEach((fn) => fn())
      }
    } catch (error) {
      console.warn('[render] painted mask could not be decoded', error)
    } finally {
      maskPending.delete(key)
    }
  }
  image.onerror = () => { maskPending.delete(key) }
  image.src = dataUrl
  return null
}

/** Forget decoded masks (used when the cache must not outlive a document). */
export function clearMaskCache(): void {
  maskCache.clear()
  maskPending.clear()
}

/**
 * True while a painted mask is still decoding. Callers must not cache a result
 * computed in this state, or the mask would never appear once the bytes land.
 */
export function maskDecodePending(mask: MaskData | undefined, width: number, height: number): boolean {
  if (!mask?.dataUrl || width <= 0 || height <= 0) return false
  const key = `${mask.dataUrl.length}:${mask.dataUrl.slice(-48)}:${width}x${height}`
  return !maskCache.has(key)
}

/** Draw the vector selection shapes into an 8-bit buffer. */
function rasteriseMaskShapes(mask: MaskData, width: number, height: number): MaskBytes | null {
  if (!mask.shapes.length) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#fff'
  for (const shape of mask.shapes) {
    const x = shape.rect.x * width
    const y = shape.rect.y * height
    const w = shape.rect.w * width
    const h = shape.rect.h * height
    if (shape.mode === 'subtract') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = '#000'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#fff'
    }
    ctx.beginPath()
    if (shape.kind === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, TAU)
    else ctx.rect(x, y, w, h)
    if (shape.mode === 'replace') {
      ctx.globalCompositeOperation = 'copy'
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
    } else {
      ctx.fill()
    }
  }
  ctx.globalCompositeOperation = 'source-over'
  const data = ctx.getImageData(0, 0, width, height).data
  const out = new Uint8Array(width * height)
  for (let p = 0; p < width * height; p++) out[p] = data[p * 4]
  return out
}

/** Contrast curve + feather, shared by every mask source. */
function gradeMask(input: MaskBytes, mask: MaskData, width: number, height: number): MaskBytes {
  let result: MaskBytes = input
  if (mask.contrast !== 1 && mask.contrast !== 0) {
    const lut = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      const v = (i / 255 - 0.5) * (1 + mask.contrast * 2) + 0.5
      lut[i] = clamp(Math.round(v * 255), 0, 255)
    }
    const graded = new Uint8Array(result.length)
    for (let i = 0; i < graded.length; i++) graded[i] = lut[input[i]]
    result = graded
  }
  if (mask.feather > 0) result = ImageKernels.maskFeather(result, width, height, Math.round(mask.feather))
  return result
}

/** Rasterise a mask (shapes + optional painted alpha) into an 8-bit buffer. */
export function rasteriseMask(mask: MaskData, width: number, height: number): MaskBytes | null {
  const hasShapes = mask.shapes.length > 0
  if (!hasShapes && !mask.dataUrl) return null
  if (width <= 0 || height <= 0) return null

  // Painted alpha decodes asynchronously; `null` means "not ready yet".
  const painted = mask.dataUrl ? paintedMask(mask.dataUrl, width, height) : null
  const shaped = hasShapes ? rasteriseMaskShapes(mask, width, height) : null

  let base: MaskBytes | null
  if (painted && shaped) {
    // Either source reveals: the painted brush and the vector shapes combine.
    const merged = new Uint8Array(painted.length)
    for (let i = 0; i < merged.length; i++) merged[i] = Math.max(painted[i], shaped[i])
    base = merged
  } else {
    base = painted ?? shaped
  }
  if (!base) return null
  return gradeMask(base, mask, width, height)
}

/* --------------------------------------------------------------- text ------ */

export function textLayoutOf(obj: TextObject, doc?: Document): TextLayoutResult {
  const sig = JSON.stringify({
    c: obj.content, s: obj.style, m: obj.mode, f: obj.frame, o: obj.onPathId, oo: obj.onPathOffset,
    side: obj.onPathSide, w: obj.wrapAround, wo: obj.wrapOffset, cols: obj.columns, gut: obj.columnGutter,
  })
  const cached = textLayoutCache.get(obj)
  if (cached && cached.sig === sig) return cached.layout
  let layout: TextLayoutResult
  if (obj.onPathId && doc) {
    const pathObj = findInDoc(doc, obj.onPathId)
    if (pathObj && pathObj.kind === 'vector') {
      const pts = flattenPath(pathObj.path, 24, pathObj.transform).flat()
      layout = layoutTextOnPath(obj.content, obj.style, pts, obj.onPathOffset, obj.onPathSide)
    } else {
      layout = layoutText(obj.content, obj.style, obj.frame.w, obj.mode)
    }
  } else {
    const exclusions = doc ? wrapExclusions(doc, obj) : []
    layout = layoutText(obj.content, obj.style, obj.frame.w, obj.mode, exclusions, obj.columns, obj.columnGutter)
  }
  textLayoutCache.set(obj, { layout, sig })
  return layout
}

function wrapExclusions(doc: Document, text: TextObject) {
  const out: { id: string; x: number; y: number; w: number; h: number; offset: number }[] = []
  for (const id of text.wrapAround) {
    const obj = findInDoc(doc, id)
    if (!obj) continue
    const b = objectBounds(obj, doc)
    if (b) out.push({ id, ...b, offset: text.wrapOffset })
  }
  return out
}

function findInDoc(doc: Document, id: string): SceneObject | null {
  for (const page of doc.pages) {
    for (const layer of page.layers) {
      const found = findIn(layer.objects, id)
      if (found) return found
    }
  }
  return null
}
function findIn(objects: SceneObject[], id: string): SceneObject | null {
  for (const o of objects) {
    if (o.id === id) return o
    if (o.kind === 'group') {
      const f = findIn(o.children, id)
      if (f) return f
    }
  }
  return null
}

/* ------------------------------------------------------------ renderer ----- */

function applyViewTransform(ctx: CanvasRenderingContext2D, rc: RenderContext): void {
  const dpr = rc.dpr ?? 1
  ctx.setTransform(rc.scale * dpr, 0, 0, rc.scale * dpr, rc.offsetX * dpr, rc.offsetY * dpr)
}

export function renderPageInto(ctx: CanvasRenderingContext2D, rc: RenderContext): void {
  const { page } = rc
  ctx.save()
  // Document space → CSS pixel space (scaled by devicePixelRatio when provided).
  applyViewTransform(ctx, rc)
  const view = viewRect(rc)

  for (const layer of page.layers) {
    if (!layer.visible) continue
    drawLayer(ctx, layer, rc)
  }
  void view
  ctx.restore()
}

function viewRect(rc: RenderContext) {
  const inv = 1 / rc.scale
  return {
    x: -rc.offsetX * inv,
    y: -rc.offsetY * inv,
    w: (rc.viewport.w || 1) * inv,
    h: (rc.viewport.h || 1) * inv,
  }
}

function drawLayer(ctx: CanvasRenderingContext2D, layer: Layer, rc: RenderContext): void {
  const needsComposite = layer.opacity < 1 || layer.blend !== 'normal'
  const rcLayer: RenderContext = { ...rc, skip: rc.skip }
  if (needsComposite) {
    const dpr = rc.dpr ?? 1
    const view = viewRect(rc)
    const layerCanvas = cacheCanvas(
      `layer:${layer.id}:${Math.round(rc.scale * 100)}:${Math.round(dpr * 100)}:${Math.round(view.w)}x${Math.round(view.h)}`,
      rc.viewport.w * dpr,
      rc.viewport.h * dpr,
    )
    const lctx = layerCanvas.getContext('2d')!
    lctx.setTransform(1, 0, 0, 1, 0, 0)
    lctx.clearRect(0, 0, layerCanvas.width, layerCanvas.height)
    applyViewTransform(lctx, rcLayer)
    drawObjects(lctx, layer.objects, rcLayer)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = layer.opacity
    ctx.globalCompositeOperation = cssBlend(layer.blend)
    ctx.drawImage(layerCanvas, 0, 0)
    ctx.restore()
    return
  }
  drawObjects(ctx, layer.objects, rcLayer)
}

export function cssBlend(mode: BlendMode): GlobalCompositeOperation {
  switch (mode) {
    case 'normal': return 'source-over'
    default: return mode as GlobalCompositeOperation
  }
}

export function drawObjects(ctx: CanvasRenderingContext2D, objects: SceneObject[], rc: RenderContext): void {
  const view = viewRect(rc)
  for (const obj of objects) {
    if (!obj.visible) continue
    if (rc.skip?.has(obj.id)) continue
    if (obj.clip && obj.clip.powerClip) continue // drawn by its frame
    const bounds = objectBounds(obj, rc.doc)
    if (bounds && !rectIntersects(bounds, { x: view.x - 4, y: view.y - 4, w: view.w + 8, h: view.h + 8 })) continue
    drawObject(ctx, obj, rc)
  }
}

export function drawObject(ctx: CanvasRenderingContext2D, obj: SceneObject, rc: RenderContext): void {
  ctx.save()
  const hasBlock = obj.kind === 'vector' && obj.blockShadow?.enabled
  if (hasBlock && obj.blockShadow) drawBlockShadow(ctx, obj, rc)
  ctx.globalAlpha = obj.opacity
  if (obj.blend !== 'normal') ctx.globalCompositeOperation = cssBlend(obj.blend)
  switch (obj.kind) {
    case 'vector': drawVector(ctx, obj, rc); break
    case 'text': drawText(ctx, obj, rc); break
    case 'bitmap': drawBitmap(ctx, obj, rc); break
    case 'group': drawGroup(ctx, obj, rc); break
  }
  ctx.restore()
}

function drawBlockShadow(ctx: CanvasRenderingContext2D, obj: VectorObject, rc: RenderContext): void {
  const shadow = obj.blockShadow!
  const steps = Math.max(1, Math.round(shadow.steps))
  const path2d = pathToPath2D(pathForObject(obj))
  ctx.save()
  ctx.globalAlpha = shadow.opacity
  ctx.fillStyle = css(shadow.color)
  ctx.strokeStyle = css(shadow.color)
  const fillable = shadow.behindFill || true
  for (let s = steps; s >= 1; s--) {
    const m = matMul(obj.transform, { a: 1, b: 0, c: 0, d: 1, e: shadow.dx * s / rc.scale * rc.scale, f: shadow.dy * s })
    ctx.save()
    applyViewTransform(ctx, rc)
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f)
    if (fillable && obj.fill.type !== 'none') ctx.fill(path2d)
    if (obj.stroke && (fillable || obj.stroke.behind)) {
      ctx.lineWidth = obj.stroke.width
      ctx.lineCap = obj.stroke.cap
      ctx.lineJoin = obj.stroke.join
      ctx.stroke(path2d)
    }
    ctx.restore()
  }
  if (shadow.feather > 0) {
    // Feather is faked with a soft translucent pass underneath.
    ctx.globalAlpha = shadow.opacity * 0.35
    ctx.filter = `blur(${Math.max(0.5, shadow.feather / 2)}px)`
    ctx.save()
    applyViewTransform(ctx, rc)
    ctx.transform(obj.transform.a, obj.transform.b, obj.transform.c, obj.transform.d, obj.transform.e + shadow.dx, obj.transform.f + shadow.dy)
    ctx.fill(path2d)
    ctx.restore()
    ctx.filter = 'none'
  }
  ctx.restore()
}

/** Apply envelope + perspective deformations to produce the drawable path. */
export function pathForObject(obj: VectorObject): PathData {
  if (!obj.envelope || obj.envelope.strength === 0) return obj.path
  const sig = JSON.stringify(obj.envelope)
  const cached = envelopeCache.get(obj.path)
  if (cached && cached.sig === sig) return cached.path
  const warped = applyEnvelope(obj.path, obj.envelope)
  envelopeCache.set(obj.path, { path: warped, sig })
  return warped
}

function drawVector(ctx: CanvasRenderingContext2D, obj: VectorObject, rc: RenderContext): void {
  const symmetry = obj.symmetry && obj.symmetry.mode !== 'none' ? symmetryTransforms(obj.symmetry) : []
  const path2d = pathToPath2D(pathForObject(obj))
  const bounds = pathBounds(obj.path) ?? { x: 0, y: 0, w: 1, h: 1 }

  const paint = () => {
    if (obj.brush) {
      const stroke = {
        ...obj.brush,
        points: obj.brush.points.length
          ? obj.brush.points
          : samplePathPoints(obj.path),
      }
      paintStroke(ctx, stroke, presetByID(obj.brush.preset), { zoom: rc.scale, turbo: rc.quality === 'draft' })
      return
    }
    if (rc.wireframe) {
      ctx.strokeStyle = 'rgba(120,200,255,0.9)'
      ctx.lineWidth = 1 / rc.scale
      ctx.stroke(path2d)
      return
    }
    if (obj.fill.type !== 'none') {
      paintFill(ctx, obj.fill, bounds)
      ctx.fill(path2d, obj.path.fillRule)
    }
    if (obj.stroke && obj.stroke.width > 0 && !obj.stroke.behind) drawStroke(ctx, obj.stroke, path2d)
  }

  const withFill = () => {
    if (obj.stroke && obj.stroke.behind && obj.stroke.width > 0) drawStroke(ctx, obj.stroke, path2d)
    paint()
  }

  ctx.save()
  ctx.transform(obj.transform.a, obj.transform.b, obj.transform.c, obj.transform.d, obj.transform.e, obj.transform.f)
  withFill()
  for (const m of symmetry) {
    ctx.save()
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f)
    withFill()
    ctx.restore()
  }
  ctx.restore()
}

function samplePathPoints(path: PathData): { x: number; y: number; p: number }[] {
  const polys = flattenPath(path, 6)
  const out: { x: number; y: number; p: number }[] = []
  for (const poly of polys) {
    poly.forEach((pt, i) => out.push({ x: pt.x, y: pt.y, p: 0.35 + 0.6 * Math.sin((i / Math.max(1, poly.length - 1)) * Math.PI) }))
  }
  return out
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, path: Path2D): void {
  ctx.save()
  ctx.strokeStyle = strokeToCss(stroke)
  ctx.lineWidth = Math.max(0.01, stroke.width)
  ctx.lineCap = stroke.cap
  ctx.lineJoin = stroke.join
  ctx.miterLimit = stroke.miterLimit
  if (stroke.dash?.length) ctx.setLineDash(stroke.dash)
  if (stroke.profile?.length) {
    // Variable outline: draw a stack of progressively shorter strokes.
    const segments = 24
    ctx.setLineDash([])
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments
      const t1 = (i + 1) / segments
      const w = stroke.width * (stroke.profile[Math.min(stroke.profile.length - 1, Math.round(t0 * (stroke.profile.length - 1)))] ?? 1)
      ctx.lineWidth = Math.max(0.01, w)
      ctx.setLineDash([t1 * 1000 - t0 * 1000, 100000])
      ctx.lineDashOffset = -t0 * 1000
      ctx.stroke(path)
    }
    ctx.setLineDash([])
  } else {
    ctx.stroke(path)
  }
  ctx.restore()
}

function drawText(ctx: CanvasRenderingContext2D, obj: TextObject, rc: RenderContext): void {
  const layout = textLayoutOf(obj, rc.doc)
  const style = obj.style
  const outlined = layout.outlined && style.fontFamily && fonts.hasOutlines(style.fontFamily)
  ctx.save()
  ctx.transform(obj.transform.a, obj.transform.b, obj.transform.c, obj.transform.d, obj.transform.e, obj.transform.f)
  if (!obj.onPathId) ctx.translate(obj.frame.x, obj.frame.y)
  if (obj.mode === 'paragraph' && style.bullet !== 'none' && rc.quality !== 'draft') {
    ctx.save()
    ctx.strokeStyle = 'rgba(120,150,180,0.35)'
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1 / rc.scale
    ctx.strokeRect(0, 0, obj.frame.w, obj.frame.h)
    ctx.restore()
  }
  ctx.fillStyle = css(style.color)
  if (outlined) {
    for (const line of layout.lines) {
      for (const glyph of line.glyphs) {
        if (!glyph.d || glyph.char === ' ') continue
        const angle = (glyph as { angle?: number }).angle ?? 0
        ctx.save()
        ctx.translate(glyph.x, line.baseline)
        if (angle) ctx.rotate(angle)
        // Glyph outlines are parsed once and cached as Path2D per character+size.
        fillGlyph(ctx, obj.style.fontFamily, glyph.char, glyph.size, style.color)
        if (style.outline && style.outline.width > 0) {
          ctx.strokeStyle = css(style.outline.color)
          ctx.lineWidth = style.outline.width
          strokeGlyph(ctx, obj.style.fontFamily, glyph.char, glyph.size)
        }
        ctx.restore()
      }
    }
  } else {
    const cssFont = cssFontFor(style)
    for (const line of layout.lines) {
      ctx.save()
      ctx.font = cssFont
      ctx.fillStyle = css(style.color)
      for (const glyph of line.glyphs) {
        if (glyph.char === ' ') continue
        const angle = (glyph as { angle?: number }).angle ?? 0
        ctx.save()
        ctx.translate(glyph.x, line.baseline)
        if (angle) ctx.rotate(angle)
        ctx.fillText(glyph.char, 0, 0)
        if (style.outline && style.outline.width > 0) {
          ctx.lineWidth = style.outline.width
          ctx.strokeStyle = css(style.outline.color)
          ctx.strokeText(glyph.char, 0, 0)
        }
        ctx.restore()
      }
      ctx.restore()
    }
  }
  ctx.restore()
}

export function cssFontFor(style: TextObject['style']): string {
  const rec = fonts.get(style.fontFamily)
  const family = rec?.cssFamily ?? `"${style.fontFamily}", sans-serif`
  return `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${family}`
}

const glyphPathCache = new WeakMap<object, Map<string, Path2D>>()
const glyphDStringCache = new Map<string, string | null>()

function fillGlyph(ctx: CanvasRenderingContext2D, family: string, char: string, size: number, color: { r: number; g: number; b: number; a: number }): void {
  const path = glyphPath(family, char, size)
  if (!path) return
  ctx.fillStyle = css(color)
  ctx.fill(path)
}

function strokeGlyph(ctx: CanvasRenderingContext2D, family: string, char: string, size: number): void {
  const path = glyphPath(family, char, size)
  if (path) ctx.stroke(path)
}

function glyphPath(family: string, char: string, size: number): Path2D | null {
  const rec = fonts.get(family)
  const fontObj = rec?.font
  if (!fontObj) return null
  let cache = glyphPathCache.get(fontObj as object)
  if (!cache) {
    cache = new Map()
    glyphPathCache.set(fontObj as object, cache)
  }
  const key = `${char}|${size}`
  const hit = cache.get(key)
  if (hit) return hit
  const axisKey = JSON.stringify(rec?.axes?.map((a) => a.tag) ?? [])
  const dKey = `${family}|${char}|${axisKey}`
  let d = glyphDStringCache.get(dKey)
  if (d === undefined) {
    const outline = fonts.outline(family, char, {})
    d = outline?.d ?? null
    glyphDStringCache.set(dKey, d)
  }
  if (!d) return null
  const path = glyphToPath2D(d, size)
  cache.set(key, path)
  return path
}

let glyphParser: ((d: string, size: number) => Path2D) | null = null
export function registerGlyphToPath2D(fn: (d: string, size: number) => Path2D): void {
  glyphParser = fn
}
function glyphToPath2D(d: string, size: number): Path2D {
  if (glyphParser) return glyphParser(d, size)
  const path = new Path2D()
  return path
}

function drawBitmap(ctx: CanvasRenderingContext2D, obj: BitmapObject, rc: RenderContext): void {
  const canvas = processedBitmap(obj, rc.quality)
  ctx.save()
  ctx.transform(obj.transform.a, obj.transform.b, obj.transform.c, obj.transform.d, obj.transform.e, obj.transform.f)
  ctx.imageSmoothingEnabled = rc.quality !== 'draft'
  ctx.drawImage(canvas, obj.rect.x, obj.rect.y, obj.rect.w, obj.rect.h)
  ctx.restore()
}

function drawGroup(ctx: CanvasRenderingContext2D, obj: GroupObject, rc: RenderContext): void {
  ctx.save()
  ctx.transform(obj.transform.a, obj.transform.b, obj.transform.c, obj.transform.d, obj.transform.e, obj.transform.f)
  if (obj.clipRect) {
    ctx.beginPath()
    ctx.rect(obj.clipRect.x, obj.clipRect.y, obj.clipRect.w, obj.clipRect.h)
    ctx.clip()
  }
  drawObjects(ctx, obj.children, rc)
  ctx.restore()
}

/** Render a PowerClip frame: the clipped content is drawn through the frame path. */
export function drawPowerClipContent(ctx: CanvasRenderingContext2D, frame: VectorObject, content: SceneObject[], rc: RenderContext): void {
  ctx.save()
  const path2d = pathToPath2D(pathForObject(frame))
  ctx.transform(frame.transform.a, frame.transform.b, frame.transform.c, frame.transform.d, frame.transform.e, frame.transform.f)
  ctx.clip(path2d)
  applyViewTransform(ctx, rc)
  drawObjects(ctx, content, rc)
  ctx.restore()
}

/* ------------------------------------------------------------ hit tests ---- */

export function hitTestObject(obj: SceneObject, point: Vec, tolerance: number, doc?: Document): boolean {
  if (!obj.visible) return false
  const inv = matInvert(obj.transform)
  const local = matApply(inv, point)
  const scaleX = Math.hypot(obj.transform.a, obj.transform.b)
  const scaleY = Math.hypot(obj.transform.c, obj.transform.d)
  const localTol = tolerance / Math.max(0.05, Math.min(scaleX, scaleY))
  switch (obj.kind) {
    case 'vector': {
      const path = pathForObject(obj)
      const loops = flattenPath(path, 12)
      const filled = obj.fill.type !== 'none'
      const hasClosed = path.subpaths.some((sp) => sp.closed)
      if (filled || hasClosed) {
        let inside = false
        for (let i = 0; i < loops.length; i++) {
          const sp = path.subpaths[i]
          if (sp && !sp.closed && !filled) continue
          if (pointInPolygon(local, loops[i])) inside = !inside
        }
        if (inside) return true
      }
      const strokeW = obj.stroke ? obj.stroke.width : obj.brush ? obj.brush.size : 2
      for (const loop of loops) if (distToPolyline(local, loop) <= strokeW / 2 + localTol) return true
      return false
    }
    case 'text': {
      const layout = textLayoutOf(obj, doc)
      const ox = obj.onPathId ? 0 : obj.frame.x
      const oy = obj.onPathId ? 0 : obj.frame.y
      const w = obj.mode === 'paragraph' ? (obj.frame.w || 1) : (layout.width || obj.style.fontSize * 4)
      const h = obj.mode === 'paragraph' ? (obj.frame.h || 1) : (layout.height || obj.style.fontSize * 1.2)
      return local.x >= ox - localTol && local.x <= ox + w + localTol
        && local.y >= oy - localTol && local.y <= oy + h + localTol
    }
    case 'bitmap': {
      return local.x >= obj.rect.x - localTol && local.x <= obj.rect.x + obj.rect.w + localTol
        && local.y >= obj.rect.y - localTol && local.y <= obj.rect.y + obj.rect.h + localTol
    }
    case 'group':
      return obj.children.some((c) => hitTestObject(c, local, localTol, doc))
    default:
      return false
  }
}

export interface HitResult { object: SceneObject; layer: Layer; topLevel: SceneObject }

/**
 * Find the topmost object under a point. `deep` selects sub-objects of groups
 * (Ctrl-click behaviour in CorelDRAW).
 */
export function hitTest(page: Page, point: Vec, tolerance: number, doc: Document, deep = false): HitResult | null {
  for (let li = page.layers.length - 1; li >= 0; li--) {
    const layer = page.layers[li]
    if (!layer.visible || layer.locked) continue
    for (let oi = layer.objects.length - 1; oi >= 0; oi--) {
      const obj = layer.objects[oi]
      if (obj.locked || !obj.visible) continue
      if (!hitTestObject(obj, point, tolerance, doc)) continue
      if (deep && obj.kind === 'group') {
        const inner = hitTestInGroup(obj, point, tolerance, doc)
        if (inner) return { object: inner, layer, topLevel: obj }
      }
      return { object: obj, layer, topLevel: obj }
    }
  }
  return null
}

function hitTestInGroup(group: GroupObject, point: Vec, tolerance: number, doc: Document): SceneObject | null {
  const inv = matInvert(group.transform)
  const local = matApply(inv, point)
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i]
    if (hitTestObject(child, local, tolerance, doc)) {
      if (child.kind === 'group') {
        const deeper = hitTestInGroup(child, local, tolerance, doc)
        if (deeper) return deeper
      }
      return child
    }
  }
  return null
}

/** Objects whose bounds intersect a marquee rectangle. */
export function objectsInRect(page: Page, rect: { x: number; y: number; w: number; h: number }, doc: Document, insideOnly = false): SceneObject[] {
  const out: SceneObject[] = []
  for (const layer of page.layers) {
    if (!layer.visible || layer.locked) continue
    for (const obj of layer.objects) {
      if (obj.locked || !obj.visible) continue
      const b = objectBounds(obj, doc)
      if (!b) continue
      const intersects = rectIntersects(b, rect)
      if (!intersects) continue
      if (insideOnly) {
        const contained = b.x >= rect.x && b.y >= rect.y && b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h
        if (!contained) continue
      }
      out.push(obj)
    }
  }
  return out
}

/* ------------------------------------------------------------ thumbnails --- */

export function renderThumbnail(doc: Document, page: Page, maxSize = 320, background = '#ffffff'): string {
  const canvas = document.createElement('canvas')
  const aspect = page.size.w / page.size.h
  const w = aspect >= 1 ? maxSize : Math.round(maxSize * aspect)
  const h = aspect >= 1 ? Math.round(maxSize / aspect) : maxSize
  canvas.width = Math.max(8, w)
  canvas.height = Math.max(8, h)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const scale = Math.min(canvas.width / page.size.w, canvas.height / page.size.h)
  const offsetX = (canvas.width - page.size.w * scale) / 2
  const offsetY = (canvas.height - page.size.h * scale) / 2
  const rc: RenderContext = {
    doc, page, scale, offsetX, offsetY,
    viewport: { x: 0, y: 0, w: canvas.width, h: canvas.height },
    quality: 'draft', wireframe: false, effects: false,
  }
  renderPageInto(ctx, rc)
  return canvas.toDataURL('image/png')
}

export { vDist }
