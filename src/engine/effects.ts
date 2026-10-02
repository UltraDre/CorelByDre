/**
 * Non-destructive effects and adjustments.
 *
 * Every adjustment is a closed-form pixel transform and every effect is a classic
 * image operator (convolution, resampling, channel maths, warp, blend). The object
 * keeps its original vector or bitmap data; the stack is re-evaluated on render and
 * cached until a parameter changes. There is no AI/ML anywhere in this file.
 */
import type { Adjustment, BlendMode, CurvePoint, Effect, NonDestructive, RGBA } from '../types'
import { BLEND_INDEX } from '../types'
import { ImageKernels, curveToLUT, identityLUT, type Bytes } from '../lib/wasm'
import { clamp, makeRng } from '../lib/util'
import { css, rgb } from '../lib/color'

export type ParamType = 'slider' | 'number' | 'select' | 'checkbox' | 'color' | 'curve' | 'angle' | 'text'

export interface ParamDef {
  key: string
  label: string
  type: ParamType
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  default: number | string | boolean | CurvePoint[] | number[]
  unit?: string
}

export interface EffectDef {
  kind: Adjustment['kind'] | Effect['kind']
  label: string
  group: 'Adjust' | 'Blur' | 'Sharpen' | 'Distort' | 'Artistic' | 'Colour' | 'Photo' | 'Stylise'
  params: ParamDef[]
  /** Non-destructive stacks are evaluated on the rasterised object. */
  rasterised: boolean
  hint?: string
}

const p = (
  key: string, label: string, type: ParamType,
  def: ParamDef['default'], min?: number, max?: number, step?: number,
  extra: Partial<ParamDef> = {},
): ParamDef => ({ key, label, type, default: def, min, max, step, ...extra })

export const EFFECT_DEFS: EffectDef[] = [
  /* ------------------------------------------------------------ adjust ---- */
  { kind: 'brightness-contrast', label: 'Brightness / Contrast / Intensity', group: 'Adjust', rasterised: true, params: [p('brightness', 'Brightness', 'slider', 0, -0.5, 0.5, 0.005), p('contrast', 'Contrast', 'slider', 0, -1, 1, 0.01), p('gamma', 'Gamma', 'slider', 1, 0.1, 3, 0.01), p('saturation', 'Saturation', 'slider', 1, 0, 3, 0.01)] },
  { kind: 'tone-curve', label: 'Tone Curve', group: 'Adjust', rasterised: true, hint: 'Natural cubic spline through your control points.', params: [p('points', 'Curve', 'curve', [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }]), p('channel', 'Channel', 'select', 'rgb', undefined, undefined, undefined, { options: [{ value: 'rgb', label: 'Composite' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }] })] },
  { kind: 'hue-curve', label: 'Hue Curve', group: 'Adjust', rasterised: true, hint: 'Rotate hue, scale saturation, offset lightness.', params: [p('deg', 'Hue shift', 'slider', 0, -180, 180, 1, { unit: '°' }), p('sat', 'Saturation', 'slider', 1, 0, 3, 0.01), p('light', 'Lightness', 'slider', 0, -0.5, 0.5, 0.005)] },
  { kind: 'levels', label: 'Levels', group: 'Adjust', rasterised: true, params: [p('inBlack', 'Input black', 'slider', 0, 0, 254, 1), p('inWhite', 'Input white', 'slider', 255, 1, 255, 1), p('gamma', 'Midtones', 'slider', 1, 0.1, 3, 0.01), p('outBlack', 'Output black', 'slider', 0, 0, 255, 1), p('outWhite', 'Output white', 'slider', 255, 0, 255, 1)] },
  { kind: 'vibrance', label: 'Vibrance', group: 'Adjust', rasterised: true, hint: 'Protects already-saturated colours while lifting muted ones.', params: [p('amount', 'Vibrance', 'slider', 0, -1, 1, 0.01), p('skin', 'Protect skin tones', 'slider', 0.4, 0, 1, 0.01)] },
  { kind: 'color-balance', label: 'Colour Balance', group: 'Adjust', rasterised: true, params: [p('cR', 'Cyan / Red', 'slider', 0, -1, 1, 0.01), p('mG', 'Magenta / Green', 'slider', 0, -1, 1, 0.01), p('yB', 'Yellow / Blue', 'slider', 0, -1, 1, 0.01), p('preserveLum', 'Preserve luminosity', 'checkbox', true)] },
  { kind: 'channel-mixer', label: 'Channel Mixer', group: 'Adjust', rasterised: true, params: [p('rr', 'Red ← Red', 'slider', 1, -2, 2, 0.01), p('rg', 'Red ← Green', 'slider', 0, -2, 2, 0.01), p('rb', 'Red ← Blue', 'slider', 0, -2, 2, 0.01), p('gr', 'Green ← Red', 'slider', 0, -2, 2, 0.01), p('gg', 'Green ← Green', 'slider', 1, -2, 2, 0.01), p('gb', 'Green ← Blue', 'slider', 0, -2, 2, 0.01), p('br', 'Blue ← Red', 'slider', 0, -2, 2, 0.01), p('bg', 'Blue ← Green', 'slider', 0, -2, 2, 0.01), p('bb', 'Blue ← Blue', 'slider', 1, -2, 2, 0.01), p('mono', 'Monochrome', 'checkbox', false)] },
  { kind: 'desaturate', label: 'Desaturate', group: 'Adjust', rasterised: true, params: [p('amount', 'Amount', 'slider', 1, 0, 1, 0.01)] },
  { kind: 'posterize', label: 'Posterize', group: 'Adjust', rasterised: true, params: [p('levels', 'Levels', 'slider', 6, 2, 32, 1)] },
  { kind: 'threshold', label: 'Threshold', group: 'Adjust', rasterised: true, params: [p('level', 'Level', 'slider', 128, 0, 255, 1)] },
  { kind: 'gamma', label: 'Gamma', group: 'Adjust', rasterised: true, params: [p('value', 'Gamma', 'slider', 1, 0.1, 4, 0.01)] },
  { kind: 'selective-color', label: 'Selective Colour', group: 'Adjust', rasterised: true, params: [p('range', 'Colour range', 'select', 'reds', undefined, undefined, undefined, { options: ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'neutrals', 'blacks', 'whites'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) }), p('c', 'Cyan', 'slider', 0, -1, 1, 0.01), p('m', 'Magenta', 'slider', 0, -1, 1, 0.01), p('y', 'Yellow', 'slider', 0, -1, 1, 0.01), p('k', 'Black', 'slider', 0, -1, 1, 0.01)] },

  /* --------------------------------------------------------------- blur --- */
  { kind: 'gaussian-blur', label: 'Gaussian Blur', group: 'Blur', rasterised: true, params: [p('radius', 'Radius', 'slider', 4, 0, 200, 1, { unit: 'px' }), p('blurAlpha', 'Blur edges', 'checkbox', false)] },
  { kind: 'blur-mask', label: 'Blur Mask (depth of field)', group: 'Blur', rasterised: true, hint: 'Keeps a focus band sharp and blurs progressively away from it.', params: [p('focusY', 'Focus at', 'slider', 0.5, 0, 1, 0.01), p('band', 'Sharp band', 'slider', 0.2, 0, 1, 0.01), p('radius', 'Blur radius', 'slider', 14, 0, 100, 1, { unit: 'px' }), p('invert', 'Blur the centre instead', 'checkbox', false)] },
  { kind: 'lens', label: 'Lens / Fisheye', group: 'Distort', rasterised: true, params: [p('amount', 'Strength', 'slider', 0.25, -1, 1, 0.01), p('zoom', 'Zoom', 'slider', 1, 0.4, 2.5, 0.01), p('edge', 'Edge handling', 'select', 'clamp', undefined, undefined, undefined, { options: [{ value: 'clamp', label: 'Stretch edges' }, { value: 'transparent', label: 'Transparent' }] })] },

  /* ------------------------------------------------------------ sharpen --- */
  { kind: 'sharpen', label: 'Sharpen (unsharp mask)', group: 'Sharpen', rasterised: true, params: [p('amount', 'Amount', 'slider', 0.6, 0, 4, 0.05)] },
  { kind: 'jpeg-restore', label: 'JPEG artifact removal', group: 'Sharpen', rasterised: true, hint: 'Edge-preserving smoothing plus 8×8 deblocking — ideal for scanned or re-saved photos.', params: [p('strength', 'Strength', 'slider', 0.6, 0, 1, 0.01)] },
  { kind: 'upsample', label: 'Upsample (high quality)', group: 'Photo', rasterised: true, hint: 'Mitchell resampling followed by edge-aware sharpening.', params: [p('scale', 'Scale', 'slider', 2, 1, 4, 0.1), p('mode', 'Method', 'select', 'mitchell', undefined, undefined, undefined, { options: [{ value: 'bilinear', label: 'Bilinear' }, { value: 'bicubic', label: 'Bicubic' }, { value: 'mitchell', label: 'Mitchell (recommended)' }, { value: 'box', label: 'Box average' }] }), p('sharpen', 'Post-sharpen', 'slider', 0.35, 0, 2, 0.05)] },
  { kind: 'noise', label: 'Add Noise', group: 'Stylise', rasterised: true, params: [p('amount', 'Amount', 'slider', 0.12, 0, 1, 0.01), p('monochrome', 'Monochrome', 'checkbox', true), p('seed', 'Seed', 'number', 7)] },
  { kind: 'pixelate', label: 'Pixelate', group: 'Stylise', rasterised: true, params: [p('size', 'Cell size', 'slider', 8, 2, 128, 1, { unit: 'px' })] },

  /* ----------------------------------------------------------- artistic --- */
  { kind: 'artistic', label: 'Artistic style', group: 'Artistic', rasterised: true, hint: 'Traditional media simulations built from filters, texture and edge work.', params: [p('style', 'Style', 'select', 'watercolor', undefined, undefined, undefined, { options: [
    { value: 'watercolor', label: 'Watercolour' }, { value: 'oil', label: 'Oil painting' },
    { value: 'impressionist', label: 'Impressionist' }, { value: 'pencil', label: 'Pencil sketch' },
    { value: 'charcoal', label: 'Charcoal' }, { value: 'pastel', label: 'Pastel' },
    { value: 'marker', label: 'Marker' }, { value: 'woodcut', label: 'Woodcut' },
    { value: 'poster', label: 'Poster art' }, { value: 'halftone', label: 'Halftone' },
    { value: 'ink', label: 'Ink wash' }, { value: 'emboss', label: 'Emboss' },
    { value: 'mosaic', label: 'Mosaic' }, { value: 'linocut', label: 'Linocut' },
  ] }), p('strength', 'Strength', 'slider', 0.75, 0, 1, 0.01), p('detail', 'Detail', 'slider', 0.5, 0, 1, 0.01), p('paper', 'Paper grain', 'slider', 0.3, 0, 1, 0.01), p('paperColor', 'Paper colour', 'color', '#f7f3e8')] },
  { kind: 'color-replace', label: 'Replace colour', group: 'Colour', rasterised: true, params: [p('from', 'Replace', 'color', '#c8102e'), p('to', 'With', 'color', '#0057b8'), p('tolerance', 'Tolerance', 'slider', 40, 0, 255, 1), p('softness', 'Softness', 'slider', 0.3, 0, 1, 0.01), p('preserve', 'Preserve luminosity', 'checkbox', true)] },
  { kind: 'perspective', label: 'Interactive perspective', group: 'Distort', rasterised: true, hint: 'Correct keystone distortion from four corner handles.', params: [p('tl', 'Top-left', 'slider', 0, -1, 1, 0.01), p('tr', 'Top-right', 'slider', 0, -1, 1, 0.01), p('bl', 'Bottom-left', 'slider', 0, -1, 1, 0.01), p('br', 'Bottom-right', 'slider', 0, -1, 1, 0.01), p('vShift', 'Vertical shift', 'slider', 0, -0.5, 0.5, 0.01)] },
  { kind: 'block-shadow', label: 'Block shadow', group: 'Stylise', rasterised: true, hint: 'Stepped vector shadow — CorelDRAW\'s Block Shadow tool as an effect.', params: [p('dx', 'Offset X', 'slider', 6, -60, 60, 0.5), p('dy', 'Offset Y', 'slider', 6, -60, 60, 0.5), p('steps', 'Steps', 'slider', 6, 1, 40, 1), p('feather', 'Feather', 'slider', 0, 0, 30, 0.5), p('opacity', 'Opacity', 'slider', 0.85, 0, 1, 0.01), p('color', 'Colour', 'color', '#1b1b1b')] },
  { kind: 'canvas-opacity', label: 'Object opacity', group: 'Stylise', rasterised: false, params: [p('opacity', 'Opacity', 'slider', 1, 0, 1, 0.01), p('blend', 'Merge mode', 'select', 'normal', undefined, undefined, undefined, { options: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'].map((v) => ({ value: v, label: v })) })] },
]

export function effectDef(kind: string): EffectDef | undefined {
  return EFFECT_DEFS.find((d) => d.kind === kind)
}

export function defaultParams(kind: string): Record<string, any> {
  const def = effectDef(kind)
  if (!def) return {}
  const out: Record<string, any> = {}
  for (const param of def.params) out[param.key] = Array.isArray(param.default) ? JSON.parse(JSON.stringify(param.default)) : param.default
  return out
}

export function makeAdjustment(kind: Adjustment['kind'], id: string): Adjustment {
  return { id, type: 'adjustment', kind, enabled: true, opacity: 1, blend: 'normal', params: defaultParams(kind) }
}
export function makeEffect(kind: Effect['kind'], id: string): Effect {
  return { id, type: 'effect', kind, enabled: true, opacity: 1, blend: 'normal', params: defaultParams(kind) }
}

/* --------------------------------------------------------- adjustments ----- */

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d)

/** Apply one adjustment to RGBA bytes (in place on a copy). */
export function applyAdjustment(data: Bytes, adj: Adjustment): Bytes {
  const params = adj.params
  switch (adj.kind) {
    case 'brightness-contrast':
      return ImageKernels.adjustBasic(data, num(params.brightness), num(params.contrast), num(params.gamma, 1), num(params.saturation, 1))
    case 'hue-curve':
      return ImageKernels.adjustHSL(data, num(params.deg), num(params.sat, 1), num(params.light))
    case 'gamma':
      return ImageKernels.adjustBasic(data, 0, 0, num(params.value, 1), 1)
    case 'desaturate':
      return ImageKernels.adjustBasic(data, 0, 0, 1, 1 - clamp(num(params.amount, 1), 0, 1))
    case 'tone-curve': {
      const points = (params.points as CurvePoint[]) ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }]
      const lut = curveToLUT(points.map((pt) => ({ x: pt.x, y: pt.y })))
      const channel = str(params.channel, 'rgb')
      const luts = [identityLUT(), identityLUT(), identityLUT(), identityLUT()]
      if (channel === 'rgb') {
        luts[0] = lut; luts[1] = lut; luts[2] = lut
      } else {
        luts[channel === 'r' ? 0 : channel === 'g' ? 1 : 2] = lut
      }
      return ImageKernels.applyCurves(data, luts)
    }
    case 'levels': {
      const inB = clamp(num(params.inBlack, 0), 0, 254)
      const inW = clamp(num(params.inWhite, 255), inB + 1, 255)
      const g = clamp(num(params.gamma, 1), 0.05, 10)
      const outB = clamp(num(params.outBlack, 0), 0, 255)
      const outW = clamp(num(params.outWhite, 255), 0, 255)
      const lut = new Uint8Array(256)
      for (let i = 0; i < 256; i++) {
        const t = clamp((i - inB) / (inW - inB), 0, 1)
        lut[i] = clamp(Math.round(outB + (outW - outB) * t ** (1 / g)), 0, 255)
      }
      return ImageKernels.applyCurves(data, [lut, lut, lut, identityLUT()])
    }
    case 'posterize': {
      const levels = clamp(Math.round(num(params.levels, 6)), 2, 32)
      const lut = new Uint8Array(256)
      for (let i = 0; i < 256; i++) lut[i] = Math.round((Math.round((i / 255) * (levels - 1)) / (levels - 1)) * 255)
      return ImageKernels.applyCurves(data, [lut, lut, lut, identityLUT()])
    }
    case 'threshold': {
      const level = clamp(num(params.level, 128), 0, 255)
      const lut = new Uint8Array(256)
      for (let i = 0; i < 256; i++) lut[i] = i >= level ? 255 : 0
      return ImageKernels.applyCurves(data, [lut, lut, lut, identityLUT()])
    }
    case 'color-balance': {
      const { cR, mG, yB, preserveLum } = {
        cR: num(params.cR), mG: num(params.mG), yB: num(params.yB), preserveLum: bool(params.preserveLum, true),
      }
      const out = new Uint8ClampedArray(data.length)
      for (let i = 0; i < data.length; i += 4) {
        let r = data[i] + cR * 128
        let g = data[i + 1] + mG * 128
        let b = data[i + 2] + yB * 128
        if (preserveLum) {
          const before = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
          const after = 0.2126 * r + 0.7152 * g + 0.0722 * b
          const d = before - after
          r += d; g += d; b += d
        }
        out[i] = r
        out[i + 1] = g
        out[i + 2] = b
        out[i + 3] = data[i + 3]
      }
      return out
    }
    case 'channel-mixer': {
      const out = new Uint8ClampedArray(data.length)
      const mono = bool(params.mono)
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        out[i] = r * num(params.rr, 1) + g * num(params.rg) + b * num(params.rb)
        out[i + 1] = r * num(params.gr) + g * num(params.gg, 1) + b * num(params.gb)
        out[i + 2] = r * num(params.br) + g * num(params.bg) + b * num(params.bb, 1)
        if (mono) {
          const l = 0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2]
          out[i] = l; out[i + 1] = l; out[i + 2] = l
        }
        out[i + 3] = data[i + 3]
      }
      return out
    }
    case 'vibrance': {
      const amount = num(params.amount)
      const skin = num(params.skin, 0.4)
      const out = new Uint8ClampedArray(data.length)
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255
        const g = data[i + 1] / 255
        const b = data[i + 2] / 255
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const sat = max === 0 ? 0 : (max - min) / max
        // Skin-tone guard: hues between ~20° and ~50° with mid saturation.
        const hue = max === min ? 0 : max === r ? ((g - b) / (max - min)) * 60 : max === g ? ((b - r) / (max - min) + 2) * 60 : ((r - g) / (max - min) + 4) * 60
        const isSkin = hue >= 10 && hue <= 55 && sat > 0.1 && sat < 0.75
        const scale = 1 + amount * (1 - sat) * (isSkin ? 1 - skin : 1)
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
        out[i] = (l + (r - l) * scale) * 255
        out[i + 1] = (l + (g - l) * scale) * 255
        out[i + 2] = (l + (b - l) * scale) * 255
        out[i + 3] = data[i + 3]
      }
      return out
    }
    case 'selective-color': {
      const range = str(params.range, 'reds')
      const target = rangeToHue(range)
      const out = new Uint8ClampedArray(data.length)
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] / 255
        const g = data[i + 1] / 255
        const b = data[i + 2] / 255
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const sat = max === 0 ? 0 : (max - min) / max
        const l = (max + min) / 2
        let weight = 0
        if (target === null) {
          weight = range === 'neutrals' ? clamp(1 - sat * 3, 0, 1)
            : range === 'blacks' ? clamp(1 - l * 2, 0, 1)
              : clamp((l - 0.5) * 2, 0, 1)
        } else {
          const hue = max === min ? 0 : max === r ? ((g - b) / (max - min)) * 60 : max === g ? ((b - r) / (max - min) + 2) * 60 : ((r - g) / (max - min) + 4) * 60
          let diff = Math.abs(hue - target)
          if (diff > 180) diff = 360 - diff
          weight = clamp(1 - diff / 60, 0, 1) * clamp(sat * 3, 0, 1)
        }
        const c = num(params.c) * weight
        const m = num(params.m) * weight
        const y = num(params.y) * weight
        const k = num(params.k) * weight
        out[i] = clamp(r - c * (1 - r) + y * r, 0, 1) * 255
        out[i + 1] = clamp(g - m * (1 - g) + c * g, 0, 1) * 255
        out[i + 2] = clamp(b - y * (1 - b) + m * b, 0, 1) * 255
        out[i + 3] = data[i + 3]
        if (k) {
          const scale = 1 - k
          out[i] *= scale; out[i + 1] *= scale; out[i + 2] *= scale
        }
      }
      return out
    }
    default:
      return data
  }
}

function rangeToHue(range: string): number | null {
  switch (range) {
    case 'reds': return 0
    case 'yellows': return 55
    case 'greens': return 120
    case 'cyans': return 180
    case 'blues': return 225
    case 'magentas': return 300
    default: return null
  }
}

/* ------------------------------------------------------------- effects ----- */

export interface EffectContext {
  width: number
  height: number
  /** Seed for deterministic effects. */
  seed?: number
}

/**
 * Apply one effect to an RGBA buffer. Effects that need resampling return a new
 * size through `sizeOut`.
 */
export function applyEffect(
  data: Bytes,
  ctx: EffectContext,
  effect: Effect,
  sizeOut?: { w: number; h: number },
): Bytes {
  const params = effect.params
  const w = ctx.width
  const h = ctx.height
  if (sizeOut) {
    sizeOut.w = w
    sizeOut.h = h
  }
  switch (effect.kind) {
    case 'gaussian-blur':
      return ImageKernels.gaussianBlur(data, w, h, Math.round(num(params.radius)), bool(params.blurAlpha) ? 1 : 0)
    case 'sharpen':
      return ImageKernels.sharpen(data, w, h, num(params.amount, 0.6))
    case 'jpeg-restore':
      return ImageKernels.jpegRestore(data, w, h, num(params.strength, 0.6))
    case 'blur-mask': {
      const focus = num(params.focusY, 0.5)
      const band = clamp(num(params.band, 0.2), 0.01, 1)
      const radius = Math.round(num(params.radius, 14))
      const blur = ImageKernels.gaussianBlur(data, w, h, Math.max(1, radius), 1)
      const out = new Uint8ClampedArray(data.length)
      for (let y = 0; y < h; y++) {
        const t = y / Math.max(1, h - 1)
        const d = Math.abs(t - focus)
        let mix = clamp((d - band / 2) / Math.max(1e-6, 0.5 - band / 2), 0, 1)
        if (bool(params.invert)) mix = 1 - mix
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          for (let k = 0; k < 4; k++) out[i + k] = data[i + k] * (1 - mix) + blur[i + k] * mix
        }
      }
      return out
    }
    case 'lens':
      return lensWarp(data, w, h, num(params.amount, 0.25), num(params.zoom, 1), str(params.edge, 'clamp') === 'transparent')
    case 'upsample': {
      const scale = clamp(num(params.scale, 2), 1, 4)
      const dw = Math.max(1, Math.round(w * scale))
      const dh = Math.max(1, Math.round(h * scale))
      const mode = str(params.mode, 'mitchell')
      const modeIndex = mode === 'bilinear' ? 0 : mode === 'bicubic' ? 1 : mode === 'box' ? 3 : 2
      let out: Bytes = ImageKernels.resample(data, w, h, dw, dh, modeIndex)
      const post = num(params.sharpen, 0.35)
      if (post > 0) out = ImageKernels.sharpen(out, dw, dh, post)
      if (sizeOut) {
        sizeOut.w = dw
        sizeOut.h = dh
      }
      return out
    }
    case 'noise': {
      const amount = num(params.amount, 0.12)
      const mono = bool(params.monochrome, true)
      const rng = makeRng(Math.round(num(params.seed, 7)) + 1)
      const out = new Uint8ClampedArray(data)
      for (let i = 0; i < out.length; i += 4) {
        const n = (rng() - 0.5) * 2 * amount * 255
        if (mono) {
          out[i] += n; out[i + 1] += n; out[i + 2] += n
        } else {
          out[i] += (rng() - 0.5) * 2 * amount * 255
          out[i + 1] += (rng() - 0.5) * 2 * amount * 255
          out[i + 2] += (rng() - 0.5) * 2 * amount * 255
        }
      }
      return out
    }
    case 'pixelate': {
      const size = Math.max(2, Math.round(num(params.size, 8)))
      const out = new Uint8ClampedArray(data)
      for (let by = 0; by < h; by += size) {
        for (let bx = 0; bx < w; bx += size) {
          let r = 0; let g = 0; let b = 0; let a = 0; let n = 0
          for (let y = by; y < Math.min(h, by + size); y++) {
            for (let x = bx; x < Math.min(w, bx + size); x++) {
              const i = (y * w + x) * 4
              r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++
            }
          }
          if (!n) continue
          for (let y = by; y < Math.min(h, by + size); y++) {
            for (let x = bx; x < Math.min(w, bx + size); x++) {
              const i = (y * w + x) * 4
              out[i] = r / n; out[i + 1] = g / n; out[i + 2] = b / n; out[i + 3] = a / n
            }
          }
        }
      }
      return out
    }
    case 'artistic':
      return artisticStyle(data, w, h, str(params.style, 'watercolor'), num(params.strength, 0.75), num(params.detail, 0.5), num(params.paper, 0.3), str(params.paperColor, '#f7f3e8'))
    case 'color-replace': {
      const from = hexToRgb(str(params.from, '#c8102e'))
      const to = hexToRgb(str(params.to, '#0057b8'))
      const tol = num(params.tolerance, 40)
      const soft = clamp(num(params.softness, 0.3), 0.001, 1)
      const preserve = bool(params.preserve, true)
      const out = new Uint8ClampedArray(data.length)
      for (let i = 0; i < data.length; i += 4) {
        const d = Math.sqrt((data[i] - from.r) ** 2 + (data[i + 1] - from.g) ** 2 + (data[i + 2] - from.b) ** 2)
        const weight = 1 - clamp((d - tol) / (255 * soft), 0, 1)
        const lumBefore = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
        let nr = data[i] * (1 - weight) + to.r * weight
        let ng = data[i + 1] * (1 - weight) + to.g * weight
        let nb = data[i + 2] * (1 - weight) + to.b * weight
        if (preserve) {
          const lumAfter = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb
          const delta = lumBefore - lumAfter
          nr += delta; ng += delta; nb += delta
        }
        out[i] = nr; out[i + 1] = ng; out[i + 2] = nb; out[i + 3] = data[i + 3]
      }
      return out
    }
    case 'perspective':
      return perspectiveCorrect(data, w, h, {
        tl: num(params.tl), tr: num(params.tr), bl: num(params.bl), br: num(params.br), vShift: num(params.vShift),
      })
    case 'block-shadow':
      return blockShadowRaster(data, w, h, {
        dx: num(params.dx, 6), dy: num(params.dy, 6), steps: Math.round(num(params.steps, 6)),
        feather: num(params.feather), opacity: num(params.opacity, 0.85), color: hexToRgb(str(params.color, '#1b1b1b')),
      })
    default:
      return data
  }
}

export function hexToRgb(hex: string): RGBA {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
    a: full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  }
}

/* ----------------------------------------------------------- operators ----- */

function lensWarp(data: Bytes, w: number, h: number, amount: number, zoom: number, transparentEdges: boolean): Bytes {
  const out = new Uint8ClampedArray(data.length)
  const cx = w / 2
  const cy = h / 2
  const maxR = Math.hypot(cx, cy)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / maxR
      const dy = (y - cy) / maxR
      const r2 = dx * dx + dy * dy
      const f = 1 + amount * r2
      const sx = cx + (dx / f / zoom) * maxR
      const sy = cy + (dy / f / zoom) * maxR
      const o = (y * w + x) * 4
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) {
        if (transparentEdges) {
          out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0
        } else {
          const cxs = clamp(sx, 0, w - 1)
          const cys = clamp(sy, 0, h - 1)
          const so = (Math.round(cys) * w + Math.round(cxs)) * 4
          out[o] = data[so]; out[o + 1] = data[so + 1]; out[o + 2] = data[so + 2]; out[o + 3] = data[so + 3]
        }
        continue
      }
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const tx = sx - x0
      const ty = sy - y0
      for (let k = 0; k < 4; k++) {
        const a = data[(y0 * w + x0) * 4 + k]
        const b = data[(y0 * w + x0 + 1) * 4 + k]
        const c = data[((y0 + 1) * w + x0) * 4 + k]
        const d = data[((y0 + 1) * w + x0 + 1) * 4 + k]
        const top = a + (b - a) * tx
        const bot = c + (d - c) * tx
        out[o + k] = top + (bot - top) * ty
      }
    }
  }
  return out
}

function perspectiveCorrect(
  data: Bytes, w: number, h: number,
  corners: { tl: number; tr: number; bl: number; br: number; vShift: number },
): Bytes {
  // Four extractions: each corner handle pulls its side, then we warp back.
  const srcPts = [
    { x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: 0, y: h - 1 }, { x: w - 1, y: h - 1 },
  ]
  const dx = w * corners.tl * 0.25
  const dx2 = w * corners.tr * 0.25
  const dx3 = w * corners.bl * 0.25
  const dx4 = w * corners.br * 0.25
  const dy = h * corners.vShift * 0.5
  const dstPts = [
    { x: 0 + dx, y: 0 + corners.tl * h * 0.12 + dy },
    { x: w - 1 + dx2, y: 0 + corners.tr * h * 0.12 + dy },
    { x: 0 + dx3, y: h - 1 + corners.bl * h * 0.12 + dy },
    { x: w - 1 + dx4, y: h - 1 + corners.br * h * 0.12 + dy },
  ]
  // Solve the homography that maps dst → src and sample backwards.
  const H = solveHomography(dstPts, srcPts)
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wgt = H[6] * x + H[7] * y + H[8]
      const sx = (H[0] * x + H[1] * y + H[2]) / (wgt || 1e-9)
      const sy = (H[3] * x + H[4] * y + H[5]) / (wgt || 1e-9)
      const o = (y * w + x) * 4
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0
        continue
      }
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const tx = sx - x0
      const ty = sy - y0
      for (let k = 0; k < 4; k++) {
        const a = data[(y0 * w + x0) * 4 + k]
        const b = data[(y0 * w + x0 + 1) * 4 + k]
        const c = data[((y0 + 1) * w + x0) * 4 + k]
        const d = data[((y0 + 1) * w + x0 + 1) * 4 + k]
        const top = a + (b - a) * tx
        const bot = c + (d - c) * tx
        out[o + k] = top + (bot - top) * ty
      }
    }
  }
  return out
}

function solveHomography(src: { x: number; y: number }[], dst: { x: number; y: number }[]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    A.push([src[i].x, src[i].y, 1, 0, 0, 0, -dst[i].x * src[i].x, -dst[i].x * src[i].y])
    b.push(dst[i].x)
    A.push([0, 0, 0, src[i].x, src[i].y, 1, -dst[i].y * src[i].x, -dst[i].y * src[i].y])
    b.push(dst[i].y)
  }
  const n = 8
  for (let i = 0; i < n; i++) {
    let pivot = i
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r
    ;[A[i], A[pivot]] = [A[pivot], A[i]]
    ;[b[i], b[pivot]] = [b[pivot], b[i]]
    const pv = A[i][i] || 1e-12
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / pv
      if (!f) continue
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]
      b[r] -= f * b[i]
    }
  }
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i]
    for (let c = i + 1; c < n; c++) sum -= A[i][c] * x[c]
    x[i] = sum / (A[i][i] || 1e-12)
  }
  return [...x, 1]
}

function blockShadowRaster(
  data: Bytes, w: number, h: number,
  opts: { dx: number; dy: number; steps: number; feather: number; opacity: number; color: RGBA },
): Bytes {
  const alpha = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) alpha[p] = data[p * 4 + 3]
  let mask = ImageKernels.blockShadowMask(alpha, w, h, opts.dx, opts.dy, Math.max(1, opts.steps))
  if (opts.feather > 0) mask = ImageKernels.maskFeather(mask, w, h, Math.round(opts.feather))
  const shadow = ImageKernels.renderShadow(mask.subarray(0, w * h), w, h, { ...opts.color, a: opts.opacity })
  // Composite the original over the shadow.
  return ImageKernels.compositeOver(shadow, data, 1)
}

/**
 * Artistic styles are deterministic filter recipes. Each recipe is a sequence of
 * the primitives above (blur, curves, colour maths, posterise) plus a procedural
 * paper/brush texture generated from a seeded noise field.
 */
function artisticStyle(
  data: Bytes, w: number, h: number,
  style: string, strength: number, detail: number, paper: number, paperColor: string,
): Bytes {
  const s = clamp(strength, 0, 1)
  const d = clamp(detail, 0, 1)
  const paperRgb = hexToRgb(paperColor)
  let work: Bytes = new Uint8ClampedArray(data)

  const toGray = (amount: number) => {
    work = ImageKernels.adjustBasic(work, 0, 0, 1, 1 - amount)
  }
  const posterise = (levels: number) => {
    const lut = new Uint8Array(256)
    for (let i = 0; i < 256; i++) lut[i] = Math.round((Math.round((i / 255) * (levels - 1)) / (levels - 1)) * 255)
    work = ImageKernels.applyCurves(work, [lut, lut, lut, identityLUT()])
  }
  const contrastS = (c: number) => {
    work = ImageKernels.adjustBasic(work, 0, c, 1, 1)
  }
  const blur = (r: number) => {
    if (r >= 1) work = ImageKernels.gaussianBlur(work, w, h, Math.round(r), 1)
  }

  switch (style) {
    case 'watercolor': {
      blur(1 + s * 3)
      posterise(Math.round(12 - s * 7))
      const detailGrain = ImageKernels.sharpen(work, w, h, 0.4 + d)
      work = detailGrain
      break
    }
    case 'oil': {
      // Bristle pass: median-ish flattening via repeated small blurs + posterise.
      blur(2 + s * 2)
      posterise(Math.round(10 - s * 6))
      contrastS(0.25 + s * 0.3)
      break
    }
    case 'impressionist': {
      blur(3 + s * 5)
      contrastS(0.2)
      work = ImageKernels.adjustBasic(work, 0.03, 0.1, 1, 1.35)
      posterise(16)
      break
    }
    case 'pencil': {
      toGray(1)
      contrastS(0.2)
      const edges = edgeMap(work, w, h)
      work = edges
      if (paper < 0.05) break
      work = blendPaper(work, w, h, paper, paperRgb, d)
      break
    }
    case 'charcoal': {
      toGray(0.85)
      contrastS(0.45)
      work = edgeMap(work, w, h, 4)
      work = blendPaper(work, w, h, Math.max(paper, 0.35), paperRgb, d)
      break
    }
    case 'pastel': {
      work = ImageKernels.adjustBasic(work, 0.12, -0.15, 1, 1.25)
      blur(1)
      work = blendPaper(work, w, h, Math.max(paper, 0.3), paperRgb, d)
      break
    }
    case 'marker': {
      posterise(9)
      contrastS(0.2)
      work = ImageKernels.adjustBasic(work, 0, 0, 1, 1.4)
      break
    }
    case 'woodcut': {
      toGray(1)
      contrastS(0.7)
      const lut = new Uint8Array(256)
      const cut = 128 + (s - 0.5) * 60
      for (let i = 0; i < 256; i++) lut[i] = i < cut ? 0 : 255
      work = ImageKernels.applyCurves(work, [lut, lut, lut, identityLUT()])
      const ink = hexToRgb('#141210')
      work = tintSolid(work, w, h, ink, paperRgb)
      break
    }
    case 'poster': {
      posterise(Math.round(5 - s * 2))
      contrastS(0.3)
      work = ImageKernels.adjustBasic(work, 0, 0, 1, 1.5)
      break
    }
    case 'halftone': {
      work = halftone(work, w, h, 3 + Math.round((1 - d) * 5))
      break
    }
    case 'ink': {
      toGray(0.9)
      contrastS(0.55)
      blur(1)
      posterise(4)
      const ink = hexToRgb('#101726')
      work = tintSolid(work, w, h, ink, paperRgb)
      break
    }
    case 'emboss': {
      toGray(1)
      work = emboss(work, w, h)
      contrastS(0.35)
      break
    }
    case 'mosaic': {
      const cell = 4 + Math.round((1 - d) * 14)
      work = mosaicCells(work, w, h, cell)
      break
    }
    case 'linocut': {
      toGray(1)
      contrastS(0.8)
      const lut = new Uint8Array(256)
      for (let i = 0; i < 256; i++) lut[i] = i < 140 ? 0 : 255
      work = ImageKernels.applyCurves(work, [lut, lut, lut, identityLUT()])
      work = ImageKernels.gaussianBlur(work, w, h, 1, 1)
      work = blendPaper(work, w, h, Math.max(paper, 0.4), paperRgb, d)
      break
    }
    default:
      break
  }
  // Global strength blend against the original.
  if (s < 1) {
    for (let i = 0; i < work.length; i += 4) {
      work[i] = data[i] * (1 - s) + work[i] * s
      work[i + 1] = data[i + 1] * (1 - s) + work[i + 1] * s
      work[i + 2] = data[i + 2] * (1 - s) + work[i + 2] * s
      work[i + 3] = Math.max(data[i + 3], work[i + 3] * s)
    }
  }
  return work
}

function edgeMap(data: Bytes, w: number, h: number, radius = 2): Bytes {
  const blurred = ImageKernels.gaussianBlur(data, w, h, radius, 0)
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dx = x > 0 && x < w - 1
        ? 0.2126 * (blurred[i + 4] - blurred[i - 4]) + 0.7152 * (blurred[i + 5] - blurred[i - 3]) + 0.0722 * (blurred[i + 6] - blurred[i - 2])
        : 0
      const dy = y > 0 && y < h - 1
        ? 0.2126 * (blurred[i + w * 4] - blurred[i - w * 4]) + 0.7152 * (blurred[i + w * 4 + 1] - blurred[i - w * 4 + 1]) + 0.0722 * (blurred[i + w * 4 + 2] - blurred[i - w * 4 + 2])
        : 0
      const mag = Math.min(255, Math.hypot(dx, dy) * 1.6)
      const v = 255 - mag
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = data[i + 3]
    }
  }
  return out
}

function emboss(data: Bytes, w: number, h: number): Bytes {
  const out = new Uint8ClampedArray(data.length)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      const a = (y - 1) * w + (x - 1)
      const b = (y + 1) * w + (x + 1)
      for (let k = 0; k < 3; k++) {
        out[i + k] = clamp(128 + (data[a * 4 + k] - data[b * 4 + k]), 0, 255)
      }
      out[i + 3] = data[i + 3]
    }
  }
  return out
}

function halftone(data: Bytes, w: number, h: number, cell: number): Bytes {
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      let lum = 0
      let n = 0
      for (let yy = y; yy < Math.min(h, y + cell); yy++) {
        for (let xx = x; xx < Math.min(w, x + cell); xx++) {
          const i = (yy * w + xx) * 4
          lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
          n++
        }
      }
      const avg = n ? lum / n : 255
      const dotScale = 1 - avg / 255
      const cx = x + cell / 2
      const cy = y + cell / 2
      const r = (cell / 2) * Math.sqrt(dotScale)
      for (let yy = y; yy < Math.min(h, y + cell); yy++) {
        for (let xx = x; xx < Math.min(w, x + cell); xx++) {
          const i = (yy * w + xx) * 4
          const inside = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) <= r
          const v = inside ? 0 : 255
          out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = data[i + 3]
        }
      }
    }
  }
  return out
}

function mosaicCells(data: Bytes, w: number, h: number, cell: number): Bytes {
  const out = new Uint8ClampedArray(data)
  const rng = makeRng(1337)
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const i = (Math.min(h - 1, y + (cell >> 1)) * w + Math.min(w - 1, x + (cell >> 1))) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const jitter = (rng() - 0.5) * 18
      for (let yy = y; yy < Math.min(h, y + cell); yy++) {
        for (let xx = x; xx < Math.min(w, x + cell); xx++) {
          const o = (yy * w + xx) * 4
          out[o] = r + jitter
          out[o + 1] = g + jitter
          out[o + 2] = b + jitter
          out[o + 3] = data[o + 3]
        }
      }
    }
  }
  return out
}

function blendPaper(
  data: Bytes, w: number, h: number, amount: number, paper: RGBA, detail: number,
): Bytes {
  const out = new Uint8ClampedArray(data.length)
  const rng = makeRng(4242)
  const grain = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) grain[i] = rng()
  // Cheap value-noise smoothing for a paper tooth look.
  const smooth = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      smooth[i] = (grain[i] * 4 + grain[i - 1] + grain[i + 1] + grain[i - w] + grain[i + w]) / 8
    }
  }
  const amp = amount * (0.55 + detail * 0.45)
  for (let p = 0; p < w * h; p++) {
    const i = p * 4
    const tooth = (smooth[p] - 0.5) * 2 * amp
    for (let k = 0; k < 3; k++) {
      const v = data[i + k]
      const target = k === 0 ? paper.r : k === 1 ? paper.g : paper.b
      // Areas the "paint" did not cover show paper.
      out[i + k] = clamp(v * (1 - amp * 0.35) + target * amp * 0.35 + tooth * 26, 0, 255)
    }
    out[i + 3] = data[i + 3]
  }
  return out
}

function tintSolid(data: Bytes, w: number, h: number, dark: RGBA, light: RGBA): Bytes {
  const out = new Uint8ClampedArray(data.length)
  for (let p = 0; p < w * h; p++) {
    const i = p * 4
    const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
    for (let k = 0; k < 3; k++) out[i + k] = (dark as unknown as number[])[k] * l + (light as unknown as number[])[k] * (1 - l)
    out[i + 3] = data[i + 3]
  }
  return out
}

/* -------------------------------------------------------- stack runner ----- */

export interface EffectStackResult {
  data: Bytes
  width: number
  height: number
}

/**
 * Evaluate a non-destructive stack over RGBA bytes. Adjustments run first (they
 * never change the pixel grid), effects after, in the order they were added.
 */
export function runStack(
  data: Bytes,
  width: number,
  height: number,
  stack: NonDestructive[],
): EffectStackResult {
  let work: Bytes = new Uint8ClampedArray(data)
  let w = width
  let h = height
  for (const entry of stack) {
    if (!entry.enabled) continue
    const sizeOut = { w, h }
    const next = entry.type === 'adjustment'
      ? applyAdjustment(work, entry)
      : applyEffect(work, { width: w, height: h }, entry, sizeOut)
    if (entry.opacity < 1 || entry.blend !== 'normal') {
      work = ImageKernels.blend(work, next, BLEND_INDEX[entry.blend as BlendMode] ?? 0, clamp(entry.opacity, 0, 1))
    } else {
      work = next
    }
    if (entry.type === 'effect' && (sizeOut.w !== w || sizeOut.h !== h)) {
      w = sizeOut.w
      h = sizeOut.h
    }
  }
  return { data: work, width: w, height: h }
}

/** Preview a stack on a small canvas (adjustment dockers use this for live preview). */
export function stackSignature(stack: NonDestructive[]): string {
  return stack
    .filter((e) => e.enabled)
    .map((e) => `${e.kind}:${Object.entries(e.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}:${e.opacity}:${e.blend}`)
    .join('|')
}

export function effectSwatch(style: string): string {
  const map: Record<string, string> = {
    watercolor: 'linear-gradient(135deg,#7fd0b0,#33477a)',
    oil: 'linear-gradient(135deg,#e4a667,#7a5c1e)',
    pencil: 'linear-gradient(135deg,#d9d9d9,#4d4d4d)',
    charcoal: 'linear-gradient(135deg,#8a8782,#141312)',
  }
  return map[style] ?? 'linear-gradient(135deg,#12a19a,#1b6cd6)'
}

export const BLEND_OPTIONS = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
].map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1).replace('-', ' ') }))

export const ADJUSTMENT_PREVIEW_STYLE = css(rgb(18, 161, 154, 0.12))
