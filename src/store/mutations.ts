/**
 * Immutable document mutations.
 *
 * Every helper clones only the nodes along the changed path, so untouched objects
 * keep their identity. That gives us three things at once:
 *   - undo/redo is a stack of document references (no deep copies),
 *   - the renderer's WeakMap caches stay warm for unchanged objects,
 *   - React re-renders only the components whose slices actually changed.
 */
import type {
  BitmapObject, Document, DocumentSettings, Fill, GroupObject, ID, Layer, LayerKind, Page, PathData, Primitive,
  SceneObject, Stroke, TextObject, VectorObject, ColorStyle, RGBA, NonDestructive, Guide,
} from '../types'
import { uid, rectCenter, node as mkNode, pathFromSubpaths, subPath } from '../lib/util'
import { rgb } from '../lib/color'

/* ------------------------------------------------------------ factories ---- */

export function defaultSettings(): DocumentSettings {
  return {
    gridStep: 10,
    snapToGrid: false,
    snapToObjects: true,
    snapToGuides: true,
    dynamicGuides: true,
    selfSnapping: true,
    snapTolerance: 8,
    showRulers: true,
    displayUnit: 'pt',
    nudgeStep: 1,
    duplicateOffset: 12,
    vectorSmoothing: 0.55,
    liveSketch: false,
    colorMode: 'RGB',
    renderingIntent: 'perceptual',
    proofing: false,
  }
}

export const PAGE_PRESETS: { id: string; label: string; w: number; h: number; unit: DocumentSettings['displayUnit'] }[] = [
  { id: 'a4', label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89, unit: 'mm' },
  { id: 'a3', label: 'A3 (297 × 420 mm)', w: 841.89, h: 1190.55, unit: 'mm' },
  { id: 'a5', label: 'A5 (148 × 210 mm)', w: 419.53, h: 595.28, unit: 'mm' },
  { id: 'letter', label: 'Letter (8.5 × 11 in)', w: 612, h: 792, unit: 'in' },
  { id: 'legal', label: 'Legal (8.5 × 14 in)', w: 612, h: 1008, unit: 'in' },
  { id: 'tabloid', label: 'Tabloid (11 × 17 in)', w: 792, h: 1224, unit: 'in' },
  { id: 'business-card', label: 'Business card (85 × 55 mm)', w: 241, h: 156, unit: 'mm' },
  { id: 'poster', label: 'Poster (18 × 24 in)', w: 1296, h: 1728, unit: 'in' },
  { id: 'social-square', label: 'Social square (1080 × 1080 px)', w: 810, h: 810, unit: 'px' },
  { id: 'social-story', label: 'Story (1080 × 1920 px)', w: 810, h: 1440, unit: 'px' },
  { id: 'web-hero', label: 'Web hero (1920 × 1080 px)', w: 1440, h: 810, unit: 'px' },
  { id: 'presentation', label: 'Presentation (16:9, 1920 px)', w: 1440, h: 810, unit: 'px' },
]

export function createLayer(name: string, kind: LayerKind = 'normal'): Layer {
  return {
    id: uid('layer'),
    name,
    kind,
    visible: true,
    locked: false,
    printable: true,
    objects: [],
    opacity: 1,
    blend: 'normal',
  }
}

export function createPage(name: string, w: number, h: number, unit: Page['size']['unit'] = 'mm'): Page {
  return {
    id: uid('page'),
    name,
    size: { w, h, unit, name: `${Math.round(w)} × ${Math.round(h)}` },
    bleed: 0,
    orientation: w > h ? 'landscape' : 'portrait',
    background: rgb(255, 255, 255),
    layers: [createLayer('Layer 1')],
    guides: [],
    masters: [],
  }
}

export function createDocument(name = 'Untitled-1', preset?: typeof PAGE_PRESETS[number]): Document {
  const p = preset ?? PAGE_PRESETS[0]
  const page = createPage('Page 1', p.w, p.h, p.unit)
  return {
    id: uid('doc'),
    name,
    version: 1,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    pages: [page],
    activePageId: page.id,
    colorStyles: [],
    palette: { id: 'default-rgb', name: 'Default RGB palette' },
    settings: defaultSettings(),
    embeddedFonts: [],
    meta: { author: '', title: name, subject: '', keywords: '' },
  }
}

export function createVector(overrides: Partial<VectorObject> & { path: PathData; primitive?: Primitive }): VectorObject {
  return {
    id: uid('obj'),
    name: overrides.name ?? 'Curve',
    kind: 'vector',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    opacity: 1,
    blend: 'normal',
    locked: false,
    visible: true,
    printable: true,
    effects: [],
    primitive: overrides.primitive ?? { type: 'freehand' },
    fill: overrides.fill ?? { type: 'uniform', color: rgb(200, 205, 212) },
    stroke: overrides.stroke === undefined ? null : overrides.stroke,
    ...overrides,
    path: overrides.path,
  }
}

export function createTextObject(mode: 'artistic' | 'paragraph', content: string, frame: { x: number; y: number; w: number; h: number }): TextObject {
  return {
    id: uid('txt'),
    name: mode === 'artistic' ? 'Artistic text' : 'Paragraph text',
    kind: 'text',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    opacity: 1,
    blend: 'normal',
    locked: false,
    visible: true,
    printable: true,
    effects: [],
    mode,
    content,
    style: {
      fontFamily: 'Helvetica',
      fontSize: mode === 'artistic' ? 36 : 14,
      fontWeight: 400,
      fontStyle: 'normal',
      variableAxes: {},
      letterSpacing: 0,
      wordSpacing: 0,
      lineHeight: 1.25,
      align: 'left',
      color: rgb(24, 26, 30),
      outline: null,
      openType: { kern: true, liga: true, calt: true },
      superSub: 'none',
      caps: 'none',
      bullet: 'none',
      bulletIndent: 14,
      bulletChar: '•',
      dropCap: 0,
      paragraphSpacing: 6,
      indents: { left: 0, right: 0, first: 0 },
      tabStops: [],
      hyphenate: false,
    },
    frame,
    onPathOffset: 0,
    onPathSide: 'above',
    wrapAround: [],
    wrapOffset: 8,
    columns: 1,
    columnGutter: 18,
    fitToFrame: false,
  }
}

export function createBitmap(dataUrl: string, width: number, height: number, rect: { x: number; y: number; w: number; h: number }): BitmapObject {
  return {
    id: uid('bmp'),
    name: 'Bitmap',
    kind: 'bitmap',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    opacity: 1,
    blend: 'normal',
    locked: false,
    visible: true,
    printable: true,
    effects: [],
    dataUrl,
    width,
    height,
    rect,
    hasAlpha: true,
  }
}

export function createGroup(children: SceneObject[]): GroupObject {
  return {
    id: uid('grp'),
    name: 'Group',
    kind: 'group',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    opacity: 1,
    blend: 'normal',
    locked: false,
    visible: true,
    printable: true,
    effects: [],
    children,
  }
}

/* ------------------------------------------------------- path helpers ------ */

export function rectPathData(x: number, y: number, w: number, h: number): PathData {
  return pathFromSubpaths([
    subPath([mkNode(x, y), mkNode(x + w, y), mkNode(x + w, y + h), mkNode(x, y + h)], true),
  ])
}

/* --------------------------------------------------- immutable traversal --- */

function mapPage(doc: Document, pageId: ID, fn: (page: Page) => Page): Document {
  return { ...doc, pages: doc.pages.map((p) => (p.id === pageId ? fn(p) : p)), modifiedAt: Date.now() }
}

export function updatePage(doc: Document, pageId: ID, fn: (page: Page) => Page): Document {
  return mapPage(doc, pageId, fn)
}

export function updateLayer(doc: Document, pageId: ID, layerId: ID, fn: (layer: Layer) => Layer): Document {
  return mapPage(doc, pageId, (page) => ({ ...page, layers: page.layers.map((l) => (l.id === layerId ? fn(l) : l)) }))
}

function mapObjects(objects: SceneObject[], id: ID, fn: (o: SceneObject) => SceneObject): SceneObject[] {
  let changed = false
  const next = objects.map((o) => {
    if (o.id === id) {
      changed = true
      return fn(o)
    }
    if (o.kind === 'group') {
      const children = mapObjects(o.children, id, fn)
      if (children !== o.children) {
        changed = true
        return { ...o, children }
      }
    }
    return o
  })
  return changed ? next : objects
}

/** Apply a function to one object anywhere in the document. */
export function updateObject(doc: Document, id: ID, fn: (o: SceneObject) => SceneObject): Document {
  return {
    ...doc,
    modifiedAt: Date.now(),
    pages: doc.pages.map((page) => {
      let touched = false
      const layers = page.layers.map((layer) => {
        const objects = mapObjects(layer.objects, id, fn)
        if (objects !== layer.objects) {
          touched = true
          return { ...layer, objects }
        }
        return layer
      })
      return touched ? { ...page, layers } : page
    }),
  }
}

export function updateObjects(doc: Document, ids: ID[], fn: (o: SceneObject) => SceneObject): Document {
  let next = doc
  for (const id of ids) next = updateObject(next, id, fn)
  return next
}

export function addObject(doc: Document, pageId: ID, layerId: ID, object: SceneObject, index?: number): Document {
  return updateLayer(doc, pageId, layerId, (layer) => {
    const objects = [...layer.objects]
    if (index === undefined || index < 0 || index >= objects.length) objects.push(object)
    else objects.splice(index, 0, object)
    return { ...layer, objects }
  })
}

export function addObjects(doc: Document, pageId: ID, layerId: ID, objects: SceneObject[], index?: number): Document {
  return updateLayer(doc, pageId, layerId, (layer) => {
    const next = [...layer.objects]
    if (index === undefined || index < 0 || index >= next.length) next.push(...objects)
    else next.splice(index, 0, ...objects)
    return { ...layer, objects: next }
  })
}

export function removeObjects(doc: Document, ids: ID[]): { doc: Document; removed: { object: SceneObject; pageId: ID; layerId: ID; index: number }[] } {
  const removed: { object: SceneObject; pageId: ID; layerId: ID; index: number }[] = []
  const set = new Set(ids)
  const pages = doc.pages.map((page) => ({
    ...page,
    layers: page.layers.map((layer) => {
      const objects: SceneObject[] = []
      layer.objects.forEach((o, index) => {
        if (set.has(o.id)) {
          removed.push({ object: o, pageId: page.id, layerId: layer.id, index })
          return
        }
        if (o.kind === 'group') {
          const children = o.children.filter((c) => !set.has(c.id))
          if (children.length !== o.children.length) {
            o.children.forEach((c, ci) => {
              if (set.has(c.id)) removed.push({ object: c, pageId: page.id, layerId: layer.id, index: ci })
            })
            objects.push({ ...o, children })
            return
          }
        }
        objects.push(o)
      })
      return { ...layer, objects }
    }),
  }))
  return { doc: { ...doc, pages, modifiedAt: Date.now() }, removed }
}

export function reorderObject(doc: Document, pageId: ID, layerId: ID, id: ID, targetIndex: number): Document {
  return updateLayer(doc, pageId, layerId, (layer) => {
    const index = layer.objects.findIndex((o) => o.id === id)
    if (index < 0) return layer
    const objects = [...layer.objects]
    const [obj] = objects.splice(index, 1)
    const clamped = Math.max(0, Math.min(objects.length, targetIndex))
    objects.splice(clamped, 0, obj)
    return { ...layer, objects }
  })
}

export function moveObjectToLayer(doc: Document, fromPage: ID, fromLayer: ID, toPage: ID, toLayer: ID, id: ID): Document {
  let moving: SceneObject | null = null
  let next = updateLayer(doc, fromPage, fromLayer, (layer) => {
    moving = layer.objects.find((o) => o.id === id) ?? null
    return { ...layer, objects: layer.objects.filter((o) => o.id !== id) }
  })
  if (moving) next = addObject(next, toPage, toLayer, moving)
  return next
}

export function duplicateObjects(doc: Document, pageId: ID, layerId: ID, ids: ID[], offset: number): { doc: Document; newIds: ID[] } {
  const page = doc.pages.find((p) => p.id === pageId)
  if (!page) return { doc, newIds: [] }
  const layer = page.layers.find((l) => l.id === layerId)
  if (!layer) return { doc, newIds: [] }
  const clones: SceneObject[] = []
  const newIds: ID[] = []
  for (const id of ids) {
    const source = layer.objects.find((o) => o.id === id)
    if (!source) continue
    const clone = cloneObject(source, offset)
    clones.push(clone)
    newIds.push(clone.id)
  }
  if (!clones.length) return { doc, newIds: [] }
  return { doc: addObjects(doc, pageId, layerId, clones), newIds }
}

export function cloneObject(obj: SceneObject, offset = 0, freshIds = true): SceneObject {
  const id = freshIds ? uid(obj.kind === 'group' ? 'grp' : obj.kind.slice(0, 3)) : obj.id
  const base = {
    ...obj,
    id,
    transform: { ...obj.transform, e: obj.transform.e + offset, f: obj.transform.f + offset },
    effects: obj.effects.map((e) => ({ ...e, id: uid('fx'), params: JSON.parse(JSON.stringify(e.params)) })),
    blockShadow: obj.blockShadow ? { ...obj.blockShadow } : undefined,
    clip: obj.clip ? { ...obj.clip } : undefined,
  }
  if (obj.kind === 'group') {
    const children = obj.children.map((c) => cloneObject(c, offset, freshIds))
    return { ...(base as GroupObject), children }
  }
  if (obj.kind === 'vector') {
    return { ...(base as VectorObject), path: { ...obj.path, subpaths: obj.path.subpaths.map((sp) => ({ ...sp, nodes: sp.nodes.map((n) => ({ ...n })) })) } }
  }
  if (obj.kind === 'text') {
    return { ...(base as TextObject), style: { ...obj.style, variableAxes: { ...obj.style.variableAxes }, openType: { ...obj.style.openType } } }
  }
  return base as BitmapObject
}

/* --------------------------------------------------------- page & layer ---- */

export function addPage(doc: Document, afterId?: ID): Document {
  const template = doc.pages.find((p) => p.id === afterId) ?? doc.pages[doc.pages.length - 1]
  const page = createPage(`Page ${doc.pages.length + 1}`, template.size.w, template.size.h, template.size.unit)
  page.bleed = template.bleed
  page.background = template.background
  page.masters = [...template.masters]
  const index = afterId ? doc.pages.findIndex((p) => p.id === afterId) + 1 : doc.pages.length
  const pages = [...doc.pages]
  pages.splice(index, 0, page)
  return { ...doc, pages, activePageId: page.id, modifiedAt: Date.now() }
}

export function deletePage(doc: Document, pageId: ID): Document {
  if (doc.pages.length <= 1) return doc
  const pages = doc.pages.filter((p) => p.id !== pageId)
  const activePageId = doc.activePageId === pageId ? pages[Math.max(0, pages.length - 1)].id : doc.activePageId
  return { ...doc, pages, activePageId, modifiedAt: Date.now() }
}

export function duplicatePage(doc: Document, pageId: ID): Document {
  const index = doc.pages.findIndex((p) => p.id === pageId)
  if (index < 0) return doc
  const source = doc.pages[index]
  const clone: Page = {
    ...source,
    id: uid('page'),
    name: `${source.name} copy`,
    layers: source.layers.map((l) => ({
      ...l,
      id: uid('layer'),
      objects: l.objects.map((o) => cloneObject(o, 0, true)),
    })),
    guides: source.guides.map((g) => ({ ...g, id: uid('guide') })),
  }
  const pages = [...doc.pages]
  pages.splice(index + 1, 0, clone)
  return { ...doc, pages, activePageId: clone.id, modifiedAt: Date.now() }
}

export function addMasterLayer(doc: Document, name: string): Document {
  const layers = doc.pages.map((page) => {
    if (page.masters.length) return page
    const master = createLayer(name, 'master')
    return { ...page, layers: [master, ...page.layers], masters: [master.id] }
  })
  return { ...doc, pages: layers, modifiedAt: Date.now() }
}

/* -------------------------------------------------------------- guides ----- */

export function addGuide(doc: Document, pageId: ID, axis: 'x' | 'y', pos: number): Document {
  return updatePage(doc, pageId, (page) => ({
    ...page,
    guides: [...page.guides, { id: uid('guide'), axis, pos, locked: false, color: { r: 0, g: 150, b: 220, a: 1 } } as Guide],
  }))
}

export function setGuides(doc: Document, pageId: ID, guides: Guide[]): Document {
  return updatePage(doc, pageId, (page) => ({ ...page, guides }))
}

/* ------------------------------------------------------------- styles ------ */

export function addColorStyle(doc: Document, style: Omit<ColorStyle, 'id'>): Document {
  return { ...doc, colorStyles: [...doc.colorStyles, { ...style, id: uid('style') }], modifiedAt: Date.now() }
}

export function updateColorStyle(doc: Document, id: ID, patch: Partial<ColorStyle>): Document {
  return { ...doc, colorStyles: doc.colorStyles.map((s) => (s.id === id ? { ...s, ...patch } : s)), modifiedAt: Date.now() }
}

export function removeColorStyle(doc: Document, id: ID): Document {
  return { ...doc, colorStyles: doc.colorStyles.filter((s) => s.id !== id), modifiedAt: Date.now() }
}

/* ------------------------------------------------------------ effects ------ */

export function addEffectTo(doc: Document, id: ID, effect: NonDestructive): Document {
  return updateObject(doc, id, (o) => ({ ...o, effects: [...o.effects, effect] }))
}

export function updateEffectIn(doc: Document, id: ID, effectId: ID, patch: Partial<NonDestructive>): Document {
  return updateObject(doc, id, (o) => ({
    ...o,
    effects: o.effects.map((e) => (e.id === effectId ? ({ ...e, ...patch } as NonDestructive) : e)),
  }))
}

export function setEffectParam(doc: Document, id: ID, effectId: ID, key: string, value: unknown): Document {
  return updateObject(doc, id, (o) => ({
    ...o,
    effects: o.effects.map((e) => (e.id === effectId ? ({ ...e, params: { ...e.params, [key]: value } } as NonDestructive) : e)),
  }))
}

export function removeEffectFrom(doc: Document, id: ID, effectId: ID): Document {
  return updateObject(doc, id, (o) => ({ ...o, effects: o.effects.filter((e) => e.id !== effectId) }))
}

export function reorderEffect(doc: Document, id: ID, effectId: ID, delta: number): Document {
  return updateObject(doc, id, (o) => {
    const index = o.effects.findIndex((e) => e.id === effectId)
    if (index < 0) return o
    const effects = [...o.effects]
    const [item] = effects.splice(index, 1)
    effects.splice(Math.max(0, Math.min(effects.length, index + delta)), 0, item)
    return { ...o, effects }
  })
}

/* --------------------------------------------------------------- misc ------ */

export function setFill(doc: Document, id: ID, fill: Fill): Document {
  return updateObject(doc, id, (o) => (o.kind === 'vector' ? { ...o, fill } : o))
}
export function setStroke(doc: Document, id: ID, stroke: Stroke | null): Document {
  return updateObject(doc, id, (o) => (o.kind === 'vector' ? { ...o, stroke } : o))
}
export function setPath(doc: Document, id: ID, path: PathData): Document {
  return updateObject(doc, id, (o) => (o.kind === 'vector' ? { ...o, path } : o))
}
export function setPrimitive(doc: Document, id: ID, primitive: Primitive, path: PathData): Document {
  return updateObject(doc, id, (o) => (o.kind === 'vector' ? { ...o, primitive, path } : o))
}
export function transformObject(doc: Document, id: ID, matrix: Parameters<typeof rectCenter> extends never ? never : { a: number; b: number; c: number; d: number; e: number; f: number }): Document {
  return updateObject(doc, id, (o) => ({ ...o, transform: matrix }))
}
export function patchObject(doc: Document, id: ID, patch: Partial<SceneObject>): Document {
  return updateObject(doc, id, (o) => ({ ...o, ...patch } as SceneObject))
}
export function setDocumentSettings(doc: Document, patch: Partial<DocumentSettings>): Document {
  return { ...doc, settings: { ...doc.settings, ...patch }, modifiedAt: Date.now() }
}
export function setPageSize(doc: Document, pageId: ID, w: number, h: number, unit: Page['size']['unit']): Document {
  return updatePage(doc, pageId, (page) => ({
    ...page,
    size: { w, h, unit },
    orientation: w > h ? 'landscape' : 'portrait',
  }))
}
export function renameDocument(doc: Document, name: string): Document {
  return { ...doc, name, meta: { ...doc.meta, title: name }, modifiedAt: Date.now() }
}
export function setActivePage(doc: Document, pageId: ID): Document {
  return { ...doc, activePageId: pageId }
}

/** Colors used anywhere in the document → drives the document palette. */
export function documentColors(doc: Document): RGBA[] {
  const out: RGBA[] = []
  const seen = new Set<string>()
  const push = (c: RGBA | undefined) => {
    if (!c) return
    const key = `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Math.round(c.a * 100)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }
  const visit = (obj: SceneObject) => {
    if (obj.kind === 'vector') {
      const fill = obj.fill
      if (fill.type === 'uniform') push(fill.color)
      else if (fill.type === 'fountain') fill.stops.forEach((s) => push(s.color))
      else if (fill.type === 'mesh') fill.nodes.forEach((n) => push(n.color))
      else if ('fg' in fill) {
        push(fill.fg)
        push(fill.bg)
      }
      if (obj.stroke) push(obj.stroke.color)
      if (obj.brush) push(obj.brush.color)
    } else if (obj.kind === 'text') {
      push(obj.style.color)
      if (obj.style.outline) push(obj.style.outline.color)
    } else if (obj.kind === 'group') {
      obj.children.forEach(visit)
    }
  }
  for (const page of doc.pages) for (const layer of page.layers) layer.objects.forEach(visit)
  return out
}

export function objectCount(doc: Document): number {
  let n = 0
  const visit = (objs: SceneObject[]) => {
    for (const o of objs) {
      n++
      if (o.kind === 'group') visit(o.children)
    }
  }
  for (const page of doc.pages) for (const layer of page.layers) visit(layer.objects)
  return n
}
