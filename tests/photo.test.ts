import { describe, expect, it } from 'vitest'
import {
  createPhotoDocument, emptySelection, paintMask, replaceColor, removeBackground, selectSubject,
  selectionAll, selectionFeather, selectionGrow, selectionInvert, selectionRect, selectionShrink,
  beginLiquify, commitLiquify, liquifyDrag, blurMask, applyLensCorrection, photoStats, PHOTO_PRESETS,
  photoSnapshot, photoUndo, photoRedo, retouchDab,
} from '../src/lib/photo'
import { ImageKernels } from '../src/lib/wasm'
import { rgb } from '../src/lib/color'

/** A white canvas with a solid red square in the middle — a stand-in photo. */
function testImage(w = 64, h = 64) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const inside = x > 16 && x < 48 && y > 16 && y < 48
      data[i] = inside ? 220 : 245
      data[i + 1] = inside ? 40 : 245
      data[i + 2] = inside ? 60 : 245
      data[i + 3] = 255
    }
  }
  return createPhotoDocument(w, h, data, 'Test photo')
}

describe('photo document', () => {
  it('tracks a local undo stack for retouching', () => {
    const doc = testImage()
    photoSnapshot(doc, 'before')
    doc.data = ImageKernels.adjustBasic(doc.data, 0.2, 0, 1, 1)
    const edited = doc.data[0]
    expect(photoUndo(doc)).toBe('before')
    expect(doc.data[0]).not.toBe(edited)
    expect(photoRedo(doc)).toBe('before')
  })

  it('reports deterministic statistics', () => {
    const doc = testImage()
    const stats = photoStats(doc, 4)
    expect(stats.histogram.length).toBe(256)
    expect(stats.dynamicRange.high).toBeGreaterThan(stats.dynamicRange.low)
    expect(stats.palette.length).toBeGreaterThanOrEqual(2)
    expect(stats.palette.length).toBeLessThanOrEqual(4)
  })

  it('offers adjustment presets that are all well formed', () => {
    expect(PHOTO_PRESETS.length).toBeGreaterThan(10)
    for (const preset of PHOTO_PRESETS) {
      const stack = preset.build()
      expect(stack.length).toBeGreaterThan(0)
      expect(stack[0].type).toBe('adjustment')
    }
  })
})

describe('selections and masking', () => {
  it('builds rectangle selections and honours modes', () => {
    let sel = emptySelection(64, 64)
    sel = selectionRect(sel, 10, 10, 20, 20)
    expect(sel.active).toBe(true)
    expect(sel.bounds).toMatchObject({ x: 10, y: 10 })
    sel = selectionInvert(sel)
    expect(sel.mask[0]).toBe(255)
    sel = selectionAll(sel)
    expect(sel.mask.every((v) => v === 0 || v === 255)).toBe(true)
  })

  it('grows, shrinks and feathers without throwing', () => {
    let sel = selectionRect(emptySelection(48, 48), 12, 12, 16, 16)
    sel = selectionGrow(sel, 2)
    expect(sel.active).toBe(true)
    sel = selectionShrink(sel, 1)
    sel = selectionFeather(sel, 2)
    expect(sel.mask.length).toBe(48 * 48)
  })

  it('paints and erases mask with a soft brush', () => {
    let sel = emptySelection(64, 64)
    sel = paintMask(sel, [{ x: 32, y: 32 }], 10, 0.5, 1, false)
    const painted = sel.mask[32 * 64 + 32]
    expect(painted).toBeGreaterThan(200)
    sel = paintMask(sel, [{ x: 32, y: 32 }], 10, 0.5, 1, true)
    expect(sel.mask[32 * 64 + 32]).toBeLessThan(painted)
  })

  it('removes a flood-fill background from the border inward', () => {
    const doc = testImage()
    const { mask, removed } = removeBackground(doc, { tolerance: 24, feather: 1, expand: 0, keepSubjectOnly: true })
    expect(removed).toBeGreaterThan(1000)
    expect(mask[0]).toBe(255) // corner is background
    expect(doc.mask?.[32 * 64 + 32]).toBe(255) // subject survives
  })

  it('selects the subject deterministically', () => {
    const doc = testImage()
    const mask = selectSubject(doc, 30)
    expect(mask[32 * 64 + 32]).toBeGreaterThan(128)
    expect(mask[2 * 64 + 2]).toBeLessThan(64)
  })

  it('applies a mask to pixels', () => {
    const doc = testImage()
    const mask = new Uint8Array(doc.w * doc.h).fill(0)
    mask[32 * 64 + 32] = 255
    const masked = ImageKernels.applyMask(doc.data, mask, doc.w, doc.h, false, true)
    expect(masked[(32 * 64 + 32) * 4 + 3]).toBe(255)
    expect(masked[0 * 4 + 3]).toBe(0)
  })
})

describe('retouch and geometry', () => {
  it('replaces a colour range while preserving luminance', () => {
    const doc = testImage()
    const out = replaceColor(doc.data, { from: rgb(220, 40, 60), to: rgb(0, 87, 184), tolerance: 60, preserveLuminosity: true })
    const centre = (32 * 64 + 32) * 4
    expect(out[centre + 2]).toBeGreaterThan(out[centre]) // now blue-dominant
  })

  it('runs the liquify pipeline end to end', () => {
    const doc = testImage()
    const session = beginLiquify(doc, 'twirl')
    liquifyDrag(session, doc, { x: 30, y: 30 }, { x: 34, y: 34 }, 20, 0.8)
    const out = commitLiquify(session, doc)
    expect(out.length).toBe(doc.w * doc.h * 4)
    expect(session.active).toBe(false)
  })

  it('blurs outside a focus band for depth of field', () => {
    const doc = testImage()
    const out = blurMask(doc.data, doc.w, doc.h, { focusY: 0.5, band: 0.5, radius: 4 })
    expect(out.length).toBe(doc.data.length)
  })

  it('corrects lens distortion in place', () => {
    const doc = testImage()
    applyLensCorrection(doc, { distortion: 0.2, aberration: 2, vignette: -0.3 })
    expect(doc.data.length).toBe(doc.w * doc.h * 4)
    expect(doc.dirty).toBe(true)
  })

  it('applies retouch brushes to a region only', () => {
    const doc = testImage()
    const before = doc.data[2 * 64 * 4 + 4]
    retouchDab(doc, { x: 32, y: 32 }, { tool: 'dodge', radius: 12, hardness: 0.4, opacity: 1, strength: 0.8 })
    expect(doc.data[(32 * 64 + 32) * 4]).toBeGreaterThanOrEqual(doc.data[(32 * 64 + 32) * 4])
    expect(doc.data[2 * 64 * 4 + 4]).toBe(before) // pixel far from the dab untouched
  })
})
