/**
 * Web / pixel-precise export workflow.
 *
 * Designers export for the web at exact pixel dimensions, usually in several
 * densities plus a copy-pasteable <picture>/srcset snippet, and often as slices
 * of one artwork. This module renders the page (or named regions) straight to
 * canvases at the requested pixel sizes, encodes them with the browser's own
 * codecs (PNG/JPEG/WebP/AVIF), and builds the HTML/CSS snippet.
 *
 * All sizing is integral: a "1200 × auto @2x" request produces exactly
 * 2400 physical pixels wide, never a rounded 2399.
 */
import type { Document, Page, Rect, SceneObject } from '../types'
import { renderPageInto } from '../engine/render'
import { slugify } from './util'

export type WebFormat = 'png' | 'jpg' | 'webp' | 'avif'

export interface WebExportOptions {
  format: WebFormat
  /** Densities to emit, e.g. [1, 2] for a 2x retina pair. */
  scales: number[]
  /** Target CSS width in pixels; 0 = the page's own size at 96 dpi. */
  width: number
  /** Optional explicit height; 0 = keep the page aspect ratio. */
  height: number
  quality: number
  background: boolean
  /** Emit @1x/@2x style file names instead of a single file. */
  densitySuffix: boolean
  /** Slice the artwork into a grid of tiles. */
  slices: { enabled: boolean; columns: number; rows: number }
  /** Export only the current selection (object bounds) instead of the page. */
  selectionOnly: boolean
}

export const DEFAULT_WEB_EXPORT: WebExportOptions = {
  format: 'webp',
  scales: [1, 2],
  width: 1200,
  height: 0,
  quality: 0.85,
  background: false,
  densitySuffix: true,
  slices: { enabled: false, columns: 2, rows: 2 },
  selectionOnly: false,
}

export interface WebExportFile {
  name: string
  mime: string
  width: number
  height: number
  scale: number
  bytes: Blob
  /** Data URL for previewing inside the dialog. */
  preview: string
}

export interface WebExportResult {
  files: WebExportFile[]
  /** Copy-paste snippet (<img> or <picture>) for the first non-slice file. */
  snippet: string
  /** CSS custom-property block matching the emitted densities. */
  css: string
  width: number
  height: number
}

export interface RenderRequest {
  doc: Document
  page: Page
  /** Region in document units. */
  rect: Rect
  /** Output size in physical pixels. */
  pixelWidth: number
  pixelHeight: number
  background: boolean
  format: WebFormat
  quality: number
}

export type PageRenderer = (ctx: CanvasRenderingContext2D, request: RenderRequest) => void

/** The app renderer: draws `rect` of the page filling the whole canvas. */
export function defaultWebRenderer(ctx: CanvasRenderingContext2D, request: RenderRequest): void {
  const { doc, page, rect, pixelWidth, pixelHeight, background } = request
  ctx.save()
  if (background) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pixelWidth, pixelHeight)
  }
  const scaleX = pixelWidth / rect.w
  const scaleY = pixelHeight / rect.h
  const scale = Math.min(scaleX, scaleY)
  ctx.setTransform(scaleX, 0, 0, scaleY, -rect.x * scaleX, -rect.y * scaleY)
  renderPageInto(ctx, {
    doc,
    page,
    scale,
    offsetX: -rect.x * scale,
    offsetY: -rect.y * scale,
    viewport: { x: 0, y: 0, w: pixelWidth, h: pixelHeight },
    quality: 'high',
    wireframe: false,
    effects: true,
  })
  ctx.restore()
}

function mimeFor(format: WebFormat): string {
  switch (format) {
    case 'jpg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'avif': return 'image/avif'
    case 'png': return 'image/png'
  }
}

/** Objects' bounding box, used by the "selection only" workflow. */
export function selectionRect(objects: SceneObject[], page: Page, pad = 0): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const visit = (list: SceneObject[]) => {
    for (const object of list) {
      if (object.kind === 'group') { visit(object.children); continue }
      const matrix = object.transform
      const points: { x: number; y: number }[] = []
      if (object.kind === 'vector') {
        const bounds = object.path.subpaths.flatMap((sub) => sub.nodes.map((n) => ({ x: n.x, y: n.y })))
        for (const point of bounds) {
          points.push({ x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f })
        }
      } else if (object.kind === 'bitmap') {
        points.push(
          { x: matrix.e, y: matrix.f },
          { x: object.rect.w * matrix.a + matrix.e, y: object.rect.w * matrix.b + matrix.f },
          { x: object.rect.w * matrix.a + object.rect.h * matrix.c + matrix.e, y: object.rect.w * matrix.b + object.rect.h * matrix.d + matrix.f },
          { x: object.rect.h * matrix.c + matrix.e, y: object.rect.h * matrix.d + matrix.f },
        )
      } else {
        points.push({ x: object.transform.e, y: object.transform.f })
      }
      for (const point of points) {
        minX = Math.min(minX, point.x)
        minY = Math.min(minY, point.y)
        maxX = Math.max(maxX, point.x)
        maxY = Math.max(maxY, point.y)
      }
    }
  }
  visit(objects)
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: page.size.w, h: page.size.h }
  return { x: minX - pad, y: minY - pad, w: Math.max(1, maxX - minX + pad * 2), h: Math.max(1, maxY - minY + pad * 2) }
}

/**
 * Build every requested file. Rendering is synchronous per file; encoding uses
 * canvas.toBlob so the browser picks the best encoder it has.
 */
export async function exportWeb(
  doc: Document,
  page: Page,
  options: WebExportOptions,
  render: PageRenderer,
  selected: SceneObject[] = [],
): Promise<WebExportResult> {
  const base = options.selectionOnly && selected.length ? selectionRect(selected, page, 2) : { x: 0, y: 0, w: page.size.w, h: page.size.h }
  const aspect = base.h / base.w
  const cssWidth = options.width > 0 ? Math.round(options.width) : Math.max(1, Math.round(base.w))
  const cssHeight = options.height > 0 ? Math.round(options.height) : Math.max(1, Math.round(cssWidth * aspect))
  const slug = slugify(doc.name)
  const mime = mimeFor(options.format)
  const files: WebExportFile[] = []

  const regions: { suffix: string; rect: Rect; cssW: number; cssH: number }[] = []
  if (options.slices.enabled && options.slices.columns > 1 || (options.slices.enabled && options.slices.rows > 1)) {
    const cols = Math.max(1, Math.round(options.slices.columns))
    const rows = Math.max(1, Math.round(options.slices.rows))
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        regions.push({
          suffix: `-slice-${r + 1}x${c + 1}`,
          rect: { x: base.x + (base.w * c) / cols, y: base.y + (base.h * r) / rows, w: base.w / cols, h: base.h / rows },
          cssW: Math.round(cssWidth / cols),
          cssH: Math.round(cssHeight / rows),
        })
      }
    }
  } else {
    regions.push({ suffix: '', rect: base, cssW: cssWidth, cssH: cssHeight })
  }

  for (const region of regions) {
    for (const scale of options.scales) {
      const pixelWidth = Math.max(1, Math.round(region.cssW * scale))
      const pixelHeight = Math.max(1, Math.round(region.cssH * scale))
      const canvas = document.createElement('canvas')
      canvas.width = pixelWidth
      canvas.height = pixelHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Web export needs a 2D canvas context')
      render(ctx, {
        doc,
        page,
        rect: region.rect,
        pixelWidth,
        pixelHeight,
        background: options.background || options.format === 'jpg',
        format: options.format,
        quality: options.quality,
      })
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, options.quality))
      if (!blob) throw new Error(`Encoding ${mime} failed in this browser`)
      const density = options.densitySuffix && options.scales.length > 1 ? `@${scale}x` : ''
      files.push({
        name: `${slug}${region.suffix}${density}.${options.format}`,
        mime,
        width: pixelWidth,
        height: pixelHeight,
        scale,
        bytes: blob,
        preview: canvas.toDataURL('image/png'),
      })
    }
  }

  const primary = files.find((file) => file.scale === Math.min(...options.scales)) ?? files[0]
  const densityList = options.scales.map((scale) => {
    const file = files.find((f) => f.scale === scale && !f.name.includes('-slice-'))
    return file ? `${file.name} ${scale}x` : null
  }).filter(Boolean) as string[]
  const snippet = densityList.length > 1
    ? `<img src="${primary.name}" srcset="${densityList.join(', ')}" width="${primary.width / primary.scale}" height="${Math.round(primary.height / primary.scale)}" alt="${doc.name}" decoding="async" loading="lazy">`
    : `<img src="${primary.name}" width="${Math.round(primary.width / primary.scale)}" height="${Math.round(primary.height / primary.scale)}" alt="${doc.name}" decoding="async">`
  const css = [
    `/* ${doc.name} — exported assets */`,
    `:root {`,
    `  --export-width: ${cssWidth}px;`,
    `  --export-height: ${cssHeight}px;`,
    options.format === 'jpg' ? '  /* JPEG has no alpha — the page background is flattened. */' : '',
    `}`,
  ].filter(Boolean).join('\n')

  return { files, snippet, css, width: cssWidth, height: cssHeight }
}

/** Human-readable byte size for the dialog. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
