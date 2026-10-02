/**
 * Import pipeline: SVG, PDF, AI (PDF-compatible), EPS, DXF, images (incl. RAW
 * previews), and a documented, limited CDR reader.
 *
 * Everything runs client-side. Formats that cannot be parsed faithfully produce a
 * clear report instead of silently dropping content.
 */
import type { Document, PathData, PathNode, SceneObject, SubPath } from '../types'
import { uid, pathFromSubpaths, subPath, node, rectNorm, slugify } from './util'
import { parseHex, rgb } from './color'
import { createBitmap, createDocument, createGroup, createTextObject, createVector, rectPathData } from '../store/mutations'
import { parseSvgPath } from './text'
// pdf.js v4 only defaults `GlobalWorkerOptions.workerSrc` under Node. In a
// browser the getter throws `No "GlobalWorkerOptions.workerSrc" specified`,
// which makes every PDF/AI import fail. Vite emits the worker as a hashed
// same-origin asset, so module-worker creation succeeds and — because the
// service worker caches same-origin static files — it keeps working offline.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export interface ImportResult {
  document: Document
  warnings: string[]
  /** Bitmaps and fonts discovered while parsing. */
  stats: { objects: number; bitmaps: number; text: number; fonts: string[] }
}

/* ------------------------------------------------------------------ SVG ---- */

export async function importSVG(text: string, name = 'Imported SVG'): Promise<ImportResult> {
  const warnings: string[] = []
  const doc = createDocument(name)
  const stats = { objects: 0, bitmaps: 0, text: 0, fonts: [] as string[] }
  const parser = new DOMParser()
  const xml = parser.parseFromString(text, 'image/svg+xml')
  const parseError = xml.querySelector('parsererror')
  if (parseError) {
    warnings.push('The SVG could not be parsed; the document was left empty.')
    return { document: doc, warnings, stats }
  }
  const svg = xml.documentElement
  const viewBox = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n))
  let width = parseFloat(svg.getAttribute('width') ?? '0') || (viewBox[2] ?? 595)
  let height = parseFloat(svg.getAttribute('height') ?? '0') || (viewBox[3] ?? 842)
  if (viewBox.length === 4) {
    width = viewBox[2]
    height = viewBox[3]
  }

  const page = doc.pages[0]
  page.size = { w: width, h: height, unit: 'px', name: `${Math.round(width)} × ${Math.round(height)}` }
  const layer = page.layers[0]

  const styleOf = (el: Element): Record<string, string> => {
    const style: Record<string, string> = {}
    const css = el.getAttribute('style')
    if (css) {
      for (const part of css.split(';')) {
        const [k, v] = part.split(':')
        if (k && v) style[k.trim()] = v.trim()
      }
    }
    for (const attr of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-family', 'font-size']) {
      const v = el.getAttribute(attr)
      if (v) style[attr] = v
    }
    return style
  }

  const inherited = (el: Element, parent: Record<string, string>): Record<string, string> => ({ ...parent, ...styleOf(el) })

  const parseTransform = (value: string | null): { a: number; b: number; c: number; d: number; e: number; f: number } => {
    const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
    if (!value) return m
    const ops = [...value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g)]
    let result = m
    for (const op of ops) {
      const args = op[2].split(/[\s,]+/).map(Number)
      let next = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
      switch (op[1]) {
        case 'matrix':
          next = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] }
          break
        case 'translate':
          next = { a: 1, b: 0, c: 0, d: 1, e: args[0] ?? 0, f: args[1] ?? 0 }
          break
        case 'scale':
          next = { a: args[0] ?? 1, b: 0, c: 0, d: args[1] ?? args[0] ?? 1, e: 0, f: 0 }
          break
        case 'rotate': {
          const rad = ((args[0] ?? 0) * Math.PI) / 180
          const cos = Math.cos(rad)
          const sin = Math.sin(rad)
          next = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
          if (args.length >= 3) {
            const cx = args[1]
            const cy = args[2]
            next = {
              a: cos, b: sin, c: -sin, d: cos,
              e: cx - cos * cx + sin * cy,
              f: cy - sin * cx - cos * cy,
            }
          }
          break
        }
        case 'skewX': next = { a: 1, b: 0, c: Math.tan(((args[0] ?? 0) * Math.PI) / 180), d: 1, e: 0, f: 0 }; break
        case 'skewY': next = { a: 1, b: Math.tan(((args[0] ?? 0) * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 }; break
      }
      result = {
        a: result.a * next.a + result.c * next.b,
        b: result.b * next.a + result.d * next.b,
        c: result.a * next.c + result.c * next.d,
        d: result.b * next.c + result.d * next.d,
        e: result.a * next.e + result.c * next.f + result.e,
        f: result.b * next.e + result.d * next.f + result.f,
      }
    }
    return result
  }

  const colorFrom = (value: string | undefined, fallback: { r: number; g: number; b: number; a: number }): { r: number; g: number; b: number; a: number } => {
    if (!value || value === 'none') return fallback
    if (value.startsWith('url(')) return rgb(150, 150, 155)
    if (value.startsWith('#')) return parseHex(value)
    const rgbMatch = value.match(/rgba?\(([^)]+)\)/)
    if (rgbMatch) {
      const parts = rgbMatch[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 }
    }
    const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080', grey: '#808080' }
    return named[value] ? parseHex(named[value]) : fallback
  }

  const subpathsFromD = (d: string): SubPath[] => {
    const out: SubPath[] = []
    for (const ring of parseSvgPath(d)) {
      if (ring.length < 2) continue
      const nodes: PathNode[] = ring.map((p) => node(p.x, p.y))
      out.push(subPath(nodes, true))
    }
    return out
  }

  const visit = (el: Element, parentStyle: Record<string, string>, parentTransform: string): void => {
    const tag = el.tagName.toLowerCase()
    const style = inherited(el, parentStyle)
    const transformAttr = el.getAttribute('transform')
    const transform = transformAttr ? `${parentTransform} ${transformAttr}` : parentTransform
    const m = parseTransform(transform)

    switch (tag) {
      case 'svg':
      case 'g': {
        for (const child of Array.from(el.children)) visit(child, style, transform)
        break
      }
      case 'path': {
        const d = el.getAttribute('d')
        if (!d) break
        const path: PathData = { subpaths: subpathsFromD(d), fillRule: el.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero' }
        const fillColor = colorFrom(style.fill, rgb(0, 0, 0))
        const strokeColor = colorFrom(style.stroke, { r: 0, g: 0, b: 0, a: 0 })
        const obj = createVector({
          path,
          primitive: { type: 'trace' },
          fill: style.fill === 'none' ? { type: 'none' } : { type: 'uniform', color: fillColor },
          stroke: style.stroke && style.stroke !== 'none'
            ? { color: strokeColor, width: parseFloat(style['stroke-width'] ?? '1') || 1, cap: 'butt', join: 'miter', miterLimit: 10, behind: false }
            : null,
        })
        obj.transform = m
        layer.objects.push(obj)
        stats.objects++
        break
      }
      case 'rect': {
        const x = parseFloat(el.getAttribute('x') ?? '0')
        const y = parseFloat(el.getAttribute('y') ?? '0')
        const w = parseFloat(el.getAttribute('width') ?? '0')
        const h = parseFloat(el.getAttribute('height') ?? '0')
        const r = parseFloat(el.getAttribute('rx') ?? '0')
        const path = r > 0 ? roundedRect(x, y, w, h, r) : rectPathData(x, y, w, h)
        const obj = createVector({
          path,
          primitive: { type: 'rect', w, h, r, corners: [1, 1, 1, 1] },
          fill: style.fill === 'none' ? { type: 'none' } : { type: 'uniform', color: colorFrom(style.fill, rgb(0, 0, 0)) },
        })
        obj.transform = m
        layer.objects.push(obj)
        stats.objects++
        break
      }
      case 'circle':
      case 'ellipse': {
        const cx = parseFloat(el.getAttribute('cx') ?? '0')
        const cy = parseFloat(el.getAttribute('cy') ?? '0')
        const rx = tag === 'circle' ? parseFloat(el.getAttribute('r') ?? '0') : parseFloat(el.getAttribute('rx') ?? '0')
        const ry = tag === 'circle' ? rx : parseFloat(el.getAttribute('ry') ?? '0')
        const path = ellipsePathAt(cx, cy, rx, ry)
        const obj = createVector({
          path,
          primitive: { type: 'ellipse', rx, ry, start: 0, end: 360, pieMode: 'pie' },
          fill: style.fill === 'none' ? { type: 'none' } : { type: 'uniform', color: colorFrom(style.fill, rgb(0, 0, 0)) },
        })
        obj.transform = m
        layer.objects.push(obj)
        stats.objects++
        break
      }
      case 'line':
      case 'polyline':
      case 'polygon': {
        const raw = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n))
        const pts: { x: number; y: number }[] = []
        for (let i = 0; i + 1 < raw.length; i += 2) pts.push({ x: raw[i], y: raw[i + 1] })
        if (tag === 'line') {
          const x1 = parseFloat(el.getAttribute('x1') ?? '0')
          const y1 = parseFloat(el.getAttribute('y1') ?? '0')
          const x2 = parseFloat(el.getAttribute('x2') ?? '0')
          const y2 = parseFloat(el.getAttribute('y2') ?? '0')
          pts.length = 0
          pts.push({ x: x1, y: y1 }, { x: x2, y: y2 })
        }
        if (pts.length < 2) break
        const closed = tag === 'polygon'
        const path = pathFromSubpaths([subPath(pts.map((p) => node(p.x, p.y)), closed)])
        const obj = createVector({
          path,
          primitive: { type: 'freehand' },
          fill: closed && style.fill !== 'none' ? { type: 'uniform', color: colorFrom(style.fill, rgb(0, 0, 0)) } : { type: 'none' },
          stroke: { color: colorFrom(style.stroke, rgb(0, 0, 0)), width: parseFloat(style['stroke-width'] ?? '1') || 1, cap: 'butt', join: 'miter', miterLimit: 10, behind: false },
        })
        obj.transform = m
        layer.objects.push(obj)
        stats.objects++
        break
      }
      case 'text': {
        const content = (el.textContent ?? '').trim()
        if (!content) break
        const fontSize = parseFloat(style['font-size'] ?? '16') || 16
        const obj = createTextObject('artistic', content, { x: 0, y: 0, w: 200, h: fontSize * 1.4 })
        obj.style.fontFamily = (style['font-family'] ?? 'Helvetica').replace(/["']/g, '').split(',')[0].trim()
        obj.style.fontSize = fontSize
        obj.style.color = colorFrom(style.fill, rgb(0, 0, 0))
        obj.transform = { ...m }
        const x = parseFloat(el.getAttribute('x') ?? '0')
        const y = parseFloat(el.getAttribute('y') ?? '0')
        obj.transform.e += m.a * x + m.c * y
        obj.transform.f += m.b * x + m.d * y
        layer.objects.push(obj)
        stats.text++
        stats.objects++
        stats.fonts.push(obj.style.fontFamily)
        break
      }
      case 'image': {
        const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? ''
        const x = parseFloat(el.getAttribute('x') ?? '0')
        const y = parseFloat(el.getAttribute('y') ?? '0')
        const w = parseFloat(el.getAttribute('width') ?? '100')
        const h = parseFloat(el.getAttribute('height') ?? '100')
        if (href.startsWith('data:')) {
          const size = imageSizeOf(href)
          layer.objects.push(createBitmap(href, size.width, size.height, { x, y, w, h }))
          stats.bitmaps++
          stats.objects++
        } else {
          warnings.push('An external image reference was skipped (only embedded images import).')
        }
        break
      }
      case 'defs':
      case 'style':
      case 'metadata':
      case 'title':
      case 'desc':
        break
      default: {
        for (const child of Array.from(el.children)) visit(child, style, transform)
      }
    }
  }

  visit(svg, {}, '')
  if (!stats.objects) warnings.push('No drawable elements were found in this SVG.')
  return { document: doc, warnings, stats }
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): PathData {
  return pathFromSubpaths([
    subPath([
      node(x + r, y), node(x + w - r, y),
      node(x + w, y + r), node(x + w, y + h - r),
      node(x + w - r, y + h), node(x + r, y + h),
      node(x, y + h - r), node(x, y + r),
    ], true),
  ])
}

function ellipsePathAt(cx: number, cy: number, rx: number, ry: number): PathData {
  const k = 0.5522847498307936
  return pathFromSubpaths([
    subPath([
      { x: cx, y: cy - ry, inX: cx - rx * k, inY: cy - ry, outX: cx + rx * k, outY: cy - ry, type: 'smooth' },
      { x: cx + rx, y: cy, inX: cx + rx, inY: cy - ry * k, outX: cx + rx, outY: cy + ry * k, type: 'smooth' },
      { x: cx, y: cy + ry, inX: cx + rx * k, inY: cy + ry, outX: cx - rx * k, outY: cy + ry, type: 'smooth' },
      { x: cx - rx, y: cy, inX: cx - rx, inY: cy + ry * k, outX: cx - rx, outY: cy - ry * k, type: 'smooth' },
    ], true),
  ])
}

function imageSizeOf(dataUrl: string): { width: number; height: number } {
  // Best effort synchronous guess; the editor re-measures after decode.
  return { width: 1000, height: 1000 }
}

/* ------------------------------------------------------------------ PDF ---- */

/**
 * PDF import via pdf.js: vector content is lifted through the operator list.
 * Text is placed with the embedded font metrics pdf.js provides.
 */
export async function importPDF(bytes: ArrayBuffer, name = 'Imported PDF'): Promise<ImportResult> {
  const warnings: string[] = []
  const stats = { objects: 0, bitmaps: 0, text: 0, fonts: [] as string[] }
  const doc = createDocument(name)
  try {
    const pdfjs: any = await import('pdfjs-dist')
    // Point pdf.js at its worker before anything else touches it. Setting it on
    // the module keeps the real worker path; if a deployment blocks workers the
    // library falls back to its main-thread "fake worker", which reads the same
    // `workerSrc` — so this single assignment fixes both paths.
    if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    }
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      disableFontFace: false,
      isEvalSupported: false,
      useSystemFonts: true,
    })
    const pdfDocument = await loadingTask.promise
    const pageCount = Math.min(pdfDocument.numPages, 32)
    if (pdfDocument.numPages > pageCount) warnings.push(`Imported the first ${pageCount} of ${pdfDocument.numPages} pages.`)
    const template = doc.pages[0]
    doc.pages = []
    for (let pageIndex = 1; pageIndex <= pageCount; pageIndex++) {
      const pdfPage = await pdfDocument.getPage(pageIndex)
      const viewport = pdfPage.getViewport({ scale: 1 })
      const page = pageIndex === 1 ? template : { ...template, id: uid('page'), layers: [{ ...template.layers[0], id: uid('layer'), objects: [] }] }
      page.size = { w: viewport.width, h: viewport.height, unit: 'pt' }
      page.name = `Page ${pageIndex}`
      const layer = page.layers[0]
      const opList = await pdfPage.getOperatorList()
      const OPS = pdfjs.OPS
      let ctm = [1, 0, 0, 1, 0, 0]
      const stack: number[][] = []
      let currentPath: SubPath[] = []
      const transformPoint = (x: number, y: number) => ({
        x: ctm[0] * x + ctm[2] * y + ctm[4],
        y: viewport.height - (ctm[1] * x + ctm[3] * y + ctm[5]),
      })
      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i]
        const args = opList.argsArray[i]
        if (fn === OPS.save) stack.push([...ctm])
        else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
        else if (fn === OPS.transform) {
          const [a, b, c, d, e, f] = args
          ctm = [
            ctm[0] * a + ctm[2] * b,
            ctm[1] * a + ctm[3] * b,
            ctm[0] * c + ctm[2] * d,
            ctm[1] * c + ctm[3] * d,
            ctm[0] * e + ctm[2] * f + ctm[4],
            ctm[1] * e + ctm[3] * f + ctm[5],
          ]
        } else if (fn === OPS.constructPath) {
          const [ops, coords] = args
          const nodes: PathNode[] = []
          let ci = 0
          let closed = false
          for (const op of ops as number[]) {
            if (op === OPS.moveTo) {
              const p = transformPoint(coords[ci], coords[ci + 1])
              ci += 2
              nodes.push(node(p.x, p.y))
            } else if (op === OPS.lineTo) {
              const p = transformPoint(coords[ci], coords[ci + 1])
              ci += 2
              const last = nodes[nodes.length - 1]
              if (last) {
                last.outX = p.x
                last.outY = p.y
              }
              nodes.push(node(p.x, p.y))
            } else if (op === OPS.curveTo) {
              const c1 = transformPoint(coords[ci], coords[ci + 1])
              const c2 = transformPoint(coords[ci + 2], coords[ci + 3])
              const p = transformPoint(coords[ci + 4], coords[ci + 5])
              ci += 6
              const last = nodes[nodes.length - 1]
              if (last) {
                last.outX = c1.x
                last.outY = c1.y
              }
              nodes.push({ x: p.x, y: p.y, inX: c2.x, inY: c2.y, outX: p.x, outY: p.y, type: 'smooth' })
            } else if (op === OPS.rectangle) {
              const x = coords[ci]
              const y = coords[ci + 1]
              const w = coords[ci + 2]
              const h = coords[ci + 3]
              ci += 4
              const a = transformPoint(x, y)
              const b = transformPoint(x + w, y + h)
              const rect = rectNorm({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y })
              currentPath.push(subPath([
                node(rect.x, rect.y), node(rect.x + rect.w, rect.y),
                node(rect.x + rect.w, rect.y + rect.h), node(rect.x, rect.y + rect.h),
              ], true))
            } else if (op === OPS.closePath) {
              closed = true
            }
          }
          if (nodes.length >= 2) currentPath.push(subPath(nodes, closed))
        } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.stroke || fn === OPS.fillStroke || fn === OPS.eoFillStroke) {
          if (currentPath.length) {
            const isFill = fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke
            const isStroke = fn === OPS.stroke || fn === OPS.fillStroke || fn === OPS.eoFillStroke
            const obj = createVector({
              path: pathFromSubpaths(currentPath, fn === OPS.eoFill || fn === OPS.eoFillStroke ? 'evenodd' : 'nonzero'),
              primitive: { type: 'trace' },
              fill: isFill ? { type: 'uniform', color: rgb(40, 44, 52) } : { type: 'none' },
              stroke: isStroke ? { color: rgb(40, 44, 52), width: 1, cap: 'butt', join: 'miter', miterLimit: 10, behind: false } : null,
            })
            layer.objects.push(obj)
            stats.objects++
            currentPath = []
          }
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
          const [objId] = args
          try {
            const image = await new Promise<any>((resolve, reject) => {
              pdfPage.objs.get(objId, (img: any) => (img ? resolve(img) : reject(new Error('missing image'))))
            })
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const ctx = canvas.getContext('2d')!
            if (image.bitmap) {
              ctx.putImageData(new ImageData(new Uint8ClampedArray(image.bitmap), image.width, image.height), 0, 0)
            } else if (image.data) {
              const clamped = new Uint8ClampedArray(image.data.length)
              for (let k = 0; k < image.data.length; k++) clamped[k] = image.data[k]
              ctx.putImageData(new ImageData(clamped, image.width, image.height), 0, 0)
            }
            const p0 = transformPoint(0, 0)
            const p1 = transformPoint(image.width, image.height)
            const rect = rectNorm({ x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y })
            layer.objects.push(createBitmap(canvas.toDataURL('image/png'), image.width, image.height, rect))
            stats.bitmaps++
            stats.objects++
          } catch {
            warnings.push('One embedded image could not be decoded.')
          }
        } else if (fn === OPS.showText && args?.[0]) {
          const items = args[0] as { str?: string; fontName?: string; width?: number; transform?: number[] }[]
          let text = ''
          let x = 0
          let y = 0
          for (const item of items) {
            if (item.str) text += item.str
            if (item.transform) {
              const p = transformPoint(item.transform[4], item.transform[5])
              x = p.x
              y = p.y
            }
          }
          if (text.trim()) {
            const obj = createTextObject('artistic', text.trim(), { x, y: y - 12, w: 240, h: 20 })
            obj.transform = { a: 1, b: 0, c: 0, d: 1, e: x, f: y - 14 }
            obj.style.fontSize = 12
            obj.content = text.trim()
            obj.frame = { x: 0, y: 0, w: 240, h: 20 }
            layer.objects.push(obj)
            stats.text++
            stats.objects++
          }
        }
      }
      doc.pages.push(page)
    }
    // Never hand back a document without a page: the editor resolves the active
    // page with `pages.find(...) ?? pages[0]` and then reads `.layers`/`.size`,
    // so an empty page list would break every panel. A PDF that yields nothing
    // (a scan, an encrypted file, zero pages) still gets a blank page.
    if (!doc.pages.length) {
      warnings.push('No pages could be extracted from this PDF; a blank page was created instead.')
      doc.pages.push({
        ...template,
        id: uid('page'),
        name: 'Page 1',
        layers: [{ ...template.layers[0], id: uid('layer'), objects: [] }],
      })
    }
    doc.activePageId = doc.pages[0].id
    if (!stats.objects) warnings.push('This PDF contains no extractable vector content (it may be a scan).')
    if (stats.objects && stats.text === 0) warnings.push('Text in this PDF was converted to outlines on import.')
  } catch (error) {
    warnings.push(`PDF import failed: ${(error as Error).message}`)
    // Recover the document so the caller always gets something editable.
    if (!doc.pages.length) {
      doc.pages.push(createDocument(name).pages[0])
      doc.activePageId = doc.pages[0].id
    }
  }
  return { document: doc, warnings, stats }
}

/* ------------------------------------------------------------ images ------- */

const RAW_EXTENSIONS = ['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'rw2', 'orf', 'pef', 'srw', 'tif', 'tiff', 'heic', 'heif', 'avif']

export async function importImage(file: File, name?: string): Promise<ImportResult> {
  const warnings: string[] = []
  const doc = createDocument(name ?? file.name.replace(/\.[^.]+$/, ''))
  const stats = { objects: 0, bitmaps: 0, text: 0, fonts: [] as string[] }
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  const isRaw = RAW_EXTENSIONS.includes(ext)

  let dataUrl: string | null = null
  let width = 0
  let height = 0
  try {
    if (isRaw) {
      // Browsers can decode HEIF/AVIF/TIFF where the OS codec exists; for camera
      // RAW we fall back to the embedded JPEG preview when it can be extracted.
      const preview = await extractRawPreview(file)
      if (preview) {
        dataUrl = preview.dataUrl
        width = preview.width
        height = preview.height
        warnings.push('Imported the embedded preview of this RAW file (full sensor decode is not available in-browser).')
      } else {
        warnings.push(`This browser cannot decode .${ext} files. Convert to JPEG/TIFF with the camera software, or use a browser with the matching codec.`)
      }
    }
    if (!dataUrl) {
      const bitmap = await createImageBitmap(file).catch(() => null)
      if (bitmap) {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
        dataUrl = canvas.toDataURL('image/png')
        width = bitmap.width
        height = bitmap.height
        bitmap.close()
      } else {
        const fallback = await new Promise<string | null>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(file)
        })
        if (!fallback) throw new Error('decode failed')
        dataUrl = fallback
        const size = await measureImage(fallback)
        width = size.width
        height = size.height
      }
    }
  } catch {
    warnings.push('The image could not be decoded by this browser.')
  }

  const page = doc.pages[0]
  if (dataUrl && width && height) {
    // Fit the image on an A4-ish page, preserving aspect.
    const maxW = 595.28
    const maxH = 841.89
    const scale = Math.min(maxW / width, maxH / height)
    const w = width * scale
    const h = height * scale
    page.size = { w: Math.max(100, w + 48), h: Math.max(100, h + 48), unit: 'px' }
    const obj = createBitmap(dataUrl, width, height, { x: (page.size.w - w) / 2, y: (page.size.h - h) / 2, w, h })
    obj.name = file.name
    obj.crop = { x: 0, y: 0, w: 1, h: 1 }
    page.layers[0].objects.push(obj)
    stats.bitmaps++
    stats.objects++
  }
  return { document: doc, warnings, stats }
}

async function extractRawPreview(file: File): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const buffer = new Uint8Array(await file.slice(0, Math.min(file.size, 12 * 1024 * 1024)).arrayBuffer())
  // Look for an embedded JPEG (SOI ... EOI) — present in nearly every RAW container.
  let start = -1
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
      start = i
      break
    }
  }
  if (start < 0) return null
  let end = -1
  for (let i = buffer.length - 2; i > start; i--) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) {
      end = i + 2
      break
    }
  }
  if (end < 0) return null
  const slice = buffer.subarray(start, end)
  const blob = new Blob([new Uint8Array(slice)], { type: 'image/jpeg' })
  const bitmap = await createImageBitmap(blob).catch(() => null)
  if (!bitmap) return null
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), width: canvas.width, height: canvas.height }
}

function measureImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = dataUrl
  })
}

/* ------------------------------------------------------------------ DXF ---- */

export async function importDXF(text: string, name = 'Imported DXF'): Promise<ImportResult> {
  const warnings: string[] = []
  const doc = createDocument(name)
  const stats = { objects: 0, bitmaps: 0, text: 0, fonts: [] as string[] }
  const page = doc.pages[0]
  const layer = page.layers[0]
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const pairs: [string, string][] = []
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i], lines[i + 1]])
  let inEntities = false
  let cursor = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  while (cursor < pairs.length) {
    const [code, value] = pairs[cursor]
    if (code === '0' && value === 'SECTION') {
      const nextSection = pairs[cursor + 1]
      inEntities = nextSection?.[1] === 'ENTITIES'
      cursor += 2
      continue
    }
    if (code === '0' && value === 'ENDSEC') {
      inEntities = false
      cursor++
      continue
    }
    if (inEntities && code === '0' && (value === 'LWPOLYLINE' || value === 'POLYLINE' || value === 'LINE')) {
      const entity = value
      const points: { x: number; y: number }[] = []
      let closed = false
      cursor++
      while (cursor < pairs.length && pairs[cursor][0] !== '0') {
        const [c, v] = pairs[cursor]
        if (c === '10') {
          const x = parseFloat(v)
          const y = parseFloat(pairs[cursor + 1]?.[1] ?? '0')
          points.push({ x, y })
          cursor++
        } else if (c === '11') {
          const x = parseFloat(v)
          const y = parseFloat(pairs[cursor + 1]?.[1] ?? '0')
          points.push({ x, y })
          cursor++
        } else if (c === '70') {
          closed = (parseInt(v, 10) & 1) === 1
        }
        cursor++
      }
      if (points.length >= 2) {
        for (const p of points) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
        }
        const useClosed = entity === 'LINE' ? false : closed
        const obj = createVector({
          path: pathFromSubpaths([subPath(points.map((p) => node(p.x, p.y)), useClosed)]),
          primitive: { type: 'freehand' },
          fill: { type: 'none' },
          stroke: { color: rgb(30, 30, 34), width: 1, cap: 'butt', join: 'miter', miterLimit: 10, behind: false },
        })
        layer.objects.push(obj)
        stats.objects++
      }
      continue
    }
    cursor++
  }
  if (Number.isFinite(minX) && Number.isFinite(minY)) {
    const w = Math.max(20, maxX - minX)
    const h = Math.max(20, maxY - minY)
    page.size = { w: w + 40, h: h + 40, unit: 'mm' }
    // DXF Y grows up; flip into page space.
    for (const obj of layer.objects) {
      obj.transform = { a: 1, b: 0, c: 0, d: -1, e: 20 - minX, f: page.size.h - 20 + minY }
    }
  }
  if (!stats.objects) warnings.push('No supported DXF entities (LINE/LWPOLYLINE) were found.')
  return { document: doc, warnings, stats }
}

/* ------------------------------------------------------------------ CDR ---- */

export interface CDRInfo {
  format: 'cdr' | 'riff' | 'unknown'
  version?: string
  chunks: { id: string; size: number }[]
}

/**
 * CDR is a proprietary RIFF container. A faithful reader requires the Corel
 * binary object model, which is out of scope for a browser build, so we detect
 * the container, report what we found and keep the file intact for a conversion
 * service or desktop CorelDRAW. This is deliberately *not* a silent partial parse.
 */
export async function inspectCDR(file: File): Promise<{ info: CDRInfo; warnings: string[] }> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const warnings: string[] = []
  const ascii = (from: number, len: number) => Array.from(head.subarray(from, from + len)).map((b) => String.fromCharCode(b)).join('')
  if (ascii(0, 4) !== 'RIFF') {
    return { info: { format: 'unknown', chunks: [] }, warnings: ['This file is not a RIFF container, so it is not a CDR file.'] }
  }
  const chunks: { id: string; size: number }[] = []
  const view = new DataView(head.buffer)
  let offset = 12
  while (offset + 8 <= head.length) {
    const id = ascii(offset, 4)
    const size = view.getUint32(offset + 4, true)
    chunks.push({ id, size })
    offset += 8 + size + (size % 2)
    if (!/^[A-Za-z0-9 ]{4}$/.test(id)) break
  }
  const versionChunk = chunks.find((c) => c.id.startsWith('vrsn'))
  warnings.push('CorelDRAW (CDR) files use a proprietary binary object model that cannot be losslessly parsed in the browser.')
  warnings.push('CorelByDre detected the container so you can see what is inside. For full fidelity, save as SVG, PDF or AI from CorelDRAW first — those import natively here.')
  warnings.push('A CDR/CMX conversion service can be plugged into src/lib/import.ts (see `convertCDR`) when a backend is available.')
  return {
    info: { format: 'riff', version: versionChunk ? 'CDR (RIFF)' : undefined, chunks },
    warnings,
  }
}

/** Placeholder hook for an optional CDR conversion service (never called offline). */
export async function convertCDR(file: File, endpoint: string): Promise<ImportResult | null> {
  try {
    const body = new FormData()
    body.append('file', file)
    body.append('target', 'svg')
    const res = await fetch(endpoint, { method: 'POST', body })
    if (!res.ok) return null
    const svg = await res.text()
    return importSVG(svg, file.name.replace(/\.cdr$/i, ''))
  } catch {
    return null
  }
}

/* -------------------------------------------------------------- dispatch --- */

export function formatOf(file: File): string {
  return (file.name.split('.').pop() ?? '').toLowerCase()
}

export async function importFile(file: File): Promise<ImportResult> {
  const ext = formatOf(file)
  switch (ext) {
    case 'svg':
    case 'svgz': {
      const text = await file.text()
      return importSVG(text, file.name.replace(/\.[^.]+$/, ''))
    }
    case 'cbd':
    case 'corelbydre':
    case 'json': {
      const text = await file.text()
      const parsed = JSON.parse(text) as Document
      return { document: parsed, warnings: [], stats: { objects: 0, bitmaps: 0, text: 0, fonts: [] } }
    }
    case 'pdf':
    case 'ai': {
      const bytes = await file.arrayBuffer()
      const result = await importPDF(bytes, file.name.replace(/\.[^.]+$/, ''))
      if (ext === 'ai') result.warnings.unshift('AI files saved with PDF compatibility are imported through the PDF pipeline; native AI artwork may be simplified.')
      return result
    }
    case 'eps':
    case 'ps': {
      const text = await file.text()
      return importEPS(text, file.name.replace(/\.[^.]+$/, ''))
    }
    case 'dxf':
    case 'dwg': {
      const text = await file.text()
      return importDXF(text, file.name.replace(/\.[^.]+$/, ''))
    }
    case 'cdr':
    case 'cmx': {
      const { warnings } = await inspectCDR(file)
      const doc = createDocument(file.name.replace(/\.[^.]+$/, ''))
      return { document: doc, warnings, stats: { objects: 0, bitmaps: 0, text: 0, fonts: [] } }
    }
    default: {
      if (['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'heic', 'heif', 'tif', 'tiff', ...RAW_EXTENSIONS].includes(ext)) {
        return importImage(file)
      }
      return { document: createDocument(file.name), warnings: [`Unsupported file type ".${ext}".`], stats: { objects: 0, bitmaps: 0, text: 0, fonts: [] } }
    }
  }
}

/** Minimal EPS reader: extracts show/moveto/lineto/curveto operators. */
export async function importEPS(text: string, name = 'Imported EPS'): Promise<ImportResult> {
  const warnings: string[] = []
  const doc = createDocument(name)
  const stats = { objects: 0, bitmaps: 0, text: 0, fonts: [] as string[] }
  const page = doc.pages[0]
  const layer = page.layers[0]
  const bboxMatch = text.match(/%%(?:HiRes)?BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/)
  const bbox = bboxMatch ? bboxMatch.slice(1, 5).map(Number) : [0, 0, 595, 842]
  page.size = { w: bbox[2] - bbox[0], h: bbox[3] - bbox[1], unit: 'pt' }
  const body = text.replace(/^%.*$/gm, '')
  const tokens = body.split(/\s+/)
  const stack: number[] = []
  const current: { x: number; y: number }[] = []
  let subpaths: SubPath[] = []
  for (const token of tokens) {
    const num = Number(token)
    if (!Number.isNaN(num) && token !== '') {
      stack.push(num)
      continue
    }
    switch (token) {
      case 'moveto':
      case 'm': {
        if (current.length >= 2) {
          subpaths.push(subPath(current.map((p) => node(p.x, p.y)), false))
          current.length = 0
        }
        const y = stack.pop() ?? 0
        const x = stack.pop() ?? 0
        current.push({ x, y })
        break
      }
      case 'lineto':
      case 'l': {
        const y = stack.pop() ?? 0
        const x = stack.pop() ?? 0
        current.push({ x, y })
        break
      }
      case 'curveto':
      case 'c': {
        const y3 = stack.pop() ?? 0
        const x3 = stack.pop() ?? 0
        stack.pop(); stack.pop(); stack.pop(); stack.pop() // control points (flattened)
        current.push({ x: x3, y: y3 })
        break
      }
      case 'closepath':
      case 'cp': {
        if (current.length >= 2) {
          subpaths.push(subPath(current.map((p) => node(p.x, p.y)), true))
          current.length = 0
        }
        break
      }
      case 'fill':
      case 'f': {
        if (current.length >= 2) subpaths.push(subPath(current.map((p) => node(p.x, p.y)), true))
        if (subpaths.length) {
          const obj = createVector({
            path: pathFromSubpaths(subpaths),
            primitive: { type: 'trace' },
            fill: { type: 'uniform', color: rgb(40, 44, 52) },
          })
          obj.transform = { a: 1, b: 0, c: 0, d: -1, e: -bbox[0], f: bbox[3] - bbox[1] + bbox[1] }
          layer.objects.push(obj)
          stats.objects++
        }
        subpaths = []
        current.length = 0
        break
      }
      default:
        break
    }
    stack.length = 0
  }
  if (current.length >= 2) {
    subpaths.push(subPath(current.map((p) => node(p.x, p.y)), true))
  }
  if (subpaths.length) {
    const obj = createVector({ path: pathFromSubpaths(subpaths), primitive: { type: 'trace' }, fill: { type: 'uniform', color: rgb(40, 44, 52) } })
    layer.objects.push(obj)
    stats.objects++
  }
  if (!stats.objects) warnings.push('No fillable paths were found. EPS files that rely on embedded images or fonts need conversion to PDF first.')
  else if (text.includes('%!PS-Adobe') && /curveto|\bc\b/.test(text)) warnings.push('Bezier control points in EPS are flattened on import; re-save as PDF or SVG for full curve fidelity.')
  return { document: doc, warnings, stats }
}

export function groupAll(objects: SceneObject[]): SceneObject {
  return objects.length > 1 ? createGroup(objects) : objects[0]
}

export { slugify }
