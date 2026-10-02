/**
 * PHOTO-PAINT: the pixel-editing layer on top of a CorelByDre document.
 *
 * Everything here is a deterministic, closed-form operator — flood-fill based
 * background removal, edge-aware masks, convolution retouching, displacement
 * warps. There is no machine-learning step anywhere: "select subject" resolves
 * the background by sampling the frame border and growing a colour-similarity
 * mask, which is exactly reproducible for the same pixels and parameters.
 */
import type { Adjustment, BlendMode, Effect, RGBA } from '../types'
import { clamp, lerp, makeRng, type Vec } from './util'
import { rgb, rgbToHsv } from './color'
import { ImageKernels, imageDataToBytes, bytesToImageData, type Bytes, type MaskBytes } from './wasm'
import { applyAdjustment, defaultParams, runStack, stackSignature } from '../engine/effects'
import { homographyFromQuad } from '../engine/shapes'
import { uid } from './util'

/* ======================================================= photo document ==== */

export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect'

export interface Selection {
  mask: MaskBytes
  w: number
  h: number
  active: boolean
  /** How the next selection operation combines with this one. */
  mode: SelectionMode
  /** 0 = hard edge, 1 = fully soft. */
  feather: number
  inverted: boolean
  bounds: { x: number; y: number; w: number; h: number } | null
}

export interface PhotoDocument {
  id: string
  name: string
  w: number
  h: number
  /** Straight RGBA pixels, premultiplied nowhere — plain 8-bit sRGB. */
  data: Bytes
  /** Document alpha. `null` means fully opaque. */
  mask: MaskBytes | null
  selection: Selection
  adjustments: Adjustment[]
  effects: Effect[]
  history: { data: Bytes; mask: MaskBytes | null; label: string }[]
  future: { data: Bytes; mask: MaskBytes | null; label: string }[]
  dirty: boolean
}

export function createPhotoDocument(w: number, h: number, data?: Bytes, name = 'Photo'): PhotoDocument {
  const pixels = data && data.length >= w * h * 4 ? data : new Uint8ClampedArray(w * h * 4)
  return {
    id: uid('photo'),
    name,
    w,
    h,
    data: pixels as Bytes,
    mask: null,
    selection: emptySelection(w, h),
    adjustments: [],
    effects: [],
    history: [],
    future: [],
    dirty: false,
  }
}

export function photoSnapshot(doc: PhotoDocument, label: string, max = 40): void {
  doc.history.push({ data: doc.data.slice(), mask: doc.mask ? doc.mask.slice() : null, label })
  if (doc.history.length > max) doc.history.shift()
  doc.future = []
  doc.dirty = true
}

export function photoCanUndo(doc: PhotoDocument): boolean {
  return doc.history.length > 0
}

export function photoCanRedo(doc: PhotoDocument): boolean {
  return doc.future.length > 0
}

export function photoUndo(doc: PhotoDocument): string | null {
  const entry = doc.history.pop()
  if (!entry) return null
  doc.future.push({ data: doc.data.slice(), mask: doc.mask ? doc.mask.slice() : null, label: entry.label })
  doc.data = entry.data
  doc.mask = entry.mask
  return entry.label
}

export function photoRedo(doc: PhotoDocument): string | null {
  const entry = doc.future.pop()
  if (!entry) return null
  doc.history.push({ data: doc.data.slice(), mask: doc.mask ? doc.mask.slice() : null, label: entry.label })
  doc.data = entry.data
  doc.mask = entry.mask
  return entry.label
}

export function photoToCanvas(doc: PhotoDocument, applyStack = true): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = doc.w
  canvas.height = doc.h
  const ctx = canvas.getContext('2d')!
  const pixels = applyStack ? renderedPhoto(doc) : doc.data
  ctx.putImageData(bytesToImageData(pixels, doc.w, doc.h), 0, 0)
  return canvas
}

/** Run the non-destructive stack plus the document mask. */
export function renderedPhoto(doc: PhotoDocument): Bytes {
  let data = doc.data
  const stack = [...doc.adjustments, ...doc.effects]
  if (stack.length) data = runStack(data.slice(), doc.w, doc.h, stack).data
  if (doc.mask) data = ImageKernels.applyMask(data, doc.mask, doc.w, doc.h, false, true)
  return data
}

export function photoDataUrl(doc: PhotoDocument, mime = 'image/png', applyStack = true): string {
  return photoToCanvas(doc, applyStack).toDataURL(mime)
}

export async function photoFromDataUrl(dataUrl: string, name = 'Photo'): Promise<PhotoDocument> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = dataUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return createPhotoDocument(canvas.width, canvas.height, imageDataToBytes(imgData), name)
}

export function photoSignature(doc: PhotoDocument): string {
  const stack = [...doc.adjustments, ...doc.effects]
  return `${doc.w}x${doc.h}|${stack.length ? stackSignature(stack) : 'none'}|${doc.mask ? 'masked' : 'plain'}`
}

/* ========================================================= presets ========= */

export interface PhotoPreset {
  id: string
  label: string
  group: 'Fix' | 'Light' | 'Colour' | 'Curves' | 'Tone'
  hint: string
  build: () => Adjustment[]
}

export const PHOTO_PRESETS: PhotoPreset[] = [
  { id: 'smart-fix', label: 'One-step photo fix', group: 'Fix', hint: 'Levels stretch plus mild vibrance and sharpening — deterministic, reversible.', build: () => [adj('levels', { inBlack: 4, inWhite: 250, gamma: 1.02 }), adj('vibrance', { amount: 0.18 }), adj('brightness-contrast', { contrast: 0.08, saturation: 1.04 })] },
  { id: 'auto-level', label: 'Auto level', group: 'Fix', hint: 'Clips 0.5 % from each end of the tone range.', build: () => [adj('levels', { inBlack: 6, inWhite: 249, gamma: 1 })] },
  { id: 'hue-curve', label: 'Hue curve', group: 'Colour', hint: 'Rotate hue and scale saturation around a custom curve.', build: () => [adj('hue-curve', { deg: 0, sat: 1, light: 0 })] },
  { id: 'tone-curve', label: 'Tone curve', group: 'Tone', hint: 'Natural cubic spline; drag control points in the editor.', build: () => [adj('tone-curve', { points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }], channel: 'rgb' })] },
  { id: 's-curve', label: 'Contrast S-curve', group: 'Tone', hint: 'Classic film S with lifted toe and rolled highlights.', build: () => [adj('tone-curve', { points: [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.84 }, { x: 1, y: 1 }] })] },
  { id: 'matte', label: 'Matte film', group: 'Tone', hint: 'Lifted blacks with slightly crushed highlights.', build: () => [adj('tone-curve', { points: [{ x: 0, y: 0.08 }, { x: 0.4, y: 0.44 }, { x: 1, y: 0.96 }] })] },
  { id: 'warm-light', label: 'Warm light', group: 'Light', hint: 'Golden-hour colour balance and a soft glow.', build: () => [adj('color-balance', { cR: 0.12, mG: -0.02, yB: -0.16 }), adj('brightness-contrast', { brightness: 0.03, contrast: 0.05 })] },
  { id: 'cool-shade', label: 'Cool shade', group: 'Light', hint: 'Blue-shifted white balance for shade and overcast light.', build: () => [adj('color-balance', { cR: -0.1, mG: 0, yB: 0.14 })] },
  { id: 'punch', label: 'High contrast punch', group: 'Light', hint: 'Strong clarity with protected highlights.', build: () => [adj('tone-curve', { points: [{ x: 0, y: 0 }, { x: 0.3, y: 0.22 }, { x: 0.7, y: 0.78 }, { x: 1, y: 1 }] }), adj('vibrance', { amount: 0.3 })] },
  { id: 'skin-soft', label: 'Soft skin', group: 'Colour', hint: 'Gentle desaturation of reds with a lift in the midtones.', build: () => [adj('selective-color', { range: 'reds', c: -0.05, m: -0.08, y: 0.04, k: 0 }), adj('brightness-contrast', { brightness: 0.04, contrast: -0.06 })] },
  { id: 'vivid-landscape', label: 'Vivid landscape', group: 'Colour', hint: 'Deep blues, vivid greens, restrained highlights.', build: () => [adj('selective-color', { range: 'blues', c: 0.06, k: 0.05 }), adj('selective-color', { range: 'greens', c: 0.04, y: -0.06 }), adj('vibrance', { amount: 0.28 })] },
  { id: 'mono-contrast', label: 'Mono with contrast filter', group: 'Colour', hint: 'Red-filter monochrome with a deep tone curve.', build: () => [adj('channel-mixer', { rr: 0.62, rg: 0.31, rb: 0.07, gr: 0.62, gg: 0.31, gb: 0.07, br: 0.62, bg: 0.31, bb: 0.07, mono: true }), adj('tone-curve', { points: [{ x: 0, y: 0 }, { x: 0.35, y: 0.28 }, { x: 0.7, y: 0.78 }, { x: 1, y: 1 }] })] },
  { id: 'bleach-bypass', label: 'Bleach bypass', group: 'Tone', hint: 'Retains silver contrast with washed colour.', build: () => [adj('channel-mixer', { rr: 0.7, rg: 0.2, rb: 0.1, gr: 0.2, gg: 0.7, gb: 0.1, br: 0.1, bg: 0.2, bb: 0.7, mono: false }), adj('brightness-contrast', { contrast: 0.22, saturation: 0.55 })] },
  { id: 'vintage-fade', label: 'Vintage fade', group: 'Tone', hint: 'Faded shadows, yellowed highlights.', build: () => [adj('tone-curve', { points: [{ x: 0, y: 0.12 }, { x: 0.5, y: 0.52 }, { x: 1, y: 0.92 }] }), adj('color-balance', { cR: 0.06, yB: -0.1 })] },
]

function adj(kind: Adjustment['kind'], params: Record<string, unknown>): Adjustment {
  return { id: uid('adj'), type: 'adjustment', kind, enabled: true, opacity: 1, blend: 'normal', params: { ...defaultParams(kind), ...params } as Adjustment['params'] }
}

export function presetById(id: string): PhotoPreset | undefined {
  return PHOTO_PRESETS.find((p) => p.id === id)
}

/* ====================================================== selections ========= */

export function emptySelection(w: number, h: number): Selection {
  return { mask: new Uint8Array(w * h), w, h, active: false, mode: 'new', feather: 0, inverted: false, bounds: null }
}

function recomputeSelectionBounds(sel: Selection, invert = false): void {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let count = 0
  for (let y = 0; y < sel.h; y++) {
    for (let x = 0; x < sel.w; x++) {
      const v = sel.mask[y * sel.w + x]
      const inside = invert ? 255 - v : v
      if (inside > 8) {
        count++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  sel.active = count > 0
  sel.bounds = count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null
}

export function selectionRect(sel: Selection, x: number, y: number, w: number, h: number, mode: SelectionMode = 'new', feather = 0): Selection {
  const temp = new Uint8Array(sel.w * sel.h)
  const x0 = Math.max(0, Math.floor(Math.min(x, x + w)))
  const y0 = Math.max(0, Math.floor(Math.min(y, y + h)))
  const x1 = Math.min(sel.w, Math.ceil(Math.max(x, x + w)))
  const y1 = Math.min(sel.h, Math.ceil(Math.max(y, y + h)))
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) temp[yy * sel.w + xx] = 255
  return commitSelection(sel, temp, mode, feather)
}

export function selectionEllipse(sel: Selection, cx: number, cy: number, rx: number, ry: number, mode: SelectionMode = 'new', feather = 0): Selection {
  const temp = new Uint8Array(sel.w * sel.h)
  const rr = Math.max(1, rx)
  const rry = Math.max(1, ry)
  for (let y = Math.max(0, Math.floor(cy - rry) - 1); y <= Math.min(sel.h - 1, Math.ceil(cy + rry) + 1); y++) {
    for (let x = Math.max(0, Math.floor(cx - rr) - 1); x <= Math.min(sel.w - 1, Math.ceil(cx + rr) + 1); x++) {
      const d = ((x + 0.5 - cx) / rr) ** 2 + ((y + 0.5 - cy) / rry) ** 2
      if (d <= 1) temp[y * sel.w + x] = 255
    }
  }
  return commitSelection(sel, temp, mode, feather)
}

export function selectionPolygon(sel: Selection, points: Vec[], mode: SelectionMode = 'new', feather = 0): Selection {
  const temp = new Uint8Array(sel.w * sel.h)
  if (points.length >= 3) {
    let minY = Infinity
    let maxY = -Infinity
    for (const p of points) {
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    const y0 = Math.max(0, Math.floor(minY))
    const y1 = Math.min(sel.h - 1, Math.ceil(maxY))
    for (let y = y0; y <= y1; y++) {
      const xs: number[] = []
      for (let i = 0; i < points.length; i++) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        const yy = y + 0.5
        if ((a.y <= yy && b.y > yy) || (b.y <= yy && a.y > yy)) {
          xs.push(a.x + ((yy - a.y) / (b.y - a.y)) * (b.x - a.x))
        }
      }
      xs.sort((p, q) => p - q)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.ceil(xs[i] - 0.5))
        const xb = Math.min(sel.w - 1, Math.floor(xs[i + 1] - 0.5))
        for (let x = xa; x <= xb; x++) temp[y * sel.w + x] = 255
      }
    }
  }
  return commitSelection(sel, temp, mode, feather)
}

export function selectionWand(sel: Selection, data: Bytes, x: number, y: number, tolerance = 32, contiguous = true, mode: SelectionMode = 'new', feather = 0): Selection {
  const mask = ImageKernels.floodSelect(data, sel.w, sel.h, Math.round(x), Math.round(y), tolerance, contiguous)
  return commitSelection(sel, mask, mode, feather)
}

export function selectionAll(sel: Selection, mode: SelectionMode = 'new'): Selection {
  const temp = new Uint8Array(sel.w * sel.h).fill(255)
  return commitSelection(sel, temp, mode, 0)
}

export function commitSelection(sel: Selection, next: MaskBytes, mode: SelectionMode, feather = 0): Selection {
  const mask = new Uint8Array(sel.w * sel.h)
  for (let i = 0; i < mask.length; i++) {
    const incoming = next[i] ?? 0
    const existing = sel.active || mode !== 'new' ? sel.mask[i] : 0
    switch (mode) {
      case 'new': mask[i] = incoming; break
      case 'add': mask[i] = Math.max(existing, incoming); break
      case 'subtract': mask[i] = Math.max(0, existing - incoming); break
      case 'intersect': mask[i] = Math.min(existing, incoming); break
    }
  }
  const out: Selection = { ...sel, mask, feather: feather > 0 ? feather : sel.feather, inverted: false }
  if (feather > 0) out.mask = ImageKernels.maskFeather(out.mask, sel.w, sel.h, feather)
  recomputeSelectionBounds(out)
  return out
}

export function selectionGrow(sel: Selection, radius = 2): Selection {
  const out: Selection = { ...sel, mask: ImageKernels.maskMorph(sel.mask, sel.w, sel.h, radius, true) }
  recomputeSelectionBounds(out)
  return out
}

export function selectionShrink(sel: Selection, radius = 2): Selection {
  const out: Selection = { ...sel, mask: ImageKernels.maskMorph(sel.mask, sel.w, sel.h, radius, false) }
  recomputeSelectionBounds(out)
  return out
}

export function selectionFeather(sel: Selection, radius = 4): Selection {
  const out: Selection = { ...sel, mask: ImageKernels.maskFeather(sel.mask, sel.w, sel.h, radius), feather: radius }
  recomputeSelectionBounds(out)
  return out
}

export function selectionInvert(sel: Selection): Selection {
  const mask: MaskBytes = new Uint8Array(sel.w * sel.h)
  for (let i = 0; i < mask.length; i++) mask[i] = 255 - sel.mask[i]
  const out: Selection = { ...sel, mask, inverted: !sel.inverted }
  recomputeSelectionBounds(out)
  return out
}

export function selectionFromMask(sel: Selection, mask: MaskBytes): Selection {
  const out: Selection = { ...sel, mask }
  recomputeSelectionBounds(out)
  return out
}

/** Effective coverage at a pixel (honours inversion). */
export function selectionAt(sel: Selection, x: number, y: number): number {
  if (!sel.active) return 255
  if (x < 0 || y < 0 || x >= sel.w || y >= sel.h) return 0
  const v = sel.mask[y * sel.w + x]
  return sel.inverted ? 255 - v : v
}

/* ============================================ background & subject ======== */

export interface BackgroundRemovalOptions {
  tolerance: number
  feather: number
  /** Grow (+) or shrink (−) the detected background before removing it. */
  expand: number
  /** Mark as a colour channel instead of erasing alpha. */
  keepSubjectOnly: boolean
  seedCorners: boolean
}

export const DEFAULT_BG_REMOVAL: BackgroundRemovalOptions = {
  tolerance: 30,
  feather: 2,
  expand: 1,
  keepSubjectOnly: true,
  seedCorners: true,
}

/**
 * Manual background removal: flood every border run whose colour is within
 * `tolerance`, then clean and feather the resulting cut-out.
 */
export function removeBackground(doc: PhotoDocument, options: Partial<BackgroundRemovalOptions> = {}): { mask: MaskBytes; removed: number } {
  const opts = { ...DEFAULT_BG_REMOVAL, ...options }
  const { w, h, data } = doc
  const bg: MaskBytes = new Uint8Array(w * h)
  const seeds: Vec[] = opts.seedCorners
    ? [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: 0, y: h - 1 }, { x: w - 1, y: h - 1 }, { x: (w - 1) / 2, y: 0 }, { x: (w - 1) / 2, y: h - 1 }, { x: 0, y: (h - 1) / 2 }, { x: w - 1, y: (h - 1) / 2 }]
    : [{ x: 0, y: 0 }]
  let removed = 0
  for (const seed of seeds) {
    const found = ImageKernels.floodSelect(data, w, h, Math.round(seed.x), Math.round(seed.y), opts.tolerance, true)
    for (let i = 0; i < bg.length; i++) {
      if (found[i] > 0) {
        if (bg[i] === 0) removed++
        bg[i] = 255
      }
    }
  }
  let cleaned: MaskBytes = bg
  if (opts.expand > 0) cleaned = ImageKernels.maskMorph(cleaned, w, h, opts.expand, true)
  else if (opts.expand < 0) cleaned = ImageKernels.maskMorph(cleaned, w, h, -opts.expand, false)
  if (opts.feather > 0) cleaned = ImageKernels.maskFeather(cleaned, w, h, opts.feather)

  if (opts.keepSubjectOnly) {
    // The document mask is the *subject*: invert the background coverage.
    const subject: MaskBytes = new Uint8Array(w * h)
    for (let i = 0; i < subject.length; i++) subject[i] = 255 - cleaned[i]
    doc.mask = subject
    doc.selection = selectionFromMask(doc.selection, subject)
  } else {
    doc.mask = null
  }
  doc.dirty = true
  return { mask: cleaned, removed }
}

/**
 * Subject selection without ML: the background is the connected, border-seeded,
 * colour-similar region; the subject is everything else, with holes filled and
 * the edge refined by a local gradient test.
 */
export function selectSubject(doc: PhotoDocument, tolerance = 28, refine = 1.5): MaskBytes {
  const { w, h, data } = doc
  const bg: MaskBytes = new Uint8Array(w * h)
  const seeds = [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: 0, y: h - 1 }, { x: w - 1, y: h - 1 }]
  for (const seed of seeds) {
    const found = ImageKernels.floodSelect(data, w, h, seed.x, seed.y, tolerance, true)
    for (let i = 0; i < bg.length; i++) bg[i] = Math.max(bg[i], found[i])
  }
  let subject: MaskBytes = new Uint8Array(w * h)
  for (let i = 0; i < subject.length; i++) subject[i] = 255 - bg[i]
  // Close small holes then soften the boundary.
  subject = ImageKernels.maskMorph(subject, w, h, 2, false)
  subject = ImageKernels.maskMorph(subject, w, h, 2, true)
  subject = refineEdges(doc, subject, refine)
  doc.selection = selectionFromMask(doc.selection, subject)
  return subject
}

/** Edge-aware refinement: pull the mask towards local luminance gradients. */
export function refineEdges(doc: PhotoDocument, mask: MaskBytes, strength = 1.5, radius = 1): MaskBytes {
  const { w, h, data } = doc
  const blurred = maskFeatherCopy(mask, w, h, radius)
  const out: MaskBytes = new Uint8Array(mask)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lum = (x: number, y: number) => {
        const k = (y * w + x) * 4
        return (data[k] * 0.2126 + data[k + 1] * 0.7152 + data[k + 2] * 0.0722) / 255
      }
      const gx = Math.abs(lum(x + 1, y) - lum(x - 1, y))
      const gy = Math.abs(lum(x, y + 1) - lum(x, y - 1))
      const edge = Math.min(1, (gx + gy) * 3)
      const soft = blurred[i] / 255
      const own = mask[i] / 255
      const blended = soft * (1 - edge) + own * edge
      out[i] = Math.round(clamp(lerp(own, blended, clamp(strength, 0, 2)), 0, 1) * 255)
    }
  }
  return out
}

function maskFeatherCopy(mask: MaskBytes, w: number, h: number, radius: number): MaskBytes {
  if (radius < 1) return new Uint8Array(mask)
  return ImageKernels.maskFeather(mask, w, h, radius)
}

/** Resize a single-channel mask by expanding it, resampling, then collapsing. */
export function resizeMask(mask: MaskBytes, sw: number, sh: number, dw: number, dh: number): MaskBytes {
  if (sw === dw && sh === dh) return new Uint8Array(mask)
  const rgba = ImageKernels.resample(expandMask(mask), sw, sh, dw, dh, 2)
  const out: MaskBytes = new Uint8Array(dw * dh)
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4]
  return out
}

/** Paint into the selection/mask with a soft round brush. */
export function paintMask(
  sel: Selection,
  points: Vec[],
  radius: number,
  hardness: number,
  flow: number,
  erase = false,
): Selection {
  const mask: MaskBytes = new Uint8Array(sel.mask)
  const r = Math.max(1, radius)
  const inner = r * clamp(hardness, 0, 0.98)
  const stroke = points.length > 1 ? points : points.length === 1 ? [points[0], points[0]] : []
  for (let i = 0; i + 1 < stroke.length; i++) {
    const a = stroke[i]
    const b = stroke[i + 1]
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, r * 0.25)))
    for (let s = 0; s <= steps; s++) {
      const cx = lerp(a.x, b.x, s / steps)
      const cy = lerp(a.y, b.y, s / steps)
      const x0 = Math.max(0, Math.floor(cx - r))
      const x1 = Math.min(sel.w - 1, Math.ceil(cx + r))
      const y0 = Math.max(0, Math.floor(cy - r))
      const y1 = Math.min(sel.h - 1, Math.ceil(cy + r))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
          if (d > r) continue
          const falloff = d <= inner ? 1 : 1 - (d - inner) / Math.max(0.001, r - inner)
          const k = y * sel.w + x
          const amount = clamp(falloff, 0, 1) * clamp(flow, 0, 1) * 255
          if (erase) mask[k] = Math.max(0, mask[k] - amount)
          else mask[k] = Math.min(255, mask[k] + amount)
        }
      }
    }
  }
  const out: Selection = { ...sel, mask, active: true }
  recomputeSelectionBounds(out)
  return out
}

/* =================================================== liquify session ======= */

export type LiquifyMode = 'push' | 'twirl' | 'pinch' | 'restore'

export interface LiquifySession {
  w: number
  h: number
  mode: LiquifyMode
  active: boolean
}

const LIQUIFY_MODE: Record<LiquifyMode, number> = { push: 0, twirl: 1, pinch: 2, restore: 3 }

export function beginLiquify(doc: PhotoDocument, mode: LiquifyMode = 'push'): LiquifySession {
  photoSnapshot(doc, `Liquify (${mode})`)
  ImageKernels.liquifyStart(doc.w, doc.h)
  return { w: doc.w, h: doc.h, mode, active: true }
}

export function liquifyDrag(session: LiquifySession, doc: PhotoDocument, from: Vec, to: Vec, radius: number, strength: number): void {
  if (!session.active) return
  const vx = to.x - from.x
  const vy = to.y - from.y
  ImageKernels.liquifyDab(doc.w, doc.h, to.x, to.y, radius, clamp(strength, 0, 1), LIQUIFY_MODE[session.mode], vx, vy)
}

export function commitLiquify(session: LiquifySession, doc: PhotoDocument): Bytes {
  const out = ImageKernels.liquifyApply(doc.data, doc.w, doc.h)
  session.active = false
  doc.data = out
  doc.dirty = true
  return out
}

export function liquifyModeLabel(mode: LiquifyMode): string {
  return mode === 'push' ? 'Push' : mode === 'twirl' ? 'Twirl' : mode === 'pinch' ? 'Pinch' : 'Restore'
}

/* ==================================================== lens & geometry ===== */

export interface LensCorrection {
  /** Negative = barrel (fix with positive), positive = pincushion. */
  distortion: number
  /** Chromatic-aberration removal strength, in pixels at the frame edge. */
  aberration: number
  vignette: number
  zoom: number
}

export const DEFAULT_LENS: LensCorrection = { distortion: 0, aberration: 0, vignette: 0, zoom: 1 }

/** Correct lens distortion / CA / vignetting with a single resample pass. */
export function applyLensCorrection(doc: PhotoDocument, opts: Partial<LensCorrection> = {}): Bytes {
  const o = { ...DEFAULT_LENS, ...opts }
  const { w, h } = doc
  const src = doc.data
  const out = new Uint8ClampedArray(w * h * 4)
  const cx = w / 2
  const cy = h / 2
  const norm = Math.hypot(cx, cy)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / norm
      const dy = (y - cy) / norm
      const r2 = dx * dx + dy * dy
      const f = 1 + o.distortion * r2 + o.distortion * 0.35 * r2 * r2
      const sx = cx + dx * norm * f * o.zoom
      const sy = cy + dy * norm * f * o.zoom
      const oi = (y * w + x) * 4
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) {
        out[oi] = 0
        out[oi + 1] = 0
        out[oi + 2] = 0
        out[oi + 3] = 0
        continue
      }
      const ca = o.aberration * r2
      const sample = (px: number, py: number, channel: number): number => {
        const x0 = Math.floor(px)
        const y0 = Math.floor(py)
        const tx = px - x0
        const ty = py - y0
        const k = (yy: number, xx: number) => src[(yy * w + xx) * 4 + channel]
        const top = lerp(k(y0, x0), k(y0, x0 + 1), tx)
        const bottom = lerp(k(y0 + 1, x0), k(y0 + 1, x0 + 1), tx)
        return lerp(top, bottom, ty)
      }
      out[oi] = sample(sx - ca * dx, sy - ca * dy, 0)
      out[oi + 1] = sample(sx, sy, 1)
      out[oi + 2] = sample(sx + ca * dx, sy + ca * dy, 2)
      out[oi + 3] = src[(Math.round(sy) * w + Math.round(sx)) * 4 + 3]
      if (o.vignette !== 0) {
        const edge = clamp(Math.sqrt(r2) * 1.42, 0, 1)
        const gain = 1 + o.vignette * edge * edge
        out[oi] = out[oi] * gain
        out[oi + 1] = out[oi + 1] * gain
        out[oi + 2] = out[oi + 2] * gain
      }
    }
  }
  doc.data = out as Bytes
  doc.dirty = true
  return doc.data
}

/** Interactive perspective correction: four handles in image space → warp. */
export function correctPerspective(doc: PhotoDocument, quad: Vec[], outputSize?: { w: number; h: number }): Bytes {
  const { w, h } = doc
  const dst = outputSize ?? { w, h }
  const src = [{ x: 0, y: 0 }, { x: dst.w, y: 0 }, { x: dst.w, y: dst.h }, { x: 0, y: dst.h }]
  const homography = homographyFromQuad(src, quad)
  const out = ImageKernels.perspectiveWarp(doc.data, w, h, dst.w, dst.h, homography)
  doc.data = out
  if (dst.w !== w || dst.h !== h) {
    doc.w = dst.w
    doc.h = dst.h
    doc.selection = emptySelection(dst.w, dst.h)
    doc.mask = doc.mask ? resizeMask(doc.mask, w, h, dst.w, dst.h) : null
  }
  doc.dirty = true
  return out
}

/**
 * Blur masking (depth of field): blur the frame, then composite it back through
 * a band mask so a chosen plane stays sharp.
 */
export function blurMask(
  data: Bytes,
  w: number,
  h: number,
  opts: { focusY: number; band: number; angle?: number; radius: number; invert?: boolean; maxBlur?: number },
): Bytes {
  const angle = ((opts.angle ?? 0) * Math.PI) / 180
  const nx = Math.sin(angle)
  const ny = Math.cos(angle)
  const maxBlur = Math.max(1, opts.maxBlur ?? opts.radius)
  const blurred = ImageKernels.gaussianBlur(data.slice(), w, h, maxBlur)
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x / w - 0.5) * nx + (y / h - 0.5) * ny + 0.5
      let d = Math.abs(u - opts.focusY)
      if (opts.invert) d = Math.max(0, 0.5 - d)
      const t = clamp((d - opts.band * 0.5) / Math.max(0.001, 0.5 - opts.band * 0.5), 0, 1)
      const amount = t * t * (3 - 2 * t)
      const i = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out[i + c] = lerp(data[i + c], blurred[i + c], amount)
    }
  }
  return out as Bytes
}

/* ================================================= retouch brushes ======== */

export interface RetouchDab {
  x: number
  y: number
  radius: number
  hardness: number
  opacity: number
  /** Source point for clone/heal. */
  source?: Vec
  /** Signed strength for dodge (+) / burn (−). */
  amount?: number
  pressure?: number
  seed?: number
}

function forEachDabPixel(dab: RetouchDab, w: number, h: number, fn: (x: number, y: number, weight: number) => void): void {
  const r = Math.max(0.5, dab.radius)
  const inner = r * clamp(dab.hardness, 0, 0.98)
  const x0 = Math.max(0, Math.floor(dab.x - r))
  const x1 = Math.min(w - 1, Math.ceil(dab.x + r))
  const y0 = Math.max(0, Math.floor(dab.y - r))
  const y1 = Math.min(h - 1, Math.ceil(dab.y + r))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - dab.x, y + 0.5 - dab.y)
      if (d > r) continue
      const falloff = d <= inner ? 1 : 1 - (d - inner) / Math.max(0.001, r - inner)
      const weight = clamp(falloff * falloff * (3 - 2 * falloff), 0, 1) * clamp(dab.opacity, 0, 1)
      if (weight > 0.0005) fn(x, y, weight)
    }
  }
}

export function pickPixel(data: Bytes, w: number, x: number, y: number): RGBA {
  const xi = clamp(Math.round(x), 0, w - 1)
  const total = data.length / 4
  const yi = clamp(Math.round(y), 0, Math.round(total / w) - 1)
  const i = (yi * w + xi) * 4
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] }
}

export function averageRegion(data: Bytes, w: number, h: number, cx: number, cy: number, radius: number): RGBA {
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  let n = 0
  const x0 = Math.max(0, Math.floor(cx - radius))
  const x1 = Math.min(w - 1, Math.ceil(cx + radius))
  const y0 = Math.max(0, Math.floor(cy - radius))
  const y1 = Math.min(h - 1, Math.ceil(cy + radius))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      a += data[i + 3]
      n++
    }
  }
  if (!n) return rgb(0, 0, 0, 0)
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: Math.round(a / n) }
}

/** Clone stamp: copies from an offset source, respecting the selection. */
export function cloneStamp(
  doc: PhotoDocument,
  dab: RetouchDab,
  selection: Selection | null = null,
): void {
  if (!dab.source) return
  const { w, h } = doc
  const src = doc.data
  const dx = dab.x - dab.source.x
  const dy = dab.y - dab.source.y
  forEachDabPixel(dab, w, h, (x, y, weight) => {
    const sel = selection && selection.active ? selectionAt(selection, x, y) / 255 : 1
    const amt = weight * sel
    if (amt <= 0.002) return
    const sx = Math.round(x - dx)
    const sy = Math.round(y - dy)
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return
    const i = (y * w + x) * 4
    const j = (sy * w + sx) * 4
    for (let c = 0; c < 4; c++) src[i + c] = lerp(src[i + c], src[j + c], amt)
  })
  doc.dirty = true
}

/**
 * Healing brush: clone, then colour-match the patch to its destination so
 * texture carries over without a visible colour seam.
 */
export function healBrush(doc: PhotoDocument, dab: RetouchDab): void {
  if (!dab.source) return
  const { w, h } = doc
  const src = doc.data
  const dx = dab.x - dab.source.x
  const dy = dab.y - dab.source.y
  const targetMean = averageRegion(src, w, h, dab.x, dab.y, Math.max(1, dab.radius * 0.6))
  const sourceMean = averageRegion(src, w, h, dab.source.x, dab.source.y, Math.max(1, dab.radius * 0.6))
  const shift = { r: targetMean.r - sourceMean.r, g: targetMean.g - sourceMean.g, b: targetMean.b - sourceMean.b }
  forEachDabPixel(dab, w, h, (x, y, weight) => {
    const sx = Math.round(x - dx)
    const sy = Math.round(y - dy)
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return
    const i = (y * w + x) * 4
    const j = (sy * w + sx) * 4
    // Structure from the source, colour from the destination.
    const lumSrc = (src[j] * 0.2126 + src[j + 1] * 0.7152 + src[j + 2] * 0.0722) / 255
    const lumDst = (src[i] * 0.2126 + src[i + 1] * 0.7152 + src[i + 2] * 0.0722) / 255
    const ratio = lumDst > 0.02 ? lumSrc / lumDst : 1
    const patch = {
      r: (src[j] + shift.r) * ratio,
      g: (src[j + 1] + shift.g) * ratio,
      b: (src[j + 2] + shift.b) * ratio,
    }
    src[i] = lerp(src[i], patch.r, weight)
    src[i + 1] = lerp(src[i + 1], patch.g, weight)
    src[i + 2] = lerp(src[i + 2], patch.b, weight)
  })
  doc.dirty = true
}

export type RetouchTool = 'smudge' | 'sharpen' | 'dodge' | 'burn' | 'saturate' | 'desaturate' | 'noise' | 'blur'

export interface RetouchOptions {
  tool: RetouchTool
  radius: number
  hardness: number
  opacity: number
  strength: number
  /** Previous dab position, used by smudge. */
  from?: Vec
  seed?: number
}

/** Generic retouch brushes — all local, deterministic convolutions. */
export function retouchDab(doc: PhotoDocument, at: Vec, opts: RetouchOptions): void {
  const { w, h } = doc
  const src = doc.data
  const rng = makeRng(opts.seed ?? 1)
  const dab: RetouchDab = { x: at.x, y: at.y, radius: opts.radius, hardness: opts.hardness, opacity: opts.opacity }
  switch (opts.tool) {
    case 'smudge': {
      const dx = opts.from ? at.x - opts.from.x : 0
      const dy = opts.from ? at.y - opts.from.y : 0
      const strength = clamp(opts.strength, 0, 1) * 0.9
      forEachDabPixel(dab, w, h, (x, y, weight) => {
        const sx = clamp(x - dx, 0, w - 1)
        const sy = clamp(y - dy, 0, h - 1)
        const x0 = Math.floor(sx)
        const y0 = Math.floor(sy)
        if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return
        const tx = sx - x0
        const ty = sy - y0
        const i = (y * w + x) * 4
        for (let c = 0; c < 3; c++) {
          const top = lerp(src[(y0 * w + x0) * 4 + c], src[(y0 * w + x0 + 1) * 4 + c], tx)
          const bottom = lerp(src[((y0 + 1) * w + x0) * 4 + c], src[((y0 + 1) * w + x0 + 1) * 4 + c], tx)
          src[i + c] = lerp(src[i + c], lerp(top, bottom, ty), weight * strength)
        }
      })
      break
    }
    case 'blur': {
      const radius = Math.max(1, opts.strength * 4)
      const blurred = ImageKernels.gaussianBlur(new Uint8ClampedArray(src) as Bytes, w, h, radius)
      forEachDabPixel(dab, w, h, (x, y, weight) => {
        const i = (y * w + x) * 4
        for (let c = 0; c < 4; c++) src[i + c] = lerp(src[i + c], blurred[i + c], weight)
      })
      break
    }
    case 'sharpen': {
      const sharp = ImageKernels.sharpen(new Uint8ClampedArray(src) as Bytes, w, h, clamp(opts.strength, 0, 2))
      forEachDabPixel(dab, w, h, (x, y, weight) => {
        const i = (y * w + x) * 4
        for (let c = 0; c < 3; c++) src[i + c] = lerp(src[i + c], sharp[i + c], weight)
      })
      break
    }
    case 'dodge':
    case 'burn': {
      const sign = opts.tool === 'dodge' ? 1 : -1
      const amount = sign * clamp(opts.strength, 0, 1) * 0.6
      forEachDabPixel(dab, w, h, (x, y, weight) => {
        const i = (y * w + x) * 4
        for (let c = 0; c < 3; c++) {
          const v = src[i + c] / 255
          const adjusted = amount > 0 ? v + (1 - v) * amount * weight : v * (1 + amount * weight)
          src[i + c] = clamp(adjusted, 0, 1) * 255
        }
      })
      break
    }
    case 'saturate':
    case 'desaturate': {
      const factor = opts.tool === 'saturate' ? 1 + clamp(opts.strength, 0, 1) * 0.8 : 1 - clamp(opts.strength, 0, 1)
      forEachDabPixel(dab, w, h, (x, y, weight) => {
        const i = (y * w + x) * 4
        const lum = src[i] * 0.2126 + src[i + 1] * 0.7152 + src[i + 2] * 0.0722
        for (let c = 0; c < 3; c++) {
          const adjusted = lum + (src[i + c] - lum) * factor
          src[i + c] = lerp(src[i + c], adjusted, weight)
        }
      })
      break
    }
    case 'noise': {
      forEachDabPixel(dab, w, h, (x, y, weight) => {
        const i = (y * w + x) * 4
        const n = (rng() - 0.5) * 255 * clamp(opts.strength, 0, 1) * 0.5
        for (let c = 0; c < 3; c++) src[i + c] = clamp(src[i + c] + n * weight, 0, 255)
      })
      break
    }
  }
  doc.dirty = true
}

/* ================================================= colour replacement ===== */

export interface ColorReplaceOptions {
  from: RGBA
  to: RGBA
  tolerance: number
  softness: number
  preserveLuminosity: boolean
  /** 0..1 blend across the whole image; 1 = fully replace. */
  amount: number
}

export const DEFAULT_COLOR_REPLACE: ColorReplaceOptions = {
  from: rgb(255, 255, 255),
  to: rgb(0, 87, 184),
  tolerance: 40,
  softness: 0.3,
  preserveLuminosity: true,
  amount: 1,
}

export function replaceColor(data: Bytes, opts: Partial<ColorReplaceOptions> = {}): Bytes {
  const o = { ...DEFAULT_COLOR_REPLACE, ...opts }
  const target = rgbToHsv(o.from)
  const out = new Uint8ClampedArray(data.length)
  for (let i = 0; i < data.length; i += 4) {
    const source = rgbToHsv({ r: data[i], g: data[i + 1], b: data[i + 2] })
    // Hue distance is circular; fully desaturated pixels match on value only.
    let hueDist = Math.abs(source.h - target.h)
    if (hueDist > 180) hueDist = 360 - hueDist
    const dist = source.s < 0.08 || target.s < 0.08
      ? Math.abs(source.v - target.v) * 255
      : Math.min(255, hueDist * (255 / 180) * 0.8 + Math.abs(source.s - target.s) * 255 * 0.5 + Math.abs(source.v - target.v) * 255 * 0.5)
    const soft = Math.max(1, o.softness * 255)
    const t = clamp((o.tolerance + soft - dist) / soft, 0, 1) * o.amount
    if (t <= 0) {
      out[i] = data[i]
      out[i + 1] = data[i + 1]
      out[i + 2] = data[i + 2]
      out[i + 3] = data[i + 3]
      continue
    }
    let r = o.to.r
    let g = o.to.g
    let b = o.to.b
    if (o.preserveLuminosity) {
      const lumSrc = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255
      const lumTo = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255 || 1
      const scale = lumSrc / lumTo
      r = clamp(r * scale, 0, 255)
      g = clamp(g * scale, 0, 255)
      b = clamp(b * scale, 0, 255)
    }
    out[i] = lerp(data[i], r, t)
    out[i + 1] = lerp(data[i + 1], g, t)
    out[i + 2] = lerp(data[i + 2], b, t)
    out[i + 3] = data[i + 3]
  }
  return out as Bytes
}

/* ======================================================== enhance ======== */

/** Upsample with Mitchell/bicubic resampling plus a light post-sharpen. */
export function upsamplePhoto(doc: PhotoDocument, scale: number, mode: 'bilinear' | 'bicubic' | 'mitchell' | 'box' = 'mitchell', sharpenAmount = 0.35): Bytes {
  const s = clamp(scale, 1, 4)
  const dw = Math.max(1, Math.round(doc.w * s))
  const dh = Math.max(1, Math.round(doc.h * s))
  const modeIndex = mode === 'bilinear' ? 0 : mode === 'bicubic' ? 1 : mode === 'mitchell' ? 2 : 3
  let out = ImageKernels.resample(doc.data, doc.w, doc.h, dw, dh, modeIndex)
  if (sharpenAmount > 0) out = ImageKernels.sharpen(out, dw, dh, sharpenAmount)
  if (doc.mask) doc.mask = resizeMask(doc.mask, doc.w, doc.h, dw, dh)
  doc.data = out
  doc.w = dw
  doc.h = dh
  doc.selection = emptySelection(dw, dh)
  doc.dirty = true
  return out
}

/** Remove 8×8 block artefacts and mosquito noise from a re-compressed photo. */
export function removeJpegArtifacts(doc: PhotoDocument, strength = 0.6): Bytes {
  const out = ImageKernels.jpegRestore(doc.data, doc.w, doc.h, clamp(strength, 0, 1))
  doc.data = out
  doc.dirty = true
  return out
}

/** Expand a single-channel mask into RGBA so it can be resampled. */
function expandMask(mask: MaskBytes): Bytes {
  const out = new Uint8ClampedArray(mask.length * 4)
  for (let i = 0; i < mask.length; i++) {
    out[i * 4] = mask[i]
    out[i * 4 + 1] = mask[i]
    out[i * 4 + 2] = mask[i]
    out[i * 4 + 3] = 255
  }
  return out as Bytes
}

/* ====================================================== analysis ========== */

export interface PhotoStats {
  histogram: Int32Array
  histogramRGB: Int32Array
  average: RGBA
  dynamicRange: { low: number; high: number }
  palette: RGBA[]
}

/** Deterministic image statistics used by the histogram and info panels. */
export function photoStats(doc: PhotoDocument, paletteCount = 8): PhotoStats {
  const data = renderedPhoto(doc)
  const histogram = ImageKernels.histogram(data)
  const histogramRGB = ImageKernels.histogramRGB(data)
  const avg = ImageKernels.averageColor(data)
  let total = 0
  let low = 0
  let high = 255
  for (let i = 0; i < 256; i++) total += histogram[i]
  let acc = 0
  for (let i = 0; i < 256; i++) {
    acc += histogram[i]
    if (acc > total * 0.005) { low = i; break }
  }
  acc = 0
  for (let i = 255; i >= 0; i--) {
    acc += histogram[i]
    if (acc > total * 0.005) { high = i; break }
  }
  const palette = ImageKernels.extractPalette(data, paletteCount).map((c) => rgb(c.r, c.g, c.b, 1))
  return {
    histogram,
    histogramRGB,
    average: rgb(Math.round(avg.r), Math.round(avg.g), Math.round(avg.b), 1),
    dynamicRange: { low, high },
    palette,
  }
}

/** Levels values that stretch the histogram to the full range. */
export function autoLevels(stats: PhotoStats): Adjustment {
  return adj('levels', { inBlack: stats.dynamicRange.low, inWhite: stats.dynamicRange.high, gamma: 1 })
}

/* ============================================== placement in vector ====== */

import type { BitmapObject } from '../types'
import { createBitmap } from '../store/mutations'

export function photoToBitmapObject(doc: PhotoDocument, name?: string): BitmapObject {
  const obj = createBitmap(photoDataUrl(doc), doc.w, doc.h, { x: 0, y: 0, w: doc.w, h: doc.h })
  if (name) obj.name = name
  return obj
}

export function blendOptions(): { value: BlendMode; label: string }[] {
  return [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
    'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
  ].map((value) => ({ value: value as BlendMode, label: value.replace('-', ' ') }))
}

export function applyPhotoAdjustment(doc: PhotoDocument, adjustment: Adjustment): void {
  photoSnapshot(doc, adjustment.kind)
  doc.data = applyAdjustment(doc.data, adjustment)
  doc.dirty = true
}

export type { Effect }
