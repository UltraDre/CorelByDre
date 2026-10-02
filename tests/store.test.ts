import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../src/store/store'
import { createDocument, createVector, rectPathData } from '../src/store/mutations'
import { objectBounds } from '../src/engine/render'
import { rgb } from '../src/lib/color'

function reset() {
  const doc = createDocument('Store test')
  useStore.getState().replaceDocument(doc, { markClean: true })
  return doc
}

function addRect(x: number, y: number) {
  const obj = createVector({
    path: rectPathData(x, y, 40, 20),
    primitive: { type: 'rect', w: 40, h: 20, r: 0, corners: [1, 1, 1, 1] },
    fill: { type: 'uniform', color: rgb(18, 161, 154) },
  })
  useStore.getState().addObjectsToActiveLayer([obj], 'Add rectangle')
  return obj
}

describe('application store', () => {
  beforeEach(() => {
    reset()
  })

  it('starts clean with a single page and no history', () => {
    const state = useStore.getState()
    expect(state.dirty).toBe(false)
    expect(state.history).toHaveLength(0)
    expect(state.doc.pages).toHaveLength(1)
  })

  it('records undoable steps and restores the exact previous document', () => {
    const before = useStore.getState().doc
    addRect(10, 10)
    const after = useStore.getState().doc
    expect(useStore.getState().history).toHaveLength(1)
    expect(after).not.toBe(before)
    expect(useStore.getState().dirty).toBe(true)

    useStore.getState().undo()
    expect(useStore.getState().doc).toBe(before)
    expect(useStore.getState().future).toHaveLength(1)

    useStore.getState().redo()
    expect(useStore.getState().doc).toBe(after)
  })

  it('clears the redo stack when a new edit lands', () => {
    addRect(0, 0)
    useStore.getState().undo()
    expect(useStore.getState().future).toHaveLength(1)
    addRect(50, 50)
    expect(useStore.getState().future).toHaveLength(0)
  })

  it('selects new objects and can delete them', () => {
    const rect = addRect(10, 10)
    expect(useStore.getState().selection).toEqual([rect.id])
    useStore.getState().deleteSelection()
    expect(useStore.getState().doc.pages[0].layers[0].objects).toHaveLength(0)
    expect(useStore.getState().selection).toHaveLength(0)
  })

  it('aligns two objects to the left edge', () => {
    const a = addRect(10, 10)
    const b = addRect(100, 60)
    useStore.getState().setSelection([a.id, b.id])
    useStore.getState().alignSelection('left')
    const doc = useStore.getState().doc
    const lefts = doc.pages[0].layers[0].objects.map((o) => objectBounds(o, doc)!.x)
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(0.001)
    expect(Math.min(...lefts)).toBeCloseTo(10, 6)
  })

  it('groups and ungroups while preserving world positions', () => {
    const a = addRect(10, 10)
    const b = addRect(60, 40)
    useStore.getState().setSelection([a.id, b.id])
    useStore.getState().groupSelection()
    const group = useStore.getState().doc.pages[0].layers[0].objects[0]
    expect(group.kind).toBe('group')
    if (group.kind === 'group') {
      const worldBefore = group.children.map((c) => ({ x: c.transform.e, y: c.transform.f }))
      useStore.getState().setSelection([group.id])
      useStore.getState().ungroupSelection()
      const restored = useStore.getState().doc.pages[0].layers[0].objects
      const worldAfter = restored.map((o) => ({ x: o.transform.e, y: o.transform.f }))
      for (const before of worldBefore) {
        expect(worldAfter.some((p) => Math.abs(p.x - before.x) < 0.001 && Math.abs(p.y - before.y) < 0.001)).toBe(true)
      }
    }
  })

  it('nudges the selection by the configured step', () => {
    const rect = addRect(10, 10)
    useStore.getState().setSelection([rect.id])
    const step = useStore.getState().doc.settings.nudgeStep
    const before = objectBounds(rect, useStore.getState().doc)!
    useStore.getState().nudgeSelection(step, 0)
    const doc = useStore.getState().doc
    const moved = doc.pages[0].layers[0].objects.find((o) => o.id === rect.id)!
    const after = objectBounds(moved, doc)!
    expect(after.x - before.x).toBeCloseTo(step, 6)
  })

  it('applies fills and strokes to the selection', () => {
    const rect = addRect(10, 10)
    useStore.getState().applyFillToSelection({ type: 'uniform', color: rgb(0, 87, 184) })
    useStore.getState().applyStrokeToSelection({ width: 3, color: rgb(0, 0, 0) })
    const obj = useStore.getState().doc.pages[0].layers[0].objects.find((o) => o.id === rect.id)!
    expect(obj.kind).toBe('vector')
    if (obj.kind === 'vector') {
      expect(obj.fill).toEqual({ type: 'uniform', color: { r: 0, g: 87, b: 184, a: 1 } })
      expect(obj.stroke?.width).toBe(3)
    }
  })

  it('adds non-destructive effects that stay editable', () => {
    const rect = addRect(10, 10)
    useStore.getState().setSelection([rect.id])
    useStore.getState().addEffect('gaussian-blur', 'effect')
    const obj = useStore.getState().doc.pages[0].layers[0].objects[0]
    expect(obj.effects).toHaveLength(1)
    expect(obj.effects[0].kind).toBe('gaussian-blur')
  })

  it('tracks pages and switches the active page', () => {
    useStore.getState().addPage()
    const state = useStore.getState()
    expect(state.doc.pages.length).toBe(2)
    useStore.getState().setActivePage(state.doc.pages[0].id)
    expect(useStore.getState().activePage().id).toBe(state.doc.pages[0].id)
  })

  it('exposes tool history for the toolbox', () => {
    useStore.getState().setTool('brush')
    useStore.getState().setTool('pick')
    const state = useStore.getState()
    expect(state.tool).toBe('pick')
    expect(state.previousTool).toBe('brush')
    expect(state.recentTools[0]).toBe('pick')
  })

  it('caps history length', () => {
    for (let i = 0; i < 140; i++) addRect(i, i)
    expect(useStore.getState().history.length).toBeLessThanOrEqual(120)
  })
})
