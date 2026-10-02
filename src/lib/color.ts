import type { RGB, RGBA, FountainFill, Fill, MeshFill, GradientStop } from '../types'
import { clamp, lerp, round, uid } from './util'

/* ------------------------------------------------------------ conversion --- */

export const rgb = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a })
export const css = (c: RGBA, withAlpha = true): string =>
  withAlpha && c.a < 1
    ? `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${round(c.a, 3)})`
    : `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`
export const hex = (c: RGBA): string =>
  '#' + [c.r, c.g, c.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')

export function parseHex(s: string): RGBA {
  const m = s.trim().replace(/^#/, '')
  if (m.length === 3) return rgb(parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16))
  if (m.length === 6 || m.length === 8) {
    const r = parseInt(m.slice(0, 2), 16)
    const g = parseInt(m.slice(2, 4), 16)
    const b = parseInt(m.slice(4, 6), 16)
    const a = m.length === 8 ? parseInt(m.slice(6, 8), 16) / 255 : 1
    return rgb(r, g, b, a)
  }
  return rgb(0, 0, 0)
}

export function hsvToRgb(h: number, s: number, v: number, a = 1): RGBA {
  const hh = ((h % 360) + 360) % 360 / 60
  const i = Math.floor(hh)
  const f = hh - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  let r = 0
  let g = 0
  let b = 0
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    default: r = v; g = p; b = q; break
  }
  return { r: r * 255, g: g * 255, b: b * 255, a }
}

export function rgbToHsv(c: RGB): { h: number; s: number; v: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hslToRgb(h: number, s: number, l: number, a = 1): RGBA {
  const hh = (((h % 360) + 360) % 360) / 360
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return { r: hue2rgb(hh + 1 / 3) * 255, g: hue2rgb(hh) * 255, b: hue2rgb(hh - 1 / 3) * 255, a }
}

export function rgbToHsl(c: RGB): { h: number; s: number; l: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/* sRGB ⇄ linear */
const toLinear = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255

export function rgbToXyz(c: RGB) {
  const r = toLinear(c.r)
  const g = toLinear(c.g)
  const b = toLinear(c.b)
  return {
    x: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    y: r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    z: r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  }
}
export function xyzToRgb(x: number, y: number, z: number): RGB {
  const r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
  const g = x * -0.969266 + y * 1.8760108 + z * 0.041556
  const b = x * 0.0556434 + y * -0.2040259 + z * 1.0572252
  return { r: clamp(fromLinear(r), 0, 255), g: clamp(fromLinear(g), 0, 255), b: clamp(fromLinear(b), 0, 255) }
}

export function rgbToLab(c: RGB) {
  const { x, y, z } = rgbToXyz(c)
  const ref = { x: 0.95047, y: 1, z: 1.08883 }
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x / ref.x)
  const fy = f(y / ref.y)
  const fz = f(z / ref.z)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}
export function labToRgb(l: number, a: number, b: number): RGB {
  const fy = (l + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200
  const finv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787)
  return xyzToRgb(finv(fx) * 0.95047, finv(fy), finv(fz) * 1.08883)
}

export function rgbToCmyk(c: RGB) {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const k = 1 - Math.max(r, g, b)
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 }
  return {
    c: (1 - r - k) / (1 - k),
    m: (1 - g - k) / (1 - k),
    y: (1 - b - k) / (1 - k),
    k,
  }
}
export function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  return { r: 255 * (1 - c) * (1 - k), g: 255 * (1 - m) * (1 - k), b: 255 * (1 - y) * (1 - k) }
}

export const relativeLuminance = (c: RGB) =>
  0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b)

/** WCAG contrast ratio — used for the "readable text" and proofing helpers. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function mixColor(a: RGBA, b: RGBA, t: number): RGBA {
  const tt = clamp(t, 0, 1)
  // Interpolate in Lab for perceptual smoothness, falling back to RGB at equal lightness.
  const la = rgbToLab(a)
  const lb = rgbToLab(b)
  const mixed = labToRgb(lerp(la.l, lb.l, tt), lerp(la.a, lb.a, tt), lerp(la.b, lb.b, tt))
  return { r: mixed.r, g: mixed.g, b: mixed.b, a: lerp(a.a, b.a, tt) }
}

/** CMYK-ish screen tint preview used by the separations panel. */
export function channelView(c: RGBA, channel: 'c' | 'm' | 'y' | 'k'): RGB {
  const cmyk = rgbToCmyk(c)
  const v = 255 * (1 - cmyk[channel])
  if (channel === 'k') return { r: v, g: v, b: v }
  return channel === 'c' ? { r: v, g: 255, b: 255 } : channel === 'm' ? { r: 255, g: v, b: 255 } : { r: 255, g: 255, b: v }
}

/* --------------------------------------------------------------- ramps ----- */

export function gradientCss(fill: FountainFill, bbox: { x: number; y: number; w: number; h: number }): CanvasGradient | string
export function gradientCss(fill: FountainFill, bbox: { x: number; y: number; w: number; h: number }): any {
  const stops = fill.stops.length ? fill.stops : [{ offset: 0, color: rgb(255, 255, 255) }, { offset: 1, color: rgb(0, 0, 0) }]
  const x0 = bbox.x + fill.start.x * bbox.w
  const y0 = bbox.y + fill.start.y * bbox.h
  const x1 = bbox.x + fill.end.x * bbox.w
  const y1 = bbox.y + fill.end.y * bbox.h
  const angle = (fill.angle * Math.PI) / 180
  const cx = bbox.x + bbox.w / 2
  const cy = bbox.y + bbox.h / 2
  return {
    type: fill.fountain,
    coords: {
      x0: fill.start.x * bbox.w,
      y0: fill.start.y * bbox.h,
      x1: fill.end.x * bbox.w,
      y1: fill.end.y * bbox.h,
      r0: 0,
      r1: fill.fountain === 'radial' ? Math.max(bbox.w, bbox.h) * fill.edgePad || Math.max(bbox.w, bbox.h) / 2 : undefined,
      inner: { x: x0, y: y0 },
      outer: { x: x1, y: y1 },
      center: { x: cx, y: cy },
      angle,
    },
    stops,
  }
}

export function fountainStops(fill: FountainFill): GradientStop[] {
  return [...fill.stops].sort((a, b) => a.offset - b.offset)
}

export function makeFountainFill(from: RGBA, to: RGBA, type: FountainFill['fountain'] = 'linear'): FountainFill {
  return {
    type: 'fountain',
    fountain: type,
    stops: [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ],
    start: { x: 0, y: 0.5 },
    end: { x: 1, y: 0.5 },
    spread: 'pad',
    angle: 0,
    edgePad: 0,
  }
}

export function makeMeshFill(base: RGBA, accent: RGBA, rows = 3, cols = 3): MeshFill {
  const nodes = []
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const t = (r / rows + c / cols) / 2
      nodes.push({ x: c / cols, y: r / rows, color: mixColor(base, accent, t) })
    }
  }
  return { type: 'mesh', rows, cols, nodes }
}

export function fillPrimaryColor(fill: Fill | undefined, fallback: RGBA): RGBA {
  if (!fill) return fallback
  switch (fill.type) {
    case 'uniform': return fill.color
    case 'fountain': return fill.stops[0]?.color ?? fallback
    case 'mesh': return fill.nodes[0]?.color ?? fallback
    case 'pattern':
    case 'texture':
    case 'postscript': return fill.fg
    default: return fallback
  }
}

export function withPrimaryColor(fill: Fill, color: RGBA): Fill {
  switch (fill.type) {
    case 'uniform': return { ...fill, color }
    case 'fountain': return { ...fill, stops: fill.stops.map((s) => ({ ...s, color })) }
    case 'mesh': return { ...fill, nodes: fill.nodes.map((n) => ({ ...n, color })) }
    case 'pattern':
    case 'texture':
    case 'postscript': return { ...fill, fg: color }
    default: return fill
  }
}

/* ---------------------------------------------------------- harmonies ------- */

export type HarmonyKind = 'complementary' | 'analogous' | 'triadic' | 'tetradic' | 'split-complementary' | 'monochromatic' | 'square'

export const HARMONIES: { id: HarmonyKind; label: string; hint: string }[] = [
  { id: 'complementary', label: 'Complementary', hint: 'Base colour plus the hue opposite it on the wheel.' },
  { id: 'analogous', label: 'Analogous', hint: 'Neighbouring hues — calm, cohesive schemes.' },
  { id: 'triadic', label: 'Triadic', hint: 'Three hues evenly spaced around the wheel.' },
  { id: 'tetradic', label: 'Tetradic', hint: 'Two complementary pairs — the richest scheme.' },
  { id: 'split-complementary', label: 'Split complementary', hint: 'Base plus the two hues flanking its complement.' },
  { id: 'monochromatic', label: 'Monochromatic', hint: 'One hue, varied value and saturation.' },
  { id: 'square', label: 'Square', hint: 'Four hues 90° apart.' },
]

/**
 * Deterministic colour-harmony generation (pure trigonometry — no inference).
 * Returns swatches derived from the base colour.
 */
export function harmonyColors(base: RGBA, kind: HarmonyKind, count = 5): RGBA[] {
  const { h, s, l } = rgbToHsl(base)
  const offsets: number[] = []
  switch (kind) {
    case 'complementary': offsets.push(0, 180, 180, 0, 0); break
    case 'analogous': offsets.push(-40, -20, 0, 20, 40); break
    case 'triadic': offsets.push(0, 120, 240, 120, 240); break
    case 'tetradic': offsets.push(0, 180, 90, 270, 0); break
    case 'split-complementary': offsets.push(0, 150, 210, 150, 210); break
    case 'monochromatic': offsets.push(0, 0, 0, 0, 0); break
    case 'square': offsets.push(0, 90, 180, 270, 90); break
  }
  const out: RGBA[] = []
  for (let i = 0; i < count; i++) {
    const off = offsets[i % offsets.length] ?? 0
    const t = count <= 1 ? 0 : i / (count - 1)
    const lightness = kind === 'monochromatic' ? clamp(l - 0.3 + t * 0.6, 0.05, 0.95) : l
    const saturation = kind === 'monochromatic' ? clamp(s * (0.6 + t * 0.6), 0.05, 1) : s
    out.push({ ...hslToRgb(h + off, saturation, lightness), a: base.a })
  }
  return out
}

/* ------------------------------------------------------------ palettes ----- */

export interface PaletteDefinition { id: string; name: string; colors: string[]; group?: string }

/**
 * Built-in colour libraries. The PANTONE®-style spot libraries below are
 * *approximations of the published hue families* provided for design convenience:
 * they are not licensed PANTONE data. Named spot colours resolve to their nearest
 * sRGB rendering and can be re-mapped by the colour manager docker.
 */
export const PALETTES: PaletteDefinition[] = [
  {
    id: 'pantone-solid-coated',
    name: 'PANTONE® Solid Coated (extended approximations)',
    group: 'Spot libraries',
    colors: [
      '#FEDD00','#D6A461','#FFB81C','#E4A667','#F0B323','#DDA46F','#F5AC00','#C97B2E',
      '#FEDF00','#FF7F32','#FF6B35','#E4002B','#D50032','#C8102E','#B31942','#A6192E',
      '#E50000','#D22630','#CE0037','#BF0D3E','#B80F42','#AE1C51','#9B2A5E','#8E2C62',
      '#7D3E6E','#6B4C7A','#5C4D7D','#4B4E83','#3F4B87','#354989','#2A4789','#224489',
      '#1F4788','#1B4A85','#174D82','#13507E','#0F547A','#0B5875','#075C70','#03606B',
      '#006066','#046A61','#0A745C','#107E57','#168852','#1C924D','#229C48','#28A643',
      '#2FB03F','#3EBA39','#4FC434','#62CE2F','#77D82A','#8FE225','#A9EC20','#C5F61B',
      '#7FD0B0','#5BBF9E','#37AE8C','#139D7A','#0E8F73','#09816C','#047365','#00555A',
      '#33477A','#3F5A8C','#4B6D9E','#5780B0','#6393C2','#6FA6D4','#7BB9E6','#87CCF8',
      '#A7C6ED','#C2D6F5','#DDE6FC','#F2F4FB','#FFFFFF','#E7E6E3','#C9C7C2','#A8A5A0',
      '#8A8782','#6E6B67','#54514D','#3C3936','#262421','#141312','#0A0A09','#F7F3EC',
      '#EFE1CB','#E1C9A5','#D2B183','#C29965','#B0824C','#9E6B36','#8A5522','#744010',
      '#FFD3B6','#FFB38E','#FF9366','#FF733E','#F55A28','#DE4317','#C22F0C','#A61F04',
      '#FFE1F0','#FFC2E1','#FFA3D2','#FF84C3','#F96AB2','#E6529F','#CE3A8C','#B62279',
      '#E0D3F5','#C7B3EC','#AE93E3','#9573DA','#7C53D1','#6333C8','#4A13BF','#3A0FA0',
      '#C8E6C9','#A5D6A7','#81C784','#66BB6A','#4CAF50','#43A047','#388E3C','#2E7D32',
      '#B3E5FC','#81D4FA','#4FC3F7','#29B6F6','#03A9F4','#039BE5','#0288D1','#0277BD',
    ],
  },
  {
    id: 'pantone-metallics',
    name: 'PANTONE® Metallics (approximations)',
    group: 'Spot libraries',
    colors: ['#D9C58B','#C8A951','#B8942F','#A67C00','#8C6B2F','#7A5C1E','#E8D9A0','#CFC0A0','#B5B2A8','#9CA3A8','#8E9AA5','#D6D3CE'],
  },
  {
    id: 'cmyk-process',
    name: 'CMYK process tints',
    group: 'Process',
    colors: ['#00AEEF','#EC008C','#FFF200','#000000','#F7941D','#8DC63F','#92278F','#00A99D','#ED1C24','#1C75BC','#A6A6A6','#F1F2F2'],
  },
  {
    id: 'default-rgb',
    name: 'Default RGB palette',
    group: 'Process',
    colors: [
      '#000000','#1A1A1A','#333333','#4D4D4D','#666666','#808080','#999999','#B3B3B3','#CCCCCC','#FFFFFF',
      '#FF0000','#FF7F00','#FFFF00','#7FFF00','#00FF00','#00FF7F','#00FFFF','#007FFF','#0000FF','#7F00FF',
      '#FF00FF','#FF007F','#7F0000','#7F3F00','#7F7F00','#3F7F00','#007F00','#007F3F','#007F7F','#003F7F',
    ],
  },
  {
    id: 'earth-tones',
    name: 'Earth tones',
    group: 'Themed',
    colors: ['#3E2723','#5D4037','#795548','#8D6E63','#A1887F','#BCAAA4','#D7CCC8','#EFEBE9','#4E342E','#6D4C41','#8B6F47','#A1887F','#C4A484','#D9BF9F','#EFDCC3'],
  },
  {
    id: 'neon-pop',
    name: 'Neon pop',
    group: 'Themed',
    colors: ['#FF006E','#FB5607','#FFBE0B','#8AC926','#00F5D4','#00BBF9','#3A86FF','#8338EC','#FF4D6D','#C77DFF'],
  },
  {
    id: 'print-safe',
    name: 'Print safe (gamut checked)',
    group: 'Process',
    colors: ['#0057B8','#C8102E','#FFB81C','#00A499','#7C878E','#A4D65E','#E56DB1','#6D2077','#FF6A13','#00B140'],
  },
  {
    id: 'document',
    name: 'Document palette',
    group: 'Document',
    colors: [],
  },
]

export function paletteByID(id: string): PaletteDefinition {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[PALETTES.length - 2]
}

/** Nearest palette colour in CIE Lab (used by "convert to nearest spot"). */
export function nearestColor(target: RGBA, candidates: RGBA[]): RGBA {
  let best = candidates[0] ?? target
  let bestD = Infinity
  const lt = rgbToLab(target)
  for (const c of candidates) {
    const lc = rgbToLab(c)
    const d = (lt.l - lc.l) ** 2 + (lt.a - lc.a) ** 2 + (lt.b - lc.b) ** 2
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/* ----------------------------------------------------------- color names --- */

const NAMED: { name: string; value: string }[] = [
  { name: 'Crimson', value: '#DC143C' }, { name: 'Cardinal', value: '#C41E3A' },
  { name: 'Coral', value: '#FF7F50' }, { name: 'Gold', value: '#FFD700' },
  { name: 'Amber', value: '#FFBF00' }, { name: 'Chartreuse', value: '#7FFF00' },
  { name: 'Emerald', value: '#50C878' }, { name: 'Jade', value: '#00A86B' },
  { name: 'Teal', value: '#008080' }, { name: 'Cyan', value: '#00FFFF' },
  { name: 'Cerulean', value: '#007BA7' }, { name: 'Cobalt', value: '#0047AB' },
  { name: 'Indigo', value: '#4B0082' }, { name: 'Violet', value: '#8F00FF' },
  { name: 'Magenta', value: '#FF00FF' }, { name: 'Plum', value: '#8E4585' },
  { name: 'Slate', value: '#708090' }, { name: 'Charcoal', value: '#36454F' },
  { name: 'Ivory', value: '#FFFFF0' }, { name: 'Beige', value: '#F5F5DC' },
]

export function colorName(c: RGBA): string {
  let best = 'Custom'
  let bestD = Infinity
  for (const n of NAMED) {
    const v = parseHex(n.value)
    const d = (v.r - c.r) ** 2 + (v.g - c.g) ** 2 + (v.b - c.b) ** 2
    if (d < bestD) {
      bestD = d
      best = n.name
    }
  }
  return best
}

export function swatchID(): string {
  return uid('style')
}
