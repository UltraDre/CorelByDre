/**
 * Vector and bitmap pattern fills.
 *
 * Vector patterns are drawn procedurally onto a tile canvas; bitmap textures are
 * deterministic noise fields (paper, canvas, grain, sand, watercolour wash...).
 * Nothing here is sampled or learned — every tile is a closed-form drawing routine
 * seeded by the pattern id, so tiles are byte-identical between sessions.
 */
import type { PatternFill, RGBA } from '../types'
import { css } from './color'
import { TAU, makeRng } from './util'

export interface PatternPreset { id: string; label: string; family: 'Vector' | 'Bitmap' | 'PostScript' }

export const VECTOR_PATTERNS: PatternPreset[] = [
  'stripes-h', 'stripes-v', 'stripes-diag', 'stripes-thick', 'dots-small', 'dots-large',
  'checks', 'checker-small', 'grid', 'crosshatch', 'hatch-diag', 'diamond',
  'triangles', 'chevron', 'herringbone', 'basket', 'brick', 'scallop',
  'waves', 'hexagons', 'plus', 'stars', 'flowers', 'circles-outline',
  'concentric', 'sunburst', 'trellis', 'zigzag', 'plaid', 'polka',
].map((id) => ({ id, label: id.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' '), family: 'Vector' as const }))

export const BITMAP_TEXTURES: PatternPreset[] = [
  'paper-rough', 'paper-smooth', 'canvas', 'linen', 'grain-fine', 'grain-coarse',
  'sand', 'watercolor-wash', 'ink-bleed', 'chalk-dust', 'sponge', 'marble',
  'wood', 'rust', 'concrete', 'frost', 'burlap', 'noise-mono', 'noise-color', 'speckle',
].map((id) => ({ id, label: id.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' '), family: 'Bitmap' as const }))

export const POSTSCRIPT_PATTERNS: PatternPreset[] = [
  'ps-lines', 'ps-rings', 'ps-starburst', 'ps-waveform', 'ps-maze', 'ps-crossdot', 'ps-burst',
].map((id) => ({ id, label: id.replace('ps-', 'PS ').toUpperCase(), family: 'PostScript' as const }))

export const ALL_PATTERNS = [...VECTOR_PATTERNS, ...BITMAP_TEXTURES, ...POSTSCRIPT_PATTERNS]

const tileCache = new Map<string, HTMLCanvasElement>()

export function getPatternTile(fill: PatternFill): HTMLCanvasElement {
  const key = `${fill.preset}|${fill.fg.r},${fill.fg.g},${fill.fg.b},${fill.fg.a}|${fill.bg.r},${fill.bg.g},${fill.bg.b}|${fill.tileSize}|${fill.dataUrl ? fill.dataUrl.slice(-16) : ''}`
  const hit = tileCache.get(key)
  if (hit) return hit
  const size = Math.max(6, Math.round(fill.tileSize || 24))
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  if (fill.dataUrl) {
    const img = new Image()
    img.onload = () => {
      ctx.clearRect(0, 0, size, size)
      const scale = Math.min(size / img.width, size / img.height)
      ctx.drawImage(img, 0, 0, img.width * scale, img.height * scale)
    }
    img.src = fill.dataUrl
  } else if (fill.preset.startsWith('ps:')) {
    drawPostScript(ctx, size, fill.preset.slice(3), fill.fg, fill.bg)
  } else if (fill.preset.startsWith('texture:')) {
    drawTexture(ctx, size, fill.preset.slice(8), fill.fg, fill.bg)
  } else if (BITMAP_TEXTURES.some((p) => p.id === fill.preset)) {
    drawTexture(ctx, size, fill.preset, fill.fg, fill.bg)
  } else {
    drawVectorPattern(ctx, size, fill.preset, fill.fg, fill.bg)
  }
  tileCache.set(key, canvas)
  if (tileCache.size > 160) {
    const first = tileCache.keys().next().value
    if (first && first !== key) tileCache.delete(first)
  }
  return canvas
}

export function patternTransform(fill: Pick<PatternFill, 'scale' | 'rotation'>, bounds: { x: number; y: number; w: number; h: number }) {
  const s = fill.scale || 1
  const rot = ((fill.rotation || 0) * Math.PI) / 180
  const cos = Math.cos(rot) * s
  const sin = Math.sin(rot) * s
  return { a: cos, b: sin, c: -sin, d: cos, e: bounds.x, f: bounds.y }
}

/* ------------------------------------------------------- vector patterns --- */

function drawVectorPattern(ctx: CanvasRenderingContext2D, s: number, id: string, fg: RGBA, bg: RGBA): void {
  const f = css({ ...fg, a: 1 })
  ctx.fillStyle = css({ ...bg, a: 1 })
  ctx.fillRect(0, 0, s, s)
  ctx.strokeStyle = f
  ctx.fillStyle = f
  ctx.lineWidth = Math.max(1, s / 12)
  const h = s / 2
  const q = s / 4
  switch (id) {
    case 'stripes-h': ctx.fillRect(0, 0, s, s / 3); break
    case 'stripes-v': ctx.fillRect(0, 0, s / 3, s); break
    case 'stripes-diag':
    case 'hatch-diag': {
      ctx.beginPath()
      for (let i = -s; i < s * 2; i += s / 3) {
        ctx.moveTo(i, 0)
        ctx.lineTo(i + s, s)
      }
      ctx.stroke()
      break
    }
    case 'stripes-thick': ctx.fillRect(0, 0, s, s / 2); break
    case 'dots-small':
    case 'polka': {
      ctx.beginPath()
      ctx.arc(h, h, s / 10, 0, TAU)
      ctx.fill()
      break
    }
    case 'dots-large': {
      ctx.beginPath()
      ctx.arc(h, h, s / 4, 0, TAU)
      ctx.fill()
      break
    }
    case 'checks':
    case 'checker-small': {
      const c = s / 4
      ctx.fillRect(0, 0, c, c)
      ctx.fillRect(c, c, c, c)
      ctx.fillRect(0, c * 2, c, c)
      ctx.fillRect(c * 2, c * 2, c, c)
      break
    }
    case 'grid': {
      ctx.beginPath()
      ctx.moveTo(0, h)
      ctx.lineTo(s, h)
      ctx.moveTo(h, 0)
      ctx.lineTo(h, s)
      ctx.stroke()
      break
    }
    case 'crosshatch': {
      ctx.beginPath()
      ctx.moveTo(0, 0); ctx.lineTo(s, s)
      ctx.moveTo(s, 0); ctx.lineTo(0, s)
      ctx.stroke()
      break
    }
    case 'diamond': {
      ctx.beginPath()
      ctx.moveTo(h, 0); ctx.lineTo(s, h); ctx.lineTo(h, s); ctx.lineTo(0, h); ctx.closePath()
      ctx.fill()
      break
    }
    case 'triangles': {
      ctx.beginPath()
      ctx.moveTo(0, s); ctx.lineTo(h, 0); ctx.lineTo(q * 3, s)
      ctx.closePath(); ctx.fill()
      break
    }
    case 'chevron':
    case 'zigzag': {
      ctx.beginPath()
      ctx.moveTo(0, q * 3)
      ctx.lineTo(q, q)
      ctx.lineTo(h, q * 3)
      ctx.lineTo(q * 3, q)
      ctx.lineTo(s, q * 3)
      ctx.stroke()
      break
    }
    case 'herringbone': {
      ctx.beginPath()
      ctx.moveTo(0, q); ctx.lineTo(q, 0); ctx.lineTo(h, q); ctx.lineTo(q, h); ctx.closePath()
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(h, q * 3); ctx.lineTo(q * 3, h); ctx.lineTo(s, q * 3); ctx.lineTo(q * 3, q * 3)
      ctx.closePath(); ctx.fill()
      break
    }
    case 'basket': {
      ctx.beginPath()
      ctx.moveTo(0, 0); ctx.lineTo(h, h); ctx.lineTo(s, 0)
      ctx.moveTo(0, h); ctx.lineTo(h, s); ctx.lineTo(s, h)
      ctx.stroke()
      break
    }
    case 'brick': {
      ctx.beginPath()
      ctx.moveTo(0, h); ctx.lineTo(s, h)
      ctx.moveTo(h, 0); ctx.lineTo(h, h)
      ctx.moveTo(0, h); ctx.lineTo(0, s)
      ctx.moveTo(s, h); ctx.lineTo(s, s)
      ctx.stroke()
      break
    }
    case 'scallop': {
      ctx.beginPath()
      for (let i = 0; i <= 2; i++) ctx.arc(i * h - h / 2, h, h, Math.PI, 0)
      ctx.stroke()
      break
    }
    case 'waves': {
      ctx.beginPath()
      for (let x = 0; x <= s; x++) {
        const y = h + Math.sin((x / s) * TAU) * (s / 8)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      break
    }
    case 'hexagons': {
      ctx.beginPath()
      const r = s / 3
      for (let i = 0; i < 6; i++) {
        const a = (TAU * i) / 6
        const x = h + r * Math.cos(a)
        const y = h + r * Math.sin(a)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.stroke()
      break
    }
    case 'plus': {
      ctx.fillRect(h - s / 8, 0, s / 4, s)
      ctx.fillRect(0, h - s / 8, s, s / 4)
      break
    }
    case 'stars': {
      ctx.beginPath()
      for (let i = 0; i < 10; i++) {
        const a = (TAU * i) / 10 - Math.PI / 2
        const r = i % 2 ? s / 10 : s / 4
        const x = h + r * Math.cos(a)
        const y = h + r * Math.sin(a)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath(); ctx.fill()
      break
    }
    case 'flowers': {
      for (let i = 0; i < 4; i++) {
        const a = (TAU * i) / 4
        ctx.beginPath()
        ctx.ellipse(h + Math.cos(a) * (s / 6), h + Math.sin(a) * (s / 6), s / 8, s / 8, 0, 0, TAU)
        ctx.fill()
      }
      break
    }
    case 'circles-outline':
    case 'concentric': {
      for (let r = s / 8; r < s * 0.75; r += s / 4) {
        ctx.beginPath()
        ctx.arc(h, h, r, 0, TAU)
        ctx.stroke()
      }
      break
    }
    case 'sunburst': {
      ctx.beginPath()
      for (let i = 0; i < 12; i++) {
        const a = (TAU * i) / 12
        ctx.moveTo(h, h)
        ctx.lineTo(h + Math.cos(a) * s, h + Math.sin(a) * s)
      }
      ctx.lineWidth = Math.max(1, s / 24)
      ctx.stroke()
      break
    }
    case 'trellis': {
      ctx.beginPath()
      ctx.moveTo(0, 0); ctx.lineTo(s, s)
      ctx.moveTo(s, 0); ctx.lineTo(0, s)
      ctx.moveTo(0, h); ctx.lineTo(s, h)
      ctx.stroke()
      break
    }
    case 'plaid': {
      ctx.globalAlpha = 0.5
      ctx.fillRect(0, 0, s / 3, s)
      ctx.fillRect(0, 0, s, s / 3)
      ctx.globalAlpha = 1
      break
    }
    default: {
      ctx.beginPath()
      ctx.arc(h, h, s / 6, 0, TAU)
      ctx.fill()
    }
  }
}

/* ------------------------------------------------------- bitmap textures --- */

function drawTexture(ctx: CanvasRenderingContext2D, s: number, id: string, fg: RGBA, bg: RGBA): void {
  const rng = makeRng(hashString(id))
  ctx.fillStyle = css(bg)
  ctx.fillRect(0, 0, s, s)
  const img = ctx.getImageData(0, 0, s, s)
  const data = img.data
  const fgR = fg.r
  const fgG = fg.g
  const fgB = fg.b

  const setPx = (x: number, y: number, t: number) => {
    const i = ((y + s) % s * s + ((x + s) % s)) * 4
    data[i] = data[i] * (1 - t) + fgR * t
    data[i + 1] = data[i + 1] * (1 - t) + fgG * t
    data[i + 2] = data[i + 2] * (1 - t) + fgB * t
    data[i + 3] = 255
  }

  const noiseField = (scale: number) => {
    const w = Math.ceil(s / scale) + 2
    const grid = new Float32Array(w * w)
    for (let i = 0; i < grid.length; i++) grid[i] = rng()
    return (x: number, y: number) => {
      const gx = x / scale
      const gy = y / scale
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const tx = gx - x0
      const ty = gy - y0
      const at = (ax: number, ay: number) => grid[(ay % w + w) % w * w + ((ax % w + w) % w)]
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx
      const bot = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx
      return top * (1 - ty) + bot * ty
    }
  }

  switch (id) {
    case 'paper-rough':
    case 'paper-smooth': {
      const rough = id === 'paper-rough'
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const n = rng()
          const t = (rough ? 0.22 : 0.1) * (n > 0.5 ? 1 : n * 2)
          setPx(x, y, t)
        }
      }
      break
    }
    case 'canvas':
    case 'linen':
    case 'burlap': {
      const step = id === 'linen' ? 3 : id === 'burlap' ? 5 : 4
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const warp = Math.sin((x / step) * Math.PI) > 0.3 ? 0.25 : 0
          const weft = Math.sin((y / step) * Math.PI) > 0.3 ? 0.25 : 0
          setPx(x, y, Math.max(warp, weft) * (0.6 + rng() * 0.5))
        }
      }
      break
    }
    case 'grain-fine':
    case 'grain-coarse': {
      const scale = id === 'grain-fine' ? 1 : 3
      const field = noiseField(scale)
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) setPx(x, y, Math.max(0, field(x, y) - 0.35) * 1.2)
      }
      break
    }
    case 'sand': {
      for (let i = 0; i < s * s * 0.35; i++) {
        const x = Math.floor(rng() * s)
        const y = Math.floor(rng() * s)
        setPx(x, y, 0.2 + rng() * 0.5)
      }
      break
    }
    case 'watercolor-wash': {
      const field = noiseField(6)
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const v = field(x, y)
          setPx(x, y, Math.max(0, v - 0.4) * 1.6)
        }
      }
      break
    }
    case 'ink-bleed': {
      const field = noiseField(4)
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const v = field(x, y)
          setPx(x, y, v > 0.62 ? 0.85 : v > 0.5 ? 0.35 : 0)
        }
      }
      break
    }
    case 'chalk-dust':
    case 'sponge': {
      const field = noiseField(id === 'sponge' ? 3 : 5)
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const v = field(x, y)
          setPx(x, y, v > 0.55 ? (v - 0.55) * 1.6 : 0)
        }
      }
      break
    }
    case 'marble': {
      const field = noiseField(8)
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const v = Math.sin((x / s) * TAU * 2 + field(x, y) * 6)
          setPx(x, y, Math.abs(v) * 0.6)
        }
      }
      break
    }
    case 'wood': {
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const v = Math.sin(x * 0.9 + Math.sin(y * 0.12) * 2.2)
          setPx(x, y, Math.abs(v) * 0.35 + rng() * 0.08)
        }
      }
      break
    }
    case 'rust': {
      const field = noiseField(4)
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const v = field(x, y)
          setPx(x, y, v > 0.5 ? (v - 0.5) * 1.4 : 0.1 * rng())
        }
      }
      break
    }
    case 'concrete':
    case 'frost': {
      const field = noiseField(id === 'frost' ? 5 : 2)
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) setPx(x, y, field(x, y) * 0.5)
      }
      break
    }
    case 'noise-mono':
    case 'noise-color': {
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const i = (y * s + x) * 4
          if (id === 'noise-mono') {
            const n = (rng() - 0.5) * 90
            data[i] += n; data[i + 1] += n; data[i + 2] += n
          } else {
            data[i] += (rng() - 0.5) * 90
            data[i + 1] += (rng() - 0.5) * 90
            data[i + 2] += (rng() - 0.5) * 90
          }
          data[i + 3] = 255
        }
      }
      break
    }
    case 'speckle': {
      for (let i = 0; i < s * s * 0.08; i++) {
        const x = Math.floor(rng() * s)
        const y = Math.floor(rng() * s)
        setPx(x, y, 0.9)
        setPx(x + 1, y, 0.6)
      }
      break
    }
    default: {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) setPx(x, y, rng() * 0.25)
    }
  }
  ctx.putImageData(img, 0, 0)
}

/* ------------------------------------------------------ PostScript-ish ----- */

function drawPostScript(ctx: CanvasRenderingContext2D, s: number, id: string, fg: RGBA, bg: RGBA): void {
  ctx.fillStyle = css(bg)
  ctx.fillRect(0, 0, s, s)
  ctx.strokeStyle = css({ ...fg, a: 1 })
  ctx.fillStyle = css({ ...fg, a: 1 })
  ctx.lineWidth = Math.max(1, s / 16)
  const h = s / 2
  ctx.beginPath()
  switch (id) {
    case 'lines':
      for (let i = 0; i < s; i += s / 5) { ctx.moveTo(0, i); ctx.lineTo(s, i) }
      break
    case 'rings':
      for (let r = s / 8; r < s; r += s / 6) { ctx.moveTo(h + r, h); ctx.arc(h, h, r, 0, TAU) }
      break
    case 'starburst':
      for (let i = 0; i < 16; i++) {
        const a = (TAU * i) / 16
        ctx.moveTo(h, h)
        ctx.lineTo(h + Math.cos(a) * s, h + Math.sin(a) * s)
      }
      break
    case 'waveform':
      for (let x = 0; x <= s; x += 2) {
        const y = h + Math.sin((x / s) * TAU * 3) * (s / 3)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      break
    case 'maze':
      ctx.moveTo(0, 0); ctx.lineTo(s, 0); ctx.lineTo(s, h); ctx.lineTo(h, h)
      ctx.lineTo(h, s); ctx.lineTo(0, s); ctx.closePath()
      break
    case 'crossdot':
      ctx.moveTo(0, h); ctx.lineTo(s, h)
      ctx.moveTo(h, 0); ctx.lineTo(h, s)
      break
    case 'burst':
      for (let i = 0; i < 8; i++) {
        const a = (TAU * i) / 8
        ctx.moveTo(h, h)
        ctx.lineTo(h + Math.cos(a) * s * 0.7, h + Math.sin(a) * s * 0.7)
      }
      break
    default:
      ctx.moveTo(0, h); ctx.lineTo(s, h)
  }
  ctx.stroke()
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Preview data-URL for the pattern docker swatches. */
export function patternPreview(preset: string, fg: RGBA, bg: RGBA, size = 32): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  if (preset.startsWith('ps:')) drawPostScript(ctx, size, preset.slice(3), fg, bg)
  else if (BITMAP_TEXTURES.some((p) => p.id === preset)) drawTexture(ctx, size, preset, fg, bg)
  else drawVectorPattern(ctx, size, preset, fg, bg)
  return canvas.toDataURL('image/png')
}
