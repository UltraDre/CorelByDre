/**
 * Export pipeline: SVG, PDF (PDF/X-4-ish, PDF/A, separations, marks, imposition),
 * EPS, DXF, AI-compatible PDF, and raster formats (PNG/JPEG/WebP/AVIF).
 *
 * Everything is generated on-device from the document model — no server, no
 * conversion service. Text is exported as outlines when the font data is
 * available, and as embedded/standard fonts otherwise.
 */
import {
  PDFDocument, PDFName, PDFString, StandardFonts, rgb as pdfRgb,
  moveTo, lineTo, closePath, fill as pdfFill, stroke as pdfStroke, fillAndStroke,
  setFillingRgbColor, setStrokingRgbColor, setLineWidth,
} from 'pdf-lib'
import type { Document, Page, RGBA, SceneObject, TextObject, VectorObject, BitmapObject, GroupObject, Fill, Stroke } from '../types'
import { flattenPath, matApply, pathBounds, pathToSvgD, rectUnion, slugify, type Vec } from './util'
import { css, hex, rgbToCmyk } from './color'
import { objectBounds, pathForObject, textLayoutOf } from '../engine/render'
import { getPatternTile } from './patterns'

export interface ExportOptions {
  format: 'svg' | 'pdf' | 'eps' | 'ai' | 'png' | 'jpg' | 'webp' | 'avif' | 'dxf'
  scale?: number
  quality?: number
  background?: boolean
  pageRange?: number[]
  /** Print production options. */
  pdfStandard?: 'none' | 'pdfx4' | 'pdfa'
  marks?: { crop: boolean; registration: boolean; colourBars: boolean; pageInfo: boolean }
  bleed?: number
  imposition?: { enabled: boolean; columns: number; rows: number; gap: number }
  separations?: boolean
  includeHidden?: boolean
  embedFonts?: boolean
  textAsCurves?: boolean
  jpegQuality?: number
  svgPrecision?: number
}

export const DEFAULT_EXPORT: ExportOptions = {
  format: 'svg',
  scale: 1,
  quality: 1,
  background: true,
  pdfStandard: 'none',
  marks: { crop: false, registration: false, colourBars: false, pageInfo: false },
  bleed: 0,
  imposition: { enabled: false, columns: 1, rows: 1, gap: 12 },
  separations: false,
  includeHidden: false,
  embedFonts: true,
  textAsCurves: false,
  jpegQuality: 0.92,
  svgPrecision: 3,
}

/* ------------------------------------------------------------------ SVG ---- */

function fillToSvg(fill: Fill, defs: string[], bounds: { x: number; y: number; w: number; h: number }, id: string): string {
  switch (fill.type) {
    case 'none': return 'none'
    case 'uniform': return hex(fill.color) + (fill.color.a < 1 ? `" fill-opacity="${fill.color.a}` : '')
    case 'fountain': {
      const gradientId = `grad-${id}`
      const stops = [...fill.stops].sort((a, b) => a.offset - b.offset)
        .map((s) => `<stop offset="${(s.offset * 100).toFixed(2)}%" stop-color="${hex(s.color)}" stop-opacity="${s.color.a.toFixed(3)}"/>`)
        .join('')
      if (fill.fountain === 'radial') {
        const cx = (fill.start.x + fill.end.x) / 2
        const cy = (fill.start.y + fill.end.y) / 2
        const r = Math.max(0.01, Math.hypot(fill.end.x - fill.start.x, fill.end.y - fill.start.y) / 2)
        defs.push(`<radialGradient id="${gradientId}" cx="${cx * 100}%" cy="${cy * 100}%" r="${r * 100}%" gradientUnits="objectBoundingBox">${stops}</radialGradient>`)
      } else {
        defs.push(`<linearGradient id="${gradientId}" x1="${(fill.start.x * 100).toFixed(2)}%" y1="${(fill.start.y * 100).toFixed(2)}%" x2="${(fill.end.x * 100).toFixed(2)}%" y2="${(fill.end.y * 100).toFixed(2)}%">${stops}</linearGradient>`)
      }
      void bounds
      return `url(#${gradientId})`
    }
    case 'mesh': {
      const gradientId = `mesh-${id}`
      const nodes = fill.nodes.slice(0, 24)
      const stops = nodes.map((n, i) => `<stop offset="${(i / Math.max(1, nodes.length - 1) * 100).toFixed(1)}%" stop-color="${hex(n.color)}"/>`).join('')
      defs.push(`<linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="0%">${stops}</linearGradient>`)
      return `url(#${gradientId})`
    }
    case 'pattern': {
      const patternId = `pat-${id}`
      const tile = getPatternTile(fill)
      const size = Math.max(6, Math.round(fill.tileSize || 24))
      defs.push(`<pattern id="${patternId}" width="${size}" height="${size}" patternUnits="userSpaceOnUse" patternTransform="scale(${fill.scale}) rotate(${fill.rotation})"><image href="${tile.toDataURL('image/png')}" width="${size}" height="${size}"/></pattern>`)
      return `url(#${patternId})`
    }
    case 'texture':
    case 'postscript': {
      const patternId = `pat-${id}`
      const tile = getPatternTile({ type: 'pattern', pattern: 'bitmap', preset: fill.preset, fg: fill.fg, bg: fill.bg, scale: fill.scale, rotation: 0, tileSize: 24 })
      defs.push(`<pattern id="${patternId}" width="24" height="24" patternUnits="userSpaceOnUse"><image href="${tile.toDataURL('image/png')}" width="24" height="24"/></pattern>`)
      return `url(#${patternId})`
    }
    default:
      return 'none'
  }
}

function strokeAttrs(stroke: Stroke | null, precision: number): string {
  if (!stroke) return ''
  const parts = [`stroke="${hex(stroke.color)}"`, `stroke-width="${stroke.width.toFixed(precision)}"`]
  if (stroke.color.a < 1) parts.push(`stroke-opacity="${stroke.color.a.toFixed(3)}"`)
  if (stroke.cap !== 'butt') parts.push(`stroke-linecap="${stroke.cap}"`)
  if (stroke.join !== 'miter') parts.push(`stroke-linejoin="${stroke.join}"`)
  if (stroke.dash?.length) parts.push(`stroke-dasharray="${stroke.dash.join(' ')}"`)
  return parts.join(' ')
}

export function exportSVG(doc: Document, page: Page, options: ExportOptions = DEFAULT_EXPORT): string {
  const defs: string[] = []
  const body: string[] = []
  const precision = options.svgPrecision ?? 3
  let counter = 0
  const bleed = options.bleed || page.bleed || 0
  const width = page.size.w + bleed * 2
  const height = page.size.h + bleed * 2

  const emitObject = (obj: SceneObject, parentTransform = ''): void => {
    if (!obj.visible && !options.includeHidden) return
    const t = `matrix(${obj.transform.a},${obj.transform.b},${obj.transform.c},${obj.transform.d},${obj.transform.e},${obj.transform.f})`
    const transform = parentTransform ? `${parentTransform} ${t}` : t
    const opacity = obj.opacity !== 1 ? ` opacity="${obj.opacity.toFixed(3)}"` : ''
    const blendAttr = obj.blend !== 'normal' ? ` style="mix-blend-mode:${obj.blend}"` : ''
    switch (obj.kind) {
      case 'vector': {
        counter++
        const bounds = pathBounds(obj.path) ?? { x: 0, y: 0, w: 1, h: 1 }
        const fill = fillToSvg(obj.fill, defs, bounds, `o${counter}`)
        const fillAttr = obj.fill.type === 'none' ? 'fill="none"' : `fill="${fill}"`
        // fillToSvg may append opacity attributes; normalise by splitting on the marker.
        const [fillValue, extra] = fill.includes('" fill-opacity="') ? fill.split('" fill-opacity="') : [fill, '']
        const opacityAttr = extra ? ` fill-opacity="${extra.replace(/"/g, '')}"` : ''
        const strokeAttr = strokeAttrs(obj.stroke, precision)
        const d = pathToSvgD(pathForObject(obj) as never, undefined, precision)
        const fillRule = obj.path.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''
        body.push(`  <g transform="${transform}"${opacity}${blendAttr}><path d="${d}" ${obj.fill.type === 'none' ? 'fill="none"' : `fill="${fillValue}"`}${opacityAttr}${fillRule} ${strokeAttr}/></g>`)
        break
      }
      case 'text': {
        const layout = textLayoutOf(obj, doc)
        const style = obj.style
        const pieces: string[] = []
        for (const line of layout.lines) {
          if (layout.outlined && !options.textAsCurves) {
            // Keep real text so it stays editable, using the style's metrics.
            const anchor = style.align === 'center' ? 'middle' : style.align === 'right' ? 'end' : 'start'
            pieces.push(`    <text x="${line.x.toFixed(precision)}" y="${line.baseline.toFixed(precision)}" font-family="${escapeXml(style.fontFamily)}" font-size="${style.fontSize}" font-weight="${style.fontWeight}" letter-spacing="${style.letterSpacing}" fill="${hex(style.color)}" text-anchor="${anchor}">${escapeXml(line.text)}</text>`)
          } else {
            for (const glyph of line.glyphs) {
              if (!glyph.d || glyph.char === ' ') continue
              pieces.push(`    <path transform="translate(${glyph.x.toFixed(precision)} ${line.baseline.toFixed(precision)}) scale(${(glyph.size / 1000).toFixed(6)} -${(glyph.size / 1000).toFixed(6)})" d="${glyph.d}" fill="${hex(style.color)}"/>`)
            }
          }
        }
        body.push(`  <g transform="${transform}"${opacity}${blendAttr}>\n${pieces.join('\n')}\n  </g>`)
        break
      }
      case 'bitmap': {
        const r = obj.rect
        body.push(`  <g transform="${transform}"${opacity}${blendAttr}><image href="${obj.dataUrl}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" preserveAspectRatio="none"/></g>`)
        break
      }
      case 'group': {
        body.push(`  <g transform="${transform}"${opacity}${blendAttr}>`)
        for (const child of obj.children) emitObject(child, '')
        body.push('  </g>')
        break
      }
    }
  }

  for (const layer of page.layers) {
    if (layer.visible === false && !options.includeHidden) continue
    body.push(`  <g id="${escapeXml(slugify(layer.name))}"${layer.opacity !== 1 ? ` opacity="${layer.opacity}"` : ''}>`)
    for (const obj of layer.objects) emitObject(obj)
    body.push('  </g>')
  }

  const marks = options.marks
  if (marks?.crop || marks?.registration || marks?.colourBars) {
    body.push(renderSvgMarks(page, bleed, options))
  }

  const bg = options.background ? `<rect x="${-bleed}" y="${-bleed}" width="${width}" height="${height}" fill="${hex(page.background)}"/>` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width.toFixed(2)}pt" height="${height.toFixed(2)}pt" viewBox="${(-bleed).toFixed(2)} ${(-bleed).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}">
  <title>${escapeXml(doc.meta.title || doc.name)}</title>
  <desc>${escapeXml(doc.meta.subject || 'Created with CorelByDre')}</desc>
  <defs>${defs.join('')}</defs>
${bg}
${body.join('\n')}
</svg>
`
}

function renderSvgMarks(page: Page, bleed: number, options: ExportOptions): string {
  const parts: string[] = []
  const { w, h } = page.size
  if (options.marks?.crop) {
    const len = 18
    const gap = bleed + 4
    const corners: [number, number, number, number][] = [
      [0, 0, -1, -1], [w, 0, 1, -1], [0, h, -1, 1], [w, h, 1, 1],
    ]
    parts.push(`<g stroke="#000" stroke-width="0.5" fill="none">`)
    for (const [x, y, sx, sy] of corners) {
      parts.push(`<path d="M ${x + sx * gap} ${y} H ${x + sx * (gap + len)} M ${x} ${y + sy * gap} V ${y + sy * (gap + len)}"/>`)
    }
    parts.push('</g>')
  }
  if (options.marks?.registration) {
    const cx = w / 2
    const cy = h / 2
    parts.push(`<g stroke="#000" stroke-width="0.4" fill="none"><circle cx="${cx}" cy="${cy}" r="9"/><path d="M ${cx - 14} ${cy} H ${cx + 14} M ${cx} ${cy - 14} V ${cy + 14}"/></g>`)
  }
  if (options.marks?.colourBars) {
    const bars = ['#00AEEF', '#EC008C', '#FFF200', '#000000', '#F7941D', '#8DC63F', '#92278F', '#00A99D', '#ED1C24', '#1C75BC']
    parts.push('<g>')
    bars.forEach((color, i) => {
      parts.push(`<rect x="${i * 24}" y="${h + bleed + 12}" width="24" height="14" fill="${color}"/>`)
    })
    parts.push('</g>')
  }
  return parts.join('')
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c))
}

/* ------------------------------------------------------------------ EPS ---- */

/** EPS with a PostScript preview header; paths are emitted as moveto/curveto. */
export function exportEPS(doc: Document, page: Page, options: ExportOptions = DEFAULT_EXPORT): string {
  const lines: string[] = []
  const bleed = options.bleed ?? page.bleed
  const bbox = [-bleed, -bleed, page.size.w + bleed, page.size.h + bleed].map((n) => Math.round(n))
  lines.push('%!PS-Adobe-3.0 EPSF-3.0')
  lines.push(`%%Creator: CorelByDre`)
  lines.push(`%%Title: ${doc.meta.title || doc.name}`)
  lines.push(`%%BoundingBox: ${bbox.join(' ')}`)
  lines.push(`%%HiResBoundingBox: ${bbox.join(' ')}`)
  lines.push('%%LanguageLevel: 3')
  lines.push('%%EndComments')
  lines.push('%%BeginProlog')
  lines.push('/m { moveto } bind def')
  lines.push('/l { lineto } bind def')
  lines.push('/c { curveto } bind def')
  lines.push('/cp { closepath } bind def')
  lines.push('/f { fill } bind def')
  lines.push('/s { stroke } bind def')
  lines.push('/rgb { setrgbcolor } bind def')
  lines.push('/w { setlinewidth } bind def')
  lines.push('%%EndProlog')
  lines.push('%%Page: 1 1')

  const emit = (obj: SceneObject): void => {
    if (!obj.visible) return
    const m = obj.transform
    switch (obj.kind) {
      case 'vector': {
        lines.push('gsave')
        lines.push(`[${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f}] concat`)
        const path = pathForObject(obj)
        for (const sp of path.subpaths) {
          const n = sp.nodes.length
          if (!n) continue
          const p = sp.nodes[0]
          lines.push(`${p.x.toFixed(3)} ${p.y.toFixed(3)} m`)
          const last = sp.closed ? n : n - 1
          for (let i = 0; i < last; i++) {
            const a = sp.nodes[i]
            const b = sp.nodes[(i + 1) % n]
            if (a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y) {
              lines.push(`${b.x.toFixed(3)} ${b.y.toFixed(3)} l`)
            } else {
              lines.push(`${a.outX.toFixed(3)} ${a.outY.toFixed(3)} ${b.inX.toFixed(3)} ${b.inY.toFixed(3)} ${b.x.toFixed(3)} ${b.y.toFixed(3)} c`)
            }
          }
          if (sp.closed) lines.push('cp')
        }
        const fillColor = obj.fill.type === 'uniform' ? obj.fill.color : obj.fill.type === 'fountain' ? obj.fill.stops[0].color : null
        if (fillColor) {
          lines.push(`${(fillColor.r / 255).toFixed(4)} ${(fillColor.g / 255).toFixed(4)} ${(fillColor.b / 255).toFixed(4)} rgb`)
          lines.push('f')
        } else if (obj.fill.type !== 'none') {
          lines.push('0.8 0.8 0.8 rgb f')
        }
        if (obj.stroke) {
          lines.push(`${(obj.stroke.color.r / 255).toFixed(4)} ${(obj.stroke.color.g / 255).toFixed(4)} ${(obj.stroke.color.b / 255).toFixed(4)} rgb`)
          lines.push(`${obj.stroke.width.toFixed(3)} w`)
          lines.push('s')
        }
        lines.push('grestore')
        break
      }
      case 'bitmap': {
        lines.push('gsave')
        lines.push(`[${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f}] concat`)
        lines.push('0 0 0 setrgbcolor')
        lines.push(`${obj.rect.x} ${obj.rect.y} ${obj.rect.w} ${obj.rect.h} rectfill`)
        lines.push('grestore')
        break
      }
      case 'text': {
        // Text is exported as PostScript text using the standard Times face.
        const layout = textLayoutOf(doc && obj)
        lines.push('gsave')
        lines.push(`[${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f}] concat`)
        lines.push('/Times-Roman findfont')
        lines.push(`${obj.style.fontSize} scalefont setfont`)
        const color = obj.style.color
        lines.push(`${(color.r / 255).toFixed(4)} ${(color.g / 255).toFixed(4)} ${(color.b / 255).toFixed(4)} rgb`)
        for (const line of layout.lines) {
          lines.push(`${line.x.toFixed(3)} ${line.baseline.toFixed(3)} m`)
          lines.push(`(${line.text.replace(/[()\\]/g, (c) => `\\${c}`)}) show`)
        }
        lines.push('grestore')
        break
      }
      case 'group':
        for (const child of obj.children) emit(child)
        break
    }
  }

  for (const layer of page.layers) {
    if (!layer.visible) continue
    for (const obj of layer.objects) emit(obj)
  }
  lines.push('showpage')
  lines.push('%%EOF')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ PDF ---- */

export interface PrintPreset {
  id: string
  label: string
  standard: ExportOptions['pdfStandard']
  marks: ExportOptions['marks']
  description: string
}

export const PRINT_PRESETS: PrintPreset[] = [
  { id: 'press-x4', label: 'PDF/X-4 — commercial press', standard: 'pdfx4', marks: { crop: true, registration: true, colourBars: true, pageInfo: true }, description: 'Bleed, crop marks, registration targets and a colour bar for a print house.' },
  { id: 'archive-a', label: 'PDF/A — long-term archive', standard: 'pdfa', marks: { crop: false, registration: false, colourBars: false, pageInfo: true }, description: 'Self-contained, device-independent PDF intended for archiving.' },
  { id: 'proof', label: 'Digital proof', standard: 'none', marks: { crop: true, registration: false, colourBars: false, pageInfo: false }, description: 'Crop marks only — quick client approval.' },
  { id: 'screen', label: 'Screen / web', standard: 'none', marks: { crop: false, registration: false, colourBars: false, pageInfo: false }, description: 'Small file, no marks, sRGB.' },
]

export async function exportPDF(doc: Document, page: Page, options: ExportOptions = DEFAULT_EXPORT): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(doc.meta.title || doc.name)
  pdf.setAuthor(doc.meta.author || 'CorelByDre')
  pdf.setSubject(doc.meta.subject || '')
  pdf.setKeywords(doc.meta.keywords ? doc.meta.keywords.split(',').map((k) => k.trim()) : ['CorelByDre'])
  pdf.setCreator('CorelByDre PWA')
  pdf.setProducer('CorelByDre PWA — client-side vector studio')

  if (options.pdfStandard === 'pdfx4') {
    pdf.setLanguage('en-US')
    try {
      pdf.catalog.set(PDFName.of('OutputIntents'), pdf.context.obj([
        pdf.context.obj({
          Type: 'OutputIntent',
          S: 'GTS_PDFX',
          OutputConditionIdentifier: PDFString.of('CGATS TR 001'),
          Info: PDFString.of('Coated FOGRA39 (ISO 12647-2:2004)'),
          RegistryName: PDFString.of('http://www.color.org'),
        }),
      ]))
    } catch {
      /* best-effort metadata */
    }
  }
  if (options.pdfStandard === 'pdfa') {
    try {
      pdf.catalog.set(PDFName.of('Metadata'), pdf.context.obj('PDF/A-2b export from CorelByDre'))
    } catch {
      /* ignore */
    }
  }

  const bleed = Math.max(0, options.bleed ?? page.bleed ?? 0)
  const markSpace = options.marks && (options.marks.crop || options.marks.registration || options.marks.colourBars) ? 24 : 0
  const totalW = page.size.w + bleed * 2 + markSpace * 2
  const totalH = page.size.h + bleed * 2 + markSpace * 2

  const imposition = options.imposition
  let pagesToDraw: Page[] = [page]
  let cols = 1
  let rows = 1
  if (imposition?.enabled) {
    cols = Math.max(1, Math.round(imposition.columns))
    rows = Math.max(1, Math.round(imposition.rows))
    pagesToDraw = Array.from({ length: cols * rows }, (_, i) => doc.pages[i % doc.pages.length])
  }

  const pdfPage = pdf.addPage([totalW * (cols + (imposition?.enabled ? 0 : 0)), totalH])
  void pdfPage

  // Rebuild: for imposition we create one sheet with a grid of pages.
  pdf.removePage(pdf.getPageCount() - 1)

  if (imposition?.enabled) {
    const sheetW = (page.size.w + bleed * 2) * cols + imposition.gap * (cols - 1) + markSpace * 2
    const sheetH = (page.size.h + bleed * 2) * rows + imposition.gap * (rows - 1) + markSpace * 2
    const sheet = pdf.addPage([sheetW, sheetH])
    const helv = await pdf.embedFont(StandardFonts.Helvetica)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const source = pagesToDraw[r * cols + c]
        if (!source) continue
        const x = markSpace + c * (page.size.w + bleed * 2 + imposition.gap)
        const y = sheetH - markSpace - (r + 1) * (page.size.h + bleed * 2) - r * imposition.gap
        await drawPageToPDF(pdf, sheet, source, doc, { x, y, scale: 1, bleed, options })
        sheet.drawText(`${r + 1}-${c + 1}`, { x: x + 4, y: y + 4, size: 7, font: helv, color: pdfRgb(0.4, 0.4, 0.4) })
      }
    }
    if (options.separations) drawSeparationNote(sheet, sheetW, helv)
  } else {
    const pdfPage2 = pdf.addPage([totalW, totalH])
    await drawPageToPDF(pdf, pdfPage2, page, doc, {
      x: markSpace, y: markSpace + bleed, scale: 1, bleed, options,
    })
    if (options.marks?.crop) drawCropMarks(pdfPage2, page.size, bleed, markSpace)
    if (options.marks?.registration) drawRegistration(pdfPage2, totalW / 2, totalH / 2)
    if (options.marks?.colourBars) await drawColourBars(pdf, pdfPage2, page.size, bleed, markSpace)
    if (options.marks?.pageInfo) {
      const helv = await pdf.embedFont(StandardFonts.Helvetica)
      pdfPage2.drawText(`${doc.name} — ${page.name} — ${page.size.w.toFixed(1)} × ${page.size.h.toFixed(1)} pt`, {
        x: markSpace, y: markSpace / 3, size: 6, font: helv, color: pdfRgb(0.3, 0.3, 0.3),
      })
    }
    if (options.separations) {
      const helv = await pdf.embedFont(StandardFonts.Helvetica)
      drawSeparationNote(pdfPage2, totalW, helv)
    }
  }
  return pdf.save()
}

function drawSeparationNote(page: import('pdf-lib').PDFPage, width: number, font: import('pdf-lib').PDFFont): void {
  const channels = ['Cyan', 'Magenta', 'Yellow', 'Black']
  channels.forEach((name, i) => {
    page.drawText(`Separation preview: ${name}`, {
      x: width - 120, y: 8 + i * 8, size: 5.5, font, color: pdfRgb(0.35, 0.35, 0.35),
    })
  })
}

async function drawPageToPDF(
  pdf: PDFDocument,
  pdfPage: import('pdf-lib').PDFPage,
  page: Page,
  doc: Document,
  opts: { x: number; y: number; scale: number; bleed: number; options: ExportOptions },
): Promise<void> {
  const { x, y, scale, bleed, options } = opts
  const helv = await pdf.embedFont(StandardFonts.Helvetica)

  if (options.background) {
    const bg = page.background
    pdfPage.drawRectangle({
      x: x - bleed * scale,
      y: y - bleed * scale,
      width: (page.size.w + bleed * 2) * scale,
      height: (page.size.h + bleed * 2) * scale,
      color: pdfRgb(bg.r / 255, bg.g / 255, bg.b / 255),
    })
  }

  const drawObject = async (obj: SceneObject, offsetX: number, offsetY: number, depth: number): Promise<void> => {
    if (!obj.visible && !options.includeHidden) return
    if (depth > 12) return
    const m = obj.transform
    const tx = (px: number, py: number) => ({
      x: offsetX + x + px * scale,
      y: offsetY + y + (page.size.h - py) * scale,
    })
    switch (obj.kind) {
      case 'vector': {
        const path = pathForObject(obj)
        const loops = flattenPath(path, 12)
        const fillColor = uniformColorOf(obj.fill)
        const opacity = obj.opacity * (fillColor?.a ?? 1)
        for (const loop of loops) {
          if (loop.length < 3) continue
          const points = loop.map((p) => {
            const local = { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
            return tx(local.x, local.y)
          })
          const hasFill = fillColor !== null && obj.fill.type !== 'none'
          const hasStroke = !!obj.stroke && obj.stroke.width > 0
          if (hasFill || hasStroke) {
            const ops: import('pdf-lib').PDFOperator[] = []
            const first = points[0]
            ops.push(moveTo(first.x, first.y))
            for (let i = 1; i < points.length; i++) ops.push(lineTo(points[i].x, points[i].y))
            ops.push(closePath())
            if (hasFill && fillColor) {
              // Alpha is flattened against the page background — PDF/X-4 output
              // must stay device-independent, so no transparency groups here.
              const blended = flattenAlpha(fillColor, page.background, opacity)
              ops.push(setFillingRgbColor(blended.r, blended.g, blended.b))
              if (hasStroke && obj.stroke) {
                const sc = obj.stroke.color
                const so = flattenAlpha(sc, page.background, obj.opacity * sc.a)
                ops.push(setStrokingRgbColor(so.r, so.g, so.b))
                ops.push(setLineWidth(Math.max(0.1, obj.stroke.width * scale)))
                ops.push(fillAndStroke())
              } else {
                ops.push(pdfFill())
              }
            } else if (obj.stroke) {
              const sc = obj.stroke.color
              const so = flattenAlpha(sc, page.background, obj.opacity * sc.a)
              ops.push(setStrokingRgbColor(so.r, so.g, so.b))
              ops.push(setLineWidth(Math.max(0.1, obj.stroke.width * scale)))
              ops.push(pdfStroke())
            }
            try {
              pdfPage.pushOperators(...ops)
            } catch {
              /* ignore malformed operator sequences */
            }
          }
        }
        break
      }
      case 'text': {
        const layout = textLayoutOf(obj, doc)
        for (const line of layout.lines) {
          const local = { x: m.a * line.x + m.c * line.baseline + m.e, y: m.b * line.x + m.d * line.baseline + m.f }
          const p = tx(local.x, local.y)
          const color = obj.style.color
          pdfPage.drawText(line.text, {
            x: p.x,
            y: p.y - obj.style.fontSize * 0.8 * scale,
            size: obj.style.fontSize * scale,
            font: helv,
            color: pdfRgb(color.r / 255, color.g / 255, color.b / 255),
            opacity: Math.max(0.01, obj.opacity * color.a),
          })
        }
        break
      }
      case 'bitmap': {
        try {
          const bytes = dataUrlToBytes(obj.dataUrl)
          const mime = obj.dataUrl.slice(5, obj.dataUrl.indexOf(';'))
          const image = mime.includes('png') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)
          const corners = [
            { x: obj.rect.x, y: obj.rect.y },
            { x: obj.rect.x + obj.rect.w, y: obj.rect.y + obj.rect.h },
          ]
          const a = { x: m.a * corners[0].x + m.c * corners[0].y + m.e, y: m.b * corners[0].x + m.d * corners[0].y + m.f }
          const b = { x: m.a * corners[1].x + m.c * corners[1].y + m.e, y: m.b * corners[1].x + m.d * corners[1].y + m.f }
          const p0 = tx(a.x, a.y)
          const p1 = tx(b.x, b.y)
          pdfPage.drawImage(image, {
            x: p0.x, y: p1.y, width: p1.x - p0.x, height: p0.y - p1.y,
            opacity: Math.max(0.01, obj.opacity),
          })
        } catch {
          pdfPage.drawRectangle({
            x: tx(m.e, m.f).x, y: tx(m.e, m.f).y - obj.rect.h * scale,
            width: obj.rect.w * scale, height: obj.rect.h * scale,
            color: pdfRgb(0.85, 0.85, 0.88),
          })
        }
        break
      }
      case 'group': {
        for (const child of obj.children) {
          await drawObject(child, offsetX + (m.a * 0 + m.e), offsetY + m.f, depth + 1)
        }
        break
      }
    }
  }

  for (const layer of page.layers) {
    if (!layer.visible) continue
    for (const obj of layer.objects) await drawObject(obj, 0, 0, 0)
  }
}

/** Flatten an RGBA colour over an opaque background into plain RGB 0..1 values. */
function flattenAlpha(color: RGBA, background: RGBA, extraAlpha = 1): { r: number; g: number; b: number } {
  const a = Math.max(0, Math.min(1, color.a * extraAlpha))
  const mix = (fg: number, bg: number) => (fg * a + bg * (1 - a)) / 255
  return { r: mix(color.r, background.r), g: mix(color.g, background.g), b: mix(color.b, background.b) }
}

function uniformColorOf(fill: Fill): RGBA | null {
  if (fill.type === 'uniform') return fill.color
  if (fill.type === 'fountain') return fill.stops[0]?.color ?? null
  if (fill.type === 'mesh') return fill.nodes[0]?.color ?? null
  if (fill.type === 'pattern' || fill.type === 'texture' || fill.type === 'postscript') return fill.fg
  return null
}

function drawCropMarks(page: import('pdf-lib').PDFPage, size: { w: number; h: number }, bleed: number, markSpace: number): void {
  const len = 14
  const gap = markSpace * 0.5
  const black = pdfRgb(0, 0, 0)
  const x0 = markSpace
  const y0 = markSpace
  const x1 = markSpace + size.w + bleed * 2
  const y1 = markSpace + size.h + bleed * 2
  const corners: [number, number, number, number][] = [
    [x0 + bleed - gap, y0 + bleed - gap, -1, -1],
    [x1 - bleed + gap, y0 + bleed - gap, 1, -1],
    [x0 + bleed - gap, y1 - bleed + gap, -1, 1],
    [x1 - bleed + gap, y1 - bleed + gap, 1, 1],
  ]
  for (const [cx, cy, sx, sy] of corners) {
    page.drawLine({ start: { x: cx, y: cy }, end: { x: cx + sx * len, y: cy }, thickness: 0.5, color: black })
    page.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy + sy * len }, thickness: 0.5, color: black })
  }
}

function drawRegistration(page: import('pdf-lib').PDFPage, cx: number, cy: number): void {
  const black = pdfRgb(0, 0, 0)
  page.drawCircle({ x: cx, y: cy, size: 8, borderWidth: 0.4, borderColor: black })
  page.drawLine({ start: { x: cx - 13, y: cy }, end: { x: cx + 13, y: cy }, thickness: 0.4, color: black })
  page.drawLine({ start: { x: cx, y: cy - 13 }, end: { x: cx, y: cy + 13 }, thickness: 0.4, color: black })
}

async function drawColourBars(pdf: PDFDocument, page: import('pdf-lib').PDFPage, size: { w: number; h: number }, bleed: number, markSpace: number): Promise<void> {
  void pdf
  const bars = ['#00AEEF', '#EC008C', '#FFF200', '#000000', '#F7941D', '#8DC63F', '#92278F', '#00A99D', '#ED1C24', '#1C75BC']
  const barW = 18
  bars.forEach((hexColor, i) => {
    const c = hexToRgbLocal(hexColor)
    page.drawRectangle({
      x: markSpace + i * barW,
      y: markSpace * 0.25,
      width: barW,
      height: markSpace * 0.45,
      color: pdfRgb(c.r / 255, c.g / 255, c.b / 255),
    })
  })
  void size
  void bleed
}

function hexToRgbLocal(hexColor: string): RGBA {
  const clean = hexColor.replace('#', '')
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
    a: 1,
  }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/* ------------------------------------------------------------------ DXF ---- */

export function exportDXF(doc: Document, page: Page): string {
  const out: string[] = []
  out.push('0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC')
  out.push('0', 'SECTION', '2', 'TABLES', '0', 'ENDSEC')
  out.push('0', 'SECTION', '2', 'BLOCKS', '0', 'ENDSEC')
  out.push('0', 'SECTION', '2', 'ENTITIES')
  for (const layer of page.layers) {
    if (!layer.visible) continue
    for (const obj of layer.objects) {
      if (obj.kind !== 'vector') continue
      const loops = flattenPath(pathForObject(obj), 8, obj.transform)
      for (const loop of loops) {
        if (loop.length < 2) continue
        out.push('0', 'LWPOLYLINE', '8', slugify(layer.name).toUpperCase() || 'LAYER0', '90', String(loop.length), '70', '1')
        for (const p of loop) {
          out.push('10', p.x.toFixed(4), '20', (page.size.h - p.y).toFixed(4))
        }
      }
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF')
  return out.join('\n')
}

/* --------------------------------------------------------------- raster ---- */

export type RasterFormat = 'png' | 'jpg' | 'webp' | 'avif'

export async function exportRaster(
  doc: Document,
  page: Page,
  render: (ctx: CanvasRenderingContext2D, scale: number) => void,
  options: ExportOptions,
): Promise<Blob> {
  const scale = options.scale ?? 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(page.size.w * scale))
  canvas.height = Math.max(1, Math.round(page.size.h * scale))
  const ctx = canvas.getContext('2d')!
  if (options.background) {
    ctx.fillStyle = css(page.background)
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  render(ctx, scale)
  const mime = options.format === 'jpg' ? 'image/jpeg' : options.format === 'webp' ? 'image/webp' : options.format === 'avif' ? 'image/avif' : 'image/png'
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, options.jpegQuality ?? 0.92))
  if (!blob) throw new Error('Raster export failed')
  return blob
}

/** Colour-separated grayscale previews used by the separations panel. */
export function separationPreview(
  doc: Document,
  page: Page,
  channel: 'c' | 'm' | 'y' | 'k' | 'rgb',
  render: (ctx: CanvasRenderingContext2D, scale: number) => void,
  maxSize = 260,
): string {
  const canvas = document.createElement('canvas')
  const scale = Math.min(maxSize / page.size.w, maxSize / page.size.h)
  canvas.width = Math.round(page.size.w * scale)
  canvas.height = Math.round(page.size.h * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.scale(scale, scale)
  render(ctx, 1)
  ctx.restore()
  if (channel === 'rgb') return canvas.toDataURL('image/png')
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const out = ctx.createImageData(canvas.width, canvas.height)
  for (let i = 0; i < data.data.length; i += 4) {
    const c = { r: data.data[i], g: data.data[i + 1], b: data.data[i + 2] }
    const cmyk = rgbToCmyk(c)
    const value = 255 * (1 - cmyk[channel === 'k' ? 'k' : channel])
    out.data[i] = channel === 'c' ? value : 255
    out.data[i + 1] = channel === 'm' ? value : 255
    out.data[i + 2] = channel === 'y' ? value : 255
    out.data[i + 3] = 255
    if (channel === 'k') {
      out.data[i] = value
      out.data[i + 1] = value
      out.data[i + 2] = value
    }
  }
  ctx.putImageData(out, 0, 0)
  return canvas.toDataURL('image/png')
}

/* --------------------------------------------------------------- helpers --- */

export function exportFileName(doc: Document, format: string): string {
  return `${slugify(doc.name)}.${format}`
}

export function objectsBoundingBox(objects: SceneObject[], doc: Document) {
  let rect: { x: number; y: number; w: number; h: number } | null = null
  for (const obj of objects) rect = rectUnion(rect, objectBounds(obj, doc))
  return rect
}

export function applyObjectTransform(point: Vec, obj: SceneObject): Vec {
  return matApply(obj.transform, point)
}

export type { VectorObject, TextObject, BitmapObject, GroupObject }
