import { describe, expect, it } from 'vitest'
import type { LensMode, Stroke } from '../src/types'
import { applyEffect, makeEffect } from '../src/engine/effects'
import { extrusionFaces, setNodeType } from '../src/engine/shapes'
import { hitTestObject, objectBounds } from '../src/engine/render'
import { addObject, createDocument, createVector, rectPathData } from '../src/store/mutations'
import { exportPDF, exportSVG } from '../src/lib/export'
import { PDFDocument } from 'pdf-lib'
import { flattenPath, node, pathFromSubpaths, subPath } from '../src/lib/util'
import { rgb as color } from '../src/lib/color'

describe('fidelity tranche geometry and effect contracts', () => {
  it('creates deterministic depth bands for an extrusion', () => {
    const path = rectPathData(10, 20, 40, 30)
    const faces = extrusionFaces(path, 30, -12, 8, 4)
    expect(faces.length).toBeGreaterThanOrEqual(16)
    expect(faces.every((face) => face.subpaths.length === 1 && face.subpaths[0].closed)).toBe(true)
    expect(extrusionFaces(path, 30, -12, 8, 4)).toEqual(faces)
  })

  it('keeps smooth handles collinear and makes symmetric handles equal-length', () => {
    const corner = { ...node(10, 0), inX: 8, inY: 0, outX: 14, outY: 0 }
    const path = pathFromSubpaths([subPath([node(0, 0), corner, node(20, 10)], false)])
    const smooth = setNodeType(path, 0, 1, 'smooth').subpaths[0].nodes[1]
    expect(Math.hypot(smooth.x - smooth.inX, smooth.y - smooth.inY)).toBeCloseTo(2, 5)
    expect(Math.hypot(smooth.outX - smooth.x, smooth.outY - smooth.y)).toBeCloseTo(4, 5)
    const symmetric = setNodeType(path, 0, 1, 'symmetric').subpaths[0].nodes[1]
    const inLength = Math.hypot(symmetric.x - symmetric.inX, symmetric.y - symmetric.inY)
    const outLength = Math.hypot(symmetric.outX - symmetric.x, symmetric.outY - symmetric.y)
    expect(inLength).toBeCloseTo(outLength, 5)
    expect((symmetric.x - symmetric.inX) * (symmetric.outY - symmetric.y) - (symmetric.y - symmetric.inY) * (symmetric.outX - symmetric.x)).toBeCloseTo(0, 5)
  })

  it('includes extruded side faces in vector hit-testing and bounds', () => {
    const path = rectPathData(10, 20, 40, 30)
    const vector = createVector({
      path,
      extrude: { dx: 30, dy: -12, steps: 6, color: color(58, 68, 82), showLines: false, fade: true },
    })
    const face = extrusionFaces(path, 30, -12, 4, 1)[0]
    const polygon = flattenPath(face, 2)[0]
    const center = polygon.reduce((acc, p) => ({ x: acc.x + p.x / polygon.length, y: acc.y + p.y / polygon.length }), { x: 0, y: 0 })
    expect(hitTestObject(vector, center, 0.1)).toBe(true)
    const bounds = objectBounds(vector)!
    expect(bounds.x).toBeLessThanOrEqual(10)
    expect(bounds.y).toBeLessThan(20)
    expect(bounds.x + bounds.w).toBeGreaterThanOrEqual(80)
  })

  it('expands outline bounds when endpoint markers are enabled', () => {
    const path = pathFromSubpaths([subPath([node(10, 10), node(30, 10)], false)])
    const stroke: Stroke = { color: color(20, 25, 30), width: 2, cap: 'butt', join: 'miter', miterLimit: 10, behind: false }
    const plain = createVector({ path, stroke })
    const marked = createVector({ path, stroke: { ...stroke, startArrow: 'triangle', endArrow: 'diamond', arrowScale: 1.5 } })
    expect(objectBounds(marked)!.w).toBeGreaterThan(objectBounds(plain)!.w)
  })

  it('exports vector arrowheads and extrusion faces into SVG', () => {
    const doc = createDocument('Fidelity SVG')
    const page = doc.pages[0]
    const path = pathFromSubpaths([
      rectPathData(8, 8, 12, 12).subpaths[0],
      subPath([node(20, 20), node(60, 20)], false),
    ])
    const vector = createVector({
      path,
      stroke: { color: color(20, 25, 30), width: 2, cap: 'butt', join: 'miter', miterLimit: 10, behind: false, startArrow: 'triangle', endArrow: 'open' },
      extrude: { dx: 24, dy: 12, steps: 3, color: color(58, 68, 82), showLines: true, fade: true },
    })
    const next = addObject(doc, page.id, page.layers[0].id, vector)
    const svg = exportSVG(next, next.pages.find((candidate) => candidate.id === page.id)!)
    expect(svg).toContain('<marker')
    expect(svg).toContain('marker-start=')
    expect(svg).toContain('marker-end=')
    expect(svg.match(/<path d="[^"]*" fill="none"[^>]*marker-start=/g)).toHaveLength(1)
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(2)
  })

  it('writes a readable PDF for open paths with arrowheads and extrusion', async () => {
    const doc = createDocument('Fidelity PDF')
    const page = doc.pages[0]
    const path = pathFromSubpaths([
      rectPathData(8, 8, 12, 12).subpaths[0],
      subPath([node(20, 20), node(60, 20)], false),
    ])
    const vector = createVector({
      path,
      stroke: { color: color(20, 25, 30), width: 2, cap: 'butt', join: 'miter', miterLimit: 10, behind: false, startArrow: 'triangle', endArrow: 'open' },
      extrude: { dx: 24, dy: 12, steps: 3, color: color(58, 68, 82), showLines: true, fade: true },
    })
    const next = addObject(doc, page.id, page.layers[0].id, vector)
    const bytes = await exportPDF(next, next.pages.find((candidate) => candidate.id === page.id)!)
    expect(bytes.byteLength).toBeGreaterThan(100)
    const parsed = await PDFDocument.load(bytes)
    expect(parsed.getPageCount()).toBe(1)
    expect(parsed.getPage(0).node.Contents()).toBeTruthy()
  })

  it('processes every Lens mode without changing the RGBA buffer dimensions', () => {
    const modes: LensMode[] = ['fisheye', 'brighten', 'tint', 'grayscale', 'invert', 'transparency', 'wireframe', 'heatmap']
    const input = new Uint8ClampedArray([
      245, 30, 20, 255, 20, 230, 80, 220,
      15, 40, 235, 180, 220, 190, 30, 255,
    ])
    for (const mode of modes) {
      const effect = makeEffect('lens', `lens-${mode}`)
      effect.params = { ...effect.params, mode, amount: 0.4, zoom: 1.2, edge: 'clamp', color: '#12a19a' }
      const output = applyEffect(input, { width: 2, height: 2 }, effect)
      expect(output).toHaveLength(input.length)
      expect([...output].every((value) => Number.isFinite(value))).toBe(true)
    }
  })
})
