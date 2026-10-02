/**
 * Reproduction: a browser where IndexedDB exists but never settles (partitioned
 * or blocked third-party storage, some private modes, sandboxed iframes).
 * The splash screen must never become a dead end.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from '../src/App'

/** A request object that never fires success/error — the real-world hang. */
function hangingIndexedDB() {
  const makeReq = () => {
    const req: Record<string, unknown> = {
      result: undefined, error: null,
      onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
    }
    return req
  }
  return {
    open: () => makeReq(),
    deleteDatabase: () => makeReq(),
    databases: () => Promise.resolve([]),
    cmp: () => 0,
  }
}

let root: Root | null = null
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const stub = () => ({
    addColorStop: () => undefined,
  })
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    canvas: null, save: () => undefined, restore: () => undefined, setTransform: () => undefined,
    clearRect: () => undefined, fillRect: () => undefined, beginPath: () => undefined,
    moveTo: () => undefined, lineTo: () => undefined, fill: () => undefined, stroke: () => undefined,
    measureText: (t: string) => ({ width: t.length * 7 }), createLinearGradient: stub,
    createRadialGradient: stub, createConicGradient: stub, createPattern: () => null,
    drawImage: () => undefined, getImageData: (_a: number, _b: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h, colorSpace: 'srgb',
    }),
    fillText: () => undefined, setLineDash: () => undefined, translate: () => undefined,
    scale: () => undefined, rotate: () => undefined, arc: () => undefined, ellipse: () => undefined,
    rect: () => undefined, closePath: () => undefined, clip: () => undefined, putImageData: () => undefined,
    bezierCurveTo: () => undefined, quadraticCurveTo: () => undefined, resetTransform: () => undefined,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h, colorSpace: 'srgb',
    }),
    isPointInPath: () => false, roundRect: () => undefined, arcTo: () => undefined,
  })) as unknown as HTMLCanvasElement['getContext']
  class FakePath2D { moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} roundRect() {} closePath() {} addPath() {} }
  ;(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath2D
  class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false, media: '', onchange: null, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  })
  Element.prototype.setPointerCapture = function () {}
  Element.prototype.releasePointerCapture = function () {}
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 800 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) } as DOMRect
  }
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterAll(() => { vi.restoreAllMocks() })

describe('blocked/hanging IndexedDB', () => {
  it('still boots into the editor', async () => {
    ;(globalThis as unknown as { indexedDB: unknown }).indexedDB = hangingIndexedDB()
    ;(window as unknown as { indexedDB: unknown }).indexedDB = (globalThis as unknown as { indexedDB: unknown }).indexedDB

    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => { root = createRoot(container); root!.render(<App />) })
    // Wait past the boot deadline: storage hangs, so only the deadline can
    // release the splash screen.
    for (let i = 0; i < 24; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
      if (document.querySelector('canvas.stage')) break
    }

    const text = document.body.textContent ?? ''
    const stuckOnSplash = text.includes('Starting CorelByDre')
    const hasEditor = document.querySelector('canvas.stage') !== null

    if (stuckOnSplash) console.debug('REPRO: app is stuck on the splash screen — IndexedDB never settled')
    if (!hasEditor) console.debug('REPRO: no editor canvas rendered')

    await act(async () => { root?.unmount() })
    container.remove()

    expect(stuckOnSplash).toBe(false)
    expect(hasEditor).toBe(true)
  }, 30000)
})
