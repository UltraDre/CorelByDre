/**
 * Strict-canvas harness.
 *
 * jsdom accepts anything; a real browser canvas throws. This stub reproduces the
 * spec'd failure modes (negative radii, zero-sized ImageData, non-finite gradient
 * geometry, invalid colour stops, zero-sized drawImage sources) so engine and UI
 * bugs that only appear in a browser surface here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from '../src/App'
import { useStore } from '../src/store/store'
import { TOOLS, type ToolID } from '../src/tools/registry'
import { createDocument, createVector, createTextObject, createBitmap, rectPathData, createGroup } from '../src/store/mutations'
import type { AdjustmentType } from '../src/types'
import { renderPageInto } from '../src/engine/render'
import { EFFECT_DEFS, makeEffect, makeAdjustment, runStack } from '../src/engine/effects'
import { BRUSH_PRESETS } from '../src/engine/brush'
import * as shapes from '../src/engine/shapes'
import { createPhotoDocument, PHOTO_PRESETS, renderedPhoto } from '../src/lib/photo'

/* --------------------------------------------------------------- errors ---- */

export const thrown: string[] = []
const finite = (...n: number[]) => n.every((v) => Number.isFinite(v))

class StrictError extends Error {}

function chk(where: string, cond: boolean, msg: string) {
  if (!cond) {
    const line = `${where}: ${msg}`
    if (!thrown.includes(line)) thrown.push(line)
    throw new StrictError(line)
  }
}

const NUM = String.raw`-?[\d.]+(?:e-?\d+)?`
const CSS_COLOR = new RegExp(
  '^(transparent|currentColor|none|inherit' +
  '|#[0-9a-f]{3,8}' +
  `|rgba?\\(\\s*${NUM}[%]?(\\s*[,/]\\s*|\\s+)${NUM}[%]?(\\s*[,/]\\s*|\\s+)${NUM}[%]?\\s*(?:[,/]\\s*${NUM}[%]?)?\\s*\\)` +
  `|hsla?\\(\\s*${NUM}(?:deg|rad|turn)?\\s*(?:[,/]\\s*|\\s+)${NUM}[%]\\s*(?:[,/]\\s*|\\s+)${NUM}[%]\\s*(?:[,/]\\s*${NUM}[%]?)?\\s*\\)` +
  ')$', 'i',
)

function checkColor(where: string, v: unknown) {
  if (typeof v !== 'string') return // gradient/pattern objects are fine
  chk(where, !/NaN|undefined|Infinity|null/.test(v), `non-finite colour "${v}"`)
  chk(where, CSS_COLOR.test(v.trim()), `invalid CSS colour "${v}"`)
}

function stub(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const grad = (where: string) => ({
    addColorStop: (offset: number, color: string) => {
      chk(`${where}.addColorStop`, finite(offset), `offset ${offset} is not finite`)
      chk(`${where}.addColorStop`, offset >= 0 && offset <= 1, `offset ${offset} out of [0,1]`)
      checkColor(`${where}.addColorStop`, color)
    },
  })
  const state: Record<string, unknown> = {
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    miterLimit: 10, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low', filter: 'none',
    direction: 'ltr', letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto', lineDashOffset: 0,
  }
  const noop = () => undefined
  const ctx: Record<string, unknown> = {
    canvas,
    ...state,
    setTransform: noop, resetTransform: noop, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    save: noop, restore: noop, scale: noop, translate: noop, rotate: noop, transform: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop,
    rect: noop, fill: noop, stroke: noop, clip: noop,
    fillText: (_t: string, x: number, y: number) => { chk('fillText', finite(x, y), `non-finite position ${x},${y}`) },
    strokeText: noop, setLineDash: noop, getLineDash: () => [],
    isPointInPath: () => false, isPointInStroke: () => false,
    arc: (_x: number, _y: number, r: number) => { chk('ctx.arc', !(r < 0), `negative radius ${r}`) },
    arcTo: (_x1: number, _y1: number, _x2: number, _y2: number, r: number) => { chk('ctx.arcTo', !(r < 0), `negative radius ${r}`) },
    ellipse: (_x: number, _y: number, rx: number, ry: number) => {
      chk('ctx.ellipse', !(rx < 0 || ry < 0), `negative radius ${rx},${ry}`)
      chk('ctx.ellipse', finite(rx, ry), `non-finite radius ${rx},${ry}`)
    },
    roundRect: (_x: number, _y: number, _w: number, _h: number, radii?: unknown) => {
      if (typeof radii === 'number') chk('ctx.roundRect', !(radii < 0), `negative radius ${radii}`)
    },
    drawImage: (img: unknown, ...rest: number[]) => {
      const src = img as { width?: number; height?: number; naturalWidth?: number } | null
      if (src && typeof src === 'object') {
        const w = src.naturalWidth ?? src.width ?? 0
        const h = src.naturalHeight ?? src.height ?? 0
        if (w === 0 || h === 0) chk('ctx.drawImage', false, `zero-sized source (${w}x${h})`)
      }
      if (rest.length === 8) {
        const [sx, sy, sw, sh] = rest
        chk('ctx.drawImage', sw !== 0 && sh !== 0, `zero-sized source rect ${sw}x${sh}`)
        chk('ctx.drawImage', finite(sx, sy, sw, sh), `non-finite source rect`)
      }
      if (rest.length === 4 || rest.length === 8) {
        const d = rest.slice(-4)
        chk('ctx.drawImage', finite(...d), `non-finite destination rect`)
      }
    },
    putImageData: noop,
    measureText: (text: string) => ({
      width: Math.max(1, text.length * 7), actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0, actualBoundingBoxRight: Math.max(1, text.length * 7),
      fontBoundingBoxAscent: 9, fontBoundingBoxDescent: 3,
    }),
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => {
      chk('createLinearGradient', finite(x0, y0, x1, y1), `non-finite coords ${x0},${y0},${x1},${y1}`)
      return grad('createLinearGradient')
    },
    createRadialGradient: (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) => {
      chk('createRadialGradient', finite(x0, y0, r0, x1, y1, r1), 'non-finite args')
      chk('createRadialGradient', !(r0 < 0 || r1 < 0), `negative radius ${r0},${r1}`)
      return grad('createRadialGradient')
    },
    createConicGradient: (a: number, x: number, y: number) => {
      chk('createConicGradient', finite(a, x, y), 'non-finite args')
      return grad('createConicGradient')
    },
    createPattern: () => ({ setTransform: noop }),
    createImageData: (w: number, h: number) => {
      chk('createImageData', w > 0 && h > 0, `zero/negative size ${w}x${h}`)
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, colorSpace: 'srgb' }
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      chk('getImageData', w > 0 && h > 0, `zero/negative size ${w}x${h}`)
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, colorSpace: 'srgb' }
    },
  }
  // Validate colour/number assignments the way the browser does.
  for (const key of Object.keys(state)) {
    let value = state[key]
    Object.defineProperty(ctx, key, {
      get: () => value,
      set: (v: unknown) => {
        if ((key === 'fillStyle' || key === 'strokeStyle' || key === 'shadowColor')) checkColor(`ctx.${key}`, v)
        if (key === 'lineWidth' || key === 'shadowBlur' || key === 'miterLimit' || key === 'globalAlpha') {
          chk(`ctx.${key}`, typeof v !== 'number' || finite(v), `non-finite ${String(v)}`)
          if (key === 'lineWidth') chk('ctx.lineWidth', typeof v !== 'number' || v > 0, `non-positive width ${String(v)}`)
          if (key === 'globalAlpha') chk('ctx.globalAlpha', typeof v !== 'number' || (v >= 0 && v <= 1), `alpha out of range ${String(v)}`)
        }
        value = v
      },
      configurable: true,
    })
  }
  return ctx as unknown as CanvasRenderingContext2D
}

/* ----------------------------------------------------------- ImageData ---- */

const RealImageData = globalThis.ImageData

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) {
    return stub(this)
  }) as unknown as HTMLCanvasElement['getContext']
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,AAAA')
  HTMLCanvasElement.prototype.toBlob = vi.fn(function (this: HTMLCanvasElement, cb: (b: Blob | null) => void) {
    cb(new Blob(['x'], { type: 'image/png' }))
  }) as unknown as HTMLCanvasElement['toBlob']

  class StrictImageData {
    data: Uint8ClampedArray; width: number; height: number; colorSpace = 'srgb'
    constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
      if (typeof a === 'number') {
        chk('new ImageData', a > 0 && b > 0, `zero/negative size ${a}x${b}`)
        this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4)
      } else {
        const w = b, h = c ?? (a.length / 4 / w)
        chk('new ImageData', w > 0 && h > 0, `zero/negative size ${w}x${h}`)
        chk('new ImageData', a.length === w * h * 4, `data length ${a.length} != ${w}*${h}*4 = ${w * h * 4}`)
        this.width = w; this.height = h; this.data = a
      }
    }
  }
  ;(globalThis as unknown as { ImageData: unknown }).ImageData = StrictImageData

  // jsdom has no Path2D; browsers do. Track construction + method args only.
  class FakePath2D {
    constructor(_d?: string) { /* path data is validated by the strict ctx calls */ }
    moveTo(x: number, y: number) { chk('Path2D.moveTo', finite(x, y), `non-finite ${x},${y}`) }
    lineTo(x: number, y: number) { chk('Path2D.lineTo', finite(x, y), `non-finite ${x},${y}`) }
    bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number) { chk('Path2D.bezierCurveTo', finite(a, b, c, d, e, f), 'non-finite control points') }
    quadraticCurveTo(a: number, b: number, c: number, d: number) { chk('Path2D.quadraticCurveTo', finite(a, b, c, d), 'non-finite control point') }
    arc(_x: number, _y: number, r: number) { chk('Path2D.arc', !(r < 0), `negative radius ${r}`) }
    arcTo(_a: number, _b: number, _c: number, _d: number, r: number) { chk('Path2D.arcTo', !(r < 0), `negative radius ${r}`) }
    ellipse(_x: number, _y: number, rx: number, ry: number) { chk('Path2D.ellipse', !(rx < 0 || ry < 0), `negative radius ${rx},${ry}`) }
    rect(x: number, y: number, w: number, h: number) { chk('Path2D.rect', finite(x, y, w, h), `non-finite ${x},${y},${w},${h}`) }
    roundRect(_x: number, _y: number, _w: number, _h: number, r?: unknown) { if (typeof r === 'number') chk('Path2D.roundRect', !(r < 0), `negative radius ${r}`) }
    closePath() {} addPath() {}
  }
  ;(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath2D

  class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false, media: '', onchange: null,
    addListener: noop0, removeListener: noop0, addEventListener: noop0, removeEventListener: noop0, dispatchEvent: () => false,
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 800 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) } as DOMRect
  }
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

function noop0() { /* ignore */ }

afterAll(() => {
  vi.restoreAllMocks()
  ;(globalThis as unknown as { ImageData: unknown }).ImageData = RealImageData
})

/* ------------------------------------------------------------- fixtures ---- */

function tinyPng(w = 4, h = 4): string {
  // A real 1x1-ish PNG data URL is not decodable in jsdom; the render path must
  // tolerate that (placeholder branch), which is exactly what we want to test.
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c.toDataURL()
}

function richDocument() {
  const doc = createDocument('Strict', { id: 'a4', label: 'A4', w: 210, h: 297, unit: 'mm' })
  const page = doc.pages[0]
  const layer = page.layers[0]
  const objs = [
    createVector({ path: rectPathData(10, 10, 100, 60), name: 'rect' }),
    createVector({ path: shapes.starPath(5, 60, 30, 0.5), name: 'star', transform: { a: 1, b: 0, c: 0, d: 1, e: 200, f: 120 } }),
    createVector({ path: shapes.spiralPath(3, 60, 0.4, false), name: 'spiral', transform: { a: 1, b: 0, c: 0, d: 1, e: 320, f: 120 } }),
    createVector({ path: shapes.polygonPath(7, 50, false), name: 'polygon', transform: { a: 1, b: 0, c: 0, d: 1, e: 80, f: 260 } }),
    createVector({ path: shapes.graphPaperPath(4, 3, 120, 90), name: 'grid', transform: { a: 1, b: 0, c: 0, d: 1, e: 180, f: 240 } }),
    createVector({ path: shapes.ellipsePath(60, 40, 0, 360, 'pie'), name: 'pie', transform: { a: 1, b: 0, c: 0, d: 1, e: 400, f: 260 } }),
    createTextObject('artistic', 'Hello Strict', { x: 20, y: 380, w: 300, h: 40 }),
    createTextObject('paragraph', 'A paragraph of text that should wrap inside its frame.', { x: 20, y: 420, w: 260, h: 120 }),
    createBitmap(tinyPng(8, 8), 8, 8, { x: 320, y: 380, w: 120, h: 90 }),
  ]
  const group = createGroup([createVector({ path: rectPathData(460, 20, 40, 40), name: 'g1' }), createVector({ path: rectPathData(510, 20, 40, 40), name: 'g2' })])
  return { doc: { ...doc, pages: [{ ...page, layers: [{ ...layer, objects: [...objs, group] }] }] }, ids: objs.map((o) => o.id) }
}

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)) })
}

/* ---------------------------------------------------------------- tests ---- */

describe('strict canvas: engine', () => {
  it('renders a rich document at every quality without a canvas error', () => {
    const { doc } = richDocument()
    const page = doc.pages[0]
    const canvas = document.createElement('canvas')
    canvas.width = 1000; canvas.height = 700
    const ctx = canvas.getContext('2d')!
    for (const quality of ['draft', 'normal', 'high'] as const) {
      for (const wireframe of [false, true]) {
        renderPageInto(ctx, { doc, page, scale: 1, offsetX: 0, offsetY: 0, viewport: { x: 0, y: 0, w: 1000, h: 700 }, quality, wireframe, effects: true })
      }
    }
    expect(thrown).toEqual([])
  })

  it('runs every effect + adjustment through the stack', () => {
    const w = 24, h = 24
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256
    const ADJ: string[] = ['brightness-contrast', 'tone-curve', 'hue-curve', 'levels', 'vibrance',
      'color-balance', 'channel-mixer', 'desaturate', 'posterize', 'threshold', 'gamma', 'selective-color']
    for (const def of EFFECT_DEFS) {
      const node = ADJ.includes(def.kind)
        ? makeAdjustment(def.kind as AdjustmentType, `e-${def.kind}`)
        : makeEffect(def.kind as never, `e-${def.kind}`)
      runStack(new Uint8ClampedArray(data), w, h, [node])
    }
    expect(thrown).toEqual([])
  })

  it('builds every brush preset and every photo preset', () => {
    expect(BRUSH_PRESETS.length).toBeGreaterThan(50)
    const w = 32, h = 32
    const data = new Uint8ClampedArray(w * h * 4).fill(128)
    for (const preset of PHOTO_PRESETS) {
      const p = createPhotoDocument(w, h, new Uint8ClampedArray(data))
      for (const node of preset.build()) p.adjustments.push(node)
      renderedPhoto(p)
    }
    expect(thrown).toEqual([])
  })

  it('rasterises every photo preset to a canvas', async () => {
    const { photoToCanvas, photoDataUrl } = await import('../src/lib/photo')
    for (const preset of PHOTO_PRESETS) {
      const p = createPhotoDocument(16, 16, new Uint8ClampedArray(16 * 16 * 4).fill(90))
      for (const node of preset.build()) p.adjustments.push(node)
      photoToCanvas(p)
      photoDataUrl(p)
    }
    expect(thrown).toEqual([])
  })

})

describe('strict canvas: UI', () => {
  /* Regression: the stage used to stay blank. The render loop is scheduled from
   * a dependency-free callback, and React 18 StrictMode mounts → tears down →
   * re-mounts every effect in development. The teardown cancelled the pending
   * animation frame but left its (now stale) id in the guard, so every later
   * scheduleDraw() bailed out and the canvas never painted at all — a black
   * rectangle in the dev server, which is exactly what a preview serves. */
  it('paints the stage through a StrictMode mount and a resize', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    const settle = () => new Promise((r) => setTimeout(r, 80))

    await act(async () => {
      root = createRoot(container)
      root!.render(<StrictMode><App /></StrictMode>)
    })
    await flush()
    await act(async () => { useStore.getState().setHome(false) })
    await flush()
    await act(async () => { await settle() })

    const stage = container.querySelector('canvas.stage.artwork') as HTMLCanvasElement | null
    expect(stage).not.toBeNull()
    // The bitmap starts at the untouched default (300×150) and the size state at
    // 900×600; the stubbed wrapper measures 1200×800 with 20pt rulers, so only a
    // frame that actually ran can land on 1180×780.
    expect(`${stage!.width}x${stage!.height}`).toBe('1180x780')

    // A resize must resize the backing bitmap, not just the CSS box.
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) } as DOMRect
    }
    try {
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      await flush()
      await act(async () => { await settle() })
      expect(`${stage!.width}x${stage!.height}`).toBe('780x580')
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }

    await act(async () => { root?.unmount() })
    container.remove()

    if (thrown.length) console.debug('STRICT THROWN:\n' + thrown.slice(0, 40).join('\n'))
    expect(thrown).toEqual([])
  }, 120000)

  it('mounts, opens the workspace and cycles every tool', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    await act(async () => { root = createRoot(container); root!.render(<App />) })
    await flush(); await flush()

    const { doc } = richDocument()
    await act(async () => { useStore.getState().replaceDocument(doc, { markClean: true }); useStore.getState().setHome(false) })
    await flush()

    const stage = document.querySelector('canvas.stage')
    expect(stage).not.toBeNull()

    for (const id of Object.keys(TOOLS) as ToolID[]) {
      await act(async () => { useStore.getState().setTool(id) })
      await flush()
    }
    for (const id of Object.keys(useStore.getState().dockers)) {
      await act(async () => { useStore.getState().setDocker(id as never, true) })
      await flush()
    }
    await act(async () => { useStore.getState().setExportDialog(true) })
    await flush()
    await act(async () => { useStore.getState().setExportDialog(false); useStore.getState().setPrintDialog(true) })
    await flush()

    await act(async () => { root?.unmount() })
    container.remove()

    if (thrown.length) console.debug('STRICT THROWN:\n' + thrown.slice(0, 40).join('\n'))
    expect(thrown).toEqual([])
  }, 120000)
})
