/**
 * The collapsible docker stack: Object properties, Colour, Layers, Pages,
 * Effects, photo Adjustments/Masking/Retouch, Text, Brush, History, Print,
 * Shaping and Symbols.
 *
 * Dockers are the only place that mutates the document from the UI besides the
 * canvas, and every mutation goes through the store's `commit`, so anything a
 * docker does is undoable.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Adjustment, BitmapObject, BlendMode, ColorStyle, Effect, Fill, ID, NonDestructive, SceneObject } from '../types'
import { useStore, type DockerID } from '../store/store'
import { EFFECT_DEFS, effectDef, makeAdjustment, makeEffect, runStack, stackSignature, BLEND_OPTIONS } from '../engine/effects'
import { PHOTO_PRESETS, photoStats, applyLensCorrection, blurMask, correctPerspective, removeJpegArtifacts, selectSubject, selectionAll, selectionGrow, selectionInvert, selectionShrink, replaceColor, removeBackground, healBrush, DEFAULT_COLOR_REPLACE, DEFAULT_BG_REMOVAL, presetById } from '../lib/photo'
import { BRUSH_PRESETS, pushMediaTray, loadMediaTray, presetByID } from '../engine/brush'
import { combinePaths, booleanPath, simplifyPath, paperDistort, type BooleanOp } from '../engine/boolean'
import { PALETTES, HARMONIES, harmonyColors, fillPrimaryColor, withPrimaryColor, css, hex, nearestColor, colorName } from '../lib/color'
import { PAGE_PRESETS, addColorStyle, addMasterLayer, deletePage, duplicatePage, reorderObject, setPageSize, updateObject, documentColors } from '../store/mutations'
import { textLayoutOf } from '../engine/render'
import { fonts } from '../lib/text'
import { bakeSession, findBitmap, openSession, peekSession } from './photoSession'
import { openSession as openPhotoSession } from './photoSession'
import { bytesToImageData, ImageKernels } from '../lib/wasm'
import { CurveEditor, Docker, EmptyState, Histogram, IconButton, Popover, Select, Slider, Tabs, Button, Check, NumberField, Row, Col, ColorPicker, splineAt } from './widgets'
import { setToolOptions, useToolOptions } from './toolOptions'
import { clamp, uid } from '../lib/util'

/* ================================================================= object === */

export function ObjectDocker() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const commit = useStore((s) => s.commit)
  const objects = useStore((s) => s.selectedObjects)()
  const [layerTab, setLayerTab] = useState<'object' | 'effects' | 'powerclip'>('object')
  const obj = objects[0]

  if (!obj) return <Docker id="object" title="Object properties"><EmptyState text="Select an object to edit its properties" icon="shape" /></Docker>

  const set = (patch: Partial<SceneObject>) => commit('Object properties', (d) => updateObject(d, obj.id, (o) => ({ ...o, ...patch } as SceneObject)))

  return (
    <Docker id="object" title="Object properties">
      <Tabs value={layerTab} onChange={setLayerTab} options={[{ value: 'object', label: 'Object' }, { value: 'effects', label: 'Effects' }, { value: 'powerclip', label: 'PowerClip' }]} />
      {layerTab === 'object' ? (
        <>
          <label className="row"><span className="lbl">Name</span><input className="field grow" value={obj.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <div className="grid2">
            <label className="col"><span className="lbl">X</span><NumberField value={round(obj.transform.e)} onChange={(v) => set({ transform: { ...obj.transform, e: v } })} /></label>
            <label className="col"><span className="lbl">Y</span><NumberField value={round(obj.transform.f)} onChange={(v) => set({ transform: { ...obj.transform, f: v } })} /></label>
            <label className="col"><span className="lbl">Rotation</span><NumberField value={round(rotationOf(obj))} onChange={(v) => rotateObject(obj, v - rotationOf(obj))} suffix="°" /></label>
            <label className="col"><span className="lbl">Scale</span><NumberField value={round(scaleOf(obj))} onChange={(v) => scaleObject(obj, v)} suffix="×" /></label>
          </div>
          <Slider label="Opacity" value={obj.opacity} min={0} max={1} step={0.01} onChange={(v) => set({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <label className="row"><span className="lbl">Merge mode</span>
            <Select value={obj.blend} width={150} onChange={(v) => set({ blend: v as BlendMode })} options={BLEND_OPTIONS.map((b) => ({ value: b.value, label: b.label }))} />
          </label>
          <div className="row">
            <Check label="Visible" checked={obj.visible} onChange={(v) => set({ visible: v })} />
            <Check label="Locked" checked={obj.locked} onChange={(v) => set({ locked: v })} />
          </div>
          <div className="sep" />
          <Row wrap>
            <Button small onClick={() => reorder('front')}>To front</Button>
            <Button small onClick={() => reorder('back')}>To back</Button>
            <Button small onClick={() => reorder('forward')}>Forward</Button>
            <Button small onClick={() => reorder('backward')}>Backward</Button>
          </Row>
          {obj.kind === 'vector' ? (
            <Row wrap>
              <Button small onClick={() => useStore.getState().duplicateSelection()}>Duplicate</Button>
              <Button small onClick={() => useStore.getState().deleteSelection()} variant="danger">Delete</Button>
              <span className="badge">{obj.path.subpaths.reduce((n, sp) => n + sp.nodes.length, 0)} nodes</span>
            </Row>
          ) : null}
        </>
      ) : null}
      {layerTab === 'effects' ? <EffectsEditor objectId={obj.id} /> : null}
      {layerTab === 'powerclip' ? <PowerClipPanel objectId={obj.id} /> : null}
      <span hidden>{doc.version}</span>
    </Docker>
  )
}

function PowerClipPanel({ objectId }: { objectId: ID }) {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const commit = useStore((s) => s.commit)
  const powerClip = useStore((s) => s.powerClip)
  const setPowerClip = useStore((s) => s.setPowerClip)
  const frame = findObjectById(doc, powerClip ?? objectId)
  const contents = useMemo(() => doc.pages.flatMap((p) => p.layers.flatMap((l) => l.objects)).filter((o) => o.clip?.powerClip && o.clip.id === (powerClip ?? objectId)), [doc, powerClip, objectId])
  return (
    <div className="col">
      <p className="tiny">PowerClip places objects inside a frame: select the frame plus the content, then choose Place inside. Content is clipped to the frame shape and stays editable.</p>
      <Row wrap>
        <Button small disabled={selection.length < 2} onClick={() => {
          const frameId = selection[0]
          const rest = selection.slice(1)
          commit('Place in PowerClip', (d) => {
            let next = d
            for (const id of rest) next = updateObject(next, id, (o) => ({ ...o, clip: { id: frameId, powerClip: true } }))
            return next
          }, { selection: [frameId] })
          setPowerClip(frameId)
        }}>Place inside</Button>
        <Button small disabled={!powerClip || !contents.length} onClick={() => {
          commit('Extract PowerClip', (d) => {
            let next = d
            for (const o of contents) next = updateObject(next, o.id, (obj) => ({ ...obj, clip: undefined }))
            return next
          })
          setPowerClip(null)
        }}>Extract contents</Button>
        <Button small disabled={!powerClip} onClick={() => setPowerClip(null)}>Finish editing</Button>
      </Row>
      <span className="badge">{contents.length} object(s) inside {frame?.name ?? 'frame'}</span>
      {contents.map((o) => (
        <div key={o.id} className="list-row">
          <span className="name">{o.name}</span>
          <IconButton icon="download" title="Extract this object" onClick={() => commit('Extract object', (d) => updateObject(d, o.id, (obj) => ({ ...obj, clip: undefined })))} />
        </div>
      ))}
    </div>
  )
}

function reorder(direction: 'front' | 'back' | 'forward' | 'backward') {
  const state = useStore.getState()
  const page = state.doc.pages.find((p) => p.id === state.doc.activePageId) ?? state.doc.pages[0]
  const id = state.selection[0]
  if (!id) return
  for (const layer of page.layers) {
    const index = layer.objects.findIndex((o) => o.id === id)
    if (index < 0) continue
    const target = direction === 'front' ? layer.objects.length - 1
      : direction === 'back' ? 0
        : direction === 'forward' ? Math.min(layer.objects.length - 1, index + 1)
          : Math.max(0, index - 1)
    state.commit('Reorder', (d) => reorderObject(d, page.id, layer.id, id, target))
    return
  }
}

/* ================================================================= colour === */

export function ColorDocker() {
  const fillColor = useStore((s) => s.fillColor)
  const strokeColor = useStore((s) => s.strokeColor)
  const setFillColor = useStore((s) => s.setFillColor)
  const setStrokeColor = useStore((s) => s.setStrokeColor)
  const applyFill = useStore((s) => s.applyFillToSelection)
  const applyStroke = useStore((s) => s.applyStrokeToSelection)
  const doc = useStore((s) => s.doc)
  const commit = useStore((s) => s.commit)
  const selection = useStore((s) => s.selection)
  const [target, setTarget] = useState<'fill' | 'stroke'>('fill')
  const [tab, setTab] = useState<'picker' | 'palettes' | 'styles' | 'harmony'>('picker')
  const [paletteId, setPaletteId] = useState(PALETTES[0].id)
  const color = target === 'fill' ? fillColor : strokeColor
  const setColor = target === 'fill' ? setFillColor : setStrokeColor
  const palette = PALETTES.find((p) => p.id === paletteId) ?? PALETTES[0]

  return (
    <Docker id="color" title="Colour">
      <Tabs value={tab} onChange={setTab} options={[{ value: 'picker', label: 'Mixer' }, { value: 'palettes', label: 'Palettes' }, { value: 'styles', label: 'Styles' }, { value: 'harmony', label: 'Harmony' }]} />
      <div className="row">
        <button type="button" className={`chip ${target === 'fill' ? 'on' : ''}`} onClick={() => setTarget('fill')}>
          <span className="swatch" style={{ width: 12, height: 12, background: css(fillColor) }} /> Fill
        </button>
        <button type="button" className={`chip ${target === 'stroke' ? 'on' : ''}`} onClick={() => setTarget('stroke')}>
          <span className="swatch" style={{ width: 12, height: 12, background: css(strokeColor) }} /> Outline
        </button>
        <Button small onClick={() => {
          const tmp = fillColor
          setFillColor(strokeColor)
          setStrokeColor(tmp)
        }} icon="swap" title="Swap fill and outline" />
      </div>

      {tab === 'picker' ? (
        <>
          <ColorPicker value={color} onChange={setColor} />
          <Row>
            <Button small onClick={() => {
              if (target === 'fill') applyFill({ type: 'uniform', color })
              else applyStroke({ color })
            }} disabled={!selection.length}>Apply to selection</Button>
            <Button small onClick={() => { setFillColor(color); setStrokeColor(color); applyFill({ type: 'uniform', color }); applyStroke({ color }) }} disabled={!selection.length}>Both</Button>
          </Row>
          <div className="col">
            <label className="row"><span className="lbl">Fill type</span></label>
            <Row wrap>
              <Button small onClick={() => applyFill({ type: 'uniform', color })} disabled={!selection.length}>Uniform</Button>
              <Button small onClick={() => applyFill({ type: 'none' })} disabled={!selection.length}>None</Button>
              <Button small onClick={() => applyFill({ type: 'fountain', fountain: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [{ offset: 0, color }, { offset: 1, color: { ...color, a: 0 } }], angle: 90, spread: 'pad', edgePad: 0 })} disabled={!selection.length}>Fountain</Button>
              <Button small onClick={() => applyFill({ type: 'pattern', pattern: 'vector', preset: 'dots', fg: color, bg: { ...color, a: 1 }, scale: 1, rotation: 0, tileSize: 24 })} disabled={!selection.length}>Pattern</Button>
              <Button small onClick={() => applyFill({ type: 'texture', preset: 'canvas', fg: color, bg: { r: 255, g: 255, b: 255, a: 1 }, scale: 1, seed: 7 })} disabled={!selection.length}>Texture</Button>
            </Row>
          </div>
        </>
      ) : null}

      {tab === 'palettes' ? (
        <>
          <Select value={paletteId} onChange={setPaletteId} options={PALETTES.map((p) => ({ value: p.id, label: `${p.name} (${p.colors.length})` }))} />
          <div className="swatch-row">
            {palette.colors.map((c, i) => (
              <button
                key={`${palette.id}-${i}`}
                type="button"
                className="swatch-pick"
                style={{ background: c }}
                title={`${hex({ r: 0, g: 0, b: 0, a: 1 })} ${colorName({ ...hexToRgbLocal(c), a: 1 })}`}
                onClick={() => {
                  const parsed = hexToRgbLocal(c)
                  setColor({ ...parsed, a: 1 })
                }}
              />
            ))}
          </div>
          <div className="row between">
            <span className="tiny">{palette.group ?? 'Palette'}</span>
            <Button small onClick={() => {
              const parsed = hexToRgbLocal(palette.colors[0] ?? '#000000')
              setColor({ ...parsed, a: 1 })
            }}>Use first</Button>
          </div>
          <div className="sep" />
          <span className="lbl">Document palette — colours used in this document</span>
          <div className="swatch-row">
            {documentColors(doc).slice(0, 64).map((c, i) => (
              <button key={i} type="button" className="swatch-pick" style={{ background: css(c) }} title={`${hex(c)} ${colorName(c)}`} onClick={() => setColor(c)} />
            ))}
          </div>
        </>
      ) : null}

      {tab === 'styles' ? (
        <ColorStylesPanel />
      ) : null}

      {tab === 'harmony' ? (
        <HarmonyPanel color={color} onPick={setColor} onApply={(colors) => {
          applyFill({ type: 'fountain', fountain: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, stops: colors.map((c, i) => ({ offset: i / Math.max(1, colors.length - 1), color: c })), angle: 0, spread: 'pad', edgePad: 0 })
          commit('Colour harmony', (d) => d)
        }} />
      ) : null}
    </Docker>
  )
}

function hexToRgbLocal(hexValue: string) {
  const clean = hexValue.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const value = Number.parseInt(full, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

function ColorStylesPanel() {
  const doc = useStore((s) => s.doc)
  const commit = useStore((s) => s.commit)
  const fillColor = useStore((s) => s.fillColor)
  const selection = useStore((s) => s.selection)
  const applyFill = useStore((s) => s.applyFillToSelection)
  return (
    <div className="col">
      <Row>
        <Button small variant="primary" onClick={() => commit('Add colour style', (d) => addColorStyle(d, { name: colorName(fillColor), color: fillColor, kind: 'process' }))}>Add current colour</Button>
      </Row>
      {doc.colorStyles.length === 0 ? <EmptyState text="No colour styles yet" icon="palette" /> : null}
      <div className="list">
        {doc.colorStyles.map((style) => (
          <div className="list-row" key={style.id}>
            <span className="swatch" style={{ width: 16, height: 16, background: css(style.color) }} />
            <span className="name">{style.name}</span>
            <span className="meta">{style.kind}</span>
            <IconButton icon="download" title="Apply to selection" disabled={!selection.length} onClick={() => applyFill({ type: 'uniform', color: style.color })} />
            <IconButton icon="refresh" title="Update from fill colour" onClick={() => commit('Update colour style', (d) => ({ ...d, colorStyles: d.colorStyles.map((s) => (s.id === style.id ? { ...s, color: fillColor } : s)) }))} />
            <IconButton icon="delete" title="Delete" onClick={() => commit('Delete colour style', (d) => ({ ...d, colorStyles: d.colorStyles.filter((s) => s.id !== style.id) }))} />
          </div>
        ))}
      </div>
    </div>
  )
}

function HarmonyPanel({ color, onPick, onApply }: { color: { r: number; g: number; b: number; a: number }; onPick: (c: { r: number; g: number; b: number; a: number }) => void; onApply: (colors: { r: number; g: number; b: number; a: number }[]) => void }) {
  const [kind, setKind] = useState(HARMONIES[0].id)
  const [count, setCount] = useState(5)
  const colors = useMemo(() => harmonyColors(color, kind, count), [color, kind, count])
  return (
    <div className="col">
      <Select value={kind} onChange={setKind} options={HARMONIES.map((h) => ({ value: h.id, label: h.label }))} />
      <span className="tiny">{HARMONIES.find((h) => h.id === kind)?.hint}</span>
      <Slider label="Swatches" value={count} min={3} max={12} step={1} onChange={setCount} />
      <div className="swatch-row">
        {colors.map((c, i) => (
          <button key={i} type="button" className="swatch-pick" style={{ background: css(c) }} title={hex(c)} onClick={() => onPick(c)} />
        ))}
      </div>
      <Button small onClick={() => onApply(colors)}>Apply as fountain fill</Button>
    </div>
  )
}

/* ================================================================= layers === */

export function LayersDocker() {
  const doc = useStore((s) => s.doc)
  const commit = useStore((s) => s.commit)
  const activeLayerId = useStore((s) => s.activeLayerId)
  const setActiveLayer = useStore((s) => s.setActiveLayer)
  const selection = useStore((s) => s.selection)
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const [renaming, setRenaming] = useState<ID | null>(null)

  const update = (layerId: ID, patch: Partial<typeof page.layers[number]>) =>
    commit('Layer properties', (d) => ({
      ...d,
      pages: d.pages.map((p) => (p.id === page.id ? { ...p, layers: p.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)) } : p)),
    }))

  return (
    <Docker id="layers" title={`Layers — ${page.name}`}>
      <Row>
        <Button small icon="plus" onClick={() => commit('Add layer', (d) => ({
          ...d,
          pages: d.pages.map((p) => (p.id === page.id ? { ...p, layers: [...p.layers, { ...p.layers[0], id: uid('layer'), name: `Layer ${p.layers.length + 1}`, objects: [] }] } : p)),
        }))}>Layer</Button>
        <Button small icon="plus" onClick={() => commit('Add master layer', (d) => addMasterLayer(d, `Master ${countMasters(d) + 1}`))}>Master</Button>
        <span className="badge">{page.layers.length} layers</span>
      </Row>
      <div className="list">
        {[...page.layers].reverse().map((layer) => (
          <div key={layer.id} className={`list-row ${layer.id === activeLayerId ? 'on' : ''}`} onClick={() => setActiveLayer(layer.id)}>
            <IconButton icon={layer.visible ? 'eye' : 'eye-off'} title="Show / hide" onClick={() => update(layer.id, { visible: !layer.visible })} />
            <IconButton icon={layer.locked ? 'lock' : 'unlock'} title="Lock / unlock" onClick={() => update(layer.id, { locked: !layer.locked })} />
            {renaming === layer.id ? (
              <input
                className="field grow"
                autoFocus
                defaultValue={layer.name}
                onBlur={(e) => { update(layer.id, { name: e.target.value }); setRenaming(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            ) : (
              <span className="name" onDoubleClick={() => setRenaming(layer.id)}>{layer.name}{layer.kind === 'master' ? ' ★' : ''}</span>
            )}
            <span className="meta">{layer.objects.length}</span>
          </div>
        ))}
      </div>
      <div className="sep" />
      <span className="lbl">Objects on this page</span>
      <div className="list" style={{ maxHeight: 220 }}>
        {page.layers.flatMap((layer) => layer.objects.map((obj) => ({ obj, layer }))).reverse().map(({ obj, layer }) => (
          <div key={obj.id} className={`list-row ${selection.includes(obj.id) ? 'on' : ''}`} onClick={() => useStore.getState().select([obj.id], false)}>
            <span className="name" title={`${obj.kind} in ${layer.name}`}>{kindGlyph(obj.kind)} {obj.name}</span>
            <IconButton icon={obj.visible ? 'eye' : 'eye-off'} title="Visible" onClick={() => commit('Toggle visibility', (d) => updateObject(d, obj.id, (o) => ({ ...o, visible: !o.visible })))} />
            <IconButton icon={obj.locked ? 'lock' : 'unlock'} title="Locked" onClick={() => commit('Toggle lock', (d) => updateObject(d, obj.id, (o) => ({ ...o, locked: !o.locked })))} />
            <IconButton icon="delete" title="Delete" onClick={() => commit('Delete object', (d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, layers: p.layers.map((l) => (l.id === layer.id ? { ...l, objects: l.objects.filter((o) => o.id !== obj.id) } : l)) })) }))} />
          </div>
        ))}
      </div>
    </Docker>
  )
}

function countMasters(doc: ReturnType<typeof useStore.getState>['doc']): number {
  return doc.pages.reduce((max, p) => Math.max(max, p.masters.length), 0)
}

function kindGlyph(kind: SceneObject['kind']): string {
  return kind === 'vector' ? '◈' : kind === 'text' ? 'T' : kind === 'bitmap' ? '▩' : '❏'
}

/* ================================================================== pages === */

export function PagesDocker() {
  const doc = useStore((s) => s.doc)
  const commit = useStore((s) => s.commit)
  const activePageId = doc.activePageId
  const page = doc.pages.find((p) => p.id === activePageId) ?? doc.pages[0]
  const setActivePage = useStore((s) => s.setActivePage)
  const [presetId, setPresetId] = useState('a4')

  return (
    <Docker id="pages" title="Pages">
      <Row wrap>
        <Button small icon="plus" onClick={() => useStore.getState().addPage()}>Add</Button>
        <Button small icon="duplicate" onClick={() => duplicatePageAndCommit()}>Duplicate</Button>
        <Button small icon="delete" variant="danger" disabled={doc.pages.length < 2} onClick={() => commit('Delete page', (d) => deletePage(d, page.id))}>Delete</Button>
      </Row>
      <div className="list" style={{ maxHeight: 320 }}>
        {doc.pages.map((p, i) => (
          <div key={p.id} className={`list-row ${p.id === activePageId ? 'on' : ''}`} onClick={() => setActivePage(p.id)}>
            <span className="badge">{i + 1}</span>
            <span className="name">{p.name}</span>
            <span className="meta">{Math.round(p.size.w)}×{Math.round(p.size.h)}</span>
          </div>
        ))}
      </div>
      <div className="sep" />
      <span className="lbl">Page size</span>
      <Select value={presetId} onChange={setPresetId} options={PAGE_PRESETS.map((p) => ({ value: p.id, label: p.label }))} />
      <Row>
        <Button small onClick={() => {
          const preset = PAGE_PRESETS.find((p) => p.id === presetId)!
          commit('Page size', (d) => setPageSize(d, page.id, preset.w, preset.h, preset.unit))
        }}>Apply preset</Button>
        <Button small onClick={() => commit('Orientation', (d) => setPageSize(d, page.id, page.size.h, page.size.w, page.size.unit))} icon="swap" title="Rotate page 90°" />
      </Row>
      <div className="grid3">
        <label className="col"><span className="lbl">Width</span><NumberField value={round(page.size.w)} onChange={(v) => commit('Page size', (d) => setPageSize(d, page.id, v, page.size.h, page.size.unit))} /></label>
        <label className="col"><span className="lbl">Height</span><NumberField value={round(page.size.h)} onChange={(v) => commit('Page size', (d) => setPageSize(d, page.id, page.size.w, v, page.size.unit))} /></label>
        <label className="col"><span className="lbl">Bleed</span><NumberField value={round(page.bleed)} onChange={(v) => commit('Bleed', (d) => ({ ...d, pages: d.pages.map((pg) => (pg.id === page.id ? { ...pg, bleed: v } : pg)) }))} /></label>
      </div>
      <label className="row"><span className="lbl">Background</span>
        <input type="color" value={css(page.background)} onChange={(e) => {
          const parsed = hexToRgbLocal(e.target.value)
          commit('Page background', (d) => ({ ...d, pages: d.pages.map((pg) => (pg.id === page.id ? { ...pg, background: { ...parsed, a: 1 } } : pg)) }))
        }} />
      </label>
      <div className="sep" />
      <span className="lbl">Guides ({page.guides.length})</span>
      <Row wrap>
        <Button small onClick={() => useStore.getState().addGuide('x', page.size.w / 2)}>Centre X</Button>
        <Button small onClick={() => useStore.getState().addGuide('y', page.size.h / 2)}>Centre Y</Button>
        <Button small onClick={() => commit('Clear guides', (d) => ({ ...d, pages: d.pages.map((pg) => (pg.id === page.id ? { ...pg, guides: [] } : pg)) }))}>Clear</Button>
      </Row>
      <span className="tiny">Click a ruler to drop a guide; drag objects near guides and other objects to snap.</span>
    </Docker>
  )
}

function duplicatePageAndCommit() {
  const state = useStore.getState()
  const id = state.doc.activePageId
  state.commit('Duplicate page', (d) => duplicatePage(d, id))
  const next = useStore.getState().doc
  const index = next.pages.findIndex((p) => p.id === id)
  setActivePageSafe(next.pages[Math.min(next.pages.length - 1, index + 1)]?.id)
}

function setActivePageSafe(id?: ID) {
  if (id) useStore.getState().setActivePage(id)
}

/* ================================================================ effects === */

export function EffectsDocker() {
  const selection = useStore((s) => s.selection)
  return (
    <Docker id="effects" title="Effects">
      {selection.length ? <EffectsEditor objectId={selection[0]} allowAdd /> : <EmptyState text="Select an object to add live effects" icon="effects" />}
    </Docker>
  )
}

function EffectsEditor({ objectId, allowAdd = true }: { objectId: ID; allowAdd?: boolean }) {
  const doc = useStore((s) => s.doc)
  const commit = useStore((s) => s.commit)
  const object = useMemo(() => findObjectById(doc, objectId), [doc, objectId])
  const [adding, setAdding] = useState(false)

  if (!object) return <EmptyState text="Object not found" />
  const stack = object.effects

  const update = (updater: (effects: NonDestructive[]) => NonDestructive[]) =>
    commit('Effect', (d) => updateObject(d, objectId, (o) => ({ ...o, effects: updater(o.effects) })))

  return (
    <div className="col">
      {stack.length === 0 ? <EmptyState text="No live effects on this object" icon="effects" /> : null}
      {stack.map((entry, index) => {
        const def = effectDef(entry.kind)
        return (
          <div key={entry.id} className="col" style={{ gap: 4, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <Row>
              <Check label="" checked={entry.enabled} onChange={(v) => update((fx) => fx.map((f, i) => (i === index ? { ...f, enabled: v } : f)))} />
              <span className="grow small">{def?.label ?? entry.kind}</span>
              <IconButton icon="chevron" title="Move up" onClick={() => update((fx) => move(fx, index, -1))} />
              <IconButton icon="plus" title="Move down" onClick={() => update((fx) => move(fx, index, 1))} />
              <IconButton icon="close" title="Remove" onClick={() => update((fx) => fx.filter((_, i) => i !== index))} />
            </Row>
            <Slider label="Effect opacity" value={entry.opacity} min={0} max={1} step={0.01} onChange={(v) => update((fx) => fx.map((f, i) => (i === index ? { ...f, opacity: v } : f)))} format={(v) => `${Math.round(v * 100)}%`} />
            <label className="row"><span className="lbl">Merge</span>
              <Select value={entry.blend} width={130} onChange={(v) => update((fx) => fx.map((f, i) => (i === index ? { ...f, blend: v as BlendMode } : f)))} options={BLEND_OPTIONS.map((b) => ({ value: b.value, label: b.label }))} />
            </label>
            {def?.hint ? <span className="tiny">{def.hint}</span> : null}
            {def?.params.map((param) => (
              <ParamEditor
                key={param.key}
                param={param}
                value={(entry.params as Record<string, unknown>)[param.key]}
                onChange={(value) => update((fx) => fx.map((f, i) => (i === index ? ({ ...f, params: { ...(f.params as Record<string, unknown>), [param.key]: value } } as NonDestructive) : f)))}
              />
            ))}
          </div>
        )
      })}
      {allowAdd ? (
        <Row>
          <Button small icon="plus" onClick={() => setAdding((a) => !a)}>Add effect</Button>
        </Row>
      ) : null}
      {adding ? (
        <div className="col" style={{ maxHeight: 260, overflow: 'auto' }}>
          {EFFECT_DEFS.map((def) => (
            <button
              key={def.kind}
              type="button"
              className="list-row"
              onClick={() => {
                const isAdjustment = ['brightness-contrast', 'tone-curve', 'hue-curve', 'levels', 'vibrance', 'color-balance', 'channel-mixer', 'desaturate', 'posterize', 'threshold', 'gamma', 'selective-color'].includes(def.kind)
                const entry: NonDestructive = isAdjustment
                  ? makeAdjustment(def.kind as Adjustment['kind'], uid('adj'))
                  : makeEffect(def.kind as Effect['kind'], uid('fx'))
                update((fx) => [...fx, entry])
                setAdding(false)
              }}
            >
              <span className="name">{def.label}</span>
              <span className="badge">{def.group}</span>
            </button>
          ))}
        </div>
      ) : null}
      <Button small onClick={() => useStore.getState().toast('info', `${stack.length} effect(s)`, 'Effects render on the rasterised object and stay editable.')} icon="info">Stack info</Button>
    </div>
  )
}

function move<T>(arr: T[], index: number, delta: number): T[] {
  const target = clamp(index + delta, 0, arr.length - 1)
  if (target === index) return arr
  const next = [...arr]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}

function ParamEditor({ param, value, onChange }: { param: ReturnType<typeof effectDef> extends infer D ? any : never; value: unknown; onChange: (v: unknown) => void }) {
  switch (param.type) {
    case 'slider':
    case 'angle':
      return <Slider label={param.label} value={Number(value ?? param.default)} min={param.min ?? 0} max={param.max ?? 1} step={param.step ?? 0.01} onChange={(v) => onChange(v)} unit={param.unit} />
    case 'number':
      return (
        <label className="row between"><span className="lbl">{param.label}</span>
          <NumberField value={Number(value ?? param.default)} min={param.min} max={param.max} step={param.step ?? 1} onChange={onChange} />
        </label>
      )
    case 'checkbox':
      return <Check label={param.label} checked={Boolean(value ?? param.default)} onChange={onChange} />
    case 'select':
      return (
        <label className="row between"><span className="lbl">{param.label}</span>
          <Select value={String(value ?? param.default)} width={140} onChange={(v) => onChange(v)} options={param.options ?? []} />
        </label>
      )
    case 'color':
      return (
        <label className="row between"><span className="lbl">{param.label}</span>
          <input type="color" value={String(value ?? param.default)} onChange={(e) => onChange(e.target.value)} />
        </label>
      )
    case 'curve': {
      const points = (value as { x: number; y: number }[] | undefined) ?? (param.default as { x: number; y: number }[])
      return (
        <div className="col">
          <span className="lbl">{param.label}</span>
          <CurveEditor points={points} onChange={(next) => onChange(next)} />
          <Row>
            <Button small onClick={() => onChange([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }])}>Reset</Button>
            <Button small onClick={() => onChange([{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.84 }, { x: 1, y: 1 }])}>S-curve</Button>
            <Button small onClick={() => onChange([{ x: 0, y: 1 }, { x: 1, y: 0 }])}>Invert</Button>
          </Row>
        </div>
      )
    }
    default:
      return (
        <label className="row between"><span className="lbl">{param.label}</span>
          <input className="field" style={{ width: 140 }} value={String(value ?? param.default)} onChange={(e) => onChange(e.target.value)} />
        </label>
      )
  }
}

/* =========================================================== adjustments === */

export function AdjustmentsDocker() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const commit = useStore((s) => s.commit)
  const toast = useStore((s) => s.toast)
  const [preview, setPreview] = useState<string | null>(null)
  const bitmap = selection.map((id) => findBitmap(doc, id)).find(Boolean) as BitmapObject | undefined
  const stats = useMemo(() => {
    const session = bitmap ? peekSession(bitmap.id) : undefined
    return session ? safeStats(session) : null
  }, [bitmap, preview])

  if (!bitmap) return <Docker id="adjustments" title="Adjustments"><EmptyState text="Select a bitmap to adjust" icon="photo" /></Docker>

  return (
    <Docker id="adjustments" title={`Adjustments — ${bitmap.name}`}>
      <Row wrap>
        {PHOTO_PRESETS.slice(0, 8).map((preset) => (
          <Button key={preset.id} small title={preset.hint} onClick={async () => {
            const session = await openPhotoSession(bitmap)
            const stack = preset.build()
            session.adjustments = [...session.adjustments, ...stack]
            commit(`Preset: ${preset.label}`, bakeSession(bitmap, session))
            setPreview(preset.id)
            toast('success', preset.label, preset.hint)
          }}>{preset.label}</Button>
        ))}
      </Row>
      <Select
        value=""
        onChange={async (id) => {
          const preset = presetById(id)
          if (!preset) return
          const session = await openPhotoSession(bitmap)
          session.adjustments = [...session.adjustments, ...preset.build()]
          commit(`Preset: ${preset.label}`, bakeSession(bitmap, session))
          setPreview(preset.id)
        }}
        options={[{ value: '', label: 'More presets…' }, ...PHOTO_PRESETS.map((p) => ({ value: p.id, label: `${p.group}: ${p.label}` }))]}
      />
      {stats ? (
        <>
          <span className="lbl">Histogram</span>
          <Histogram bins={stats.histogram} />
          <div className="row between">
            <span className="tiny">Black point {stats.dynamicRange.low}</span>
            <span className="tiny">White point {stats.dynamicRange.high}</span>
          </div>
        </>
      ) : null}
      <div className="sep" />
      <span className="lbl">Manual adjustments</span>
      {EFFECT_DEFS.filter((d) => d.group === 'Adjust').map((def) => (
        <Button key={def.kind} small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          const adjustment = makeAdjustment(def.kind as Adjustment['kind'], uid('adj'))
          session.adjustments = [...session.adjustments, adjustment]
          commit(`Add ${def.label}`, bakeSession(bitmap, session))
        }}>{def.label}</Button>
      ))}
      <div className="sep" />
      <span className="lbl">Lens correction</span>
      <LensPanel bitmap={bitmap} />
      <div className="sep" />
      <Row wrap>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          session.adjustments = []
          session.effects = []
          commit('Reset adjustments', bakeSession(bitmap, session))
        }} icon="refresh">Reset live stack</Button>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          removeJpegArtifacts(session, 0.6)
          commit('JPEG artifact removal', bakeSession(bitmap, session))
        }}>JPEG cleanup</Button>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          const { w, h } = session
          const up = Math.min(2, 4096 / Math.max(w, h))
          if (up <= 1.01) {
            toast('warn', 'Already at a high resolution')
            return
          }
          ImageKernels.resample(session.data, w, h, Math.round(w * up), Math.round(h * up), 2)
          commit('Upsample', bakeSession(bitmap, session))
        }}>Upsample 2×</Button>
      </Row>
    </Docker>
  )
}

function safeStats(session: import('../lib/photo').PhotoDocument) {
  try {
    return photoStats(session)
  } catch {
    return null
  }
}

function LensPanel({ bitmap }: { bitmap: BitmapObject }) {
  const commit = useStore((s) => s.commit)
  const [distortion, setDistortion] = useState(0)
  const [aberration, setAberration] = useState(0)
  const [vignette, setVignette] = useState(0)
  return (
    <div className="col">
      <Slider label="Distortion" value={distortion} min={-0.6} max={0.6} step={0.01} onChange={setDistortion} />
      <Slider label="Chromatic aberration" value={aberration} min={0} max={8} step={0.1} onChange={setAberration} />
      <Slider label="Vignette" value={vignette} min={-1} max={1} step={0.01} onChange={setVignette} />
      <Button small onClick={async () => {
        const session = await openPhotoSession(bitmap)
        applyLensCorrection(session, { distortion, aberration, vignette })
        commit('Lens correction', bakeSession(bitmap, session))
      }}>Apply lens correction</Button>
      <Button small onClick={async () => {
        const session = await openPhotoSession(bitmap)
        const depth = blurMask(session.data, session.w, session.h, { focusY: 0.5, band: 0.25, radius: 12 })
        session.data = depth
        commit('Blur mask (depth of field)', bakeSession(bitmap, session))
      }}>Blur mask — depth of field</Button>
    </div>
  )
}

/* =============================================================== masking === */

export function MaskingDocker() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const commit = useStore((s) => s.commit)
  const toast = useStore((s) => s.toast)
  const options = useToolOptions()
  const bitmap = selection.map((id) => findBitmap(doc, id)).find(Boolean) as BitmapObject | undefined
  const [tolerance, setTolerance] = useState(32)
  const [feather, setFeather] = useState(2)

  if (!bitmap) return <Docker id="masking" title="Masking"><EmptyState text="Select a bitmap to mask" icon="mask" /></Docker>

  return (
    <Docker id="masking" title={`Masking — ${bitmap.name}`}>
      <Row wrap>
        <Button small icon="mask" onClick={async () => {
          const session = await openPhotoSession(bitmap)
          const { removed } = removeBackgroundWith(session, tolerance, feather)
          commit('Remove background', bakeSession(bitmap, session))
          toast('success', 'Background removed', `${removed.toLocaleString()} pixels cleared. Undo restores them.`)
        }}>Remove background</Button>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          selectSubject(session, tolerance)
          commit('Select subject', bakeSession(bitmap, session))
          toast('success', 'Subject selected', 'Deterministic border-flood segmentation; refine with the grow/shrink buttons.')
        }}>Select subject</Button>
      </Row>
      <Slider label="Tolerance" value={tolerance} min={0} max={128} step={1} onChange={setTolerance} />
      <Slider label="Edge feather" value={feather} min={0} max={24} step={1} onChange={setFeather} />
      <div className="sep" />
      <span className="lbl">Selection</span>
      <Row wrap>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          session.selection = selectionAll(session.selection)
          commit('Select all', bakeSession(bitmap, session))
        }}>All</Button>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          session.selection = selectionInvert(session.selection)
          commit('Invert selection', bakeSession(bitmap, session))
        }}>Invert</Button>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          session.selection = selectionGrow(session.selection, 3)
          commit('Grow selection', bakeSession(bitmap, session))
        }}>Grow</Button>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          session.selection = selectionShrink(session.selection, 3)
          commit('Shrink selection', bakeSession(bitmap, session))
        }}>Shrink</Button>
      </Row>
      <span className="lbl">Mask brush</span>
      <Tabs
        value={options.maskMode}
        onChange={(v) => setToolOptions({ maskMode: v })}
        options={[{ value: 'paint', label: 'Paint mask' }, { value: 'erase', label: 'Erase mask' }]}
      />
      <Slider label="Brush size" value={options.photoRadius} min={2} max={400} step={1} onChange={(v) => setToolOptions({ photoRadius: v })} unit="px" />
      <Slider label="Hardness" value={options.photoHardness} min={0} max={1} step={0.01} onChange={(v) => setToolOptions({ photoHardness: v })} format={(v) => `${Math.round(v * 100)}%`} />
      <Button small icon="brush" onClick={() => useStore.getState().setTool('maskBrush')}>Use mask brush on canvas</Button>
      <div className="sep" />
      <Button small onClick={async () => {
        const session = await openPhotoSession(bitmap)
        // Baking the document mask clears the cut-out and returns the original pixels.
        session.mask = null
        session.selection = selectionAll(session.selection)
        commit('Clear mask', bakeSession(bitmap, session))
      }} icon="refresh">Clear mask</Button>
    </Docker>
  )
}

function removeBackgroundWith(session: import('../lib/photo').PhotoDocument, tolerance: number, feather: number) {
  const result = removeBackground(session, { ...DEFAULT_BG_REMOVAL, tolerance, feather })
  // Bake the subject mask into alpha so the change is visible everywhere.
  if (session.mask) session.data = ImageKernels.applyMask(session.data, session.mask, session.w, session.h, false, true)
  return result
}

/* =============================================================== retouch === */

export function RetouchDocker() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const commit = useStore((s) => s.commit)
  const toast = useStore((s) => s.toast)
  const options = useToolOptions()
  const activeTool = useStore((s) => s.tool)
  const bitmap = selection.map((id) => findBitmap(doc, id)).find(Boolean) as BitmapObject | undefined
  const [replaceFrom, setReplaceFrom] = useState(DEFAULT_COLOR_REPLACE.from)
  const [replaceTo, setReplaceTo] = useState(DEFAULT_COLOR_REPLACE.to)
  const [replaceTolerance, setReplaceTolerance] = useState(DEFAULT_COLOR_REPLACE.tolerance)
  const [before, setBefore] = useState<string | null>(null)

  if (!bitmap) return <Docker id="retouch" title="Retouch"><EmptyState text="Select a bitmap to retouch" icon="wrench" /></Docker>

  return (
    <Docker id="retouch" title={`Retouch — ${bitmap.name}`}>
      <div className="grid4">
        {(['clone', 'colorReplace', 'blurBrush', 'sharpenBrush', 'dodgeBrush', 'burnBrush', 'liquify', 'perspectiveCorrect'] as const).map((tool) => (
          <Button key={tool} small active={activeTool === tool} onClick={() => useStore.getState().setTool(tool)}>{toolLabel(tool)}</Button>
        ))}
      </div>
      <Slider label="Brush size" value={options.photoRadius} min={2} max={400} step={1} onChange={(v) => setToolOptions({ photoRadius: v })} unit="px" />
      <Slider label="Hardness" value={options.photoHardness} min={0} max={1} step={0.01} onChange={(v) => setToolOptions({ photoHardness: v })} format={(v) => `${Math.round(v * 100)}%`} />
      <Slider label="Opacity" value={options.photoOpacity} min={0} max={1} step={0.01} onChange={(v) => setToolOptions({ photoOpacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
      <Slider label="Strength" value={options.photoStrength} min={0} max={1} step={0.01} onChange={(v) => setToolOptions({ photoStrength: v })} format={(v) => `${Math.round(v * 100)}%`} />
      <span className="tiny">Clone: Alt-click to set the source, then paint. Heal uses the same source with a colour match.</span>
      <Row wrap>
        <Button small onClick={async () => {
          // Heal a rectangular patch centred on the current selection bounds.
          const session = await openPhotoSession(bitmap)
          const cx = session.w / 2
          const cy = session.h / 2
          healAt(session, cx, cy, options.photoRadius)
          commit('Heal', bakeSession(bitmap, session))
        }}>Heal centre</Button>
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          setBefore(sessionWideThumb(session))
        }} icon="eye">Snapshot before</Button>
        <Button small disabled={!before} onClick={() => { setBefore(null); toast('info', 'Comparison cleared') }}>Clear snapshot</Button>
      </Row>
      {before ? (
        <div className="col">
          <span className="tiny">Before</span>
          <img src={before} alt="Before" style={{ width: '100%', borderRadius: 6, border: '1px solid var(--line)' }} />
        </div>
      ) : null}
      <div className="sep" />
      <span className="lbl">Replace colour</span>
      <Row>
        <input type="color" value={toHex(replaceFrom)} onChange={(e) => { const c = hexToRgbLocal(e.target.value); setReplaceFrom({ ...c, a: 1 }) }} />
        <span className="tiny">→</span>
        <input type="color" value={toHex(replaceTo)} onChange={(e) => { const c = hexToRgbLocal(e.target.value); setReplaceTo({ ...c, a: 1 }) }} />
        <Button small onClick={async () => {
          const session = await openPhotoSession(bitmap)
          session.data = replaceColor(session.data, { from: replaceFrom, to: replaceTo, tolerance: replaceTolerance })
          commit('Replace colour', bakeSession(bitmap, session))
        }}>Replace</Button>
      </Row>
      <Slider label="Colour tolerance" value={replaceTolerance} min={0} max={255} step={1} onChange={setReplaceTolerance} />
      <div className="sep" />
      <Button small onClick={async () => {
        const session = await openPhotoSession(bitmap)
        const quad = [
          { x: session.w * 0.06, y: session.h * 0.06 },
          { x: session.w * 0.94, y: session.h * 0.02 },
          { x: session.w * 0.98, y: session.h * 0.96 },
          { x: session.w * 0.02, y: session.h * 0.94 },
        ]
        correctPerspective(session, quad)
        commit('Perspective correction', bakeSession(bitmap, session))
      }}>Fine-deskew (upright)</Button>
      <Button small onClick={async () => {
        const session = await openPhotoSession(bitmap)
        session.data = ImageKernels.sharpen(session.data, session.w, session.h, 0.8)
        commit('Sharpen', bakeSession(bitmap, session))
      }}>Unsharp mask</Button>
    </Docker>
  )
}

function toolLabel(tool: string): string {
  return tool === 'colorReplace' ? 'Colour' : tool === 'blurBrush' ? 'Blur' : tool === 'sharpenBrush' ? 'Sharpen'
    : tool === 'dodgeBrush' ? 'Dodge' : tool === 'burnBrush' ? 'Burn' : tool === 'perspectiveCorrect' ? 'Perspective'
      : tool.charAt(0).toUpperCase() + tool.slice(1)
}

function healAt(session: import('../lib/photo').PhotoDocument, x: number, y: number, radius: number) {
  const source = { x: clamp(x - radius * 2, 0, session.w - 1), y: clamp(y - radius * 2, 0, session.h - 1) }
  healBrush(session, { x, y, radius, hardness: 0.6, opacity: 0.9, source, amount: 0.6, seed: 3 })
}

function sessionWideThumb(session: import('../lib/photo').PhotoDocument): string {
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 320 / Math.max(session.w, session.h))
  canvas.width = Math.max(1, Math.round(session.w * scale))
  canvas.height = Math.max(1, Math.round(session.h * scale))
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(bytesToImageData(session.data, session.w, session.h), 0, 0)
  if (scale < 1) {
    const smaller = document.createElement('canvas')
    smaller.width = canvas.width
    smaller.height = canvas.height
    smaller.getContext('2d')!.drawImage(canvas, 0, 0, canvas.width, canvas.height)
    return smaller.toDataURL('image/png')
  }
  return canvas.toDataURL('image/png')
}

function toHex(c: { r: number; g: number; b: number }): string {
  return `#${[c.r, c.g, c.b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`
}

/* =================================================================== text === */

export function TextDocker() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const applyTextStyle = useStore((s) => s.applyTextStyle)
  const commit = useStore((s) => s.commit)
  const object = useMemo(() => selection.map((id) => findObjectById(doc, id)).find((o) => o?.kind === 'text'), [doc, selection])
  const [family, setFamily] = useState('Inter')
  const [axis, setAxis] = useState<Record<string, number>>({})
  const [glyphs, setGlyphs] = useState<{ char: string; code: number }[]>([])
  const text = object?.kind === 'text' ? object : null
  const fontRecord = fonts.get(text?.style.fontFamily ?? family)
  const layout = text ? textLayoutOf(text, doc) : null

  useEffect(() => {
    if (!text) return
    setFamily(text.style.fontFamily)
    setGlyphs(fonts.glyphs(text.style.fontFamily, 400))
  }, [text?.id, text?.style.fontFamily]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Docker id="text" title="Text">
      {!text ? <EmptyState text="Select a text object" icon="text" /> : null}
      <Select value={text?.style.fontFamily ?? family} onChange={(v) => { setFamily(v); fonts.load(v); applyTextStyle({ fontFamily: v }) }} options={fonts.list().slice(0, 500).map((f) => ({ value: f.family, label: f.family }))} />
      {fontRecord?.variable && fontRecord.axes?.length ? (
        <div className="col">
          <span className="lbl">Variable axes</span>
          {fontRecord.axes.map((a) => (
            <Slider
              key={a.tag}
              label={a.name}
              value={axis[a.tag] ?? a.default}
              min={a.min}
              max={a.max}
              step={(a.max - a.min) / 100 || 1}
              onChange={(v) => {
                const next = { ...axis, [a.tag]: v }
                setAxis(next)
                applyTextStyle({ variableAxes: next })
              }}
            />
          ))}
        </div>
      ) : null}
      <div className="sep" />
      <span className="lbl">OpenType features</span>
      <Row wrap>
        {['kern', 'liga', 'dlig', 'smcp', 'onum', 'tnum', 'frac', 'swsh'].map((tag) => (
          <button
            key={tag}
            type="button"
            className={`chip ${text?.style.openType?.[tag] ? 'on' : ''}`}
            onClick={() => applyTextStyle({ openType: { ...(text?.style.openType ?? {}), [tag]: !text?.style.openType?.[tag] } })}
          >
            {tag}
          </button>
        ))}
      </Row>
      <div className="sep" />
      <span className="lbl">Paragraph</span>
      <Row wrap>
        {(['none', 'bullet', 'number', 'roman', 'alpha'] as const).map((b) => (
          <Button key={b} small active={text?.style.bullet === b} onClick={() => applyTextStyle({ bullet: b })}>{b === 'none' ? 'No bullets' : b}</Button>
        ))}
      </Row>
      <Slider label="Bullet indent" value={text?.style.bulletIndent ?? 14} min={0} max={80} step={1} onChange={(v) => applyTextStyle({ bulletIndent: v })} />
      <Slider label="Drop cap lines" value={text?.style.dropCap ?? 0} min={0} max={8} step={1} onChange={(v) => applyTextStyle({ dropCap: v })} />
      <Slider label="Paragraph spacing" value={text?.style.paragraphSpacing ?? 0} min={0} max={40} step={0.5} onChange={(v) => applyTextStyle({ paragraphSpacing: v })} />
      <Check label="Hyphenate" checked={text?.style.hyphenate ?? false} onChange={(v) => applyTextStyle({ hyphenate: v })} />
      <div className="sep" />
      <span className="lbl">Text on path</span>
      <Row>
        <Button small disabled={!text || selection.length < 2} onClick={() => {
          const curve = selection.map((id) => findObjectById(doc, id)).find((o) => o?.kind === 'vector')
          if (!text || !curve) {
            useStore.getState().toast('warn', 'Select a text object and a curve')
            return
          }
          commit('Fit text to path', (d) => updateObject(d, text.id, (o) => (o.kind === 'text' ? { ...o, onPathId: curve.id, onPathOffset: 0, onPathSide: 'above' } : o)))
        }}>Fit text to curve</Button>
        <Button small disabled={!text?.onPathId} onClick={() => {
          if (!text) return
          commit('Detach text', (d) => updateObject(d, text.id, (o) => (o.kind === 'text' ? { ...o, onPathId: undefined } : o)))
        }}>Detach</Button>
      </Row>
      {layout ? <span className="tiny">{layout.lines.length} lines · {Math.round(layout.width)} × {Math.round(layout.height)} pt{layout.overflow ? ' · overflows frame' : ''}</span> : null}
      <div className="sep" />
      <span className="lbl">Glyphs — click to copy the character</span>
      <div className="grid4" style={{ maxHeight: 220, overflow: 'auto' }}>
        {glyphs.slice(0, 200).map((g) => (
          <button
            key={g.code}
            type="button"
            className="btn small"
            title={`U+${g.code.toString(16).toUpperCase().padStart(4, '0')}`}
            onClick={() => {
              void navigator.clipboard?.writeText(g.char)
              useStore.getState().toast('info', `Copied ${g.char}`)
            }}
            style={{ fontFamily: text?.style.fontFamily ?? family, fontSize: 15 }}
          >
            {g.char}
          </button>
        ))}
      </div>
      <Button small onClick={() => {
        if (!text) return
        const record = fonts.get(text.style.fontFamily)
        useStore.getState().toast(record?.dataUrl ? 'success' : 'info', `${text.style.fontFamily}`, record?.dataUrl ? 'Font data is embedded in this document.' : 'Font is linked, not embedded. Load it online once to embed.')
      }} icon="info">Font embedding status</Button>
    </Docker>
  )
}

/* ================================================================== brush === */

export function BrushDocker() {
  const options = useToolOptions()
  const [category, setCategory] = useState('all')
  const [tray, setTray] = useState<string[]>(() => loadMediaTray())
  const categories = useMemo(() => ['all', ...new Set(BRUSH_PRESETS.map((p) => p.category))], [])
  const filtered = BRUSH_PRESETS.filter((p) => category === 'all' || p.category === category)

  return (
    <Docker id="brush" title="Brush — painterly media">
      <Select value={category} onChange={setCategory} options={categories.map((c) => ({ value: c, label: c }))} />
      <div className="list" style={{ maxHeight: 260 }}>
        {filtered.map((preset) => (
          <div key={preset.id} className={`list-row ${options.brushPreset === preset.id ? 'on' : ''}`} onClick={() => setToolOptions({ brushPreset: preset.id, brushWidth: preset.size })}>
            <span className="swatch" style={{ width: 18, height: 18, background: `radial-gradient(circle at 40% 40%, var(--text-dim), transparent 70%)`, opacity: 0.4 + preset.flow * 0.6 }} />
            <span className="name">{preset.name}</span>
            <span className="meta">{preset.category}</span>
            <IconButton icon="plus" title="Add to Media Tray" onClick={() => setTray(pushMediaTray(preset.id))} />
          </div>
        ))}
      </div>
      <div className="sep" />
      <span className="lbl">Media Tray ({tray.length})</span>
      <div className="grid4">
        {tray.map((id) => {
          const preset = presetByID(id)
          return (
            <Button key={id} small active={options.brushPreset === id} onClick={() => setToolOptions({ brushPreset: id })} title={`${preset.category} · ${preset.name}`}>
              {preset.name.slice(0, 8)}
            </Button>
          )
        })}
      </div>
      <span className="tiny">{BRUSH_PRESETS.length} presets across {categories.length - 1} media families — watercolour, oil, pastel, marker, pencil, ink, airbrush, chalk, charcoal, gouache, acrylic and spray.</span>
    </Docker>
  )
}

/* ================================================================ history === */

export function HistoryDocker() {
  const history = useStore((s) => s.history)
  const future = useStore((s) => s.future)
  const gotoHistory = useStore((s) => s.gotoHistory)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  return (
    <Docker id="history" title="History">
      <Row>
        <Button small icon="undo" onClick={undo} disabled={!history.length}>Undo</Button>
        <Button small icon="redo" onClick={redo} disabled={!future.length}>Redo</Button>
        <span className="badge">{history.length} steps</span>
      </Row>
      <div className="list" style={{ maxHeight: 300 }}>
        {[...history].reverse().map((entry, i) => (
          <button key={`${entry.label}-${i}`} type="button" className="list-row" onClick={() => gotoHistory(history.length - 1 - i)}>
            <span className="name">{entry.label}</span>
          </button>
        ))}
        {future.map((entry, i) => (
          <div key={`f-${entry.label}-${i}`} className="list-row" style={{ opacity: 0.45 }}>
            <span className="name">{entry.label}</span>
            <span className="meta">redo</span>
          </div>
        ))}
      </div>
    </Docker>
  )
}

/* ================================================================== print === */

export function PrintDocker() {
  const doc = useStore((s) => s.doc)
  const [preset, setPreset] = useState('press-x4')
  const [separations, setSeparations] = useState(false)
  const [imposition, setImposition] = useState({ enabled: false, columns: 2, rows: 2, gap: 12 })
  const openPrint = useStore((s) => s.setPrintDialog ?? (() => undefined))
  return (
    <Docker id="print" title="Print & prepress">
      <Select value={preset} onChange={setPreset} options={[
        { value: 'press-x4', label: 'PDF/X-4 — commercial press' },
        { value: 'archive-a', label: 'PDF/A — long-term archive' },
        { value: 'proof', label: 'Digital proof' },
        { value: 'screen', label: 'Screen / web' },
      ]} />
      <Check label="Colour separations preview" checked={separations} onChange={setSeparations} />
      <Check label="Imposition (multi-up)" checked={imposition.enabled} onChange={(v) => setImposition((i) => ({ ...i, enabled: v }))} />
      {imposition.enabled ? (
        <div className="grid3">
          <label className="col"><span className="lbl">Columns</span><NumberField value={imposition.columns} min={1} max={8} onChange={(v) => setImposition((i) => ({ ...i, columns: Math.round(v) }))} /></label>
          <label className="col"><span className="lbl">Rows</span><NumberField value={imposition.rows} min={1} max={8} onChange={(v) => setImposition((i) => ({ ...i, rows: Math.round(v) }))} /></label>
          <label className="col"><span className="lbl">Gap</span><NumberField value={imposition.gap} min={0} max={72} onChange={(v) => setImposition((i) => ({ ...i, gap: v }))} /></label>
        </div>
      ) : null}
      <Button small icon="print" variant="primary" onClick={() => openPrint(true)}>Open print preview…</Button>
      <span className="tiny">{doc.pages.length} page(s) · marks, bleed and separations are configured in the print dialog.</span>
    </Docker>
  )
}

/* =============================================================== shaping === */

export function ShapingDocker() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const commit = useStore((s) => s.commit)
  const toast = useStore((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const vectors = useMemo(() => selection.map((id) => findObjectById(doc, id)).filter((o): o is Extract<SceneObject, { kind: 'vector' }> => o?.kind === 'vector'), [doc, selection])

  const run = async (op: BooleanOp) => {
    if (vectors.length < 2) {
      toast('warn', 'Select two or more curves')
      return
    }
    setBusy(true)
    try {
      let acc = vectors[0].path
      for (let i = 1; i < vectors.length; i++) {
        const result = await booleanPath(acc, vectors[i].path, op)
        if (!result) {
          toast('warn', `${op} failed`, 'Paper.js is loading or the paths do not overlap — the geometry fallback can only handle simple cases.')
          return
        }
        acc = result
      }
      const ids = vectors.map((v) => v.id)
      commit(`Shape ${op}`, (d) => {
        let next = d
        next = updateObject(next, ids[0], (o) => (o.kind === 'vector' ? { ...o, path: acc } : o))
        for (const id of ids.slice(1)) {
          next = {
            ...next,
            pages: next.pages.map((p) => ({ ...p, layers: p.layers.map((l) => ({ ...l, objects: l.objects.filter((o) => o.id !== id) })) })),
          }
        }
        return next
      }, { selection: [ids[0]] })
      toast('success', `Shape ${op} applied`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Docker id="shaping" title="Shaping">
      <Row wrap>
        {(['unite', 'subtract', 'intersect', 'exclude', 'divide'] as BooleanOp[]).map((op) => (
          <Button key={op} small disabled={busy} onClick={() => void run(op)}>{op}</Button>
        ))}
      </Row>
      <Row wrap>
        <Button small disabled={!vectors.length} onClick={async () => {
          if (!vectors.length) return
          const result = await simplifyPath(vectors[0].path, 1.5)
          if (!result) { toast('warn', 'Simplify needs Paper.js', 'It loads on first use — try again in a moment.'); return }
          commit('Simplify', (d) => updateObject(d, vectors[0].id, (o) => (o.kind === 'vector' ? { ...o, path: result } : o)))
        }}>Simplify</Button>
        <Button small disabled={!vectors.length} onClick={async () => {
          if (!vectors.length) return
          const result = await paperDistort(vectors[0].path, 'smooth', 0.4)
          if (!result) { toast('warn', 'Smooth needs Paper.js'); return }
          commit('Smooth', (d) => updateObject(d, vectors[0].id, (o) => (o.kind === 'vector' ? { ...o, path: result } : o)))
        }}>Smooth</Button>
        <Button small disabled={!vectors.length} onClick={() => commit('Combine', (d) => (vectors.length ? updateObject(d, vectors[0].id, (o) => (o.kind === 'vector' ? { ...o, path: combinePaths(vectors.map((v) => v.path)) } : o)) : d))}>Combine</Button>
      </Row>
      <span className="tiny">Booleans run through Paper.js in a worker-friendly async call with a geometry fallback for simple overlaps.</span>
    </Docker>
  )
}

/* =============================================================== symbols === */

interface SymbolEntry { id: string; name: string; createdAt: number; bounds: { w: number; h: number }; objects: SceneObject[] }

export function SymbolsDocker() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const commit = useStore((s) => s.commit)
  const [symbols, setSymbols] = useState<SymbolEntry[]>(() => loadSymbols())

  return (
    <Docker id="symbols" title="Symbols">
      <Row>
        <Button small icon="plus" disabled={!selection.length} onClick={() => {
          const objects = useStore.getState().selectedObjects()
          const bounds = useStore.getState().selectionBounds()
          const entry: SymbolEntry = { id: uid('sym'), name: objects[0]?.name ?? 'Symbol', createdAt: Date.now(), bounds: { w: bounds?.w ?? 0, h: bounds?.h ?? 0 }, objects }
          const next = [...symbols, entry]
          setSymbols(next)
          saveSymbols(next)
        }}>Create from selection</Button>
      </Row>
      <div className="list">
        {symbols.map((symbol) => (
          <div key={symbol.id} className="list-row">
            <span className="name">{symbol.name}</span>
            <span className="meta">{symbol.objects.length} obj</span>
            <IconButton icon="download" title="Place instance" onClick={() => {
              const clones = symbol.objects.map((o) => cloneWithOffset(o, 12))
              commit(`Place ${symbol.name}`, (d) => ({
                ...d,
                pages: d.pages.map((p) => (p.id === d.activePageId ? { ...p, layers: p.layers.map((l, i) => (i === 0 ? { ...l, objects: [...l.objects, ...clones] } : l)) } : p)),
              }))
            }} />
            <IconButton icon="delete" title="Delete symbol" onClick={() => {
              const next = symbols.filter((s) => s.id !== symbol.id)
              setSymbols(next)
              saveSymbols(next)
            }} />
          </div>
        ))}
        {symbols.length === 0 ? <EmptyState text="Symbols you create are stored in this browser" icon="shape" /> : null}
      </div>
    </Docker>
  )
}

function cloneWithOffset(obj: SceneObject, offset: number): SceneObject {
  const copy = JSON.parse(JSON.stringify(obj)) as SceneObject
  return { ...copy, id: uid('sym'), transform: { ...copy.transform, e: copy.transform.e + offset, f: copy.transform.f + offset } }
}

function loadSymbols(): SymbolEntry[] {
  try {
    return JSON.parse(localStorage.getItem('corelbydre.symbols') ?? '[]') as SymbolEntry[]
  } catch {
    return []
  }
}

function saveSymbols(symbols: SymbolEntry[]): void {
  try {
    localStorage.setItem('corelbydre.symbols', JSON.stringify(symbols.slice(-40)))
  } catch {
    /* storage full — symbols are a convenience, never a requirement */
  }
}

/* ================================================================ helpers === */

function findObjectById(doc: ReturnType<typeof useStore.getState>['doc'], id: ID): SceneObject | null {
  for (const page of doc.pages) {
    for (const layer of page.layers) {
      const found = search(layer.objects, id)
      if (found) return found
    }
  }
  return null
}

function search(objects: SceneObject[], id: ID): SceneObject | null {
  for (const obj of objects) {
    if (obj.id === id) return obj
    if (obj.kind === 'group') {
      const nested = search(obj.children, id)
      if (nested) return nested
    }
  }
  return null
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

function rotationOf(obj: SceneObject): number {
  return (Math.atan2(obj.transform.b, obj.transform.a) * 180) / Math.PI
}

function scaleOf(obj: SceneObject): number {
  return Math.hypot(obj.transform.a, obj.transform.b)
}

function rotateObject(obj: SceneObject, deltaDeg: number): void {
  const state = useStore.getState()
  const rad = (deltaDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  state.commit('Rotate', (d) => updateObject(d, obj.id, (o) => ({
    ...o,
    transform: {
      a: o.transform.a * cos - o.transform.b * sin,
      b: o.transform.a * sin + o.transform.b * cos,
      c: o.transform.c * cos - o.transform.d * sin,
      d: o.transform.c * sin + o.transform.d * cos,
      e: o.transform.e,
      f: o.transform.f,
    },
  })))
}

function scaleObject(obj: SceneObject, factor: number): void {
  const current = scaleOf(obj)
  if (current < 1e-6) return
  const k = factor / current
  useStore.getState().commit('Scale', (d) => updateObject(d, obj.id, (o) => ({
    ...o,
    transform: { ...o.transform, a: o.transform.a * k, b: o.transform.b * k, c: o.transform.c * k, d: o.transform.d * k },
  })))
}

