import { describe, expect, it } from 'vitest'
import {
  addObject, addPage, createDocument, createGroup, createLayer, createTextObject, createVector, deletePage,
  duplicatePage, objectCount, rectPathData, removeObjects, reorderObject, setFill, updateObject, updatePage,
} from '../src/store/mutations'
import { pathBounds, matTranslate, rectUnion } from '../src/lib/util'
import { rgb } from '../src/lib/color'

function sampleDoc() {
  let doc = createDocument('Test')
  const pageId = doc.pages[0].id
  const layerId = doc.pages[0].layers[0].id
  const rect = createVector({ path: rectPathData(10, 20, 100, 50), primitive: { type: 'rect', w: 100, h: 50, r: 0, corners: [1, 1, 1, 1] } })
  const circle = createVector({ path: rectPathData(200, 200, 40, 40), primitive: { type: 'rect', w: 40, h: 40, r: 0, corners: [1, 1, 1, 1] } })
  doc = addObject(doc, pageId, layerId, rect)
  doc = addObject(doc, pageId, layerId, circle)
  return { doc, pageId, layerId, rect, circle }
}

describe('document model', () => {
  it('creates a multi-layer A4 document', () => {
    const doc = createDocument('Layout')
    expect(doc.pages).toHaveLength(1)
    expect(doc.pages[0].size.w).toBeGreaterThan(500)
    expect(doc.pages[0].layers.length).toBeGreaterThanOrEqual(1)
    expect(objectCount(doc)).toBe(0)
  })

  it('keeps untouched objects identical when one object changes', () => {
    const { doc, rect, circle } = sampleDoc()
    const next = updateObject(doc, rect.id, (o) => ({ ...o, transform: matTranslate(5, 5) }))
    const layer = next.pages[0].layers[0]
    const updatedRect = layer.objects.find((o) => o.id === rect.id)!
    const untouchedCircle = layer.objects.find((o) => o.id === circle.id)!
    expect(updatedRect).not.toBe(rect)
    expect(untouchedCircle).toBe(circle) // identity preserved for renderer caches
    expect(doc.pages[0].layers[0].objects[0]).toBe(rect) // original document untouched
  })

  it('removes objects and reports where they came from', () => {
    const { doc, rect, pageId, layerId } = sampleDoc()
    const result = removeObjects(doc, [rect.id])
    expect(result.removed).toHaveLength(1)
    expect(result.removed[0].pageId).toBe(pageId)
    expect(result.removed[0].layerId).toBe(layerId)
    expect(objectCount(result.doc)).toBe(1)
  })

  it('adds, duplicates and deletes pages while keeping at least one', () => {
    let doc = createDocument('Paged')
    doc = addPage(doc)
    expect(doc.pages).toHaveLength(2)
    doc = duplicatePage(doc, doc.pages[0].id)
    expect(doc.pages).toHaveLength(3)
    doc = deletePage(doc, doc.pages[0].id)
    expect(doc.pages).toHaveLength(2)
    doc = deletePage(doc, doc.pages[0].id)
    doc = deletePage(doc, doc.pages[0].id)
    expect(doc.pages.length).toBeGreaterThanOrEqual(1)
  })

  it('reorders objects within a layer', () => {
    const { doc, rect, pageId, layerId } = sampleDoc()
    const next = reorderObject(doc, pageId, layerId, rect.id, 1)
    expect(next.pages[0].layers[0].objects[1].id).toBe(rect.id)
  })

  it('groups children and keeps their geometry', () => {
    const { doc, rect, circle } = sampleDoc()
    const group = createGroup([rect, circle])
    const bounds = rectUnion(pathBounds(group.children[0].kind === 'vector' ? group.children[0].path : null), pathBounds(circle.path))
    expect(group.kind).toBe('group')
    expect(bounds?.w).toBeGreaterThan(100)
    expect(updatePage(doc, doc.pages[0].id, (p) => p).pages[0].id).toBe(doc.pages[0].id)
  })

  it('applies fills without touching other properties', () => {
    const { doc, rect } = sampleDoc()
    const next = setFill(doc, rect.id, { type: 'uniform', color: rgb(200, 16, 46) })
    const obj = next.pages[0].layers[0].objects[0]
    expect(obj.kind).toBe('vector')
    if (obj.kind === 'vector') expect(obj.fill).toEqual({ type: 'uniform', color: { r: 200, g: 16, b: 46, a: 1 } })
  })

  it('creates text objects with typography defaults', () => {
    const text = createTextObject('paragraph', 'Hello', { x: 0, y: 0, w: 200, h: 80 })
    expect(text.kind).toBe('text')
    expect(text.style.fontSize).toBeGreaterThan(0)
    expect(text.style.openType).toBeTruthy()
    expect(text.frame.w).toBe(200)
  })

  it('creates layers of both kinds', () => {
    expect(createLayer('Layer 2').kind).toBe('normal')
    expect(createLayer('Master', 'master').kind).toBe('master')
  })
})
