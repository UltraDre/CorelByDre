/**
 * PDF import regressions.
 *
 * pdf.js v4 throws unless `GlobalWorkerOptions.workerSrc` is set (it only
 * defaults under Node), and a PDF that yields nothing must still produce a
 * document the editor can open. Both are asserted here against a stubbed pdf.js.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  workerSrcAtGetDocument: null as string | null,
  numPages: 1,
  failGetDocument: false,
}

vi.mock('pdfjs-dist', () => {
  const GlobalWorkerOptions = { workerSrc: '' }
  return {
    GlobalWorkerOptions,
    OPS: {
      save: 10, restore: 11, transform: 12, constructPath: 13,
      showText: 20, setTextMatrix: 21, beginText: 22, endText: 23,
      setFillRGBColor: 60, setStrokeRGBColor: 61, paintSolidColorImageMask: 90,
    },
    getDocument: (_params: unknown) => {
      // Capture what the app configured *before* pdf.js would read the getter.
      state.workerSrcAtGetDocument = GlobalWorkerOptions.workerSrc
      if (state.failGetDocument) return { promise: Promise.reject(new Error('boom')) }
      const pdfDocument = {
        numPages: state.numPages,
        getPage: () => Promise.resolve({
          getViewport: () => ({ width: 595, height: 842 }),
          getOperatorList: () => Promise.resolve({ fnArray: [], argsArray: [] }),
        }),
      }
      return { promise: Promise.resolve(pdfDocument) }
    },
  }
})

const { importPDF } = await import('../src/lib/import')

beforeEach(() => {
  state.workerSrcAtGetDocument = null
  state.numPages = 1
  state.failGetDocument = false
})

describe('PDF import', () => {
  it('configures the pdf.js worker before parsing', async () => {
    await importPDF(new ArrayBuffer(8), 'worker.pdf')
    expect(state.workerSrcAtGetDocument).toBeTruthy()
    expect(typeof state.workerSrcAtGetDocument).toBe('string')
    // Must be a same-origin path so the PWA can cache it and Worker() accepts it.
    expect(state.workerSrcAtGetDocument!.startsWith('/')).toBe(true)
  })

  it('returns an openable document for a single page', async () => {
    const result = await importPDF(new ArrayBuffer(8), 'one.pdf')
    expect(result.document.pages.length).toBe(1)
    expect(result.document.activePageId).toBe(result.document.pages[0].id)
    expect(result.document.pages[0].layers.length).toBeGreaterThan(0)
  })

  it('never returns a document with zero pages', async () => {
    state.numPages = 0
    const result = await importPDF(new ArrayBuffer(8), 'empty.pdf')
    expect(result.document.pages.length).toBeGreaterThan(0)
    expect(result.document.activePageId).toBe(result.document.pages[0].id)
    expect(result.document.pages[0].layers.length).toBeGreaterThan(0)
    expect(result.warnings.join(' ')).toMatch(/blank page|no extractable/i)
  })

  it('recovers a usable document when pdf.js rejects', async () => {
    state.failGetDocument = true
    const result = await importPDF(new ArrayBuffer(8), 'broken.pdf')
    expect(result.document.pages.length).toBeGreaterThan(0)
    expect(result.document.activePageId).toBe(result.document.pages[0].id)
    expect(result.warnings.join(' ')).toMatch(/PDF import failed/)
  })
})
