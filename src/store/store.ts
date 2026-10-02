/**
 * Application store (Zustand).
 *
 * Holds the immutable document, the undo/redo stacks, selection, active tool,
 * dockers and view state. Actions are the only way to change the document, which
 * keeps history coherent and makes every mutation undoable by construction.
 */
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  BrushStroke, Document, Fill, ID, Layer, Page, RGBA, SceneObject, Stroke, TextStyle, ViewState, Effect, Adjustment,
} from '../types'
import type { ToolID } from '../tools/registry'
import { objectBounds } from '../engine/render'
import * as M from './mutations'
import { addColorStyle, createBitmap, createDocument, createGroup, createTextObject, createVector, documentColors, objectCount, updateObject, updatePage } from './mutations'
import { clamp, uid, rectUnion, type Vec } from '../lib/util'
import { rgb } from '../lib/color'
import { makeAdjustment, makeEffect } from '../engine/effects'
import { fonts } from '../lib/text'

export interface DockerState {
  object: boolean
  color: boolean
  layers: boolean
  pages: boolean
  effects: boolean
  adjustments: boolean
  masking: boolean
  retouch: boolean
  text: boolean
  brush: boolean
  history: boolean
  print: boolean
  shaping: boolean
  symbols: boolean
  comments: boolean
  collab: boolean
}

export type DockerID = keyof DockerState

export interface HistoryEntry { doc: Document; label: string }

export interface ToastMessage { id: string; kind: 'info' | 'success' | 'warn' | 'error'; text: string; detail?: string }

export interface AppState {
  /* document */
  doc: Document
  dirty: boolean
  fileHandle: FileSystemFileHandle | null
  history: HistoryEntry[]
  future: HistoryEntry[]

  /* selection & tools */
  tool: ToolID
  previousTool: ToolID
  selection: ID[]
  nodeSelection: { sub: number; index: number }[]
  activeLayerId: ID
  powerClip: ID | null
  editingTextId: ID | null
  fillColor: RGBA
  strokeColor: RGBA
  recentTools: ToolID[]
  lastBrush: BrushStroke | null
  clipboard: SceneObject[]

  /* view */
  view: ViewState
  dockers: DockerState
  theme: 'dark' | 'light'
  homeVisible: boolean
  toasts: ToastMessage[]
  statusMessage: string
  previewEffects: boolean
  /** Modal state for the export dialog and the print preview. */
  exportDialog: boolean
  printDialog: boolean
  installPrompt: unknown | null

  /* actions */
  setTool: (tool: ToolID) => void
  setFillColor: (color: RGBA) => void
  setStrokeColor: (color: RGBA) => void
  select: (ids: ID[], additive?: boolean) => void
  setSelection: (ids: ID[]) => void
  clearSelection: () => void
  setNodeSelection: (nodes: { sub: number; index: number }[]) => void
  setActiveLayer: (id: ID) => void
  setView: (patch: Partial<ViewState>) => void
  zoomTo: (zoom: number, focus?: Vec) => void
  setDocker: (id: DockerID, open?: boolean) => void
  toggleDocker: (id: DockerID) => void
  setTheme: (theme: 'dark' | 'light') => void
  setHome: (visible: boolean) => void
  toast: (kind: ToastMessage['kind'], text: string, detail?: string) => void
  dismissToast: (id: string) => void
  setStatus: (text: string) => void
  setPowerClip: (id: ID | null) => void
  setEditingText: (id: ID | null) => void
  setLastBrush: (brush: BrushStroke) => void
  setClipboard: (objects: SceneObject[]) => void
  setPreviewEffects: (on: boolean) => void
  setExportDialog: (open: boolean) => void
  setPrintDialog: (open: boolean) => void
  setInstallPrompt: (event: unknown | null) => void

  /* document commands */
  commit: (label: string, updater: (doc: Document) => Document, options?: { selection?: ID[] }) => void
  replaceDocument: (doc: Document, options?: { fileHandle?: FileSystemFileHandle | null; markClean?: boolean }) => void
  markSaved: (handle?: FileSystemFileHandle | null) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  gotoHistory: (index: number) => void

  /* helpers */
  activePage: () => Page
  activeLayer: () => Layer | undefined
  selectedObjects: () => SceneObject[]
  selectionBounds: () => { x: number; y: number; w: number; h: number } | null
  layerOf: (id: ID) => Layer | undefined
  addObjectsToActiveLayer: (objects: SceneObject[], label: string) => void
  addEffect: (kind: string, type: 'effect' | 'adjustment') => void
  deleteSelection: () => void
  duplicateSelection: () => void
  groupSelection: () => void
  ungroupSelection: () => void
  nudgeSelection: (dx: number, dy: number) => void
  alignSelection: (mode: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'hdistribute' | 'vdistribute') => void
  applyFillToSelection: (fill: Fill) => void
  applyStrokeToSelection: (patch: Partial<Stroke>) => void
  applyTextStyle: (patch: Partial<TextStyle>) => void
  addPage: () => void
  deletePage: (id: ID) => void
  duplicatePage: (id: ID) => void
  setActivePage: (id: ID) => void
  addGuide: (axis: 'x' | 'y', pos: number) => void
  toastThen: (kind: ToastMessage['kind'], text: string) => void
}

const HISTORY_LIMIT = 120

const initialDoc = createDocument()

export const useStore = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    doc: initialDoc,
    dirty: false,
    fileHandle: null,
    history: [],
    future: [],

    tool: 'pick',
    previousTool: 'pick',
    selection: [],
    nodeSelection: [],
    activeLayerId: initialDoc.pages[0].layers[0].id,
    powerClip: null,
    editingTextId: null,
    fillColor: rgb(18, 161, 154),
    strokeColor: rgb(24, 26, 30),
    recentTools: ['pick'],
    lastBrush: null,
    clipboard: [],

    view: {
      zoom: 1,
      panX: 60,
      panY: 60,
      showGrid: false,
      showGuides: true,
      showRulers: true,
      showPageShadow: true,
      wireframe: false,
    },
    dockers: {
      object: true, color: true, layers: true, pages: false, effects: false,
      adjustments: false, masking: false, retouch: false, text: false, brush: false,
      history: false, print: false, shaping: false, symbols: false,
      comments: false, collab: false,
    },
    theme: (typeof localStorage !== 'undefined' && (localStorage.getItem('corelbydre.theme') as 'dark' | 'light')) || 'dark',
    homeVisible: true,
    toasts: [],
    statusMessage: 'Ready',
    previewEffects: true,
    exportDialog: false,
    printDialog: false,
    installPrompt: null,

    /* ------------------------------------------------------------ actions -- */

    setTool: (tool) => set((s) => ({
      previousTool: s.tool,
      tool,
      recentTools: [tool, ...s.recentTools.filter((t) => t !== tool)].slice(0, 8),
      editingTextId: tool === 'text' ? s.editingTextId : null,
    })),

    setFillColor: (color) => {
      set({ fillColor: color })
      const { selection } = get()
      if (selection.length) get().applyFillToSelection({ type: 'uniform', color })
    },
    setStrokeColor: (color) => {
      set({ strokeColor: color })
      const { selection } = get()
      if (selection.length) get().applyStrokeToSelection({ color })
    },

    select: (ids, additive = false) => set((s) => ({
      selection: additive ? [...new Set([...s.selection, ...ids])] : ids,
      nodeSelection: [],
    })),
    setSelection: (ids) => set({ selection: ids, nodeSelection: [] }),
    clearSelection: () => set({ selection: [], nodeSelection: [] }),
    setNodeSelection: (nodeSelection) => set({ nodeSelection }),
    setActiveLayer: (activeLayerId) => set({ activeLayerId }),

    setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),
    zoomTo: (zoom, focus) => set((s) => {
      const next = clamp(zoom, 0.02, 64)
      if (!focus) return { view: { ...s.view, zoom: next } }
      const k = next / s.view.zoom
      return {
        view: {
          ...s.view,
          zoom: next,
          panX: focus.x - (focus.x - s.view.panX) * k,
          panY: focus.y - (focus.y - s.view.panY) * k,
        },
      }
    }),

    setDocker: (id, open = true) => set((s) => ({ dockers: { ...s.dockers, [id]: open } })),
    toggleDocker: (id) => set((s) => ({ dockers: { ...s.dockers, [id]: !s.dockers[id] } })),
    setTheme: (theme) => {
      try {
        localStorage.setItem('corelbydre.theme', theme)
      } catch { /* ignore */ }
      set({ theme })
    },
    setHome: (homeVisible) => set({ homeVisible }),
    toast: (kind, text, detail) => set((s) => ({ toasts: [...s.toasts, { id: uid('toast'), kind, text, detail }].slice(-4) })),
    toastThen: (kind, text) => set((s) => ({ toasts: [...s.toasts, { id: uid('toast'), kind, text }].slice(-4) })),
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setStatus: (statusMessage) => set({ statusMessage }),
    setPowerClip: (powerClip) => set({ powerClip }),
    setEditingText: (editingTextId) => set({ editingTextId }),
    setLastBrush: (lastBrush) => set({ lastBrush }),
    setClipboard: (clipboard) => set({ clipboard }),
    setPreviewEffects: (previewEffects) => set({ previewEffects }),
    setExportDialog: (exportDialog) => set({ exportDialog }),
    setPrintDialog: (printDialog) => set({ printDialog }),
    setInstallPrompt: (installPrompt) => set({ installPrompt }),

    commit: (label, updater, options) => set((s) => {
      const next = updater(s.doc)
      if (next === s.doc) return s
      const history = [...s.history, { doc: s.doc, label }].slice(-HISTORY_LIMIT)
      return {
        doc: next,
        history,
        future: [],
        dirty: true,
        selection: options?.selection ?? s.selection,
        nodeSelection: options?.selection ? [] : s.nodeSelection,
      }
    }),

    replaceDocument: (doc, options) => set((s) => ({
      doc,
      history: [],
      future: [],
      selection: [],
      nodeSelection: [],
      activeLayerId: doc.pages.find((p) => p.id === doc.activePageId)?.layers[0]?.id ?? '',
      fileHandle: options?.fileHandle ?? null,
      dirty: !options?.markClean,
      homeVisible: false,
      view: s.view,
    })),

    markSaved: (handle) => set((s) => ({ dirty: false, fileHandle: handle === undefined ? s.fileHandle : handle })),

    undo: () => set((s) => {
      const entry = s.history[s.history.length - 1]
      if (!entry) return s
      return {
        doc: entry.doc,
        history: s.history.slice(0, -1),
        future: [{ doc: s.doc, label: entry.label }, ...s.future].slice(0, HISTORY_LIMIT),
        dirty: true,
        selection: s.selection.filter((id) => findObjectIn(entry.doc, id)),
        nodeSelection: [],
      }
    }),

    redo: () => set((s) => {
      const entry = s.future[0]
      if (!entry) return s
      return {
        doc: entry.doc,
        history: [...s.history, { doc: s.doc, label: entry.label }].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        dirty: true,
      }
    }),

    canUndo: () => get().history.length > 0,
    canRedo: () => get().future.length > 0,

    gotoHistory: (index) => set((s) => {
      const target = clamp(index, 0, s.history.length)
      if (target === s.history.length) return s
      const current = s.doc
      const restored = s.history[target].doc
      const undone = s.history.slice(target)
      return {
        doc: restored,
        history: s.history.slice(0, target),
        future: [...undone.map((h, i) => (i === 0 ? { doc: current, label: h.label } : h)).reverse(), ...s.future].slice(0, HISTORY_LIMIT),
        dirty: true,
      }
    }),

    /* ------------------------------------------------------------ helpers -- */

    activePage: () => {
      const { doc } = get()
      return doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
    },
    activeLayer: () => {
      const page = get().activePage()
      return page.layers.find((l) => l.id === get().activeLayerId) ?? page.layers[0]
    },
    selectedObjects: () => {
      const { doc, selection } = get()
      const out: SceneObject[] = []
      for (const page of doc.pages) {
        for (const layer of page.layers) {
          for (const obj of layer.objects) {
            if (selection.includes(obj.id)) out.push(obj)
            if (obj.kind === 'group') {
              for (const child of obj.children) if (selection.includes(child.id)) out.push(child)
            }
          }
        }
      }
      return out
    },
    selectionBounds: () => {
      const page = get().activePage()
      const { doc, selection } = get()
      let rect: { x: number; y: number; w: number; h: number } | null = null
      const visit = (objs: SceneObject[]) => {
        for (const obj of objs) {
          if (selection.includes(obj.id)) rect = rectUnion(rect, boundsOf(obj, doc))
          if (obj.kind === 'group') visit(obj.children)
        }
      }
      for (const layer of page.layers) visit(layer.objects)
      return rect
    },
    layerOf: (id) => {
      for (const page of get().doc.pages) {
        for (const layer of page.layers) {
          if (layer.objects.some((o) => o.id === id)) return layer
        }
      }
      return undefined
    },

    addObjectsToActiveLayer: (objects, label) => {
      if (!objects.length) return
      const state = get()
      const page = state.activePage()
      const layer = state.activeLayer() ?? page.layers[0]
      state.commit(label, (doc) => M.addObjects(doc, page.id, layer.id, objects), { selection: objects.map((o) => o.id) })
    },

    addEffect: (kind, type) => {
      const state = get()
      const ids = state.selection
      if (!ids.length) {
        state.toast('warn', 'Select an object first')
        return
      }
      const effect: Effect | Adjustment = type === 'adjustment'
        ? makeAdjustment(kind as Adjustment['kind'], uid('adj'))
        : makeEffect(kind as Effect['kind'], uid('fx'))
      let doc = state.doc
      for (const id of ids) doc = M.addEffectTo(doc, id, effect)
      state.commit(`Add ${kind}`, () => doc)
      state.setDocker(type === 'adjustment' ? 'adjustments' : 'effects', true)
    },

    deleteSelection: () => {
      const state = get()
      if (!state.selection.length) return
      state.commit('Delete', (doc) => M.removeObjects(doc, state.selection).doc, { selection: [] })
    },

    duplicateSelection: () => {
      const state = get()
      const page = state.activePage()
      const layer = state.layerOf(state.selection[0])
      if (!layer) return
      const result = M.duplicateObjects(state.doc, page.id, layer.id, state.selection, state.doc.settings.duplicateOffset)
      state.commit('Duplicate', () => result.doc, { selection: result.newIds })
    },

    groupSelection: () => {
      const state = get()
      const page = state.activePage()
      const layer = state.layerOf(state.selection[0])
      if (!layer || state.selection.length < 2) {
        state.toast('info', 'Select two or more objects to group')
        return
      }
      const picked = layer.objects.filter((o) => state.selection.includes(o.id))
      if (picked.length < 2) return
      const index = layer.objects.findIndex((o) => o.id === picked[0].id)
      const group = createGroup(picked)
      let doc = M.removeObjects(state.doc, picked.map((o) => o.id)).doc
      doc = M.addObject(doc, page.id, layer.id, group, index)
      state.commit('Group', () => doc, { selection: [group.id] })
    },

    ungroupSelection: () => {
      const state = get()
      const page = state.activePage()
      const layer = state.layerOf(state.selection[0])
      if (!layer) return
      const groups = layer.objects.filter((o) => state.selection.includes(o.id) && o.kind === 'group')
      if (!groups.length) return
      let doc = state.doc
      const released: ID[] = []
      for (const group of groups) {
        const index = layer.objects.findIndex((o) => o.id === group.id)
        doc = M.removeObjects(doc, [group.id]).doc
        const children = (group as Extract<SceneObject, { kind: 'group' }>).children.map((c) => ({
          ...c,
          transform: {
            a: group.transform.a * c.transform.a + group.transform.c * c.transform.b,
            b: group.transform.b * c.transform.a + group.transform.d * c.transform.b,
            c: group.transform.a * c.transform.c + group.transform.c * c.transform.d,
            d: group.transform.b * c.transform.c + group.transform.d * c.transform.d,
            e: group.transform.a * c.transform.e + group.transform.c * c.transform.f + group.transform.e,
            f: group.transform.b * c.transform.e + group.transform.d * c.transform.f + group.transform.f,
          },
        }))
        doc = M.addObjects(doc, page.id, layer.id, children as SceneObject[], index)
        released.push(...children.map((c) => c.id))
      }
      state.commit('Ungroup', () => doc, { selection: released })
    },

    nudgeSelection: (dx, dy) => {
      const state = get()
      if (!state.selection.length) return
      state.commit('Nudge', (doc) => M.updateObjects(doc, state.selection, (o) => ({
        ...o,
        transform: { ...o.transform, e: o.transform.e + dx, f: o.transform.f + dy },
      })))
    },

    alignSelection: (mode) => {
      const state = get()
      const objects = state.selectedObjects()
      if (objects.length < 2) {
        state.toast('info', 'Select at least two objects')
        return
      }
      const bounds = state.selectionBounds()
      if (!bounds) return
      const items = objects.map((o) => ({ obj: o, b: boundsOf(o, state.doc)! })).filter((i) => i.b)
      const deltas = new Map<ID, { dx: number; dy: number }>()
      const sorted = [...items].sort((a, b) => a.b.x - b.b.x)
      const sortedY = [...items].sort((a, b) => a.b.y - b.b.y)
      switch (mode) {
        case 'left': items.forEach((i) => deltas.set(i.obj.id, { dx: bounds.x - i.b.x, dy: 0 })); break
        case 'right': items.forEach((i) => deltas.set(i.obj.id, { dx: bounds.x + bounds.w - (i.b.x + i.b.w), dy: 0 })); break
        case 'hcenter': items.forEach((i) => deltas.set(i.obj.id, { dx: bounds.x + bounds.w / 2 - (i.b.x + i.b.w / 2), dy: 0 })); break
        case 'top': items.forEach((i) => deltas.set(i.obj.id, { dx: 0, dy: bounds.y - i.b.y })); break
        case 'bottom': items.forEach((i) => deltas.set(i.obj.id, { dx: 0, dy: bounds.y + bounds.h - (i.b.y + i.b.h) })); break
        case 'vcenter': items.forEach((i) => deltas.set(i.obj.id, { dx: 0, dy: bounds.y + bounds.h / 2 - (i.b.y + i.b.h / 2) })); break
        case 'hdistribute': {
          const total = sorted.reduce((sum, i) => sum + i.b.w, 0)
          const gap = (bounds.w - total) / Math.max(1, sorted.length - 1)
          let cursor = bounds.x
          for (const i of sorted) {
            deltas.set(i.obj.id, { dx: cursor - i.b.x, dy: 0 })
            cursor += i.b.w + gap
          }
          break
        }
        case 'vdistribute': {
          const total = sortedY.reduce((sum, i) => sum + i.b.h, 0)
          const gap = (bounds.h - total) / Math.max(1, sortedY.length - 1)
          let cursor = bounds.y
          for (const i of sortedY) {
            deltas.set(i.obj.id, { dx: 0, dy: cursor - i.b.y })
            cursor += i.b.h + gap
          }
          break
        }
      }
      state.commit(`Align ${mode}`, (doc) => {
        let next = doc
        for (const [id, d] of deltas) {
          next = M.updateObject(next, id, (o) => ({ ...o, transform: { ...o.transform, e: o.transform.e + d.dx, f: o.transform.f + d.dy } }))
        }
        return next
      })
    },

    applyFillToSelection: (fill) => {
      const state = get()
      if (!state.selection.length) return
      state.commit('Apply fill', (doc) => M.updateObjects(doc, state.selection, (o) => (o.kind === 'vector' ? { ...o, fill } : o)))
    },

    applyStrokeToSelection: (patch) => {
      const state = get()
      if (!state.selection.length) return
      state.commit('Stroke', (doc) => M.updateObjects(doc, state.selection, (o) => {
        if (o.kind !== 'vector') return o
        const base: Stroke = o.stroke ?? {
          color: state.strokeColor, width: 1, cap: 'butt', join: 'miter', miterLimit: 10, behind: false,
        }
        return { ...o, stroke: { ...base, ...patch } }
      }))
    },

    applyTextStyle: (patch) => {
      const state = get()
      const textIds = state.selectedObjects().filter((o) => o.kind === 'text').map((o) => o.id)
      if (!textIds.length) return
      state.commit('Text style', (doc) => {
        let next = doc
        for (const id of textIds) {
          next = M.updateObject(next, id, (o) => (o.kind === 'text' ? { ...o, style: { ...o.style, ...patch } } : o))
        }
        return next
      })
      if (patch.fontFamily) void fonts.load(patch.fontFamily)
    },

    addPage: () => {
      const state = get()
      state.commit('Add page', (doc) => M.addPage(doc, doc.activePageId))
      const page = get().activePage()
      set({ activeLayerId: page.layers[0].id, selection: [] })
      state.toast('success', 'Page added')
    },

    deletePage: (id) => {
      const state = get()
      if (state.doc.pages.length <= 1) {
        state.toast('warn', 'A document needs at least one page')
        return
      }
      state.commit('Delete page', (doc) => M.deletePage(doc, id))
      const page = get().activePage()
      set({ activeLayerId: page.layers[0].id, selection: [] })
    },

    duplicatePage: (id) => {
      const state = get()
      state.commit('Duplicate page', (doc) => M.duplicatePage(doc, id))
      const page = get().activePage()
      set({ activeLayerId: page.layers[0].id, selection: [] })
    },

    setActivePage: (id) => {
      const state = get()
      state.commit('Switch page', (doc) => M.setActivePage(doc, id), { selection: [] })
      const page = get().doc.pages.find((p) => p.id === id)
      if (page) set({ activeLayerId: page.layers[0].id, selection: [] })
    },

    addGuide: (axis, pos) => {
      const state = get()
      const page = state.activePage()
      state.commit('Add guide', (doc) => M.addGuide(doc, page.id, axis, pos))
    },
  })),
)

function findObjectIn(doc: Document, id: ID): SceneObject | null {
  const visit = (objs: SceneObject[]): SceneObject | null => {
    for (const o of objs) {
      if (o.id === id) return o
      if (o.kind === 'group') {
        const f = visit(o.children)
        if (f) return f
      }
    }
    return null
  }
  for (const page of doc.pages) for (const layer of page.layers) {
    const f = visit(layer.objects)
    if (f) return f
  }
  return null
}

function boundsOf(obj: SceneObject, doc: Document) {
  return objectBounds(obj, doc)
}

export { documentColors, objectCount, createBitmap, createDocument, createTextObject, createVector, addColorStyle, updateObject, updatePage }
