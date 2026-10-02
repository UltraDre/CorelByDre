/**
 * Canvas stage.
 *
 * Rendering strategy (60 fps with thousands of objects):
 * • Artwork is drawn with the shared `renderPageInto` pipeline, which culls to
 *   the viewport and reuses cached per-object geometry.
 * • The interactive layer (selection, handles, guides, marquee, node editing,
 *   remote cursors, brush/photo rings) is a second canvas repainted on pointer
 *   moves while the artwork layer only repaints when document or view change.
 * • Drag state lives in refs; pointer moves schedule one requestAnimationFrame
 *   repaint instead of re-rendering React, so dragging never thrashes the tree.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/store'
import { useCollab } from '../store/collab'
import { useToolOptions } from './toolOptions'
import { TextEditor } from './TextEditor'
import { Icon } from './icons'
import { hitTest, objectBounds, objectOutline, objectsInRect, onBitmapReady, renderPageInto, selectionBounds } from '../engine/render'
import {
  ENVELOPE_PRESETS,
  applyEnvelope,
  breakApart,
  deleteNode,
  distortNodes,
  dragHandle,
  ellipsePath,
  envelopePreset,
  graphPaperPath,
  homographyFromQuad,
  insertNode,
  moveNode,
  polygonPath,
  rectPath,
  refineCurve,
  spiralPath,
  starPath,
  threePointEllipse,
  threePointRect,
  variableOutline,
} from '../engine/shapes'
import { makeStrokePoints, presetByID } from '../engine/brush'
import { createTextObject, createVector, updateObjects } from '../store/mutations'
import { css, parseHex } from '../lib/color'
import { clamp, makeSmoothNode, matMul, matRotate, matScale, matTranslate, node, pathFromSubpaths, rectFromPoints, subPath, vDist, type Vec } from '../lib/util'
import {
  DEFAULT_BG_REMOVAL,
  DEFAULT_COLOR_REPLACE,
  beginLiquify,
  cloneStamp,
  commitLiquify,
  correctPerspective,
  liquifyDrag,
  paintMask,
  removeBackground,
  replaceColor,
  retouchDab,
  selectSubject,
  selectionFromMask,
  type LiquifySession,
  type PhotoDocument,
  type Selection,
} from '../lib/photo'
import { bakeSession, findBitmap, openSession, peekSession } from './photoSession'
import type { BitmapObject, BrushStroke, Document, Fill, Matrix, Page, PathData, PathNode, SceneObject, Stroke, VectorObject, ViewState } from '../types'

const RULER = 20
const HANDLE = 7

type Drag =
  | { kind: 'pan'; start: Vec; pan: Vec }
  | { kind: 'marquee'; start: Vec; current: Vec; additive: boolean; lasso: boolean; points: Vec[] }
  | { kind: 'move'; start: Vec; current: Vec; origins: { id: string; transform: Matrix }[] }
  | { kind: 'scale'; handle: string; start: Vec; bounds: { x: number; y: number; w: number; h: number }; origins: { id: string; transform: Matrix }[] }
  | { kind: 'rotate'; centre: Vec; startAngle: number; origins: { id: string; transform: Matrix }[] }
  | { kind: 'create'; start: Vec; current: Vec; shift: boolean }
  | { kind: 'draw'; points: Vec[]; pressures: number[] }
  | { kind: 'pen-handle'; index: number }
  | { kind: 'node'; sub: number; index: number; which: 'node' | 'in' | 'out' }
  | { kind: 'zoom-rect'; start: Vec; current: Vec }
  | { kind: 'distort'; last: Vec; current: Vec }
  | { kind: 'photo'; last: Vec; current: Vec; first: Vec }

interface PenDraft { objectId: string; dragIndex: number; smooth: boolean }

export function CanvasView() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const artworkRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 900, h: 600 })
  const [panning, setPanning] = useState(false)

  const doc = useStore((s) => s.doc)
  const view = useStore((s) => s.view)
  const tool = useStore((s) => s.tool)
  const selection = useStore((s) => s.selection)
  const nodeSelection = useStore((s) => s.nodeSelection)
  const previewEffects = useStore((s) => s.previewEffects)
  const editingTextId = useStore((s) => s.editingTextId)
  const options = useToolOptions()
  const peers = useCollab((s) => s.peers)
  const actor = useCollab((s) => s.actor)

  const page = useMemo(() => doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0], [doc])

  const dragRef = useRef<Drag | null>(null)
  const penRef = useRef<PenDraft | null>(null)
  const liquifyRef = useRef<LiquifySession | null>(null)
  const maskRef = useRef<{ bitmapId: string; mode: 'paint' | 'erase' } | null>(null)
  const spaceRef = useRef(false)
  const cursorRef = useRef<Vec>({ x: 0, y: 0 })
  const snapRef = useRef<{ v: number[]; h: number[]; points: Vec[] }>({ v: [], h: [], points: [] })
  const frameRef = useRef(0)
  const lastPresenceRef = useRef(0)

  const stateRef = useRef({ doc, page, view, tool, selection, nodeSelection, options, previewEffects, peers, actor, editingTextId })
  stateRef.current = { doc, page, view, tool, selection, nodeSelection, options, previewEffects, peers, actor, editingTextId }

  /* --------------------------------------------------------------- sizing -- */

  useLayoutEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setSize({ w: Math.max(120, Math.round(rect.width) - RULER), h: Math.max(120, Math.round(rect.height) - RULER) })
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  /* -------------------------------------------------------------- drawing -- */

  const screenToDoc = useCallback((x: number, y: number): Vec => {
    const v = stateRef.current.view
    return { x: (x - v.panX) / v.zoom, y: (y - v.panY) / v.zoom }
  }, [])

  const scheduleDraw = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      draw()
    })
  }, [])

  const draw = useCallback(() => {
    const artwork = artworkRef.current
    const overlay = overlayRef.current
    if (!artwork || !overlay) return
    const s = stateRef.current
    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
    const w = size.w
    const h = size.h
    for (const canvas of [artwork, overlay]) {
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
    }
    const ctx = artwork.getContext('2d')
    const octx = overlay.getContext('2d')
    if (!ctx || !octx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    octx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    octx.clearRect(0, 0, w, h)

    const { doc: d, page: pg, view: v } = s
    const zoom = v.zoom
    const panX = v.panX
    const panY = v.panY

    ctx.fillStyle = '#1d2126'
    ctx.fillRect(0, 0, w, h)
    if (v.showPageShadow) {
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.45)'
      ctx.shadowBlur = 24 * Math.min(2, zoom)
      ctx.shadowOffsetY = 6
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(panX, panY, pg.size.w * zoom, pg.size.h * zoom)
      ctx.restore()
    }

    ctx.save()
    ctx.translate(panX, panY)
    ctx.scale(zoom, zoom)
    ctx.fillStyle = css(pg.background)
    ctx.fillRect(0, 0, pg.size.w, pg.size.h)
    if (v.showGrid) {
      const step = d.settings.gridStep || 10
      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1 / zoom
      ctx.beginPath()
      for (let x = 0; x <= pg.size.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, pg.size.h) }
      for (let y = 0; y <= pg.size.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(pg.size.w, y) }
      ctx.stroke()
      ctx.restore()
    }
    renderPageInto(ctx, {
      doc: d,
      page: pg,
      scale: zoom,
      offsetX: panX,
      offsetY: panY,
      viewport: { x: 0, y: 0, w, h },
      quality: zoom > 2 ? 'high' : zoom > 0.6 ? 'normal' : 'draft',
      wireframe: v.wireframe,
      effects: s.previewEffects,
    })
    if (v.showGuides) {
      ctx.save()
      ctx.strokeStyle = '#39c7ff'
      ctx.lineWidth = 1 / zoom
      ctx.setLineDash([6 / zoom, 4 / zoom])
      ctx.beginPath()
      for (const guide of pg.guides) {
        if (guide.axis === 'x') { ctx.moveTo(guide.pos, 0); ctx.lineTo(guide.pos, pg.size.h) }
        else { ctx.moveTo(0, guide.pos); ctx.lineTo(pg.size.w, guide.pos) }
      }
      ctx.stroke()
      ctx.restore()
    }
    ctx.restore()

    /* ------------------------------------------------------------ overlay -- */

    const toScreen = (p: Vec) => ({ x: p.x * zoom + panX, y: p.y * zoom + panY })
    const drag = dragRef.current

    const selected = s.selection.length ? collectObjects(d, s.selection) : []
    if (selected.length) {
      octx.save()
      octx.strokeStyle = '#12a19a'
      octx.lineWidth = 1
      for (const object of selected) {
        for (const sub of objectOutline(object, d)) {
          octx.beginPath()
          sub.forEach((point, index) => {
            const screen = toScreen(point)
            if (index === 0) octx.moveTo(screen.x, screen.y)
            else octx.lineTo(screen.x, screen.y)
          })
          octx.stroke()
        }
      }
      const bounds = selectionBounds(selected, d)
      if (bounds && s.tool !== 'shape') {
        const a = toScreen(bounds)
        const b = toScreen({ x: bounds.x + bounds.w, y: bounds.y + bounds.h })
        octx.strokeStyle = 'rgba(18,161,154,0.9)'
        octx.setLineDash([4, 3])
        octx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
        octx.setLineDash([])
        for (const handle of handlePoints(bounds)) {
          const p = toScreen(handle.p)
          octx.fillStyle = '#ffffff'
          octx.strokeStyle = '#12a19a'
          octx.beginPath()
          octx.rect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE)
          octx.fill()
          octx.stroke()
        }
        const rc = toScreen({ x: bounds.x + bounds.w / 2, y: bounds.y })
        octx.beginPath()
        octx.moveTo(rc.x, rc.y)
        octx.lineTo(rc.x, rc.y - 26)
        octx.strokeStyle = '#12a19a'
        octx.stroke()
        octx.beginPath()
        octx.arc(rc.x, rc.y - 30, 5, 0, Math.PI * 2)
        octx.fillStyle = '#12a19a'
        octx.fill()
      }
      octx.restore()
    }

    // Node markers for the shape tool.
    if (s.tool === 'shape') {
      const object = selected.find((o): o is VectorObject => o.kind === 'vector')
      if (object) {
        const path = worldPath(object)
        octx.save()
        const selectedNodes = s.nodeSelection
        for (let sub = 0; sub < path.subpaths.length; sub++) {
          const nodes = path.subpaths[sub].nodes
          for (let index = 0; index < nodes.length; index++) {
            const point = nodes[index]
            const p = toScreen({ x: point.x, y: point.y })
            const active = selectedNodes.some((n) => n.sub === sub && n.index === index)
            octx.fillStyle = active ? '#12a19a' : '#ffffff'
            octx.strokeStyle = '#12a19a'
            octx.beginPath()
            octx.rect(p.x - 3.5, p.y - 3.5, 7, 7)
            octx.fill()
            octx.stroke()
            if (!active) continue
            for (const handle of [{ x: point.inX, y: point.inY }, { x: point.outX, y: point.outY }]) {
              if (handle.x === point.x && handle.y === point.y) continue
              const hp = toScreen(handle)
              octx.beginPath()
              octx.moveTo(p.x, p.y)
              octx.lineTo(hp.x, hp.y)
              octx.strokeStyle = 'rgba(18,161,154,0.7)'
              octx.stroke()
              octx.beginPath()
              octx.arc(hp.x, hp.y, 3.5, 0, Math.PI * 2)
              octx.fillStyle = '#12a19a'
              octx.fill()
            }
          }
        }
        octx.restore()
      }
    }

    if (drag) {
      octx.save()
      if (drag.kind === 'marquee') {
        const a = toScreen(drag.start)
        const b = toScreen(drag.current)
        octx.fillStyle = 'rgba(18,161,154,0.12)'
        if (drag.lasso && drag.points.length > 1) {
          octx.beginPath()
          drag.points.forEach((point, index) => {
            const p = toScreen(point)
            if (index === 0) octx.moveTo(p.x, p.y)
            else octx.lineTo(p.x, p.y)
          })
          octx.closePath()
          octx.fill()
        } else {
          octx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        }
        octx.strokeStyle = '#12a19a'
        octx.setLineDash([5, 3])
        octx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        octx.setLineDash([])
      } else if (drag.kind === 'create') {
        const path = shapeFromDrag(drag, s.options)
        if (path) {
          octx.beginPath()
          for (const sub of path.subpaths) {
            sub.nodes.forEach((point, index) => {
              const p = toScreen(point)
              if (index === 0) octx.moveTo(p.x, p.y)
              else octx.lineTo(p.x, p.y)
            })
            if (sub.closed) octx.closePath()
          }
          octx.strokeStyle = '#12a19a'
          octx.setLineDash([5, 3])
          octx.stroke()
          octx.setLineDash([])
        }
      } else if (drag.kind === 'zoom-rect') {
        const a = toScreen(drag.start)
        const b = toScreen(drag.current)
        octx.strokeStyle = '#ffcc66'
        octx.setLineDash([4, 3])
        octx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        octx.setLineDash([])
      } else if (drag.kind === 'draw') {
        octx.beginPath()
        drag.points.forEach((point, index) => {
          const p = toScreen(point)
          if (index === 0) octx.moveTo(p.x, p.y)
          else octx.lineTo(p.x, p.y)
        })
        octx.strokeStyle = s.tool === 'brush' ? 'rgba(18,161,154,0.85)' : '#e9edf2'
        octx.lineWidth = s.tool === 'brush' ? Math.max(1, s.options.brushWidth * zoom * 0.35) : 1.4
        octx.lineCap = 'round'
        octx.lineJoin = 'round'
        octx.stroke()
      } else if (drag.kind === 'distort' || drag.kind === 'photo') {
        const p = toScreen(drag.current)
        const radius = Math.max(4, s.options.photoRadius * zoom)
        octx.beginPath()
        octx.arc(p.x, p.y, radius, 0, Math.PI * 2)
        octx.strokeStyle = 'rgba(255,255,255,0.85)'
        octx.stroke()
        octx.beginPath()
        octx.arc(p.x, p.y, Math.max(3, radius * 0.55), 0, Math.PI * 2)
        octx.strokeStyle = 'rgba(18,161,154,0.8)'
        octx.stroke()
      }
      octx.restore()
    }

    if (snapRef.current.v.length || snapRef.current.h.length || snapRef.current.points.length) {
      octx.save()
      octx.strokeStyle = '#ff7ac1'
      octx.lineWidth = 1
      octx.setLineDash([6, 4])
      for (const x of snapRef.current.v) {
        const sx = x * zoom + panX
        octx.beginPath()
        octx.moveTo(sx, 0)
        octx.lineTo(sx, h)
        octx.stroke()
      }
      for (const y of snapRef.current.h) {
        const sy = y * zoom + panY
        octx.beginPath()
        octx.moveTo(0, sy)
        octx.lineTo(w, sy)
        octx.stroke()
      }
      octx.setLineDash([])
      octx.fillStyle = '#ff7ac1'
      for (const point of snapRef.current.points) {
        const p = toScreen(point)
        octx.beginPath()
        octx.arc(p.x, p.y, 3.5, 0, Math.PI * 2)
        octx.fill()
      }
      octx.restore()
    }

    // Remote collaborators: cursors and selection boxes.
    for (const peer of Object.values(s.peers)) {
      if (peer.actor === s.actor.id) continue
      if (peer.selection?.length) {
        const objects = collectObjects(d, peer.selection)
        const bounds = objects.length ? selectionBounds(objects, d) : null
        if (bounds) {
          const a = toScreen(bounds)
          octx.save()
          octx.strokeStyle = peer.color
          octx.setLineDash([3, 3])
          octx.strokeRect(a.x, a.y, bounds.w * zoom, bounds.h * zoom)
          octx.restore()
        }
      }
      if (!peer.cursor) continue
      const p = toScreen(peer.cursor)
      octx.save()
      octx.fillStyle = peer.color
      octx.beginPath()
      octx.moveTo(p.x, p.y)
      octx.lineTo(p.x + 11, p.y + 4)
      octx.lineTo(p.x + 4.5, p.y + 5.5)
      octx.lineTo(p.x + 3, p.y + 12)
      octx.closePath()
      octx.fill()
      octx.font = '11px system-ui, sans-serif'
      octx.fillText(peer.name, p.x + 14, p.y + 14)
      octx.restore()
    }

    // Pen draft preview.
    if (penRef.current) {
      const object = collectObjects(d, [penRef.current.objectId])[0]
      if (object && object.kind === 'vector') {
        const path = worldPath(object)
        octx.save()
        octx.strokeStyle = 'rgba(18,161,154,0.9)'
        octx.beginPath()
        for (const sub of path.subpaths) {
          sub.nodes.forEach((point, index) => {
            const p = toScreen(point)
            if (index === 0) octx.moveTo(p.x, p.y)
            else octx.lineTo(p.x, p.y)
          })
        }
        octx.stroke()
        path.subpaths[0]?.nodes.forEach((point, index) => {
          const p = toScreen(point)
          octx.fillStyle = penRef.current?.dragIndex === index ? '#ffcc66' : '#ffffff'
          octx.strokeStyle = '#12a19a'
          octx.beginPath()
          octx.rect(p.x - 3.5, p.y - 3.5, 7, 7)
          octx.fill()
          octx.stroke()
        })
        octx.restore()
      }
    }

    if (liquifyRef.current || maskRef.current) {
      const p = toScreen(cursorRef.current)
      const radius = Math.max(6, s.options.photoRadius * zoom)
      octx.save()
      octx.strokeStyle = 'rgba(255,255,255,0.7)'
      octx.beginPath()
      octx.arc(p.x, p.y, radius, 0, Math.PI * 2)
      octx.stroke()
      octx.restore()
    }
  }, [size.w, size.h])

  useEffect(() => { scheduleDraw() }, [doc, view, selection, nodeSelection, tool, previewEffects, peers, editingTextId, scheduleDraw])
  useEffect(() => onBitmapReady(scheduleDraw), [scheduleDraw])
  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }, [])

  /* ---------------------------------------------------------------- input -- */

  const canvasPoint = (event: { clientX: number; clientY: number }): { screen: Vec; doc: Vec } => {
    const rect = overlayRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    return { screen, doc: screenToDoc(screen.x, screen.y) }
  }

  const tolerance = () => 6 / stateRef.current.view.zoom

  function handlePoints(bounds: { x: number; y: number; w: number; h: number }): { name: string; p: Vec }[] {
    const { x, y, w, h } = bounds
    return [
      { name: 'nw', p: { x, y } }, { name: 'n', p: { x: x + w / 2, y } }, { name: 'ne', p: { x: x + w, y } },
      { name: 'e', p: { x: x + w, y: y + h / 2 } }, { name: 'se', p: { x: x + w, y: y + h } }, { name: 's', p: { x: x + w / 2, y: y + h } },
      { name: 'sw', p: { x, y: y + h } }, { name: 'w', p: { x, y: y + h / 2 } },
    ]
  }

  function handleAt(screen: Vec, bounds: { x: number; y: number; w: number; h: number }): string | null {
    const v = stateRef.current.view
    const toScreen = (p: Vec) => ({ x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY })
    const rotate = toScreen({ x: bounds.x + bounds.w / 2, y: bounds.y })
    if (Math.abs(screen.x - rotate.x) <= 9 && Math.abs(screen.y - (rotate.y - 30)) <= 9) return 'rotate'
    for (const handle of handlePoints(bounds)) {
      const p = toScreen(handle.p)
      if (Math.abs(screen.x - p.x) <= HANDLE + 2 && Math.abs(screen.y - p.y) <= HANDLE + 2) return handle.name
    }
    return null
  }

  function anchorFor(handle: string, bounds: { x: number; y: number; w: number; h: number }): Vec {
    const { x, y, w, h } = bounds
    switch (handle) {
      case 'nw': return { x: x + w, y: y + h }
      case 'n': return { x: x + w / 2, y: y + h }
      case 'ne': return { x, y: y + h }
      case 'e': return { x, y: y + h / 2 }
      case 'se': return { x, y }
      case 's': return { x: x + w / 2, y }
      case 'sw': return { x: x + w, y }
      case 'w': return { x: x + w, y: y + h / 2 }
      default: return { x: x + w / 2, y: y + h / 2 }
    }
  }

  function applySnapping(point: Vec, bounds: { x: number; y: number; w: number; h: number } | null, ignore: string[]): Vec {
    const s = stateRef.current
    const settings = s.doc.settings
    snapRef.current = { v: [], h: [], points: [] }
    const tol = (settings.snapTolerance || 8) / s.view.zoom
    if (settings.snapToGrid) {
      const step = settings.gridStep || 10
      return { x: Math.round(point.x / step) * step, y: Math.round(point.y / step) * step }
    }
    if (!settings.snapToObjects && !settings.dynamicGuides && !settings.snapToGuides && !settings.selfSnapping) return point
    const candidatesX: number[] = []
    const candidatesY: number[] = []
    if (settings.snapToGuides) {
      for (const guide of s.page.guides) (guide.axis === 'x' ? candidatesX : candidatesY).push(guide.pos)
    }
    if (settings.snapToObjects || settings.dynamicGuides) {
      for (const layer of s.page.layers) {
        if (!layer.visible) continue
        for (const object of layer.objects) {
          if (ignore.includes(object.id)) continue
          const b = objectBounds(object, s.doc)
          if (!b) continue
          candidatesX.push(b.x, b.x + b.w / 2, b.x + b.w)
          candidatesY.push(b.y, b.y + b.h / 2, b.y + b.h)
        }
      }
    }
    candidatesX.push(0, s.page.size.w / 2, s.page.size.w)
    candidatesY.push(0, s.page.size.h / 2, s.page.size.h)

    if (!bounds) {
      let snapped = point
      if (settings.selfSnapping && dragRef.current?.kind === 'draw') {
        for (const existing of dragRef.current.points) {
          if (vDist(existing, snapped) <= tol) { snapped = { ...existing }; snapRef.current.points.push(existing); break }
        }
      }
      if (settings.snapToObjects) {
        for (const layer of s.page.layers) {
          if (!layer.visible) continue
          for (const object of layer.objects) {
            if (ignore.includes(object.id)) continue
            for (const sub of objectOutline(object, s.doc)) {
              for (const outlinePoint of sub) {
                if (vDist(outlinePoint, snapped) <= tol) {
                  snapped = { ...outlinePoint }
                  snapRef.current.points.push(outlinePoint)
                  return snapped
                }
              }
            }
          }
        }
      }
      const nearX = candidatesX.find((value) => Math.abs(value - snapped.x) <= tol)
      const nearY = candidatesY.find((value) => Math.abs(value - snapped.y) <= tol)
      if (nearX !== undefined) { snapped = { ...snapped, x: nearX }; snapRef.current.v.push(nearX) }
      if (nearY !== undefined) { snapped = { ...snapped, y: nearY }; snapRef.current.h.push(nearY) }
      return snapped
    }

    const boxX = [bounds.x, bounds.x + bounds.w / 2, bounds.x + bounds.w]
    const boxY = [bounds.y, bounds.y + bounds.h / 2, bounds.y + bounds.h]
    let dx = 0
    let dy = 0
    for (const candidate of candidatesX) {
      const hit = boxX.find((bx) => Math.abs(candidate - bx) <= tol)
      if (hit !== undefined) { dx = candidate - hit; snapRef.current.v.push(candidate); break }
    }
    for (const candidate of candidatesY) {
      const hit = boxY.find((by) => Math.abs(candidate - by) <= tol)
      if (hit !== undefined) { dy = candidate - hit; snapRef.current.h.push(candidate); break }
    }
    return { x: point.x + dx, y: point.y + dy }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { screen, doc: point } = canvasPoint(event)
    const s = stateRef.current
    const store = useStore.getState()
    overlayRef.current?.setPointerCapture(event.pointerId)
    cursorRef.current = point

    if (event.button === 1 || spaceRef.current || s.tool === 'pan' || (event.button === 0 && event.altKey && s.tool === 'zoom')) {
      dragRef.current = { kind: 'pan', start: screen, pan: { x: s.view.panX, y: s.view.panY } }
      setPanning(true)
      return
    }
    if (event.button === 2) return

    const selected = collectObjects(s.doc, s.selection)
    const bounds = selected.length ? selectionBounds(selected, s.doc) : null
    const handle = bounds ? handleAt(screen, bounds) : null
    if (handle === 'rotate' && bounds) {
      const centre = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
      dragRef.current = { kind: 'rotate', centre, startAngle: Math.atan2(point.y - centre.y, point.x - centre.x), origins: objectsWithTransform(selected) }
      return
    }
    if (handle && bounds) {
      dragRef.current = { kind: 'scale', handle, start: point, bounds, origins: objectsWithTransform(selected) }
      return
    }

    const t = s.tool as string
    switch (t) {
      case 'zoom': dragRef.current = { kind: 'zoom-rect', start: point, current: point }; return
      case 'freeTransform': {
        const hit = hitTest(s.page, point, tolerance(), s.doc, event.altKey)
        if (!hit) { dragRef.current = { kind: 'marquee', start: point, current: point, additive: event.shiftKey, lasso: false, points: [] }; return }
        const ids = event.shiftKey ? [...new Set([...s.selection, hit.object.id])] : [hit.object.id]
        store.select([hit.object.id], event.shiftKey)
        dragRef.current = { kind: 'move', start: point, current: point, origins: objectsWithTransform(collectObjects(s.doc, ids)) }
        return
      }
      case 'lasso': dragRef.current = { kind: 'marquee', start: point, current: point, additive: event.shiftKey, lasso: true, points: [point] }; return
      case 'shape': {
        const object = selected.find((o): o is VectorObject => o.kind === 'vector')
        if (object) {
          const clicked = nearestNode(object, point, tolerance() * 1.8)
          if (clicked) {
            const already = s.nodeSelection.some((n) => n.sub === clicked.sub && n.index === clicked.index)
            store.setNodeSelection(already && event.shiftKey
              ? s.nodeSelection.filter((n) => !(n.sub === clicked.sub && n.index === clicked.index))
              : [{ sub: clicked.sub, index: clicked.index }])
            dragRef.current = { kind: 'node', sub: clicked.sub, index: clicked.index, which: clicked.which }
            return
          }
          const segment = nearestSegment(object, point, tolerance() * 1.8)
          if (segment) {
            store.commit('Add node', (d) => updateObjects(d, [object.id], () => ({ ...object, path: insertNode(object.path, segment.sub, segment.segment, segment.t) })))
            return
          }
        }
        const hit = hitTest(s.page, point, tolerance(), s.doc, event.altKey)
        if (hit) {
          store.select([hit.object.id], event.shiftKey)
          if (hit.object.kind === 'vector') store.setNodeSelection([{ sub: 0, index: 0 }])
        } else if (!event.shiftKey) {
          store.clearSelection()
          store.setNodeSelection([])
        }
        return
      }
      case 'rectangle': case 'ellipse': case 'polygon': case 'star': case 'complexStar':
      case 'graphPaper': case 'spiral': case 'line2': case 'rect3': case 'ellipse3':
      case 'text': case 'table': case 'crop': case 'perspective':
        dragRef.current = { kind: 'create', start: point, current: point, shift: event.shiftKey }
        return
      case 'freehand': case 'liveSketch': case 'brush': case 'variableOutline': case 'symmetry': case 'bspline':
        dragRef.current = { kind: 'draw', points: [point], pressures: [event.pressure || 0.6] }
        return
      case 'pen': case 'bezier': case 'polyline':
        beginPen(point, t !== 'polyline')
        return
      case 'smudge': case 'roughen': case 'twirl': case 'attract': case 'repel': case 'smear':
        dragRef.current = { kind: 'distort', last: point, current: point }
        return
      case 'eraser': case 'knife':
        dragRef.current = { kind: 'distort', last: point, current: point }
        return
      case 'transparency': case 'blend': case 'contour': case 'dropShadow': case 'blockShadow': {
        const kindMap: Record<string, string> = { transparency: 'transparency', blend: 'blend', contour: 'contour', dropShadow: 'drop-shadow', blockShadow: 'block-shadow' }
        store.addEffect(kindMap[t] ?? t, 'effect')
        store.setTool('pick')
        return
      }
      case 'envelope': {
        void applyEnvelopePreset(point)
        return
      }
      case 'perspectiveCorrect': {
        dragRef.current = { kind: 'photo', last: point, current: point, first: point }
        void applyPerspectiveCorrection(point)
        return
      }
      case 'eyedropper': {
        const sampled = sampleCanvas(point)
        if (sampled) store.setFillColor(sampled)
        return
      }
      case 'fill': case 'meshFill': case 'smartFill': {
        applyFillToHit(point, event.altKey)
        return
      }
      case 'maskBrush': case 'cutout': case 'bgRemove': {
        void startMaskStroke(t)
        dragRef.current = { kind: 'photo', last: point, current: point, first: point }
        return
      }
      case 'liquify': {
        void startLiquify()
        dragRef.current = { kind: 'photo', last: point, current: point, first: point }
        return
      }
      case 'clone': case 'colorReplace': case 'blurBrush': case 'sharpenBrush':
      case 'dodgeBrush': case 'burnBrush': case 'enhance':
        dragRef.current = { kind: 'photo', last: point, current: point, first: point }
        void photoDab(point, point)
        return
      default: {
        const hit = hitTest(s.page, point, tolerance(), s.doc, event.altKey)
        if (hit) {
          const ids = event.shiftKey ? [...new Set([...s.selection, hit.object.id])] : [hit.object.id]
          store.select([hit.object.id], event.shiftKey)
          dragRef.current = { kind: 'move', start: point, current: point, origins: objectsWithTransform(collectObjects(s.doc, ids)) }
        } else {
          dragRef.current = { kind: 'marquee', start: point, current: point, additive: event.shiftKey, lasso: false, points: [] }
        }
      }
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { screen, doc: point } = canvasPoint(event)
    const s = stateRef.current
    cursorRef.current = point
    const drag = dragRef.current
    const store = useStore.getState()

    if (useCollab.getState().room) {
      const now = Date.now()
      if (now - lastPresenceRef.current > 120) {
        lastPresenceRef.current = now
        void useCollab.getState().sendPresence({ cursor: { x: point.x, y: point.y } })
      }
    }

    if (!drag) { scheduleDraw(); return }
    switch (drag.kind) {
      case 'pan':
        store.setView({ panX: drag.pan.x + (screen.x - drag.start.x), panY: drag.pan.y + (screen.y - drag.start.y) })
        break
      case 'marquee':
        drag.current = point
        if (drag.lasso) drag.points.push(point)
        scheduleDraw()
        break
      case 'move': {
        drag.current = point
        let dx = point.x - drag.start.x
        let dy = point.y - drag.start.y
        if (event.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0 }
        const base = unionBounds(drag.origins.map((o) => {
          const object = collectObjects(s.doc, [o.id])[0]
          return object ? objectBounds(object, s.doc) : null
        }), dx, dy)
        const snapped = applySnapping({ x: dx, y: dy }, base, drag.origins.map((o) => o.id))
        dx = snapped.x
        dy = snapped.y
        store.commit('Move', (d) => updateObjects(d, drag.origins.map((o) => o.id), (object) => {
          const origin = drag.origins.find((o) => o.id === object.id)!
          return { ...object, transform: { ...origin.transform, e: origin.transform.e + dx, f: origin.transform.f + dy } }
        }), { selection: s.selection })
        break
      }
      case 'scale': {
        const anchor = anchorFor(drag.handle, drag.bounds)
        const sx = (point.x - anchor.x) / ((drag.start.x - anchor.x) || 1)
        const sy = (point.y - anchor.y) / ((drag.start.y - anchor.y) || 1)
        const fx = drag.handle.length === 2 ? (event.shiftKey ? Math.max(sx, sy) : sx) : sx
        const fy = drag.handle.length === 2 ? (event.shiftKey ? Math.max(sx, sy) : sy) : sy
        store.commit('Scale', (d) => updateObjects(d, drag.origins.map((o) => o.id), (object) => {
          const origin = drag.origins.find((o) => o.id === object.id)!
          const m = matMul(matTranslate(anchor.x, anchor.y), matMul(matScale(fx, fy), matTranslate(-anchor.x, -anchor.y)))
          return { ...object, transform: matMul(m, origin.transform) }
        }), { selection: s.selection })
        break
      }
      case 'rotate': {
        const angle = Math.atan2(point.y - drag.centre.y, point.x - drag.centre.x) - drag.startAngle
        const snappedAngle = event.shiftKey ? Math.round(angle / (Math.PI / 12)) * (Math.PI / 12) : angle
        store.commit('Rotate', (d) => updateObjects(d, drag.origins.map((o) => o.id), (object) => {
          const origin = drag.origins.find((o) => o.id === object.id)!
          const m = matMul(matTranslate(drag.centre.x, drag.centre.y), matMul(matRotate(snappedAngle), matTranslate(-drag.centre.x, -drag.centre.y)))
          return { ...object, transform: matMul(m, origin.transform) }
        }), { selection: s.selection })
        break
      }
      case 'create':
      case 'zoom-rect':
        drag.current = point
        scheduleDraw()
        break
      case 'draw': {
        const last = drag.points[drag.points.length - 1]
        if (vDist(last, point) * s.view.zoom >= 1.4) {
          const snapped = applySnapping(point, null, [])
          drag.points.push(snapped)
          drag.pressures.push(event.pressure || 0.6)
        }
        scheduleDraw()
        break
      }
      case 'pen-handle': {
        const object = collectObjects(s.doc, [penRef.current?.objectId ?? ''])[0]
        if (object && object.kind === 'vector') {
          const local = { x: point.x - object.transform.e, y: point.y - object.transform.f }
          const path = dragHandle(object.path, 0, drag.index, 'out', local)
          store.commit('Adjust curve', (d) => updateObjects(d, [object.id], () => ({ ...object, path })))
        }
        break
      }
      case 'node': {
        const object = collectObjects(s.doc, s.selection).find((o): o is VectorObject => o.kind === 'vector')
        if (object && s.nodeSelection.length) {
          const local = { x: point.x - object.transform.e, y: point.y - object.transform.f }
          if (drag.which === 'node') {
            const origin = nodePos(object.path, drag.sub, drag.index)
            const path = moveNode(object.path, drag.sub, drag.index, local.x - origin.x, local.y - origin.y, !event.altKey)
            // Move every selected node together.
            let next = path
            for (const entry of s.nodeSelection) {
              if (entry.sub === drag.sub && entry.index === drag.index) continue
              const from = nodePos(object.path, entry.sub, entry.index)
              next = moveNode(next, entry.sub, entry.index, local.x - from.x, local.y - from.y, !event.altKey)
            }
            store.commit('Edit node', (d) => updateObjects(d, [object.id], () => ({ ...object, path: next })))
          } else {
            const path = dragHandle(object.path, drag.sub, drag.index, drag.which, local)
            store.commit('Edit node', (d) => updateObjects(d, [object.id], () => ({ ...object, path })))
          }
        }
        break
      }
      case 'distort': {
        drag.current = point
        applyDistort(point, drag.last)
        drag.last = point
        break
      }
      case 'photo': {
        drag.current = point
        void photoDab(point, drag.last)
        drag.last = point
        break
      }
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const s = stateRef.current
    const store = useStore.getState()
    dragRef.current = null
    snapRef.current = { v: [], h: [], points: [] }
    setPanning(false)
    if (!drag) return
    const point = canvasPoint(event).doc

    if (drag.kind === 'marquee') {
      if (drag.lasso) {
        const candidates = objectsInRect(s.page, boundsOfPoints(drag.points), s.doc)
        const inside = candidates.filter((object) => {
          const b = objectBounds(object, s.doc)
          return b ? pointInPolygon({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, drag.points) : false
        })
        store.select(inside.map((o) => o.id), drag.additive)
      } else {
        const rect = rectFromPoints(drag.start, drag.current)
        store.select(objectsInRect(s.page, rect, s.doc).map((o) => o.id), drag.additive)
      }
    } else if (drag.kind === 'create') {
      finishCreateShape(drag, point)
    } else if (drag.kind === 'zoom-rect') {
      const rect = rectFromPoints(drag.start, drag.current)
      if (rect.w < 4 || rect.h < 4) {
        store.zoomTo(s.view.zoom * (event.altKey ? 1 / 1.5 : 1.5), point)
      } else {
        const zoom = Math.min(size.w / rect.w, size.h / rect.h)
        store.setView({ zoom, panX: -rect.x * zoom + (size.w - rect.w * zoom) / 2, panY: -rect.y * zoom + (size.h - rect.h * zoom) / 2 })
      }
    } else if (drag.kind === 'draw') {
      finishStroke(drag.points, drag.pressures)
    } else if (drag.kind === 'photo') {
      void finishPhotoDrag()
    }
    scheduleDraw()
  }

  /* ---------------------------------------------------------- doc helpers -- */

  function collectObjects(d: Document, ids: string[]): SceneObject[] {
    if (!ids.length) return []
    const wanted = new Set(ids)
    const out: SceneObject[] = []
    const walk = (objects: SceneObject[]) => {
      for (const object of objects) {
        if (wanted.has(object.id)) out.push(object)
        if (object.kind === 'group') walk(object.children)
      }
    }
    for (const p of d.pages) for (const layer of p.layers) walk(layer.objects)
    return out
  }

  function objectsWithTransform(objects: SceneObject[]): { id: string; transform: Matrix }[] {
    return objects.flatMap((object) => object.kind === 'group'
      ? objectsWithTransform(object.children)
      : [{ id: object.id, transform: { ...object.transform } }])
  }

  function worldPath(object: VectorObject): PathData {
    const m = object.transform
    const map = (x: number, y: number): Vec => ({ x: x * m.a + y * m.c + m.e, y: x * m.b + y * m.d + m.f })
    return {
      fillRule: object.path.fillRule,
      subpaths: object.path.subpaths.map((sub) => ({
        closed: sub.closed,
        nodes: sub.nodes.map((n) => {
          const position = map(n.x, n.y)
          const inHandle = map(n.inX, n.inY)
          const outHandle = map(n.outX, n.outY)
          return { ...n, x: position.x, y: position.y, inX: inHandle.x, inY: inHandle.y, outX: outHandle.x, outY: outHandle.y }
        }),
      })),
    }
  }

  function nodePos(path: PathData, sub: number, index: number): Vec {
    const found = path.subpaths[sub]?.nodes[index]
    return found ? { x: found.x, y: found.y } : { x: 0, y: 0 }
  }

  function nearestNode(object: VectorObject, point: Vec, tol: number): { sub: number; index: number; which: 'node' | 'in' | 'out' } | null {
    const world = worldPath(object)
    for (let sub = 0; sub < world.subpaths.length; sub++) {
      const nodes = world.subpaths[sub].nodes
      for (let index = 0; index < nodes.length; index++) {
        const n = nodes[index]
        if (vDist(n, point) <= tol) return { sub, index, which: 'node' }
        if (vDist({ x: n.inX, y: n.inY }, point) <= tol && (n.inX !== n.x || n.inY !== n.y)) return { sub, index, which: 'in' }
        if (vDist({ x: n.outX, y: n.outY }, point) <= tol && (n.outX !== n.x || n.outY !== n.y)) return { sub, index, which: 'out' }
      }
    }
    return null
  }

  function nearestSegment(object: VectorObject, point: Vec, tol: number): { sub: number; segment: number; t: number } | null {
    const world = worldPath(object)
    for (let sub = 0; sub < world.subpaths.length; sub++) {
      const nodes = world.subpaths[sub].nodes
      for (let index = 0; index + 1 < nodes.length; index++) {
        const a = nodes[index]
        const b = nodes[index + 1]
        const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1
        const t = clamp(((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSq, 0, 1)
        const closest = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        if (vDist(closest, point) <= tol) return { sub, segment: index, t }
      }
    }
    return null
  }

  /* -------------------------------------------------------- shape creation -- */

  function shapeFromDrag(drag: Extract<Drag, { kind: 'create' }>, opts: ReturnType<typeof useToolOptions>): PathData | null {
    const start = drag.start
    let end = drag.current
    if (drag.shift) {
      const d = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y))
      end = { x: start.x + Math.sign(end.x - start.x || 1) * d, y: start.y + Math.sign(end.y - start.y || 1) * d }
    }
    const w = end.x - start.x
    const h = end.y - start.y
    const aw = Math.abs(w)
    const ah = Math.abs(h)
    const cx = start.x + w / 2
    const cy = start.y + h / 2
    const tool = stateRef.current.tool as string
    const translate = (path: PathData, dx: number, dy: number): PathData => ({
      fillRule: path.fillRule,
      subpaths: path.subpaths.map((sub) => ({
        closed: sub.closed,
        nodes: sub.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy, inX: n.inX + dx, inY: n.inY + dy, outX: n.outX + dx, outY: n.outY + dy })),
      })),
    })
    switch (tool) {
      case 'rectangle':
        return translate(rectPath(aw, ah, opts.rectCorner), Math.min(start.x, end.x), Math.min(start.y, end.y))
      case 'rect3':
        return threePointRect(start, end, { x: end.x, y: end.y + Math.max(1, ah * 0.25) })
      case 'ellipse':
        return translate(ellipsePath(aw / 2, ah / 2, opts.ellipseStart, opts.ellipseEnd, opts.ellipsePie), cx, cy)
      case 'ellipse3':
        return threePointEllipse(start, end, { x: end.x, y: end.y + Math.max(1, ah * 0.25) })
      case 'polygon':
        return translate(polygonPath(Math.max(3, Math.round(opts.polygonSides)), Math.max(1, Math.max(aw, ah) / 2)), cx, cy)
      case 'star':
        return translate(starPath(Math.max(3, Math.round(opts.starPoints)), Math.max(1, Math.max(aw, ah) / 2), Math.max(1, Math.max(aw, ah) / 2 * clamp(opts.starSharpness, 0.05, 0.95)), 1), cx, cy)
      case 'complexStar':
        return translate(starPath(Math.max(3, Math.round(opts.complexStarPoints)), Math.max(1, Math.max(aw, ah) / 2), Math.max(1, Math.max(aw, ah) / 2 * clamp(opts.complexStarSharpness, 0.05, 0.95)), 1), cx, cy)
      case 'graphPaper':
        return translate(graphPaperPath(Math.max(1, Math.round(opts.graphCols)), Math.max(1, Math.round(opts.graphRows)), Math.max(1, aw), Math.max(1, ah)), Math.min(start.x, end.x), Math.min(start.y, end.y))
      case 'spiral':
        return translate(spiralPath(Math.max(1, opts.spiralRevolutions), Math.max(1, Math.max(aw, ah) / 2), opts.spiralDivergence, opts.spiralSymmetrical), cx, cy)
      case 'line2':
        return pathFromSubpaths([subPath([node(start.x, start.y), node(end.x, end.y)], false)])
      default:
        return null
    }
  }

  function finishCreateShape(drag: Extract<Drag, { kind: 'create' }>, point: Vec): void {
    const store = useStore.getState()
    const s = stateRef.current
    const opts = s.options
    const tool = s.tool as string
    const current = { ...drag, current: point }

    if (tool === 'text' || tool === 'table') {
      const rect = rectFromPoints(drag.start, point)
      const width = Math.max(40, rect.w || 200)
      const height = Math.max(20, rect.h || 40)
      const object = createTextObject(tool === 'table' || rect.w > 260 || rect.h > 80 ? 'paragraph' : 'artistic', tool === 'table' ? 'Column A, Column B\nRow 1, —\nRow 2, —' : '', {
        x: drag.start.x, y: drag.start.y, w: width, h: height,
      })
      object.style = {
        ...object.style,
        fontFamily: opts.textFont,
        fontSize: opts.textSize,
        fontWeight: opts.textBold ? 700 : 400,
        fontStyle: opts.textItalic ? 'italic' : 'normal',
        align: opts.textAlign,
        lineHeight: opts.textLineHeight,
        letterSpacing: opts.textLetterSpacing,
      }
      store.addObjectsToActiveLayer([object], 'Add text')
      store.setEditingText(object.id)
      return
    }
    if (tool === 'crop') {
      const rect = rectFromPoints(drag.start, point)
      if (rect.w > 4 && rect.h > 4) {
        store.commit('Crop page', (d) => ({
          ...d,
          pages: d.pages.map((p) => p.id === d.activePageId ? { ...p, size: { ...p.size, w: rect.w, h: rect.h } } : p),
        }))
        store.setView({ panX: s.view.panX - rect.x * s.view.zoom, panY: s.view.panY - rect.y * s.view.zoom })
      }
      return
    }
    if (tool === 'perspective') {
      const object = collectObjects(s.doc, s.selection).find((o): o is VectorObject => o.kind === 'vector')
      if (!object) {
        store.toast('info', 'Select a curve first', 'Perspective draw maps the selected vector object onto the drawn quad.')
        return
      }
      const rect = rectFromPoints(drag.start, point)
      const bounds = objectBounds(object, s.doc)
      if (!bounds) return
      const src = [
        { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.w, y: bounds.y },
        { x: bounds.x + bounds.w, y: bounds.y + bounds.h }, { x: bounds.x, y: bounds.y + bounds.h },
      ]
      const dst = [
        { x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y },
        { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h },
      ]
      const m = homographyFromQuad(src, dst)
      const mapPoint = (x: number, y: number): Vec => {
        const denominator = m[6] * x + m[7] * y + m[8] || 1e-9
        return { x: (m[0] * x + m[1] * y + m[2]) / denominator, y: (m[3] * x + m[4] * y + m[5]) / denominator }
      }
      const mapped: PathData = {
        fillRule: object.path.fillRule,
        subpaths: object.path.subpaths.map((sub) => ({
          closed: sub.closed,
          nodes: sub.nodes.map((n) => {
            const p = mapPoint(n.x, n.y)
            const handleIn = mapPoint(n.inX, n.inY)
            const handleOut = mapPoint(n.outX, n.outY)
            return { ...n, x: p.x, y: p.y, inX: handleIn.x, inY: handleIn.y, outX: handleOut.x, outY: handleOut.y }
          }),
        })),
      }
      store.commit('Perspective draw', (d) => updateObjects(d, [object.id], () => ({ ...object, path: mapped })))
      return
    }
    const path = shapeFromDrag(current, opts)
    if (!path) return
    const width = Math.abs(drag.current.x - drag.start.x)
    const height = Math.abs(drag.current.y - drag.start.y)
    const primitive = ((): VectorObject['primitive'] => {
      switch (tool) {
        case 'rectangle': return { type: 'rect', w: width, h: height, r: opts.rectCorner, corners: [1, 1, 1, 1] }
        case 'rect3': return { type: 'rect', w: width, h: height, r: 0, corners: [1, 1, 1, 1] }
        case 'ellipse': return { type: 'ellipse', rx: width / 2, ry: height / 2, start: opts.ellipseStart, end: opts.ellipseEnd, pieMode: opts.ellipsePie }
        case 'ellipse3': return { type: 'ellipse', rx: width / 2, ry: height / 2, start: 0, end: 360, pieMode: 'pie' }
        case 'polygon': return { type: 'polygon', sides: Math.round(opts.polygonSides), radius: Math.max(width, height) / 2, sharp: true }
        case 'star': return { type: 'star', points: Math.round(opts.starPoints), radius: Math.max(width, height) / 2, innerRadius: Math.max(width, height) / 2 * clamp(opts.starSharpness, 0.05, 0.95), sharpness: 1 }
        case 'complexStar': return { type: 'star', points: Math.round(opts.complexStarPoints), radius: Math.max(width, height) / 2, innerRadius: Math.max(width, height) / 2 * clamp(opts.complexStarSharpness, 0.05, 0.95), sharpness: 1 }
        case 'spiral': return { type: 'spiral', revolutions: opts.spiralRevolutions, radius: Math.max(width, height) / 2, divergence: opts.spiralDivergence, symmetrical: opts.spiralSymmetrical }
        case 'graphPaper': return { type: 'graphPaper', cols: Math.round(opts.graphCols), rows: Math.round(opts.graphRows), w: width, h: height }
        case 'line2': return { type: 'line', x2: drag.current.x, y2: drag.current.y }
        default: return { type: 'freehand' }
      }
    })()
    const object = createVector({
      path,
      primitive,
      fill: tool === 'line2' ? { type: 'none' } : { type: 'uniform', color: useStore.getState().fillColor },
      stroke: tool === 'line2'
        ? { color: useStore.getState().strokeColor, width: 1, cap: 'round', join: 'round', miterLimit: 10, dash: [], behind: false }
        : null,
      name: titleCase(tool),
    })
    store.addObjectsToActiveLayer([object], `Add ${titleCase(tool)}`)
  }

  function beginPen(point: Vec, smooth: boolean): void {
    const store = useStore.getState()
    const s = stateRef.current
    const pen = penRef.current
    if (pen) {
      const object = collectObjects(s.doc, [pen.objectId])[0]
      if (object && object.kind === 'vector') {
        const first = object.path.subpaths[0].nodes[0]
        if (vDist({ x: first.x, y: first.y }, { x: point.x - object.transform.e, y: point.y - object.transform.f }) <= tolerance() * 2.5) {
          const closed: PathData = { fillRule: 'nonzero', subpaths: [{ ...object.path.subpaths[0], closed: true }] }
          store.commit('Close curve', (d) => updateObjects(d, [object.id], () => ({ ...object, path: closed })))
          penRef.current = null
          return
        }
        const local = { x: point.x - object.transform.e, y: point.y - object.transform.f }
        const nodes = [...object.path.subpaths[0].nodes, smooth ? makeSmoothNode(local.x, local.y, local.x, local.y, local.x, local.y) : node(local.x, local.y)]
        const next: PathData = { fillRule: 'nonzero', subpaths: [{ closed: false, nodes }] }
        store.commit('Add node', (d) => updateObjects(d, [object.id], () => ({ ...object, path: next })))
        penRef.current = { ...pen, dragIndex: nodes.length - 1, smooth }
        dragRef.current = { kind: 'pen-handle', index: nodes.length - 1 }
        return
      }
      penRef.current = null
    }
    const object = createVector({
      path: pathFromSubpaths([subPath([smooth ? makeSmoothNode(point.x, point.y, point.x, point.y, point.x, point.y) : node(point.x, point.y)], false)]),
      primitive: { type: 'freehand' },
      fill: { type: 'none' },
      stroke: { color: store.strokeColor, width: 1.2, cap: 'round', join: 'round', miterLimit: 10, dash: [], behind: false },
      name: 'Curve',
    })
    store.addObjectsToActiveLayer([object], 'Start curve')
    penRef.current = { objectId: object.id, dragIndex: 0, smooth }
    dragRef.current = { kind: 'pen-handle', index: 0 }
  }

  function finishStroke(points: Vec[], pressures: number[]): void {
    if (points.length < 2) return
    const store = useStore.getState()
    const s = stateRef.current
    const opts = s.options
    const smoothing = clamp(opts.freehandSmoothing, 0, 1)
    const path = refineCurve(points, smoothing * 0.8, false)
    const t = s.tool as string

    if (t === 'brush') {
      const preset = presetByID(opts.brushPreset)
      const stroke: BrushStroke = {
        preset: preset.id,
        points: makeStrokePoints(points, pressures),
        size: opts.brushWidth,
        sizeVariation: preset.sizeVariation,
        opacityVariation: preset.opacityVariation,
        spacing: preset.spacing,
        rotation: 0,
        flow: preset.flow,
        media: (preset.media === 'airbrush' || preset.media === 'spray' || preset.media === 'chalk' || preset.media === 'charcoal'
          ? 'pencil'
          : preset.media === 'gouache' || preset.media === 'acrylic'
            ? 'oil'
            : preset.media) as BrushStroke['media'],
        color: store.strokeColor,
        colorVariation: clamp(preset.bleed, 0, 1),
        jitter: preset.jitter,
        seed: Math.floor(Math.random() * 1e9),
        buildup: preset.buildup,
      }
      const object = createVector({
        path,
        primitive: { type: 'freehand' },
        fill: { type: 'none' },
        stroke: null,
        brush: stroke,
        name: `${preset.name} stroke`,
      })
      store.setLastBrush(stroke)
      store.addObjectsToActiveLayer([object], 'Brush stroke')
      return
    }
    if (t === 'variableOutline') {
      const object = createVector({
        path: variableOutline(path, opts.variableWidth, [0.35, 1, 0.7, 1, 0.4]),
        primitive: { type: 'freehand' },
        fill: { type: 'uniform', color: store.fillColor },
        stroke: null,
        name: 'Variable outline',
      })
      store.addObjectsToActiveLayer([object], 'Variable outline')
      return
    }
    if (t === 'symmetry') {
      const object = createVector({
        path,
        primitive: { type: 'freehand' },
        fill: { type: 'none' },
        stroke: { color: store.strokeColor, width: 1.2, cap: 'round', join: 'round', miterLimit: 10, dash: [], behind: false },
        symmetry: {
          mode: opts.symmetryMode === 'mirror' ? 'mirror-x' : opts.symmetryMode,
          mirrors: Math.max(2, Math.round(opts.symmetryCount)),
          center: { x: s.page.size.w / 2, y: s.page.size.h / 2 },
          reflect: opts.symmetryMode !== 'radial',
        },
        name: 'Symmetry stroke',
      })
      store.addObjectsToActiveLayer([object], 'Symmetry stroke')
      return
    }
    const liveSketch = t === 'liveSketch'
    const object = createVector({
      path: refineCurve(points, liveSketch ? Math.min(1, smoothing + 0.35) : smoothing, false),
      primitive: { type: 'freehand' },
      fill: { type: 'none' },
      stroke: { color: store.strokeColor, width: liveSketch ? Math.max(1.2, opts.brushWidth * 0.4) : 1.2, cap: 'round', join: 'round', miterLimit: 10, dash: [], behind: false },
      name: liveSketch ? 'LiveSketch result' : 'Freehand',
    })
    store.addObjectsToActiveLayer([object], liveSketch ? 'LiveSketch' : 'Freehand stroke')
  }

  function applyDistort(point: Vec, previous: Vec): void {
    const store = useStore.getState()
    const s = stateRef.current
    const opts = s.options
    const t = s.tool as string
    const objects = collectObjects(s.doc, s.selection).filter((o): o is VectorObject => o.kind === 'vector')

    if (t === 'eraser') {
      for (const object of objects) {
        let path = object.path
        for (let sub = path.subpaths.length - 1; sub >= 0; sub--) {
          for (let i = path.subpaths[sub].nodes.length - 1; i >= 0; i--) {
            const n = path.subpaths[sub].nodes[i]
            const world = { x: n.x + object.transform.e, y: n.y + object.transform.f }
            if (vDist(world, point) <= opts.photoRadius) path = deleteNode(path, sub, i)
          }
        }
        store.commit('Erase nodes', (d) => updateObjects(d, [object.id], () => ({ ...object, path })))
      }
      return
    }
    if (t === 'knife') {
      for (const object of objects) {
        const pieces = breakApart(object.path)
        if (pieces.length < 2) continue
        const [first, ...rest] = pieces
        store.commit('Knife', (d) => {
          let next = updateObjects(d, [object.id], () => ({ ...object, path: first }))
          const activePage = next.pages.find((p) => p.id === next.activePageId) ?? next.pages[0]
          const layer = activePage.layers[activePage.layers.length - 1]
          const extras = rest.map((piece, index) => createVector({
            path: piece,
            primitive: { type: 'freehand' },
            fill: object.fill,
            stroke: object.stroke,
            name: `${object.name} piece ${index + 2}`,
          }))
          next = {
            ...next,
            pages: next.pages.map((p) => p.id !== activePage.id ? p : {
              ...p,
              layers: p.layers.map((l) => l.id !== layer.id ? l : { ...l, objects: [...l.objects, ...extras] }),
            }),
          }
          return next
        })
      }
      return
    }
    if (!objects.length) return
    const kind = t === 'smudge' || t === 'smear' ? 'smudge' : t === 'roughen' ? 'roughen' : t === 'twirl' ? 'twirl' : t === 'attract' ? 'attract' : 'repel'
    const radius = Math.max(4, opts.distortRadius)
    const strength = clamp(opts.distortStrength, 0.01, 1)
    for (const object of objects) {
      const local = { x: point.x - object.transform.e, y: point.y - object.transform.f }
      const delta = { x: point.x - previous.x, y: point.y - previous.y }
      const path = distortNodes(object.path, kind, local, radius, strength, delta, 7)
      store.commit(titleCase(kind), (d) => updateObjects(d, [object.id], () => ({ ...object, path })))
    }
  }

  function applyFillToHit(point: Vec, alt: boolean): void {
    const store = useStore.getState()
    const s = stateRef.current
    const hit = hitTest(s.page, point, tolerance(), s.doc, true)
    if (!hit) return
    if ((s.tool as string) === 'meshFill' && hit.object.kind === 'vector') {
      const object = hit.object
      const rows = 3
      const cols = 3
      const nodes = Array.from({ length: (rows + 1) * (cols + 1) }, (_, index) => {
        const r = Math.floor(index / (cols + 1))
        const c = index % (cols + 1)
        return { x: c / cols, y: r / rows, color: { ...store.fillColor } }
      })
      store.commit('Mesh fill', (d) => updateObjects(d, [object.id], (o) => (o.kind === 'vector' ? { ...o, fill: { type: 'mesh', rows, cols, nodes } } : o)))
      return
    }
    store.select([hit.object.id], false)
    if (alt) store.applyStrokeToSelection({ color: store.strokeColor })
    else store.applyFillToSelection({ type: 'uniform', color: store.fillColor })
  }

  /* ----------------------------------------------------------- photo tools -- */

  async function selectedBitmap(): Promise<BitmapObject | null> {
    const s = stateRef.current
    for (const id of s.selection) {
      const bitmap = findBitmap(s.doc, id)
      if (bitmap) return bitmap
    }
    return null
  }

  async function startMaskStroke(toolId: string): Promise<void> {
    const store = useStore.getState()
    const bitmap = await selectedBitmap()
    if (!bitmap) { store.toast('info', 'Select a bitmap', 'Masking tools need a selected bitmap (import a photo first).'); return }
    const photo = peekSession(bitmap.id) ?? (await openSession(bitmap))
    if (toolId === 'bgRemove') {
      const result = removeBackground(photo, DEFAULT_BG_REMOVAL)
      photo.selection = selectionFromMask(photo.selection, result.mask)
      store.commit('Remove background', bakeSession(bitmap, photo))
      store.toast('success', 'Background removed', 'The detected background was erased from the bitmap alpha.')
      return
    }
    if (toolId === 'cutout') {
      photo.selection = selectionFromMask(photo.selection, selectSubject(photo, 28, 1.5))
      store.commit('Select subject', bakeSession(bitmap, photo))
      return
    }
    maskRef.current = { bitmapId: bitmap.id, mode: stateRef.current.options.maskMode }
  }

  async function startLiquify(): Promise<void> {
    const store = useStore.getState()
    const bitmap = await selectedBitmap()
    if (!bitmap) { store.toast('info', 'Select a bitmap', 'Liquify works on bitmap objects.'); return }
    const photo = await openSession(bitmap)
    liquifyRef.current = beginLiquify(photo, stateRef.current.options.liquifyMode)
  }

  async function photoDab(point: Vec, previous: Vec): Promise<void> {
    const s = stateRef.current
    const bitmap = await selectedBitmap()
    if (!bitmap) return
    const photo: PhotoDocument = peekSession(bitmap.id) ?? (await openSession(bitmap))
    const radius = Math.max(2, s.options.photoRadius)
    const hardness = clamp(s.options.photoHardness, 0, 1)
    const opacity = clamp(s.options.photoOpacity, 0, 1)
    const strength = clamp(s.options.photoStrength, 0.01, 1)
    const t = s.tool as string

    if (t === 'liquify' && liquifyRef.current) {
      liquifyDrag(liquifyRef.current, photo, previous, point, radius, strength)
      return
    }
    if (maskRef.current && t === 'maskBrush') {
      photo.selection = paintMask(photo.selection, [previous, point], radius, hardness, opacity, maskRef.current.mode === 'erase')
      return
    }
    if (t === 'clone') {
      const offset = Math.max(4, s.options.distortRadius)
      cloneStamp(photo, {
        x: point.x, y: point.y, radius, hardness, opacity,
        source: { x: point.x + offset, y: point.y + offset },
      }, photo.selection.active ? photo.selection : null)
      return
    }
    if (t === 'colorReplace') {
      const next = replaceColor(photo.data.slice(), {
        ...DEFAULT_COLOR_REPLACE,
        from: parseHex(s.options.colorReplaceFrom || '#ffffff'),
        to: parseHex(s.options.colorReplaceTo || '#000000'),
        tolerance: s.options.colorReplaceTolerance,
        softness: hardness,
        amount: opacity,
      })
      if (photo.selection.active) {
        for (let i = 0; i < photo.w * photo.h; i++) {
          const mask = photo.selection.mask[i] / 255
          if (mask <= 0) continue
          for (let c = 0; c < 4; c++) {
            const index = i * 4 + c
            photo.data[index] = photo.data[index] * (1 - mask) + next[index] * mask
          }
        }
      } else {
        photo.data.set(next)
      }
      return
    }
    if (t === 'perspectiveCorrect') {
      return
    }
    const retouchTool = t === 'blurBrush' ? 'blur'
      : t === 'sharpenBrush' || t === 'enhance' ? 'sharpen'
        : t === 'dodgeBrush' ? 'dodge'
          : t === 'burnBrush' ? 'burn'
            : (s.options.retouchTool as never)
    retouchDab(photo, point, { tool: retouchTool, radius, hardness, opacity, strength, from: previous, seed: 4242 })
  }

  async function applyPerspectiveCorrection(point: Vec): Promise<void> {
    const store = useStore.getState()
    const bitmap = await selectedBitmap()
    if (!bitmap) { store.toast('info', 'Select a bitmap', 'Perspective correction runs on a bitmap.'); return }
    const photo = await openSession(bitmap)
    const quad = [
      { x: 0, y: 0 },
      { x: photo.w - 1, y: 0 },
      { x: photo.w - 1, y: photo.h - 1 },
      { x: 0, y: photo.h - 1 },
    ]
    void point
    photo.data.set(correctPerspective(photo, quad))
    store.commit('Perspective correction', bakeSession(bitmap, photo))
  }

  async function finishPhotoDrag(): Promise<void> {
    const store = useStore.getState()
    const bitmap = await selectedBitmap()
    if (!bitmap) return
    const photo = peekSession(bitmap.id)
    if (!photo) return
    if (liquifyRef.current) {
      photo.data.set(commitLiquify(liquifyRef.current, photo))
      liquifyRef.current = null
    }
    if (maskRef.current) maskRef.current = null
    store.commit('Photo edit', bakeSession(bitmap, photo))
  }

  async function applyEnvelopePreset(point: Vec): Promise<void> {
    const store = useStore.getState()
    const s = stateRef.current
    const objects = collectObjects(s.doc, s.selection).filter((o): o is VectorObject => o.kind === 'vector')
    if (!objects.length) { store.toast('info', 'Select a curve', 'Envelopes need at least one vector object.'); return }
    const preset = ENVELOPE_PRESETS[Math.abs(Math.round(point.x + point.y)) % ENVELOPE_PRESETS.length]
    const envelope = { ...envelopePreset(preset.id), strength: 1 }
    for (const object of objects) {
      store.commit('Envelope', (d) => updateObjects(d, [object.id], () => ({ ...object, envelope, path: applyEnvelope(object.path, envelope) })))
    }
    store.setTool('pick')
  }

  function sampleCanvas(point: Vec): { r: number; g: number; b: number; a: number } | null {
    const ctx = artworkRef.current?.getContext('2d')
    if (!ctx) return null
    const { view: v } = stateRef.current
    try {
      const data = ctx.getImageData(Math.round(point.x * v.zoom + v.panX), Math.round(point.y * v.zoom + v.panY), 1, 1).data
      return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 }
    } catch {
      return null
    }
  }

  /* --------------------------------------------------------------- events -- */

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const store = useStore.getState()
    const s = stateRef.current
    if (event.ctrlKey || event.metaKey) {
      const { doc: point } = canvasPoint(event)
      store.zoomTo(s.view.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), point)
    } else if (event.shiftKey) {
      store.setView({ panX: s.view.panX - event.deltaY })
    } else {
      store.setView({ panX: s.view.panX - event.deltaX, panY: s.view.panY - event.deltaY })
    }
  }

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { doc: point } = canvasPoint(event)
    const store = useStore.getState()
    const s = stateRef.current
    const hit = hitTest(s.page, point, tolerance(), s.doc, true)
    if (!hit) return
    if (hit.object.kind === 'text') {
      store.setSelection([hit.object.id])
      store.setEditingText(hit.object.id)
    } else if (hit.object.kind === 'vector') {
      store.setTool('shape')
      store.setSelection([hit.object.id])
      store.setNodeSelection([{ sub: 0, index: 0 }])
    } else if (hit.object.kind === 'bitmap') {
      store.setSelection([hit.object.id])
      store.setDocker('adjustments', true)
    } else if (hit.object.kind === 'group') {
      store.setSelection(hit.object.children.map((c) => c.id))
    }
  }

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const { doc: point } = canvasPoint(event)
    const store = useStore.getState()
    const s = stateRef.current
    const hit = hitTest(s.page, point, tolerance(), s.doc, true)
    if (hit && !s.selection.includes(hit.object.id)) store.setSelection([hit.object.id])
    if (!hit && event.altKey) store.addGuide(event.shiftKey ? 'y' : 'x', event.shiftKey ? point.y : point.x)
    store.setStatus(hit ? `${hit.object.name} — use the property bar and dockers for commands` : 'No object under the pointer')
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
      if (event.code === 'Space' && !typing) { spaceRef.current = true; setPanning(true) }
      if (typing) return
      const store = useStore.getState()
      if (event.key === 'Escape') {
        if (penRef.current) { penRef.current = null; dragRef.current = null } else store.clearSelection()
        return
      }
      if (event.key === 'Enter' && penRef.current) { penRef.current = null; dragRef.current = null; return }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.ctrlKey && !event.metaKey) {
        const object = collectObjects(stateRef.current.doc, store.selection).find((o): o is VectorObject => o.kind === 'vector')
        if (object && store.nodeSelection.length) {
          let path = object.path
          for (const entry of [...store.nodeSelection].sort((a, b) => b.index - a.index)) {
            if ((path.subpaths[entry.sub]?.nodes.length ?? 0) > 2) path = deleteNode(path, entry.sub, entry.index)
          }
          store.commit('Delete nodes', (d) => updateObjects(d, [object.id], () => ({ ...object, path })))
          store.setNodeSelection([])
        } else if (store.selection.length) {
          store.deleteSelection()
        }
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') { spaceRef.current = false; setPanning(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (penRef.current) return
    dragRef.current = null
    scheduleDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool])

  /* --------------------------------------------------------------- render -- */

  const editingText = editingTextId ? collectObjects(doc, [editingTextId])[0] : undefined
  const rulers = view.showRulers
  const cursor = panning ? 'grab' : cursorFor(tool)

  return (
    <div className={`canvas-wrap ${panning ? 'panning' : ''}`} ref={wrapRef}>
      <canvas ref={artworkRef} className="stage artwork" style={{ left: rulers ? RULER : 0, top: rulers ? RULER : 0, width: size.w, height: size.h }} aria-hidden />
      <canvas
        ref={overlayRef}
        className="stage interactive"
        style={{ left: rulers ? RULER : 0, top: rulers ? RULER : 0, width: size.w, height: size.h, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {rulers ? <Rulers width={size.w} height={size.h} view={view} /> : null}
      {editingText && editingText.kind === 'text' ? <TextEditor object={editingText} /> : null}
      <div className="zoom-hud">
        <button type="button" className="sbtn" onClick={() => useStore.getState().zoomTo(view.zoom / 1.25)} aria-label="Zoom out"><Icon name="zoom-out" size={13} /></button>
        <span>{(view.zoom * 100).toFixed(0)}%</span>
        <button type="button" className="sbtn" onClick={() => useStore.getState().zoomTo(view.zoom * 1.25)} aria-label="Zoom in"><Icon name="zoom-in" size={13} /></button>
        <button type="button" className="sbtn" onClick={() => fitPage(size, page, useStore.getState().setView)}>Fit</button>
      </div>
      {penRef.current ? <div className="canvas-hint">Click to add nodes · drag for handles · click the first node to close · Enter/Esc to finish</div> : null}
    </div>
  )
}

/* ---------------------------------------------------------------- helpers -- */

function unionBounds(bounds: ({ x: number; y: number; w: number; h: number } | null)[], dx: number, dy: number) {
  let out: { x: number; y: number; w: number; h: number } | null = null
  for (const b of bounds) {
    if (!b) continue
    const moved = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }
    if (!out) { out = moved; continue }
    const x = Math.min(out.x, moved.x)
    const y = Math.min(out.y, moved.y)
    out = { x, y, w: Math.max(out.x + out.w, moved.x + moved.w) - x, h: Math.max(out.y + out.h, moved.y + moved.h) - y }
  }
  return out
}

function boundsOfPoints(points: Vec[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function pointInPolygon(point: Vec, polygon: Vec[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-9) + a.x) inside = !inside
  }
  return inside
}

function titleCase(value: string): string {
  return value.replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function cursorFor(tool: string): string {
  if (tool === 'pan') return 'grab'
  if (tool === 'zoom') return 'zoom-in'
  if (['pen', 'bezier', 'polyline', 'freehand', 'brush', 'liveSketch', 'line2', 'curve3', 'variableOutline', 'symmetry', 'rectangle', 'ellipse', 'polygon', 'star', 'complexStar', 'graphPaper', 'spiral', 'crop', 'text', 'table', 'rect3', 'ellipse3', 'bspline'].includes(tool)) return 'crosshair'
  if (['smudge', 'roughen', 'twirl', 'attract', 'repel', 'smear', 'liquify', 'clone', 'maskBrush', 'cutout', 'bgRemove', 'blurBrush', 'sharpenBrush', 'dodgeBrush', 'burnBrush', 'enhance', 'colorReplace'].includes(tool)) return 'none'
  return 'default'
}

function fitPage(size: { w: number; h: number }, page: Page, setView: (patch: Partial<ViewState>) => void): void {
  const padding = 48
  const zoom = Math.min((size.w - padding) / page.size.w, (size.h - padding) / page.size.h)
  setView({ zoom, panX: (size.w - page.size.w * zoom) / 2, panY: (size.h - page.size.h * zoom) / 2 })
}

function Rulers({ width, height, view }: { width: number; height: number; view: ViewState }) {
  const horizontalRef = useRef<HTMLCanvasElement>(null)
  const verticalRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
    const render = (canvas: HTMLCanvasElement | null, horizontal: boolean) => {
      if (!canvas) return
      canvas.width = Math.round((horizontal ? width : RULER) * dpr)
      canvas.height = Math.round((horizontal ? RULER : height) * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, horizontal ? width : RULER, horizontal ? RULER : height)
      ctx.fillStyle = '#20242a'
      ctx.fillRect(0, 0, horizontal ? width : RULER, horizontal ? RULER : height)
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.fillStyle = 'rgba(230,236,242,0.78)'
      ctx.font = '9px system-ui, sans-serif'
      ctx.beginPath()
      const start = (horizontal ? -view.panX : -view.panY) / view.zoom
      const span = (horizontal ? width : height) / view.zoom
      const step = niceStep(span / 9)
      const first = Math.floor(start / step) * step
      for (let value = first; value <= start + span + step; value += step) {
        const screen = value * view.zoom + (horizontal ? view.panX : view.panY)
        if (horizontal) {
          ctx.moveTo(screen, RULER - 6)
          ctx.lineTo(screen, RULER)
          ctx.fillText(String(Math.round(value)), screen + 2, 9)
        } else {
          ctx.moveTo(RULER - 6, screen)
          ctx.lineTo(RULER, screen)
          ctx.save()
          ctx.translate(8, screen - 2)
          ctx.rotate(-Math.PI / 2)
          ctx.fillText(String(Math.round(value)), 0, 0)
          ctx.restore()
        }
      }
      ctx.stroke()
    }
    render(horizontalRef.current, true)
    render(verticalRef.current, false)
  }, [width, height, view])
  return (
    <>
      <canvas ref={horizontalRef} className="ruler h" style={{ left: RULER, width }} />
      <canvas ref={verticalRef} className="ruler v" style={{ top: RULER, height }} />
      <div className="ruler-corner" />
    </>
  )
}

function niceStep(value: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, value))))
  const normalized = value / power
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return factor * power
}

export type { Fill, Stroke, PathNode }
