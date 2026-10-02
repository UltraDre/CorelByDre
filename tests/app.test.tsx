/**
 * Integration smoke test: mounts the real editor shell in jsdom with a minimal
 * canvas stub. It does not check pixels — it catches the class of failure that
 * matters most here: a module, docker or tool that throws on first render.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from '../src/App'

function stubContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => undefined }
  const ctx: Record<string, unknown> = {
    canvas: null,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textBaseline: 'alphabetic',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    setTransform: () => undefined,
    resetTransform: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    scale: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    transform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    bezierCurveTo: () => undefined,
    quadraticCurveTo: () => undefined,
    arc: () => undefined,
    ellipse: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    fill: () => undefined,
    stroke: () => undefined,
    fillText: () => undefined,
    strokeText: () => undefined,
    setLineDash: () => undefined,
    drawImage: () => undefined,
    putImageData: () => undefined,
    measureText: (text: string) => ({ width: text.length * 7 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
      colorSpace: 'srgb',
    }),
  }
  return ctx as unknown as CanvasRenderingContext2D
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  HTMLCanvasElement.prototype.getContext = vi.fn(() => stubContext()) as unknown as HTMLCanvasElement['getContext']
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,')
  class FakeResizeObserver {
    observe(): void { /* no layout in jsdom */ }
    unobserve(): void { /* ignore */ }
    disconnect(): void { /* ignore */ }
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
  if (!('matchMedia' in window)) {
    ;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: false, addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
    })
  }
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('editor shell', () => {
  it('mounts the home dashboard and the workspace without throwing', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(<App />)
    })
    // Let the session-restore effect settle.
    await act(async () => { await Promise.resolve() })

    const text = document.body.textContent ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('CorelByDre')

    // The shell renders both the toolbar and the canvas stage.
    expect(document.querySelector('canvas.stage')).not.toBeNull()
    expect(document.querySelectorAll('.tool').length).toBeGreaterThan(8)
    expect(document.querySelectorAll('.docker').length).toBeGreaterThanOrEqual(2)

    await act(async () => { root?.unmount() })
    container.remove()
  })
})
