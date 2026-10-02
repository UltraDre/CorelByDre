/**
 * Painterly brush engine.
 *
 * A brush is a deterministic stamping machine: a spine (sampled stroke points with
 * pressure) is walked at a fixed spacing and a media-specific "dab" is drawn at each
 * step. Traditional-media looks come from layering, not from any learned model —
 * watercolour builds up translucent washes that sit in the paper tooth, oils lay
 * opaque bristle streaks, pastels leave pigment crumbs, and so on.
 */
import type { BrushStroke, RGBA } from '../types'
import { clamp, makeRng, type Vec } from '../lib/util'
import { css, mixColor } from '../lib/color'

export type MediaKind = 'watercolor' | 'oil' | 'pastel' | 'marker' | 'pencil' | 'ink' | 'airbrush' | 'chalk' | 'charcoal' | 'gouache' | 'acrylic' | 'spray'

export interface BrushPreset {
  id: string
  name: string
  category: string
  media: MediaKind
  size: number
  sizeVariation: number
  opacityVariation: number
  spacing: number
  flow: number
  jitter: number
  buildup: number
  bristles: number
  grain: number
  bleed: number
  taper: 'none' | 'in' | 'out' | 'both'
  blend: GlobalCompositeOperation
  /** Sampling quality vs. speed. */
  quality: 'draft' | 'normal' | 'high'
}

const CATEGORIES: { id: string; label: string; media: MediaKind }[] = [
  { id: 'watercolor', label: 'Watercolour', media: 'watercolor' },
  { id: 'oil', label: 'Oils & acrylics', media: 'oil' },
  { id: 'pastel', label: 'Pastels & chalk', media: 'pastel' },
  { id: 'marker', label: 'Markers', media: 'marker' },
  { id: 'pencil', label: 'Pencils & charcoal', media: 'pencil' },
  { id: 'ink', label: 'Ink & calligraphy', media: 'ink' },
  { id: 'spray', label: 'Airbrush & spray', media: 'airbrush' },
  { id: 'gouache', label: 'Gouache', media: 'gouache' },
]

const VARIANTS: { suffix: string; tweak: Partial<BrushPreset> }[] = [
  { suffix: 'Soft', tweak: { flow: 0.35, grain: 0.15, buildup: 3 } },
  { suffix: 'Wet', tweak: { flow: 0.4, bleed: 0.7, buildup: 4, spacing: 0.05 } },
  { suffix: 'Dry', tweak: { flow: 0.5, grain: 0.75, buildup: 2, spacing: 0.11 } },
  { suffix: 'Grainy', tweak: { grain: 0.85, flow: 0.45, buildup: 3 } },
  { suffix: 'Heavy', tweak: { flow: 0.9, buildup: 1, spacing: 0.08 } },
  { suffix: 'Fine', tweak: { size: 6, flow: 0.6, spacing: 0.04 } },
  { suffix: 'Broad', tweak: { size: 42, flow: 0.5, spacing: 0.12 } },
  { suffix: 'Tapered', tweak: { taper: 'both', flow: 0.6, spacing: 0.05 } },
  { suffix: 'Bristle', tweak: { bristles: 22, flow: 0.5, grain: 0.5 } },
  { suffix: 'Wash', tweak: { flow: 0.12, bleed: 0.9, buildup: 6, spacing: 0.03 } },
  { suffix: 'Smudge', tweak: { flow: 0.3, bleed: 1, buildup: 5, grain: 0.3 } },
  { suffix: 'Detail', tweak: { size: 3, flow: 0.75, spacing: 0.03, quality: 'high' } },
  { suffix: 'Impasto', tweak: { flow: 1, bristles: 30, grain: 0.4, buildup: 1 } },
  { suffix: 'Splatter', tweak: { jitter: 0.6, flow: 0.35, grain: 0.9, spacing: 0.16 } },
  { suffix: 'Chisel', tweak: { bristles: 1, flow: 0.8, size: 34, spacing: 0.05 } },
]

function baseFor(media: MediaKind): BrushPreset {
  const common = {
    category: 'Watercolour',
    taper: 'both' as BrushPreset['taper'],
    blend: 'source-over' as GlobalCompositeOperation,
    quality: 'normal' as BrushPreset['quality'],
  }
  switch (media) {
    case 'watercolor':
      return { id: '', name: '', media, size: 26, sizeVariation: 0.3, opacityVariation: 0.4, spacing: 0.04, flow: 0.3, jitter: 0.1, buildup: 4, bristles: 0, grain: 0.35, bleed: 0.6, ...common }
    case 'oil':
      return { id: '', name: '', media, size: 22, sizeVariation: 0.15, opacityVariation: 0.2, spacing: 0.06, flow: 0.85, jitter: 0.05, buildup: 1, bristles: 18, grain: 0.25, bleed: 0.1, ...common, category: 'Oils & acrylics', taper: 'none', blend: 'source-over' }
    case 'pastel':
      return { id: '', name: '', media, size: 18, sizeVariation: 0.35, opacityVariation: 0.45, spacing: 0.09, flow: 0.5, jitter: 0.22, buildup: 3, bristles: 0, grain: 0.8, bleed: 0.15, ...common, category: 'Pastels & chalk' }
    case 'marker':
      return { id: '', name: '', media, size: 16, sizeVariation: 0.05, opacityVariation: 0.08, spacing: 0.03, flow: 0.55, jitter: 0.02, buildup: 2, bristles: 0, grain: 0.08, bleed: 0.3, ...common, category: 'Markers', taper: 'none' }
    case 'pencil':
      return { id: '', name: '', media, size: 4, sizeVariation: 0.25, opacityVariation: 0.3, spacing: 0.05, flow: 0.4, jitter: 0.12, buildup: 3, bristles: 0, grain: 0.65, bleed: 0.05, ...common, category: 'Pencils & charcoal' }
    case 'ink':
      return { id: '', name: '', media, size: 10, sizeVariation: 0.1, opacityVariation: 0.06, spacing: 0.02, flow: 1, jitter: 0.02, buildup: 1, bristles: 0, grain: 0.1, bleed: 0.05, ...common, category: 'Ink & calligraphy' }
    case 'airbrush':
      return { id: '', name: '', media, size: 40, sizeVariation: 0.1, opacityVariation: 0.5, spacing: 0.03, flow: 0.18, jitter: 0.05, buildup: 4, bristles: 0, grain: 0.05, bleed: 0.85, ...common, category: 'Airbrush & spray' }
    case 'chalk':
      return { id: '', name: '', media, size: 20, sizeVariation: 0.3, opacityVariation: 0.4, spacing: 0.08, flow: 0.45, jitter: 0.25, buildup: 3, bristles: 0, grain: 0.85, bleed: 0.2, ...common, category: 'Pastels & chalk' }
    case 'charcoal':
      return { id: '', name: '', media, size: 24, sizeVariation: 0.4, opacityVariation: 0.45, spacing: 0.1, flow: 0.35, jitter: 0.3, buildup: 4, bristles: 0, grain: 0.9, bleed: 0.25, ...common, category: 'Pencils & charcoal' }
    case 'gouache':
      return { id: '', name: '', media, size: 20, sizeVariation: 0.12, opacityVariation: 0.15, spacing: 0.05, flow: 0.95, jitter: 0.04, buildup: 1, bristles: 0, grain: 0.2, bleed: 0.08, ...common, category: 'Gouache', taper: 'none' }
    case 'acrylic':
      return { id: '', name: '', media, size: 24, sizeVariation: 0.14, opacityVariation: 0.18, spacing: 0.06, flow: 0.9, jitter: 0.05, buildup: 1, bristles: 12, grain: 0.3, bleed: 0.1, ...common, category: 'Gouache', taper: 'none' }
    default:
      return { id: '', name: '', media, size: 30, sizeVariation: 0.2, opacityVariation: 0.3, spacing: 0.06, flow: 0.4, jitter: 0.1, buildup: 3, bristles: 0, grain: 0.4, bleed: 0.3, ...common, category: 'Airbrush & spray' }
  }
}

/** 120 deterministic presets: 8 media families × 15 named variants. */
export const BRUSH_PRESETS: BrushPreset[] = (() => {
  const out: BrushPreset[] = []
  for (const cat of CATEGORIES) {
    const base = baseFor(cat.media)
    for (const variant of VARIANTS) {
      const preset: BrushPreset = {
        ...base,
        ...variant.tweak,
        id: `${cat.id}-${variant.suffix.toLowerCase()}`,
        name: `${cat.label.split(' ')[0]} ${variant.suffix}`,
        category: cat.label,
        media: cat.media,
      }
      out.push(preset)
    }
  }
  return out
})()

export function presetByID(id: string): BrushPreset {
  return BRUSH_PRESETS.find((p) => p.id === id) ?? BRUSH_PRESETS[0]
}

/* ------------------------------------------------------------- sampling ---- */

export interface Dab { x: number; y: number; angle: number; pressure: number; size: number; alpha: number }

function taperFactor(t: number, mode: BrushPreset['taper']): number {
  const ramp = 0.18
  if (mode === 'in') return clamp(t / ramp, 0.15, 1)
  if (mode === 'out') return clamp((1 - t) / ramp, 0.15, 1)
  if (mode === 'both') return clamp(Math.min(t, 1 - t) / ramp, 0.08, 1)
  return 1
}

/** Walk the spine and produce the dab list — deterministic for a given seed. */
export function sampleDabs(stroke: BrushStroke, preset: BrushPreset, zoom = 1): Dab[] {
  const rng = makeRng(stroke.seed || 1)
  const dabs: Dab[] = []
  const pts = stroke.points
  if (pts.length === 0) return dabs
  const step = Math.max(0.35 / zoom, preset.spacing * stroke.size)
  let carry = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    const angle = Math.atan2(dy, dx)
    let travelled = carry
    while (travelled <= len) {
      const t = travelled / len
      const x = a.x + dx * t
      const y = a.y + dy * t
      const p = a.p + (b.p - a.p) * t
      const globalT = (i + t) / Math.max(1, pts.length - 1)
      const pressure = clamp(p, 0.02, 1) * taperFactor(globalT, preset.taper)
      const jitterX = (rng() - 0.5) * preset.jitter * stroke.size
      const jitterY = (rng() - 0.5) * preset.jitter * stroke.size
      const sizeVar = 1 + (rng() - 0.5) * 2 * (preset.sizeVariation + stroke.sizeVariation)
      const alphaVar = 1 + (rng() - 0.5) * 2 * (preset.opacityVariation + stroke.opacityVariation)
      dabs.push({
        x: x + jitterX,
        y: y + jitterY,
        angle: angle + stroke.rotation,
        pressure,
        size: Math.max(0.4, stroke.size * clamp(sizeVar, 0.15, 2.2) * (0.35 + pressure * 0.65)),
        alpha: clamp(preset.flow * alphaVar * (0.45 + pressure * 0.55), 0.01, 1),
      })
      travelled += step
    }
    carry = travelled - len
  }
  return dabs
}

/* ------------------------------------------------------------- painting ---- */

export interface BrushRenderOptions {
  /** Colour-jitter neighbour used for watercolour colour drift. */
  drift?: RGBA
  zoom?: number
  turbo?: boolean
}

/**
 * Paint a stroke onto a 2D context. Coordinates are in document units; the caller
 * sets up the view transform beforehand.
 */
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  stroke: BrushStroke,
  preset: BrushPreset,
  options: BrushRenderOptions = {},
): void {
  const dabs = sampleDabs(stroke, preset, options.zoom ?? 1)
  if (!dabs.length) return
  const color = stroke.color
  const drift = options.drift ?? color
  const turbo = options.turbo ?? false
  const rng = makeRng((stroke.seed || 1) ^ 0x9e3779b9)

  ctx.save()
  ctx.globalCompositeOperation = preset.blend
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const layers = turbo ? 1 : Math.max(1, Math.round(stroke.buildup || preset.buildup))
  const perLayer = dabs.length / layers

  for (let layer = 0; layer < layers; layer++) {
    const from = Math.floor(layer * perLayer)
    const to = Math.floor((layer + 1) * perLayer)
    const slice = dabs.slice(Math.max(0, from - 1), to + 1)
    if (!slice.length) continue
    const layerAlpha = 1 / (layers * (preset.media === 'watercolor' ? 0.9 : 1))
    for (const dab of slice) {
      paintDab(ctx, dab, preset, color, drift, layerAlpha, rng, turbo)
    }
  }
  ctx.restore()
}

function paintDab(
  ctx: CanvasRenderingContext2D,
  dab: Dab,
  preset: BrushPreset,
  color: RGBA,
  drift: RGBA,
  layerAlpha: number,
  rng: () => number,
  turbo: boolean,
): void {
  const alpha = clamp(dab.alpha * layerAlpha * color.a, 0.01, 1)
  const r = dab.size / 2
  switch (preset.media) {
    case 'watercolor': {
      // Pigment pools at the edges: a soft core plus a darker rim.
      const tint = mixColor(color, drift, rng() * 0.12)
      ctx.globalAlpha = alpha * 0.55
      const grad = ctx.createRadialGradient(dab.x, dab.y, r * 0.1, dab.x, dab.y, r * (1 + preset.bleed * 0.6))
      grad.addColorStop(0, css({ ...tint, a: 1 }))
      grad.addColorStop(0.6, css({ ...tint, a: 0.45 }))
      grad.addColorStop(1, css({ ...tint, a: 0 }))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(dab.x, dab.y, r * (1 + preset.bleed * 0.6), 0, Math.PI * 2)
      ctx.fill()
      if (!turbo && preset.grain > 0.05) {
        ctx.globalAlpha = alpha * preset.grain * 0.4
        ctx.fillStyle = css({ ...tint, a: 1 })
        for (let i = 0; i < 3; i++) {
          const a = rng() * Math.PI * 2
          const rr = rng() * r
          ctx.beginPath()
          ctx.arc(dab.x + Math.cos(a) * rr, dab.y + Math.sin(a) * rr, Math.max(0.3, r * 0.12 * rng()), 0, Math.PI * 2)
          ctx.fill()
        }
      }
      break
    }
    case 'oil':
    case 'acrylic': {
      ctx.globalAlpha = alpha
      const bristles = turbo ? 0 : preset.bristles
      if (bristles > 0) {
        const nx = Math.cos(dab.angle + Math.PI / 2)
        const ny = Math.sin(dab.angle + Math.PI / 2)
        const count = Math.min(bristles * 2, 24)
        for (let i = 0; i < count; i++) {
          const t = (i / Math.max(1, count - 1)) * 2 - 1
          const shade = 1 + (rng() - 0.5) * preset.grain * 0.5
          ctx.strokeStyle = css({ ...mixColor(color, { r: 255, g: 255, b: 255, a: 1 }, Math.max(0, (shade - 1) * 0.5)), a: 1 })
          ctx.lineWidth = Math.max(0.4, dab.size / (count * 1.4))
          ctx.beginPath()
          const len = r * 1.1
          ctx.moveTo(dab.x - Math.cos(dab.angle) * len + nx * t * r, dab.y - Math.sin(dab.angle) * len + ny * t * r)
          ctx.lineTo(dab.x + Math.cos(dab.angle) * len + nx * t * r, dab.y + Math.sin(dab.angle) * len + ny * t * r)
          ctx.stroke()
        }
      } else {
        ctx.fillStyle = css({ ...color, a: 1 })
        ctx.beginPath()
        ctx.ellipse(dab.x, dab.y, r, r * 0.92, dab.angle, 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'pastel':
    case 'chalk':
    case 'charcoal': {
      const crumbs = turbo ? 2 : 7
      ctx.globalAlpha = alpha * 0.75
      ctx.fillStyle = css({ ...color, a: 1 })
      for (let i = 0; i < crumbs; i++) {
        const a = rng() * Math.PI * 2
        const rr = rng() * r * 1.15
        const sz = Math.max(0.4, r * (0.18 + rng() * 0.4) * (1 - preset.grain * 0.4))
        ctx.beginPath()
        ctx.arc(dab.x + Math.cos(a) * rr, dab.y + Math.sin(a) * rr, sz, 0, Math.PI * 2)
        ctx.fill()
      }
      break
    }
    case 'pencil': {
      ctx.globalAlpha = alpha * 0.5
      ctx.fillStyle = css({ ...color, a: 1 })
      const nx = Math.cos(dab.angle + Math.PI / 2)
      const ny = Math.sin(dab.angle + Math.PI / 2)
      const n = turbo ? 1 : 5
      for (let i = 0; i < n; i++) {
        const t = (rng() - 0.5) * 2 * r * 0.8
        const px = dab.x + nx * t
        const py = dab.y + ny * t
        const len = r * (0.6 + rng() * 0.6)
        ctx.lineWidth = Math.max(0.25, (dab.size / 9) * (0.5 + rng()))
        ctx.strokeStyle = css({ ...color, a: 1 })
        ctx.beginPath()
        ctx.moveTo(px - Math.cos(dab.angle) * len, py - Math.sin(dab.angle) * len)
        ctx.lineTo(px + Math.cos(dab.angle) * len, py + Math.sin(dab.angle) * len)
        ctx.stroke()
      }
      break
    }
    case 'marker': {
      ctx.globalAlpha = alpha * 0.6
      ctx.fillStyle = css({ ...color, a: 1 })
      ctx.beginPath()
      ctx.ellipse(dab.x, dab.y, r * 1.05, r * 0.85, dab.angle, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'ink': {
      ctx.globalAlpha = alpha
      ctx.fillStyle = css({ ...color, a: 1 })
      ctx.beginPath()
      ctx.arc(dab.x, dab.y, r, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'airbrush':
    default: {
      ctx.globalAlpha = alpha * 0.35
      const grad = ctx.createRadialGradient(dab.x, dab.y, 0, dab.x, dab.y, r * (1 + preset.bleed))
      grad.addColorStop(0, css({ ...color, a: 1 }))
      grad.addColorStop(1, css({ ...color, a: 0 }))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(dab.x, dab.y, r * (1 + preset.bleed), 0, Math.PI * 2)
      ctx.fill()
      break
    }
  }
}

/** Sample the pressure stream of a pointer trail into stroke points. */
export function makeStrokePoints(points: Vec[], pressure: number[] = []): BrushStroke['points'] {
  return points.map((p, i) => ({ x: p.x, y: p.y, p: pressure[i] ?? 0.6 }))
}

/* --------------------------------------------------------- media tray ------ */

const TRAY_KEY = 'corelbydre.brush.tray'

export function loadMediaTray(): string[] {
  try {
    const raw = localStorage.getItem(TRAY_KEY)
    if (!raw) return ['watercolor-soft', 'oil-impasto', 'pastel-grainy', 'marker-heavy', 'pencil-soft', 'ink-tapered']
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? parsed : []
  } catch {
    return ['watercolor-soft', 'oil-impasto']
  }
}

export function pushMediaTray(id: string): string[] {
  const tray = [id, ...loadMediaTray().filter((x) => x !== id)].slice(0, 12)
  try {
    localStorage.setItem(TRAY_KEY, JSON.stringify(tray))
  } catch {
    /* storage may be unavailable in private mode */
  }
  return tray
}
