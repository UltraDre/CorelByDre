/**
 * Typography engine.
 *
 * Two rendering paths, chosen per family:
 *  1. Outlined — the family is available as font data (bundled, Google Fonts,
 *     or embedded inside the document). Text is shaped and rendered as vector
 *     outlines with opentype.js, which gives us variable-font axes, OpenType
 *     feature toggles, special glyph insertion and text-on-path for free, plus
 *     pixel-identical PDF/SVG export.
 *  2. System — the family resolves through the platform font stack. We render
 *     with the canvas text API (fast, but limited to the browser's shaping).
 *
 * No AI/ML: line breaking, justification, hyphenation and glyph selection are all
 * deterministic algorithms.
 */
import type { TextStyle, PathData, ID } from '../types'
import { clamp, pathFromSubpaths, subPath, node } from './util'

/* --------------------------------------------------------------- fonts ----- */

export interface FontAxisInfo { tag: string; name: string; min: number; max: number; default: number }

export interface FontRecord {
  family: string
  cssFamily: string
  category: 'sans-serif' | 'serif' | 'display' | 'handwriting' | 'monospace' | 'system'
  variable: boolean
  axes?: FontAxisInfo[]
  /** OpenType features this family advertises (best-effort tag list). */
  features: string[]
  google?: string
  weights: number[]
  status: 'system' | 'idle' | 'loading' | 'ready' | 'error' | 'embedded'
  font?: any
  dataUrl?: string
}

/**
 * Google Fonts families — the catalogue is fetched at runtime when online
 * (see fetchGoogleCatalog) so the picker can offer the full 1,700+ library;
 * this curated list is the always-available subset.
 */
export const CURATED_GOOGLE_FONTS: { family: string; category: FontRecord['category']; variable?: boolean; axes?: FontAxisInfo[]; weights?: number[] }[] = [
  { family: 'Inter', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }, { tag: 'opsz', name: 'Optical size', min: 14, max: 32, default: 14 }], weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: 'Roboto', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }], weights: [100, 300, 400, 500, 700, 900] },
  { family: 'Open Sans', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 300, max: 800, default: 400 }], weights: [300, 400, 600, 700, 800] },
  { family: 'Lato', category: 'sans-serif', weights: [100, 300, 400, 700, 900] },
  { family: 'Montserrat', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }], weights: [100, 300, 400, 600, 700, 900] },
  { family: 'Poppins', category: 'sans-serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: 'Nunito', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 1000, default: 400 }], weights: [200, 300, 400, 600, 700, 900] },
  { family: 'Work Sans', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }], weights: [100, 300, 400, 600, 800, 900] },
  { family: 'Manrope', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 800, default: 400 }] },
  { family: 'DM Sans', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 1000, default: 400 }] },
  { family: 'Plus Jakarta Sans', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 800, default: 400 }] },
  { family: 'Outfit', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }] },
  { family: 'Barlow', category: 'sans-serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: 'Karla', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 800, default: 400 }] },
  { family: 'Rubik', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 300, max: 900, default: 400 }] },
  { family: 'Play', category: 'sans-serif', weights: [400, 700] },
  { family: 'Oswald', category: 'display', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 700, default: 400 }] },
  { family: 'Anton', category: 'display', weights: [400] },
  { family: 'Bebas Neue', category: 'display', weights: [400] },
  { family: 'Archivo Black', category: 'display', weights: [400] },
  { family: 'Abril Fatface', category: 'display', weights: [400] },
  { family: 'Alfa Slab One', category: 'display', weights: [400] },
  { family: 'Righteous', category: 'display', weights: [400] },
  { family: 'Space Grotesk', category: 'display', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 300, max: 700, default: 400 }] },
  { family: 'Sora', category: 'display', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 800, default: 400 }] },
  { family: 'Playfair Display', category: 'serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 400, max: 900, default: 400 }], weights: [400, 500, 600, 700, 800, 900] },
  { family: 'Merriweather', category: 'serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 300, max: 900, default: 400 }], weights: [300, 400, 700, 900] },
  { family: 'Lora', category: 'serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 400, max: 700, default: 400 }], weights: [400, 500, 600, 700] },
  { family: 'Source Serif 4', category: 'serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 900, default: 400 }, { tag: 'opsz', name: 'Optical size', min: 8, max: 60, default: 20 }] },
  { family: 'Libre Baskerville', category: 'serif', weights: [400, 700] },
  { family: 'Crimson Pro', category: 'serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 900, default: 400 }] },
  { family: 'EB Garamond', category: 'serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 400, max: 800, default: 400 }] },
  { family: 'Cormorant Garamond', category: 'serif', weights: [300, 400, 500, 600, 700] },
  { family: 'Spectral', category: 'serif', weights: [200, 300, 400, 500, 600, 700, 800] },
  { family: 'Newsreader', category: 'serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 800, default: 400 }, { tag: 'opsz', name: 'Optical size', min: 6, max: 72, default: 16 }] },
  { family: 'Caveat', category: 'handwriting', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 400, max: 700, default: 400 }] },
  { family: 'Dancing Script', category: 'handwriting', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 400, max: 700, default: 400 }] },
  { family: 'Pacifico', category: 'handwriting', weights: [400] },
  { family: 'Satisfy', category: 'handwriting', weights: [400] },
  { family: 'Shadows Into Light', category: 'handwriting', weights: [400] },
  { family: 'Indie Flower', category: 'handwriting', weights: [400] },
  { family: 'Great Vibes', category: 'handwriting', weights: [400] },
  { family: 'Kalam', category: 'handwriting', weights: [300, 400, 700] },
  { family: 'JetBrains Mono', category: 'monospace', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 800, default: 400 }] },
  { family: 'Space Mono', category: 'monospace', weights: [400, 700] },
  { family: 'IBM Plex Mono', category: 'monospace', weights: [100, 200, 300, 400, 500, 600, 700] },
  { family: 'Fira Code', category: 'monospace', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 300, max: 700, default: 400 }] },
  { family: 'Inconsolata', category: 'monospace', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 900, default: 400 }] },
  { family: 'Fira Sans', category: 'sans-serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: 'Mulish', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 200, max: 1000, default: 400 }] },
  { family: 'Quicksand', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 300, max: 700, default: 400 }] },
  { family: 'Heebo', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }] },
  { family: 'Ubuntu', category: 'sans-serif', weights: [300, 400, 500, 700] },
  { family: 'Public Sans', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }] },
  { family: 'Figtree', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 300, max: 900, default: 400 }] },
  { family: 'Instrument Sans', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 400, max: 700, default: 400 }] },
  { family: 'Geist', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }] },
  { family: 'Kanit', category: 'sans-serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
  { family: 'Josefin Sans', category: 'sans-serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 700, default: 400 }] },
  { family: 'Bitter', category: 'serif', variable: true, axes: [{ tag: 'wght', name: 'Weight', min: 100, max: 900, default: 400 }] },
]

export const SYSTEM_FONT_STACKS: { family: string; css: string; category: FontRecord['category'] }[] = [
  { family: 'Arial', css: 'Arial, Helvetica, sans-serif', category: 'system' },
  { family: 'Helvetica', css: '"Helvetica Neue", Helvetica, Arial, sans-serif', category: 'system' },
  { family: 'Verdana', css: 'Verdana, Geneva, sans-serif', category: 'system' },
  { family: 'Tahoma', css: 'Tahoma, Geneva, sans-serif', category: 'system' },
  { family: 'Trebuchet MS', css: '"Trebuchet MS", Helvetica, sans-serif', category: 'system' },
  { family: 'Georgia', css: 'Georgia, "Times New Roman", serif', category: 'system' },
  { family: 'Times New Roman', css: '"Times New Roman", Times, serif', category: 'system' },
  { family: 'Garamond', css: 'Garamond, Georgia, serif', category: 'system' },
  { family: 'Courier New', css: '"Courier New", Courier, monospace', category: 'system' },
  { family: 'Brush Script MT', css: '"Brush Script MT", cursive', category: 'system' },
]

/* ------------------------------------------------------- font manager ------ */

class FontManager {
  private records = new Map<string, FontRecord>()
  private glyphCache = new Map<string, { d: string; advance: number; unitsPerEm: number }>()
  private listeners = new Set<() => void>()

  constructor() {
    for (const s of SYSTEM_FONT_STACKS) {
      this.records.set(s.family, {
        family: s.family, cssFamily: s.css, category: s.category, variable: false,
        features: [], weights: [400, 700], status: 'system',
      })
    }
    for (const g of CURATED_GOOGLE_FONTS) {
      this.records.set(g.family, {
        family: g.family,
        cssFamily: `"${g.family}", sans-serif`,
        category: g.category,
        variable: Boolean(g.variable),
        axes: g.axes,
        features: ['kern', 'liga', 'clig', 'calt', 'ss01', 'ss02', 'smcp', 'onum', 'tnum', 'frac', 'dlig'],
        google: g.family,
        weights: g.weights ?? [400, 700],
        status: 'idle',
      })
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit() {
    this.listeners.forEach((fn) => fn())
  }

  list(): FontRecord[] {
    return [...this.records.values()].sort((a, b) => a.family.localeCompare(b.family))
  }
  byCategory(): Record<string, FontRecord[]> {
    const out: Record<string, FontRecord[]> = {}
    for (const r of this.list()) {
      const key = r.category === 'system' ? 'System' : r.category.charAt(0).toUpperCase() + r.category.slice(1)
      ;(out[key] ||= []).push(r)
    }
    return out
  }
  get(family: string): FontRecord | undefined {
    return this.records.get(family)
  }
  /** Names only — used by the UI which re-renders from useSyncExternalStore. */
  version = 0

  /** Fetch the full Google Fonts catalogue (1,700+ families) when online. */
  async fetchGoogleCatalog(): Promise<number> {
    try {
      const res = await fetch('https://fonts.google.com/metadata/fonts', { headers: { accept: 'application/json' } })
      if (!res.ok) return 0
      const text = await res.text()
      const json = JSON.parse(text.replace(/^\)\]\}'\n/, ''))
      const families: any[] = json.familyMetadataList ?? []
      let added = 0
      for (const fam of families) {
        const family = fam.family as string
        if (!family || this.records.has(family)) continue
        const axes: FontAxisInfo[] = (fam.axes ?? [])
          .filter((a: any) => a.tag && a.min !== undefined)
          .map((a: any) => ({ tag: a.tag, name: a.tag, min: a.min, max: a.max, default: a.defaultValue ?? a.min }))
        this.records.set(family, {
          family,
          cssFamily: `"${family}", sans-serif`,
          category: (fam.category as FontRecord['category']) ?? 'sans-serif',
          variable: axes.length > 0,
          axes,
          features: ['kern', 'liga', 'calt', 'ss01', 'smcp', 'onum', 'tnum'],
          google: family,
          weights: fam.fonts ? Object.keys(fam.fonts).map((k) => Number(k)).filter((n) => !Number.isNaN(n)) : [400, 700],
          status: 'idle',
        })
        added++
      }
      this.version++
      this.emit()
      return added
    } catch {
      return 0
    }
  }

  /** Load a family: Google Fonts CSS + font file for outlining, or FontFace only. */
  async load(family: string): Promise<FontRecord | undefined> {
    const rec = this.records.get(family)
    if (!rec) {
      // Unknown family — register it as a system/webfont attempt.
      const created: FontRecord = {
        family, cssFamily: `"${family}", sans-serif`, category: 'system', variable: false,
        features: [], weights: [400, 700], status: 'idle',
      }
      this.records.set(family, created)
      return this.load(family)
    }
    if (rec.status === 'ready' || rec.status === 'embedded' || rec.status === 'loading') return rec
    rec.status = 'loading'
    this.emit()
    try {
      const [opentypeMod, cssRes] = await Promise.all([
        import('opentype.js').then((m) => (m as any).default ?? m),
        rec.google
          ? fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(rec.google)}:ital,wght@0,100..900;1,100..900&display=swap`)
          : Promise.resolve(null),
      ])
      if (cssRes && cssRes.ok) {
        const css = await cssRes.text()
        const url = extractFontUrl(css)
        if (url) {
          // Register with the CSS font loader so canvas/DOM text works too.
          try {
            const face = new FontFace(rec.family, `url(${url})`)
            await face.load()
            ;(document.fonts as unknown as { add: (f: FontFace) => void }).add(face)
          } catch {
            /* FontFace may refuse cross-origin without CORS; opentype still works */
          }
          const buf = await fetch(url).then((r) => r.arrayBuffer())
          const font = opentypeMod.parse(buf)
          rec.font = font
          rec.status = 'ready'
          const axes = readAxes(font)
          if (axes.length) {
            rec.variable = true
            rec.axes = axes
          }
          rec.dataUrl = toDataUrl(buf)
          this.version++
          this.emit()
          return rec
        }
      }
      // No Google family: try the local font stack (already usable via canvas).
      rec.status = 'ready'
      this.version++
      this.emit()
      return rec
    } catch (error) {
      console.warn(`[fonts] could not load ${family}:`, error)
      rec.status = 'error'
      this.version++
      this.emit()
      return rec
    }
  }

  /** Register font bytes embedded in a document. */
  async embed(family: string, dataUrl: string): Promise<FontRecord | undefined> {
    try {
      const buf = dataUrlToBuffer(dataUrl)
      const opentypeMod = await import('opentype.js').then((m) => (m as any).default ?? m)
      const font = opentypeMod.parse(buf)
      const rec: FontRecord = {
        family, cssFamily: `"${family}", sans-serif`, category: 'system', variable: false,
        features: ['kern', 'liga'], weights: [400, 700], status: 'embedded', font, dataUrl,
        axes: readAxes(font),
      }
      this.records.set(family, rec)
      try {
        const face = new FontFace(family, new Uint8Array(buf))
        await face.load()
        ;(document.fonts as unknown as { add: (f: FontFace) => void }).add(face)
      } catch {
        /* outlining still works */
      }
      this.version++
      this.emit()
      return rec
    } catch {
      return undefined
    }
  }

  hasOutlines(family: string): boolean {
    const rec = this.records.get(family)
    return Boolean(rec?.font)
  }

  /**
   * Glyph outline in em units (y-up, 1000/2048 unitsPerEm normalised to 1).
   * Cached per family + axis settings + character.
   */
  outline(family: string, char: string, axes: Record<string, number> = {}): { d: string; advance: number } | null {
    const rec = this.records.get(family)
    if (!rec?.font) return null
    const key = `${family}|${Object.entries(axes).sort().map(([k, v]) => `${k}${v}`).join(',')}|${char}`
    const cached = this.glyphCache.get(key)
    if (cached) return cached
    try {
      const font = rec.font
      applyVariation(font, axes)
      const glyph = font.charToGlyph(char)
      const upm = font.unitsPerEm || 1000
      const d = glyph.path.toPathData(2)
      const advance = (glyph.advanceWidth ?? upm) / upm
      const entry = { d, advance, unitsPerEm: upm }
      this.glyphCache.set(key, entry)
      return entry
    } catch {
      return null
    }
  }

  /** Variable-font axes for a family (empty for static faces). */
  axes(family: string): FontAxisInfo[] {
    const rec = this.records.get(family)
    return rec?.font ? readAxes(rec.font) : (rec?.axes ?? [])
  }

  /** Advance width of a string, either from outlines or measured on a canvas. */
  measure(family: string, text: string, size: number, letterSpacing = 0, axes: Record<string, number> = {}): number {
    if (this.hasOutlines(family)) {
      let w = 0
      for (const ch of Array.from(text)) {
        if (ch === '\n') continue
        const g = this.outline(family, ch, axes)
        w += (g?.advance ?? 0.5) * size + letterSpacing
      }
      return w
    }
    const ctx = measureCtx()
    const base = ctx
      ? (() => {
        ctx.font = `${size}px ${this.records.get(family)?.cssFamily ?? family}`
        return ctx.measureText(text).width
      })()
      : approximateWidth(text, size)
    return base + letterSpacing * Math.max(0, Array.from(text).length - 1)
  }

  /** Every glyph the family advertises, for the glyphs/insert-symbol docker. */
  glyphs(family: string, limit = 600): { char: string; code: number }[] {
    const rec = this.records.get(family)
    const out: { char: string; code: number }[] = []
    if (rec?.font?.characterSet) {
      for (const code of rec.font.characterSet as number[]) {
        if (out.length >= limit) break
        if (code < 32) continue
        out.push({ char: String.fromCodePoint(code), code })
      }
      return out
    }
    // Deterministic fallback: Latin-1 + common punctuation + arrows + maths.
    const ranges = [[32, 126], [160, 255], [0x2013, 0x201e], [0x2190, 0x2193], [0x2200, 0x2208], [0x00d7, 0x00f7]]
    for (const [a, b] of ranges) {
      for (let c = a; c <= b && out.length < limit; c++) out.push({ char: String.fromCodePoint(c), code: c })
    }
    return out
  }
}

function readAxes(font: any): FontAxisInfo[] {
  try {
    const fvar = font.tables?.fvar
    if (!fvar?.axes) return []
    return fvar.axes.map((a: any) => ({ tag: a.tag, name: a.name?.en ?? a.tag, min: a.minValue, max: a.maxValue, default: a.defaultValue }))
  } catch {
    return []
  }
}

function applyVariation(font: any, axes: Record<string, number>): void {
  if (!font?.variation) return
  const entries = Object.entries(axes)
  if (!entries.length) return
  const coords: Record<string, number> = {}
  for (const [tag, value] of entries) coords[tag] = value
  try {
    font.variation.set(coords)
  } catch {
    /* static font or unsupported table */
  }
}

function extractFontUrl(css: string): string | null {
  const matches = [...css.matchAll(/url\((https:[^)]+\.(?:woff2|woff|ttf))\)/g)]
  if (!matches.length) return null
  return matches[0][1]
}

function toDataUrl(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:font/ttf;base64,${btoa(binary)}`
}

function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(',').pop() ?? ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

let sharedCtx: CanvasRenderingContext2D | null = null
let ctxUnavailable = false

/**
 * Shared measuring context. Returns null in environments without a 2D canvas
 * (headless export, some test runners); callers then fall back to the metric
 * approximation below so text layout never throws.
 */
function measureCtx(): CanvasRenderingContext2D | null {
  if (sharedCtx || ctxUnavailable) return sharedCtx
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  sharedCtx = canvas.getContext('2d')
  if (!sharedCtx) ctxUnavailable = true
  return sharedCtx
}

/** Deterministic advance estimate used when no measuring context exists. */
function approximateWidth(text: string, size: number): number {
  let units = 0
  for (const ch of text) {
    if (ch === ' ') units += 0.28
    else if ('iljtIf.,:;\'!|'.includes(ch)) units += 0.3
    else if ('mwMW@'.includes(ch)) units += 0.92
    else if (ch >= 'A' && ch <= 'Z') units += 0.68
    else units += 0.54
  }
  return units * size
}

export const fonts = new FontManager()

/* -------------------------------------------------------------- layout ----- */

export interface PositionedGlyph {
  char: string
  x: number
  y: number
  size: number
  /** Outline path data in em units (y-down already flipped). */
  d: string | null
  advance: number
}

export interface TextLine {
  glyphs: PositionedGlyph[]
  text: string
  x: number
  y: number
  width: number
  baseline: number
  /** Wrap exclusions narrowed this line. */
  shortened?: boolean
}

export interface TextLayoutResult {
  lines: TextLine[]
  width: number
  height: number
  outlined: boolean
  overflow: boolean
}

export interface WrapExclusion { id: ID; x: number; y: number; w: number; h: number; offset: number }

const DEFAULT_SIZE = 24

/** Split a paragraph into break opportunities (spaces + optional hyphenation). */
function breakPoints(word: string, hyphenate: boolean): number[] {
  if (!hyphenate || word.length < 6) return []
  const points: number[] = []
  // Deterministic vowel-consonant rule set (no dictionary, no ML).
  const vowels = 'aeiouyAEIOUY'
  for (let i = 2; i < word.length - 2; i++) {
    const prev = word[i - 1]
    const cur = word[i]
    const next = word[i + 1]
    if (vowels.includes(prev) && !vowels.includes(cur) && !vowels.includes(next)) points.push(i)
    else if (!vowels.includes(prev) && vowels.includes(cur) && i > 2) points.push(i)
  }
  return points
}

export interface ShapedRun { text: string; x: number; y: number }

function shapeText(style: TextStyle, family: string): boolean {
  void style
  return fonts.hasOutlines(family)
}

/** Apply the caps / super-sub transforms that are cheap to do on the fly. */
function transformText(text: string, style: TextStyle): string {
  let out = text
  if (style.superSub === 'super') out = toSuperscript(out)
  else if (style.superSub === 'sub') out = toSubscript(out)
  else if (style.caps === 'all') out = out.toUpperCase()
  else if (style.caps === 'small') out = out.replace(/[a-z]/g, (c) => c.toUpperCase())
  return out
}

const SUPER: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' }
const SUB: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' }
const toSuperscript = (s: string) => s.split('').map((c) => SUPER[c] ?? c).join('')
const toSubscript = (s: string) => s.split('').map((c) => SUB[c] ?? c).join('')

function bulletPrefix(index: number, style: TextStyle): string {
  switch (style.bullet) {
    case 'bullet': return `${style.bulletChar || '•'}  `
    case 'number': return `${index + 1}.  `
    case 'roman': return `${toRoman(index + 1)}.  `
    case 'alpha': return `${toAlpha(index + 1)}.  `
    default: return ''
  }
}

function toRoman(n: number): string {
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let out = ''
  let v = n
  for (const [value, sym] of table) while (v >= value) { out += sym; v -= value }
  return out.toLowerCase()
}
function toAlpha(n: number): string {
  let out = ''
  let v = n
  while (v > 0) {
    const rem = (v - 1) % 26
    out = String.fromCharCode(97 + rem) + out
    v = Math.floor((v - 1) / 26)
  }
  return out
}

/**
 * Lay out artistic or paragraph text.
 * `frameWidth` is the paragraph frame width; exclusions reshape individual lines.
 */
export function layoutText(
  content: string,
  style: TextStyle,
  frameWidth: number,
  mode: 'artistic' | 'paragraph',
  exclusions: WrapExclusion[] = [],
  columns = 1,
  columnGutter = 18,
): TextLayoutResult {
  const family = style.fontFamily
  const size = style.fontSize || DEFAULT_SIZE
  const outlined = shapeText(style, family)
  const lineHeight = size * (style.lineHeight || 1.2)
  const axes = style.variableAxes ?? {}
  const paragraphs = content.split('\n')
  const lines: TextLine[] = []
  const columnWidth = mode === 'paragraph' && columns > 1
    ? (frameWidth - columnGutter * (columns - 1)) / columns
    : frameWidth
  const startX = style.indents.left

  const makeLine = (text: string, y: number, x: number, justifyWidth = 0): TextLine => {
    const chars = Array.from(text)
    const glyphs: PositionedGlyph[] = []
    let cx = x
    const spaceExtra = (() => {
      if (justifyWidth <= 0) return 0
      const spaces = chars.filter((c) => c === ' ').length
      if (!spaces) return 0
      const natural = fonts.measure(family, text, size, style.letterSpacing, axes)
      return Math.max(0, (justifyWidth - natural) / spaces)
    })()
    for (const ch of chars) {
      const outline = outlined ? fonts.outline(family, ch, axes) : null
      glyphs.push({ char: ch, x: cx, y, size, d: outline?.d ?? null, advance: (outline?.advance ?? 0.5) * size })
      cx += (outline?.advance ?? 0.5) * size + style.letterSpacing + (ch === ' ' ? style.wordSpacing + spaceExtra : 0)
    }
    return { glyphs, text, x, y, width: cx - x, baseline: y + size * 0.8 }
  }

  if (mode === 'artistic') {
    const block = style.bullet === 'none' ? content : content
    const parts = block.split('\n')
    parts.forEach((part, i) => {
      const text = transformText(part, style)
      const width = fonts.measure(family, text, size, style.letterSpacing, axes)
      const x = style.align === 'center' ? -width / 2 : style.align === 'right' ? -width : 0
      lines.push(makeLine(text, i * lineHeight, x))
    })
    const height = Math.max(lineHeight, parts.length * lineHeight)
    const width = Math.max(0, ...lines.map((l) => l.width))
    return { lines, width, height, outlined, overflow: false }
  }

  // Paragraph text: greedy line breaking with optional hyphenation and wrapping.
  let y = 0
  let overflow = false
  let bulletIndex = 0
  const availableWidth = (lineTop: number) => {
    let w = columnWidth
    for (const ex of exclusions) {
      const top = ex.y - ex.offset
      const bottom = ex.y + ex.h + ex.offset
      if (lineTop + lineHeight > top && lineTop < bottom) {
        const right = ex.x + ex.w + ex.offset
        if (right > 0) w = Math.min(w, Math.max(40, ex.x - ex.offset))
      }
    }
    return w
  }
  for (const para of paragraphs) {
    const prefix = bulletPrefix(bulletIndex, style)
    if (prefix) bulletIndex++
    const raw = transformText(para, style)
    if (style.dropCap > 0 && raw.trim().length > 4) {
      const capSize = size * style.dropCap
      const first = raw.trim()[0]
      const rest = raw.trim().slice(1)
      const capWidth = fonts.measure(family, first, capSize, 0, axes)
      const capLines = Math.max(1, Math.round(style.dropCap))
      const indent = capWidth + 6
      const words = rest.split(/\s+/).filter(Boolean)
      let lineIdx = 0
      let current = ''
      for (const word of words) {
        const test = current ? `${current} ${word}` : word
        const limit = availableWidth(y + lineIdx * lineHeight) - indent - style.indents.right
        if (fonts.measure(family, test, size, style.letterSpacing, axes) > limit && current) {
          lines.push(makeLine(current, y + lineIdx * lineHeight, startX + indent))
          lineIdx++
          current = word
        } else current = test
      }
      if (current) {
        lines.push(makeLine(current, y + lineIdx * lineHeight, startX + indent))
        lineIdx++
      }
      lines.push({
        glyphs: [{ char: first, x: startX, y, size: capSize, d: outlined ? fonts.outline(family, first, axes)?.d ?? null : null, advance: capWidth }],
        text: first, x: startX, y, width: capWidth, baseline: y + capSize * 0.8,
      })
      void capLines
      y += lineIdx * lineHeight + style.paragraphSpacing
      continue
    }
    const words = (prefix + raw).split(/(\s+)/).filter((w) => w.length > 0)
    let current = ''
    let lineIndex = 0
    const flush = (justify: boolean) => {
      if (!current) return
      const lineTop = y + lineIndex * lineHeight
      const limit = availableWidth(lineTop) - style.indents.right
      const justifyWidth = justify && style.align === 'justify' ? limit - startX : 0
      lines.push(makeLine(current, lineTop, startX, justifyWidth))
      lineIndex++
      current = ''
    }
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        current += ' '
        continue
      }
      const test = current + word
      const lineTop = y + lineIndex * lineHeight
      const limit = availableWidth(lineTop) - style.indents.right
      const width = fonts.measure(family, test, size, style.letterSpacing, axes)
      if (width > limit - startX && current.trim()) {
        // Try hyphenating the overflowing word before moving it down.
        let placed = false
        if (style.hyphenate) {
          for (const bp of breakPoints(word, true).reverse()) {
            const head = `${current.trimEnd()}-${word.slice(0, bp)}`
            if (fonts.measure(family, head, size, style.letterSpacing, axes) <= limit - startX) {
              lines.push(makeLine(head, lineTop, startX))
              lineIndex++
              current = `${word.slice(bp)} `
              placed = true
              break
            }
          }
        }
        if (!placed) {
          flush(true)
          current = `${word} `
        }
      } else {
        current = test
      }
    }
    flush(false)
    y += lineIndex * lineHeight + style.paragraphSpacing
  }
  const totalWidth = columnWidth
  const height = y
  if (mode === 'paragraph' && lines.length === 0) overflow = true
  return { lines, width: totalWidth, height, outlined, overflow }
}

/* -------------------------------------------------------- text on path ---- */

/**
 * Place laid-out lines along a path. Each line is projected onto the path by
 * arc length, which keeps spacing even around curves.
 */
export function layoutTextOnPath(
  content: string,
  style: TextStyle,
  pathPoints: { x: number; y: number }[],
  offset = 0,
  side: 'above' | 'below' = 'above',
): TextLayoutResult {
  const family = style.fontFamily
  const size = style.fontSize || DEFAULT_SIZE
  const outlined = fonts.hasOutlines(family)
  const axes = style.variableAxes ?? {}
  const text = transformText(content.replace(/\n/g, ' '), style)
  if (pathPoints.length < 2) {
    return { lines: [], width: 0, height: size, outlined, overflow: true }
  }
  // Cumulative arc length table.
  const cum: number[] = [0]
  for (let i = 1; i < pathPoints.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pathPoints[i].x - pathPoints[i - 1].x, pathPoints[i].y - pathPoints[i - 1].y))
  }
  const total = cum[cum.length - 1]
  const atLength = (len: number) => {
    const clamped = clamp(len, 0, total)
    let i = 1
    while (i < cum.length - 1 && cum[i] < clamped) i++
    const t = (clamped - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])
    const a = pathPoints[i - 1]
    const b = pathPoints[i]
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) }
  }
  const glyphs: PositionedGlyph[] = []
  const textWidth = fonts.measure(family, text, size, style.letterSpacing, axes)
  let cursor = offset + (layoutAlignOffset(style.align, total, textWidth))
  for (const ch of Array.from(text)) {
    const adv = fonts.measure(family, ch, size, style.letterSpacing, axes)
    const p = atLength(cursor + adv / 2)
    const outline = outlined ? fonts.outline(family, ch, axes) : null
    glyphs.push({
      char: ch,
      x: p.x,
      y: p.y,
      size,
      d: outline?.d ?? null,
      advance: (outline?.advance ?? 0.5) * size,
    })
    glyphs[glyphs.length - 1].x = p.x
    ;(glyphs[glyphs.length - 1] as PositionedGlyph & { angle?: number }).angle = p.angle + (side === 'below' ? Math.PI : 0)
    cursor += adv
  }
  return { lines: [{ glyphs, text, x: 0, y: 0, width: textWidth, baseline: 0 }], width: textWidth, height: size, outlined, overflow: textWidth > total }
}

function layoutAlignOffset(align: TextStyle['align'], total: number, textWidth: number): number {
  if (align === 'center') return (total - textWidth) / 2
  if (align === 'right') return total - textWidth
  return 0
}

/** Convert a laid-out line into a PathData (used by export and envelope ops). */
export function lineToPathData(line: TextLine): PathData {
  const subpaths = []
  for (const g of line.glyphs) {
    if (!g.d || g.char === ' ') continue
    const parsed = parseSvgPath(g.d)
    for (const sp of parsed) {
      subpaths.push(subPath(sp.map((n) => node(
        line.x + g.x - g.x + n.x * g.size + g.x,
        line.y + line.y - line.y - n.y * g.size + line.y,
        'sharp',
      )), true))
    }
  }
  return pathFromSubpaths(subpaths)
}

/** Minimal SVG path parser (M/L/C/Q/Z + relative forms) used for glyph outlines. */
export function parseSvgPath(d: string): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []
  let cx = 0
  let cy = 0
  let startX = 0
  let startY = 0
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  let i = 0
  const num = () => Number(tokens[i++])
  const push = (x: number, y: number) => current.push({ x, y })
  while (i < tokens.length) {
    const cmd = tokens[i++]
    switch (cmd) {
      case 'M': case 'm': {
        if (current.length) out.push(current)
        current = []
        const x = num()
        const y = num()
        cx = cmd === 'm' ? cx + x : x
        cy = cmd === 'm' ? cy + y : y
        startX = cx
        startY = cy
        push(cx, cy)
        break
      }
      case 'L': case 'l': {
        const x = num()
        const y = num()
        cx = cmd === 'l' ? cx + x : x
        cy = cmd === 'l' ? cy + y : y
        push(cx, cy)
        break
      }
      case 'H': case 'h': {
        const x = num()
        cx = cmd === 'h' ? cx + x : x
        push(cx, cy)
        break
      }
      case 'V': case 'v': {
        const y = num()
        cy = cmd === 'v' ? cy + y : y
        push(cx, cy)
        break
      }
      case 'C': case 'c': {
        const n = [num(), num(), num(), num(), num(), num()]
        const abs = cmd === 'C'
        const p0 = { x: cx, y: cy }
        const p1 = { x: abs ? n[0] : cx + n[0], y: abs ? n[1] : cy + n[1] }
        const p2 = { x: abs ? n[2] : cx + n[2], y: abs ? n[3] : cy + n[3] }
        const p3 = { x: abs ? n[4] : cx + n[4], y: abs ? n[5] : cy + n[5] }
        for (let t = 1; t <= 6; t++) {
          const tt = t / 6
          const mt = 1 - tt
          push(
            mt ** 3 * p0.x + 3 * mt * mt * tt * p1.x + 3 * mt * tt * tt * p2.x + tt ** 3 * p3.x,
            mt ** 3 * p0.y + 3 * mt * mt * tt * p1.y + 3 * mt * tt * tt * p2.y + tt ** 3 * p3.y,
          )
        }
        cx = p3.x
        cy = p3.y
        break
      }
      case 'Q': case 'q': {
        const n = [num(), num(), num(), num()]
        const abs = cmd === 'Q'
        const p0 = { x: cx, y: cy }
        const p1 = { x: abs ? n[0] : cx + n[0], y: abs ? n[1] : cy + n[1] }
        const p2 = { x: abs ? n[2] : cx + n[2], y: abs ? n[3] : cy + n[3] }
        for (let t = 1; t <= 6; t++) {
          const tt = t / 6
          const mt = 1 - tt
          push(mt * mt * p0.x + 2 * mt * tt * p1.x + tt * tt * p2.x, mt * mt * p0.y + 2 * mt * tt * p1.y + tt * tt * p2.y)
        }
        cx = p2.x
        cy = p2.y
        break
      }
      case 'Z': case 'z': {
        cx = startX
        cy = startY
        break
      }
      default: {
        // Unknown/unsupported command: consume a plausible argument count.
        num()
        break
      }
    }
  }
  if (current.length) out.push(current)
  return out
}
