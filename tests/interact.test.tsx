/**
 * Interaction harness: drives the real canvas with pointer events and asserts
 * that each tool actually mutates the document.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from '../src/App'
import { useStore } from '../src/store/store'
import { createDocument } from '../src/store/mutations'
import type { ToolID } from '../src/tools/registry'

function stubContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => undefined }
  const noop = () => undefined
  const ctx: Record<string, unknown> = {
    canvas, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', shadowColor: 'transparent', shadowBlur: 0,
    shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true, filter: 'none',
    setTransform: noop, resetTransform: noop, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    save: noop, restore: noop, scale: noop, translate: noop, rotate: noop, transform: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, bezierCurveTo: noop, quadraticCurveTo: noop, arc: noop, arcTo: noop,
    ellipse: noop, rect: noop, roundRect: noop, clip: noop, fill: noop, stroke: noop,
    fillText: noop, strokeText: noop, setLineDash: noop, getLineDash: () => [],
    drawImage: noop, putImageData: noop, isPointInPath: () => false, isPointInStroke: () => false,
    measureText: (t: string) => ({ width: Math.max(1, t.length * 7), actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    createConicGradient: () => gradient, createPattern: () => ({ setTransform: noop }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h, colorSpace: 'srgb' }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h, colorSpace: 'srgb' }),
  }
  return ctx as unknown as CanvasRenderingContext2D
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  HTMLCanvasElement.prototype.getContext = vi.fn(function (this: HTMLCanvasElement) { return stubContext(this) }) as unknown as HTMLCanvasElement['getContext']
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,AAAA')
  class FakePath2D { moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} roundRect() {} closePath() {} addPath() {} }
  ;(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath2D
  class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false, media: '', onchange: null, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  })
  // Pointer capture is not implemented in jsdom.
  Element.prototype.setPointerCapture = function () { /* noop */ }
  Element.prototype.releasePointerCapture = function () { /* noop */ }
  Element.prototype.hasPointerCapture = function () { return false }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 800 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) } as DOMRect
  }
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterAll(() => { vi.restoreAllMocks() })

let root: Root | null = null

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)) })
}

async function boot() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { root = createRoot(container); root!.render(<App />) })
  await flush(); await flush()
  await act(async () => {
    useStore.getState().replaceDocument(createDocument('Interact', { id: 'a4', label: 'A4', w: 210, h: 297, unit: 'mm' }), { markClean: true })
    useStore.getState().setHome(false)
    useStore.getState().setView({ zoom: 1, panX: 0, panY: 0 })
  })
  await flush()
  return container
}

function stage(): HTMLCanvasElement {
  const el = document.querySelector('canvas.stage.interactive')
  if (!el) throw new Error('interactive stage canvas not found')
  return el as HTMLCanvasElement
}

function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pressure: 0.6, ...extra })
  act(() => { stage().dispatchEvent(ev) })
}

function drag(x0: number, y0: number, x1: number, y1: number) {
  pointer('pointerdown', x0, y0)
  pointer('pointermove', (x0 + x1) / 2, (y0 + y1) / 2)
  pointer('pointermove', x1, y1)
  pointer('pointerup', x1, y1)
}

function objectCount(): number {
  const s = useStore.getState()
  return s.doc.pages.flatMap((p) => p.layers.flatMap((l) => l.objects)).length
}

describe('canvas interaction', () => {
  it('boots into an empty workspace', async () => {
    await boot()
    expect(stage()).toBeTruthy()
    expect(objectCount()).toBe(0)
  }, 30000)

  const dragTools: ToolID[] = ['rectangle', 'ellipse', 'polygon', 'star', 'complexStar', 'graphPaper', 'spiral', 'line2', 'rect3', 'ellipse3', 'freehand', 'liveSketch', 'brush']
  for (const tool of dragTools) {
    it(`${tool}: drag creates an object`, async () => {
      await act(async () => { useStore.getState().replaceDocument(createDocument('T', { id: 'a4', label: 'A4', w: 210, h: 297, unit: 'mm' }), { markClean: true }); useStore.getState().setTool(tool) })
      await flush()
      const before = objectCount()
      await act(async () => { drag(120, 120, 380, 300) })
      await flush()
      const after = objectCount()
      if (after === before) console.debug(`NO OBJECT CREATED for tool=${tool}`)
      expect(after).toBeGreaterThan(before)
    }, 30000)
  }

  it('pick tool selects a drawn object', async () => {
    await act(async () => { useStore.getState().replaceDocument(createDocument('T', { id: 'a4', label: 'A4', w: 210, h: 297, unit: 'mm' }), { markClean: true }); useStore.getState().setTool('rectangle') })
    await flush()
    await act(async () => { drag(120, 120, 380, 300) })
    await flush()
    expect(objectCount()).toBe(1)
    await act(async () => { useStore.getState().setTool('pick'); useStore.getState().clearSelection() })
    await flush()
    // Marquee over the shape.
    await act(async () => { drag(80, 80, 420, 340) })
    await flush()
    const sel = useStore.getState().selection.length
    if (sel === 0) console.debug('MARQUEE DID NOT SELECT')
    expect(sel).toBe(1)
  }, 30000)

  it('text tool creates a text object', async () => {
    await act(async () => { useStore.getState().replaceDocument(createDocument('T', { id: 'a4', label: 'A4', w: 210, h: 297, unit: 'mm' }), { markClean: true }); useStore.getState().setTool('text') })
    await flush()
    await act(async () => { drag(150, 150, 450, 260) })
    await flush()
    if (objectCount() === 0) console.debug('TEXT TOOL CREATED NOTHING')
    expect(objectCount()).toBeGreaterThan(0)
  }, 30000)

  it('zoom tool changes the zoom', async () => {
    await act(async () => { useStore.getState().setTool('zoom'); useStore.getState().setView({ zoom: 1 }) })
    await flush()
    await act(async () => { pointer('pointerdown', 300, 300); pointer('pointerup', 300, 300) })
    await flush()
    const z = useStore.getState().view.zoom
    if (z === 1) console.debug('ZOOM TOOL DID NOT ZOOM')
    expect(z).not.toBe(1)
  }, 30000)

  it('calibrates direct click selection on objects and rotates via the center x handle', async () => {
    await act(async () => {
      useStore.getState().replaceDocument(createDocument('T', { id: 'a4', label: 'A4', w: 210, h: 297, unit: 'mm' }), { markClean: true })
      useStore.getState().setView({ zoom: 1, panX: 0, panY: 0, showRulers: false })
      useStore.getState().setTool('rectangle')
    })
    await flush()
    // Draw a rectangle from (100, 100) to (300, 220); center is (200, 160).
    await act(async () => { drag(100, 100, 300, 220) })
    await flush()
    expect(objectCount()).toBe(1)

    await act(async () => {
      useStore.getState().setTool('pick')
      useStore.getState().clearSelection()
    })
    await flush()
    expect(useStore.getState().selection).toHaveLength(0)

    // Clicking outside the object at (50, 50) does not select it.
    await act(async () => {
      pointer('pointerdown', 50, 50)
      pointer('pointerup', 50, 50)
    })
    await flush()
    expect(useStore.getState().selection).toHaveLength(0)

    // Clicking directly on the object at (140, 140) selects it immediately.
    await act(async () => {
      pointer('pointerdown', 140, 140)
      pointer('pointerup', 140, 140)
    })
    await flush()
    expect(useStore.getState().selection).toHaveLength(1)

    // The small 'x' rotation button is rendered at the center of the selected object.
    const centerXBtn = document.querySelector('[data-testid="center-rotate-x"]') as HTMLButtonElement | null
    expect(centerXBtn).toBeTruthy()
    expect(centerXBtn?.textContent?.trim()).toBe('x')

    // Clicking the center 'x' enables rotation mode.
    await act(async () => {
      centerXBtn!.click()
    })
    await flush()
    expect(centerXBtn?.classList.contains('active')).toBe(true)

    // Dragging on the selected object or handle now rotates it.
    await act(async () => {
      drag(300, 160, 200, 260)
    })
    await flush()
    const obj = useStore.getState().doc.pages[0].layers[0].objects[0]
    expect(Math.abs(obj.transform.b) + Math.abs(obj.transform.c)).toBeGreaterThan(0.05)
  }, 30000)

  it('opens the options menu on hold-left-click + right-click tap and on 2-finger tap', async () => {
    await act(async () => {
      useStore.getState().setTool('pick')
    })
    await flush()

    // 1. Hold left click (button 0) + right click tap (button 2, buttons 3).
    await act(async () => {
      pointer('pointerdown', 180, 180, { button: 0, buttons: 1 })
      pointer('pointerdown', 180, 180, { button: 2, buttons: 3 })
      pointer('pointerup', 180, 180, { button: 0, buttons: 0 })
    })
    await flush()
    let menu = document.querySelector('.canvas-options-menu[role="menu"]')
    expect(menu).toBeTruthy()

    // Close menu via Escape
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(document.querySelector('.canvas-options-menu[role="menu"]')).toBeNull()

    // 2. Two-finger tap via touch pointer events
    await act(async () => {
      pointer('pointerdown', 200, 200, { pointerId: 10, pointerType: 'touch' })
      pointer('pointerdown', 240, 200, { pointerId: 11, pointerType: 'touch' })
      pointer('pointerup', 200, 200, { pointerId: 10, pointerType: 'touch' })
      pointer('pointerup', 240, 200, { pointerId: 11, pointerType: 'touch' })
    })
    await flush()
    menu = document.querySelector('.canvas-options-menu[role="menu"]')
    expect(menu).toBeTruthy()
  }, 30000)

  it('zooms the page in and out on 2-finger drag', async () => {
    await act(async () => {
      useStore.getState().setView({ zoom: 1, panX: 0, panY: 0 })
    })
    await flush()
    expect(useStore.getState().view.zoom).toBe(1)

    // Two-finger spread / drag to zoom in
    await act(async () => {
      pointer('pointerdown', 250, 250, { pointerId: 21, pointerType: 'touch' })
      pointer('pointerdown', 350, 250, { pointerId: 22, pointerType: 'touch' })
      pointer('pointermove', 200, 250, { pointerId: 21, pointerType: 'touch' })
      pointer('pointermove', 400, 250, { pointerId: 22, pointerType: 'touch' })
      pointer('pointerup', 200, 250, { pointerId: 21, pointerType: 'touch' })
      pointer('pointerup', 400, 250, { pointerId: 22, pointerType: 'touch' })
    })
    await flush()
    const zoomedIn = useStore.getState().view.zoom
    expect(zoomedIn).toBeGreaterThan(1)

    // Parallel two-finger drag downward to zoom out
    await act(async () => {
      pointer('pointerdown', 250, 200, { pointerId: 31, pointerType: 'touch' })
      pointer('pointerdown', 310, 200, { pointerId: 32, pointerType: 'touch' })
      pointer('pointermove', 250, 280, { pointerId: 31, pointerType: 'touch' })
      pointer('pointermove', 310, 280, { pointerId: 32, pointerType: 'touch' })
      pointer('pointerup', 250, 280, { pointerId: 31, pointerType: 'touch' })
      pointer('pointerup', 310, 280, { pointerId: 32, pointerType: 'touch' })
    })
    await flush()
    const zoomedOut = useStore.getState().view.zoom
    expect(zoomedOut).toBeLessThan(zoomedIn)
  }, 30000)

  it('shows the tool or icon name when hovering on any tool or icon', async () => {
    const toolButtons = Array.from(document.querySelectorAll('.toolbox .tool'))
    expect(toolButtons.length).toBeGreaterThan(5)
    for (const btn of toolButtons) {
      expect(btn.getAttribute('title') || btn.getAttribute('data-tooltip')).toBeTruthy()
    }

    const railButtons = Array.from(document.querySelectorAll('.dockers-rail button'))
    expect(railButtons.length).toBeGreaterThan(5)
    for (const btn of railButtons) {
      expect(btn.getAttribute('title') || btn.getAttribute('data-tooltip')).toBeTruthy()
    }

    const firstTool = toolButtons[0] as HTMLElement
    await act(async () => {
      firstTool.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 20, clientY: 120 }))
    })
    await flush()
    const tooltip = document.querySelector('.hover-tooltip[role="tooltip"]')
    expect(tooltip).toBeTruthy()
    expect(tooltip?.textContent?.length).toBeGreaterThan(0)
  }, 30000)
})
