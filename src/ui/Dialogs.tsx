/**
 * Export and print dialogs, including the real-time print preview with colour
 * separations, printer's marks and imposition.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ArrowheadStyle, Fill, FountainFill, GradientStop, RGBA, Stroke } from '../types'
import type { ExportOptions } from '../lib/export'
import { DEFAULT_EXPORT, PRINT_PRESETS, separationPreview } from '../lib/export'
import { hex, parseHex, rgb, mixColor } from '../lib/color'
import { useStore } from '../store/store'
import { Button, Check, ColorPicker, Col, Modal, NumberField, Row, Select, Slider, Tabs } from './widgets'
import { printDocument, renderPageForExport, runExport, runWebExport, type ExportRequest } from './fileOps'
import { DEFAULT_WEB_EXPORT, defaultWebRenderer, exportWeb, formatBytes, type WebExportOptions, type WebExportResult } from '../lib/webexport'

const DEFAULT_STROKE: Stroke = {
  color: rgb(24, 26, 30), width: 1, cap: 'butt', join: 'miter', miterLimit: 10,
  startArrow: 'none', endArrow: 'none', arrowScale: 1, scaleWithObject: true, behind: false,
}

const DEFAULT_FOUNTAIN: FountainFill = {
  type: 'fountain', fountain: 'linear',
  stops: [
    { offset: 0, color: rgb(18, 161, 154) },
    { offset: 1, color: rgb(27, 108, 214) },
  ],
  start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 },
  spread: 'pad', angle: 0, edgePad: 0,
}

/** F11 and Shift+F11: contextual fountain/uniform fill editors. */
export function FillDialog() {
  const mode = useStore((s) => s.fillDialog)
  const setMode = useStore((s) => s.setFillDialog)
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const fillColor = useStore((s) => s.fillColor)
  const setFillColor = useStore((s) => s.setFillColor)
  const applyFill = useStore((s) => s.applyFillToSelection)
  const [color, setColor] = useState<RGBA>(fillColor)
  const [fountain, setFountain] = useState<FountainFill>(DEFAULT_FOUNTAIN)

  useEffect(() => {
    if (!mode) return
    const objects = useStore.getState().selectedObjects()
    const vector = objects.find((o) => o.kind === 'vector')
    if (mode === 'uniform') {
      if (vector?.kind === 'vector' && vector.fill.type === 'uniform') setColor(vector.fill.color)
      else setColor(useStore.getState().fillColor)
    } else if (vector?.kind === 'vector' && vector.fill.type === 'fountain') {
      setFountain({ ...vector.fill, stops: vector.fill.stops.map((stop) => ({ ...stop, color: { ...stop.color } })) })
    }
  }, [mode, selection])

  if (!mode) return null
  const close = () => setMode(null)
  const apply = () => {
    if (!selection.length) {
      setFillColor(color)
      useStore.getState().toast('info', 'Default fill colour updated', 'Select an object and use the fill tool to apply it.')
    } else if (mode === 'uniform') {
      // setFillColor also applies the chosen colour to the current selection.
      setFillColor(color)
    } else {
      const angle = fountain.angle * Math.PI / 180
      const start = { x: 0.5 - Math.cos(angle) * 0.5, y: 0.5 - Math.sin(angle) * 0.5 }
      const end = { x: 0.5 + Math.cos(angle) * 0.5, y: 0.5 + Math.sin(angle) * 0.5 }
      applyFill({ ...fountain, start, end })
    }
    close()
  }
  const setStop = (index: number, patch: Partial<GradientStop>) => setFountain((f) => ({
    ...f, stops: f.stops.map((stop, i) => i === index ? { ...stop, ...patch } : stop),
  }))
  const addStop = () => setFountain((f) => {
    if (f.stops.length >= 8) return f
    const sorted = [...f.stops].sort((a, b) => a.offset - b.offset)
    const left = sorted[sorted.length - 2] ?? sorted[0]
    const right = sorted[sorted.length - 1]
    const offset = (left.offset + right.offset) / 2
    return { ...f, stops: [...f.stops, { offset, color: mixColor(left.color, right.color, 0.5) }].sort((a, b) => a.offset - b.offset) }
  })
  const removeStop = (index: number) => setFountain((f) => f.stops.length <= 2 ? f : { ...f, stops: f.stops.filter((_, i) => i !== index) })

  return (
    <Modal
      title={mode === 'uniform' ? 'Uniform Fill' : 'Fountain Fill'}
      onClose={close}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={apply}>{selection.length ? 'Apply fill' : 'Set default'}</Button></>}
    >
      {mode === 'uniform' ? (
        <>
          <span className="tiny">Choose a solid colour for every selected vector object. Alpha is preserved as fill transparency.</span>
          <ColorPicker value={color} onChange={setColor} />
        </>
      ) : (
        <>
          <Row>
            <span className="lbl">Type</span>
            <Select value={fountain.fountain} width={160} onChange={(v) => setFountain((f) => ({ ...f, fountain: v as FountainFill['fountain'] }))} options={[
              { value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'conical', label: 'Conical' }, { value: 'square', label: 'Rectangular' },
            ]} />
            <span className="lbl">Spread</span>
            <Select value={fountain.spread} width={130} onChange={(v) => setFountain((f) => ({ ...f, spread: v as FountainFill['spread'] }))} options={[
              { value: 'pad', label: 'Pad' }, { value: 'repeat', label: 'Repeat' }, { value: 'reflect', label: 'Reflect' },
            ]} />
          </Row>
          <Row>
            <span className="lbl">Angle</span>
            <NumberField value={fountain.angle} min={-360} max={360} onChange={(v) => setFountain((f) => ({ ...f, angle: v }))} suffix="°" />
            <span className="lbl">Edge pad</span>
            <NumberField value={fountain.edgePad} min={0} max={100} onChange={(v) => setFountain((f) => ({ ...f, edgePad: v }))} suffix="%" />
          </Row>
          <div className="col">
            <div className="row between"><strong>Colour stops</strong><Button small disabled={fountain.stops.length >= 8} onClick={addStop}>Add stop</Button></div>
            {fountain.stops.map((stop, index) => (
              <div key={`${index}-${stop.offset}`} className="col" style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 8 }}>
                <Row>
                  <span className="badge">{index + 1}</span>
                  <span className="lbl">Position</span>
                  <NumberField value={Math.round(stop.offset * 100)} min={0} max={100} onChange={(v) => setStop(index, { offset: v / 100 })} suffix="%" />
                  <input aria-label={`Stop ${index + 1} colour`} type="color" value={hex(stop.color)} onChange={(e) => setStop(index, { color: parseHex(e.target.value) })} />
                  <Button small disabled={fountain.stops.length <= 2} onClick={() => removeStop(index)}>Remove</Button>
                </Row>
                <Slider label="Stop opacity" value={stop.color.a} min={0} max={1} step={0.01} onChange={(v) => setStop(index, { color: { ...stop.color, a: v } })} format={(v) => `${Math.round(v * 100)}%`} />
              </div>
            ))}
          </div>
          <span className="tiny">The fill remains editable; its geometry is stored relative to each object's bounds.</span>
        </>
      )}
    </Modal>
  )
}

const ARROW_OPTIONS: { value: ArrowheadStyle; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'triangle', label: 'Triangle' }, { value: 'stealth', label: 'Stealth' },
  { value: 'diamond', label: 'Diamond' }, { value: 'open', label: 'Open V' }, { value: 'circle', label: 'Circle' }, { value: 'bar', label: 'Bar' },
]

function arrowPreviewPath(style: ArrowheadStyle): string {
  switch (style) {
    case 'triangle': return 'M0 0 L8 4 L0 8 Z'
    case 'stealth': return 'M0 0 L8 4 L0 8 L2.5 4 Z'
    case 'diamond': return 'M0 4 L4 0 L8 4 L4 8 Z'
    case 'open': return 'M0 0 L8 4 L0 8'
    case 'circle': return 'M4 0 A4 4 0 1 0 4 8 A4 4 0 1 0 4 0 Z'
    case 'bar': return 'M6 0 L6 8'
    default: return ''
  }
}

/** F12: a proper outline-pen control surface; line and marker settings remain editable data. */
export function OutlinePenDialog() {
  const open = useStore((s) => s.outlineDialog)
  const setOpen = useStore((s) => s.setOutlineDialog)
  const selection = useStore((s) => s.selection)
  const doc = useStore((s) => s.doc)
  const [stroke, setStroke] = useState<Stroke>(DEFAULT_STROKE)
  const [unit, setUnit] = useState<'pt' | 'mm' | 'in' | 'px'>('pt')
  const [tab, setTab] = useState<'outline' | 'arrows'>('outline')

  useEffect(() => {
    if (!open) return
    const state = useStore.getState()
    const vector = state.selectedObjects().find((o) => o.kind === 'vector')
    setStroke(vector?.kind === 'vector' && vector.stroke ? { ...DEFAULT_STROKE, ...vector.stroke } : { ...DEFAULT_STROKE, color: state.strokeColor })
    setUnit(state.doc.settings.displayUnit)
  }, [open, selection, doc])

  if (!open) return null
  const ptsPerUnit = unit === 'in' ? 72 : unit === 'mm' ? 72 / 25.4 : unit === 'px' ? 0.75 : 1
  const close = () => setOpen(false)
  const apply = () => {
    if (selection.length) {
      useStore.getState().applyStrokeToSelection(stroke)
      useStore.setState({ strokeColor: stroke.color })
    } else {
      useStore.getState().setStrokeColor(stroke.color)
      useStore.getState().toast('info', 'Outline colour default updated', 'Select an object to apply the full outline-pen settings.')
    }
    close()
  }
  const patch = (value: Partial<Stroke>) => setStroke((s) => ({ ...s, ...value }))

  return (
    <Modal title="Outline Pen" onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={apply}>{selection.length ? 'Apply to selection' : 'Set default colour'}</Button></>}>
      <Tabs value={tab} onChange={setTab} options={[{ value: 'outline', label: 'Outline' }, { value: 'arrows', label: 'Arrows & scale' }]} />
      {tab === 'outline' ? (
        <>
          <Row>
            <span className="lbl">Width</span>
            <NumberField value={stroke.width / ptsPerUnit} min={0} max={500} step={unit === 'pt' ? 0.1 : 0.01} onChange={(v) => patch({ width: v * ptsPerUnit })} />
            <Select value={unit} width={88} onChange={(v) => setUnit(v as typeof unit)} options={[
              { value: 'pt', label: 'pt' }, { value: 'mm', label: 'mm' }, { value: 'in', label: 'in' }, { value: 'px', label: 'px' },
            ]} />
            <Check label="Behind fill" checked={stroke.behind} onChange={(v) => patch({ behind: v })} />
          </Row>
          <Row>
            <span className="lbl">Colour</span>
            <input aria-label="Outline colour" type="color" value={hex(stroke.color)} onChange={(e) => patch({ color: parseHex(e.target.value) })} />
            <NumberField value={Math.round(stroke.color.a * 100)} min={0} max={100} onChange={(v) => patch({ color: { ...stroke.color, a: v / 100 } })} suffix="% alpha" />
          </Row>
          <Row>
            <span className="lbl">Cap</span>
            <Select value={stroke.cap} width={112} onChange={(v) => patch({ cap: v as Stroke['cap'] })} options={[
              { value: 'butt', label: 'Butt' }, { value: 'round', label: 'Round' }, { value: 'square', label: 'Square' },
            ]} />
            <span className="lbl">Join</span>
            <Select value={stroke.join} width={112} onChange={(v) => patch({ join: v as Stroke['join'] })} options={[
              { value: 'miter', label: 'Miter' }, { value: 'round', label: 'Round' }, { value: 'bevel', label: 'Bevel' },
            ]} />
            <span className="lbl">Miter limit</span>
            <NumberField value={stroke.miterLimit} min={1} max={100} step={0.5} onChange={(v) => patch({ miterLimit: v })} />
          </Row>
          <Row wrap>
            <span className="lbl">Dash</span>
            <Select value={stroke.dash?.join(',') ?? ''} width={174} onChange={(v) => patch({ dash: v ? v.split(',').map(Number) : [] })} options={[
              { value: '', label: 'Solid' }, { value: '4,2', label: 'Short dash' }, { value: '10,4', label: 'Dash' },
              { value: '1,2', label: 'Dot' }, { value: '10,3,2,3', label: 'Dash-dot' },
            ]} />
            <Check label="Scale with object" checked={stroke.scaleWithObject !== false} onChange={(v) => patch({ scaleWithObject: v })} />
          </Row>
        </>
      ) : (
        <>
          <Row>
            <span className="lbl">Start arrow</span>
            <Select value={stroke.startArrow ?? 'none'} width={150} onChange={(v) => patch({ startArrow: v as ArrowheadStyle })} options={ARROW_OPTIONS} />
            <span className="lbl">End arrow</span>
            <Select value={stroke.endArrow ?? 'none'} width={150} onChange={(v) => patch({ endArrow: v as ArrowheadStyle })} options={ARROW_OPTIONS} />
          </Row>
          <Slider label="Arrowhead scale" value={stroke.arrowScale ?? 1} min={0.25} max={4} step={0.05} onChange={(v) => patch({ arrowScale: v })} format={(v) => `${v.toFixed(2)}×`} />
          <span className="tiny">Markers are applied to open path endpoints only. Their colour and alpha follow the outline.</span>
        </>
      )}
      <div className="col" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
        <span className="tiny">Stroke preview</span>
        <div style={{ height: 30, display: 'grid', placeItems: 'center' }}>
          <svg width="260" height="28" viewBox="0 0 260 28" aria-label="Outline preview">
            <defs>
              {stroke.startArrow && stroke.startArrow !== 'none' ? <marker id="outline-start-preview" viewBox="0 0 8 8" markerWidth={8 * (stroke.arrowScale ?? 1)} markerHeight={8 * (stroke.arrowScale ?? 1)} refX="8" refY="4" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                <path d={arrowPreviewPath(stroke.startArrow)} fill={stroke.startArrow === 'open' || stroke.startArrow === 'bar' ? 'none' : hex(stroke.color)} stroke={hex(stroke.color)} strokeOpacity={stroke.color.a} strokeWidth="1.2" />
              </marker> : null}
              {stroke.endArrow && stroke.endArrow !== 'none' ? <marker id="outline-end-preview" viewBox="0 0 8 8" markerWidth={8 * (stroke.arrowScale ?? 1)} markerHeight={8 * (stroke.arrowScale ?? 1)} refX="8" refY="4" orient="auto" markerUnits="userSpaceOnUse">
                <path d={arrowPreviewPath(stroke.endArrow)} fill={stroke.endArrow === 'open' || stroke.endArrow === 'bar' ? 'none' : hex(stroke.color)} stroke={hex(stroke.color)} strokeOpacity={stroke.color.a} strokeWidth="1.2" />
              </marker> : null}
            </defs>
            <path d="M18 14H242" fill="none" stroke={hex(stroke.color)} strokeOpacity={stroke.color.a} strokeWidth={Math.max(1, stroke.width / ptsPerUnit)} strokeLinecap={stroke.cap} strokeLinejoin={stroke.join} strokeDasharray={stroke.dash?.join(' ')} markerStart={stroke.startArrow && stroke.startArrow !== 'none' ? 'url(#outline-start-preview)' : undefined} markerEnd={stroke.endArrow && stroke.endArrow !== 'none' ? 'url(#outline-end-preview)' : undefined} />
          </svg>
        </div>
      </div>
      <span className="tiny">Open paths show the chosen start/end markers; closed paths keep their joins and caps but do not draw arrowheads.</span>
    </Modal>
  )
}

/** Ctrl+J: a compact Options surface for document units and repeat/nudge defaults. */
export function AppSettingsDialog() {
  const open = useStore((s) => s.settingsDialog)
  const setOpen = useStore((s) => s.setSettingsDialog)
  const doc = useStore((s) => s.doc)
  const commit = useStore((s) => s.commit)
  if (!open) return null
  const unit = doc.settings.displayUnit
  const unitPerPoint = unit === 'in' ? 1 / 72 : unit === 'mm' ? 25.4 / 72 : unit === 'px' ? 4 / 3 : 1
  const set = (patch: Partial<typeof doc.settings>) => commit('Options', (d) => ({ ...d, settings: { ...d.settings, ...patch } }))
  return (
    <Modal title="Options" onClose={() => setOpen(false)} footer={<Button variant="primary" onClick={() => setOpen(false)}>Done</Button>}>
      <span className="tiny">Document-specific defaults used by the drawing tools and workspace.</span>
      <Row><span className="lbl">Display units</span><Select value={doc.settings.displayUnit} width={120} onChange={(v) => set({ displayUnit: v as typeof doc.settings.displayUnit })} options={[
        { value: 'pt', label: 'Points' }, { value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }, { value: 'px', label: 'Pixels' },
      ]} /></Row>
      <Row><span className="lbl">Nudge distance</span><NumberField value={doc.settings.nudgeStep * unitPerPoint} min={0.1} max={1000} step={unit === 'pt' || unit === 'px' ? 1 : 0.1} suffix={unit} onChange={(v) => set({ nudgeStep: v / unitPerPoint })} /></Row>
      <Row><span className="lbl">Duplicate offset</span><NumberField value={doc.settings.duplicateOffset * unitPerPoint} min={0} max={1000} step={unit === 'pt' || unit === 'px' ? 1 : 0.1} suffix={unit} onChange={(v) => set({ duplicateOffset: v / unitPerPoint })} /></Row>
      <Row><span className="lbl">Grid spacing</span><NumberField value={doc.settings.gridStep * unitPerPoint} min={0.1} max={1000} step={unit === 'pt' || unit === 'px' ? 1 : 0.1} suffix={unit} onChange={(v) => set({ gridStep: v / unitPerPoint })} /></Row>
      <Row><span className="lbl">Snap tolerance</span><NumberField value={doc.settings.snapTolerance * unitPerPoint} min={0.1} max={100} step={0.1} suffix={unit} onChange={(v) => set({ snapTolerance: v / unitPerPoint })} /></Row>
      <Check label="Snap to grid" checked={doc.settings.snapToGrid} onChange={(v) => set({ snapToGrid: v })} />
      <Check label="Snap to objects" checked={doc.settings.snapToObjects} onChange={(v) => set({ snapToObjects: v })} />
      <Check label="Dynamic guides" checked={doc.settings.dynamicGuides} onChange={(v) => set({ dynamicGuides: v })} />
      <Check label="Self-snapping" checked={doc.settings.selfSnapping} onChange={(v) => set({ selfSnapping: v })} />
    </Modal>
  )
}

const KEY_REFERENCE: { command: string; shortcut: string; scope: string }[] = [
  { command: 'New / Open / Save / Import', shortcut: 'Ctrl+N / O / S / I', scope: 'Document' },
  { command: 'Export / Print / Options', shortcut: 'Ctrl+E / P / J', scope: 'Document' },
  { command: 'Undo / Redo / Repeat last', shortcut: 'Ctrl+Z / Ctrl+Shift+Z / Ctrl+R', scope: 'Edit' },
  { command: 'Duplicate / Group / Ungroup', shortcut: 'Ctrl+D / Ctrl+G / Ctrl+U', scope: 'Objects' },
  { command: 'Convert to curves / Combine / Break apart', shortcut: 'Ctrl+Q / Ctrl+L / Ctrl+K', scope: 'Objects' },
  { command: 'Order forward / backward', shortcut: 'Page Up / Page Down', scope: 'Objects' },
  { command: 'To front / to back', shortcut: 'Shift+Page Up / Shift+Page Down', scope: 'Objects' },
  { command: 'Zoom in / out / fit drawing / fit page', shortcut: 'F2 / F3 / F4 / Shift+F4', scope: 'View' },
  { command: 'Zoom increment / decrement', shortcut: 'Numpad + / Numpad −', scope: 'View' },
  { command: 'Full-screen preview', shortcut: 'F9; Esc exits', scope: 'View' },
  { command: 'Display mode', shortcut: 'Use View menu', scope: 'View' },
  { command: 'Uniform fill / fountain fill / outline pen', shortcut: 'Shift+F11 / F11 / F12', scope: 'Formatting' },
  { command: 'Select all / deselect / delete', shortcut: 'Ctrl+A / Esc / Delete', scope: 'Selection' },
  { command: 'Small / large nudge', shortcut: 'Arrow keys / Shift+Arrow keys', scope: 'Selection' },
  { command: 'Pick / Shape / Freehand / Text', shortcut: 'V / F10 / F5 / F8', scope: 'Tools' },
  { command: 'Rectangle / Ellipse / Zoom / Pan', shortcut: 'F6 / F7 / Z / H', scope: 'Tools' },
  { command: 'Toggle node cusp / smooth / symmetrical', shortcut: 'C / S / Y', scope: 'Shape tool' },
]

export function ShortcutHelpDialog() {
  const open = useStore((s) => s.shortcutsDialog)
  const setOpen = useStore((s) => s.setShortcutsDialog)
  const [filter, setFilter] = useState('')
  if (!open) return null
  const rows = KEY_REFERENCE.filter((r) => `${r.command} ${r.shortcut} ${r.scope}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <Modal wide title="Keyboard Shortcuts" onClose={() => setOpen(false)} footer={<Button variant="primary" onClick={() => setOpen(false)}>Done</Button>}>
      <input className="field" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search commands or keys" aria-label="Search keyboard shortcuts" />
      <div style={{ maxHeight: 'min(58vh, 560px)', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th align="left">Command</th><th align="left">Shortcut</th><th align="left">Scope</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.command} style={{ borderTop: '1px solid var(--line-soft)' }}>
            <td style={{ padding: 7 }}>{row.command}</td><td style={{ padding: 7 }}><kbd>{row.shortcut}</kbd></td><td className="tiny" style={{ padding: 7 }}>{row.scope}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <span className="tiny">Ctrl means Ctrl on Windows/Linux and ⌘ on macOS. Platform keymaps and localized keyboard layouts can differ.</span>
    </Modal>
  )
}

const FORMATS: { value: ExportOptions['format']; label: string; detail: string }[] = [
  { value: 'cdr', label: 'CDR (CorelDRAW)', detail: 'CorelDRAW RIFF container (.cdr) with full vector paths, layers and lossless document state.' },
  { value: 'svg', label: 'SVG', detail: 'Editable vector web graphic; text stays as text unless you request curves.' },
  { value: 'pdf', label: 'PDF', detail: 'Full fidelity, print-ready. Options include PDF/X-4 and PDF/A output.' },
  { value: 'ai', label: 'AI (PDF compatible)', detail: 'Illustrator interchange PDF — openable in Illustrator, InDesign and CorelDRAW.' },
  { value: 'eps', label: 'EPS', detail: 'PostScript with a bounding box and preview header for prepress.' },
  { value: 'dxf', label: 'DXF', detail: 'AutoCAD interchange; curves are flattened to polylines.' },
  { value: 'png', label: 'PNG', detail: 'Lossless raster with transparency support.' },
  { value: 'jpg', label: 'JPEG', detail: 'Lossy raster, smallest file, quality slider below.' },
  { value: 'webp', label: 'WebP', detail: 'Modern web raster with strong compression.' },
  { value: 'avif', label: 'AVIF', detail: 'Next-generation web raster where the browser supports it.' },
]

export function ExportDialog() {
  const open = useStore((s) => s.exportDialog)
  const close = useStore((s) => s.setExportDialog)
  const doc = useStore((s) => s.doc)
  const [format, setFormat] = useState<ExportOptions['format']>('svg')
  const [options, setOptions] = useState<ExportOptions>({ ...DEFAULT_EXPORT, marks: { ...DEFAULT_EXPORT.marks! }, imposition: { ...DEFAULT_EXPORT.imposition! } })
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'general' | 'web' | 'marks' | 'preview'>('general')
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const isRaster = ['png', 'jpg', 'webp', 'avif'].includes(format)
  const isPrint = format === 'pdf' || format === 'ai' || format === 'eps'

  const preview = useMemo(() => {
    if (!open) return null
    try {
      return separationPreview(doc, page, 'rgb', renderPageForExport, 420)
    } catch {
      return null
    }
  }, [doc, page, open])

  if (!open) return null

  const set = (patch: Partial<ExportOptions>) => setOptions((o) => ({ ...o, ...patch }))

  const run = async () => {
    setBusy(true)
    try {
      const request: ExportRequest = { ...options, format }
      await runExport(request)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      wide
      title={`Export — ${doc.name}`}
      onClose={() => close(false)}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          {isPrint ? <Button icon="print" onClick={() => void printDocument({ ...options, format: 'pdf' })}>Print…</Button> : null}
          <Button variant="primary" icon="export" disabled={busy} onClick={() => void run()}>{busy ? 'Exporting…' : `Export ${format.toUpperCase()}`}</Button>
        </>
      }
    >
      <Row>
        <span className="lbl">Format</span>
        <Select value={format} width={260} onChange={(v) => setFormat(v)} options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} />
        <span className="tiny grow">{FORMATS.find((f) => f.value === format)?.detail}</span>
      </Row>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'general', label: 'General' },
          { value: 'web', label: 'Web / pixel-precise' },
          { value: 'marks', label: 'Prepress' },
          { value: 'preview', label: 'Preview & separations' },
        ]}
      />

      {tab === 'general' ? (
        <div className="col">
          <Row>
            <span className="lbl">Page</span>
            <span className="badge">{page.name} · {Math.round(page.size.w)} × {Math.round(page.size.h)} pt</span>
            <span className="lbl">Bleed</span>
            <NumberField value={options.bleed ?? 0} min={0} max={72} onChange={(v) => set({ bleed: v })} suffix="pt" />
          </Row>
          {isRaster ? (
            <>
              <Slider label="Resolution" value={options.scale ?? 2} min={0.5} max={6} step={0.5} onChange={(v) => set({ scale: v })} format={(v) => `${(v * 96).toFixed(0)} dpi`} />
              {format === 'jpg' ? <Slider label="Quality" value={options.jpegQuality ?? 0.92} min={0.3} max={1} step={0.01} onChange={(v) => set({ jpegQuality: v })} format={(v) => `${Math.round(v * 100)}%`} /> : null}
              <Check label="Include page background" checked={options.background ?? true} onChange={(v) => set({ background: v })} />
            </>
          ) : null}
          {format === 'svg' ? (
            <>
              <Slider label="Path precision" value={options.svgPrecision ?? 3} min={1} max={6} step={1} onChange={(v) => set({ svgPrecision: v })} format={(v) => `${v} decimals`} />
              <Check label="Convert text to curves" checked={options.textAsCurves ?? false} onChange={(v) => set({ textAsCurves: v })} />
            </>
          ) : null}
          {isPrint ? (
            <>
              <Check label="Embed fonts" checked={options.embedFonts ?? true} onChange={(v) => set({ embedFonts: v })} />
              <Check label="Include hidden objects" checked={options.includeHidden ?? false} onChange={(v) => set({ includeHidden: v })} />
              <Check label="Include page background" checked={options.background ?? true} onChange={(v) => set({ background: v })} />
            </>
          ) : null}
        </div>
      ) : null}


      {tab === 'web' ? <WebExportPanel doc={doc} /> : null}
      {tab === 'marks' ? (
        <div className="col">
          <Row>
            <span className="lbl">Preset</span>
            {PRINT_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                small
                title={preset.description}
                onClick={() => set({ pdfStandard: preset.standard, marks: { ...preset.marks! } })}
              >
                {preset.label}
              </Button>
            ))}
          </Row>
          <Row wrap>
            <Check label="Crop marks" checked={options.marks?.crop ?? false} onChange={(v) => set({ marks: { ...options.marks!, crop: v } })} />
            <Check label="Registration targets" checked={options.marks?.registration ?? false} onChange={(v) => set({ marks: { ...options.marks!, registration: v } })} />
            <Check label="Colour bars" checked={options.marks?.colourBars ?? false} onChange={(v) => set({ marks: { ...options.marks!, colourBars: v } })} />
            <Check label="Page information" checked={options.marks?.pageInfo ?? false} onChange={(v) => set({ marks: { ...options.marks!, pageInfo: v } })} />
          </Row>
          <Row>
            <span className="lbl">PDF standard</span>
            <Select
              value={options.pdfStandard ?? 'none'}
              width={220}
              onChange={(v) => set({ pdfStandard: v as ExportOptions['pdfStandard'] })}
              options={[
                { value: 'none', label: 'None (smallest file)' },
                { value: 'pdfx4', label: 'PDF/X-4 (press ready)' },
                { value: 'pdfa', label: 'PDF/A (archival)' },
              ]}
            />
          </Row>
          <Check label="Include separations note (C/M/Y/K)" checked={options.separations ?? false} onChange={(v) => set({ separations: v })} />
          <div className="sep" />
          <Row wrap>
            <Check label="Imposition (multi-up)" checked={options.imposition?.enabled ?? false} onChange={(v) => set({ imposition: { ...options.imposition!, enabled: v } })} />
            {options.imposition?.enabled ? (() => {
              const imp = options.imposition!
              return (
                <>
                  <span className="lbl">Columns</span>
                  <NumberField value={imp.columns} min={1} max={8} onChange={(v) => set({ imposition: { ...imp, columns: Math.round(v) } })} />
                  <span className="lbl">Rows</span>
                  <NumberField value={imp.rows} min={1} max={8} onChange={(v) => set({ imposition: { ...imp, rows: Math.round(v) } })} />
                  <span className="lbl">Gap</span>
                  <NumberField value={imp.gap} min={0} max={72} onChange={(v) => set({ imposition: { ...imp, gap: v } })} />
                </>
              )
            })() : null}
          </Row>
          <span className="tiny">Imposition repeats the document's pages across one sheet — page 1 top-left, filling left to right.</span>
        </div>
      ) : null}

      {tab === 'preview' ? (
        <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <div className="col" style={{ width: 340 }}>
            <span className="lbl">Live preview</span>
            {preview ? <img src={preview} alt="Print preview" style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} /> : <span className="tiny">Preview unavailable</span>}
          </div>
          <div className="col grow">
            <span className="lbl">Colour separations</span>
            <div className="grid2">
              {(['c', 'm', 'y', 'k'] as const).map((channel) => (
                <div key={channel} className="col" style={{ gap: 4 }}>
                  <span className="tiny">{channel === 'c' ? 'Cyan' : channel === 'm' ? 'Magenta' : channel === 'y' ? 'Yellow' : 'Black'}</span>
                  <img
                    src={separationPreview(doc, page, channel, renderPageForExport, 180)}
                    alt={`${channel} separation`}
                    style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 6, background: '#fff' }}
                  />
                </div>
              ))}
            </div>
            <span className="tiny">Separations are rendered live from the document using a deterministic RGB→CMYK conversion (no ICC profile needed offline).</span>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

/* --------------------------------------------------------- web export tab -- */

function WebExportPanel({ doc }: { doc: import('../types').Document }) {
  const selectedObjects = useStore((s) => s.selectedObjects)()
  const [options, setOptions] = useState<WebExportOptions>({ ...DEFAULT_WEB_EXPORT, slices: { ...DEFAULT_WEB_EXPORT.slices } })
  const [result, setResult] = useState<WebExportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const selection = useStore((s) => s.selection)

  const update = (patch: Partial<Omit<WebExportOptions, 'slices'>> & { slices?: Partial<WebExportOptions['slices']> }) =>
    setOptions((o) => ({ ...o, ...patch, slices: { ...o.slices, ...(patch.slices ?? {}) } }))

  // Live preview: regenerated whenever the options or the document change.
  useEffect(() => {
    let cancelled = false
    setBusy(true)
    const timer = window.setTimeout(() => {
      void exportWeb(doc, page, options, defaultWebRenderer, selectedObjects)
        .then((next) => { if (!cancelled) { setResult(next); setError(null) } })
        .catch((err: Error) => { if (!cancelled) setError(err.message) })
        .finally(() => { if (!cancelled) setBusy(false) })
    }, 160)
    return () => { cancelled = true; window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, options, selectedObjects.length])

  const total = result?.files.reduce((sum, file) => sum + file.bytes.size, 0) ?? 0

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
      <div className="col" style={{ width: 320 }}>
        <Row>
          <span className="lbl">Format</span>
          <Select
            value={options.format}
            width={120}
            onChange={(v) => update({ format: v as WebExportOptions['format'] })}
            options={[
              { value: 'webp', label: 'WebP' },
              { value: 'png', label: 'PNG' },
              { value: 'jpg', label: 'JPEG' },
              { value: 'avif', label: 'AVIF' },
            ]}
          />
        </Row>
        <Row>
          <span className="lbl">CSS width</span>
          <NumberField value={options.width} min={16} max={8000} onChange={(v) => update({ width: Math.round(v) })} suffix="px" />
          <span className="lbl">Height</span>
          <NumberField value={options.height} min={0} max={8000} onChange={(v) => update({ height: Math.round(v) })} suffix={options.height ? 'px' : 'auto'} />
        </Row>
        <Row wrap>
          <span className="lbl">Densities</span>
          {[1, 2, 3].map((scale) => (
            <Check
              key={scale}
              label={`${scale}×`}
              checked={options.scales.includes(scale)}
              onChange={(on) => {
                const next = on ? [...new Set([...options.scales, scale])].sort() : options.scales.filter((s) => s !== scale)
                update({ scales: next.length ? next : [1] })
              }}
            />
          ))}
          <Check label="Transparent" checked={!options.background} onChange={(on) => update({ background: !on })} />
        </Row>
        {options.format === 'jpg' || options.format === 'webp' || options.format === 'avif' ? (
          <Slider label="Quality" value={options.quality} min={0.3} max={1} step={0.01} onChange={(v) => update({ quality: v })} format={(v) => `${Math.round(v * 100)}%`} />
        ) : null}
        <Row wrap>
          <Check label="Slice into a grid" checked={options.slices.enabled} onChange={(on) => update({ slices: { enabled: on } })} />
          {options.slices.enabled ? (
            <>
              <NumberField value={options.slices.columns} min={1} max={12} onChange={(v) => update({ slices: { columns: Math.round(v) } })} suffix="cols" />
              <NumberField value={options.slices.rows} min={1} max={12} onChange={(v) => update({ slices: { rows: Math.round(v) } })} suffix="rows" />
            </>
          ) : null}
        </Row>
        <Row>
          <Check
            label={`Selection only (${selection.length} object${selection.length === 1 ? '' : 's'})`}
            checked={options.selectionOnly}
            onChange={(on) => update({ selectionOnly: on })}
          />
        </Row>
        <span className="tiny">
          Files are encoded by the browser at exactly the requested pixel size — a 1200 px asset at 2× is 2400 physical pixels wide.
        </span>
      </div>

      <div className="col grow" style={{ gap: 8 }}>
        <Row>
          <span className="lbl">{busy ? 'Generating…' : result ? `${result.files.length} file(s) · ${formatBytes(total)}` : 'Web export'}</span>
          <span className="spacer" />
          <Button small disabled={busy || !result} onClick={() => { void runWebExport(options) }} icon="download">Download all</Button>
          <Button small disabled={!result} onClick={() => { void navigator.clipboard?.writeText(result ? `${result.snippet}\n\n${result.css}` : '') }} icon="copy">Copy snippet</Button>
        </Row>
        {error ? <span className="tiny" style={{ color: 'var(--danger)' }}>{error}</span> : null}
        {result ? (
          <>
            <div className="grid2">
              {result.files.slice(0, 6).map((file) => (
                <div key={file.name} className="col" style={{ gap: 3 }}>
                  <img src={file.preview} alt={file.name} style={{ width: '100%', background: '#fff', border: '1px solid var(--line)', borderRadius: 6 }} />
                  <span className="tiny mono">{file.name} · {file.width}×{file.height} · {formatBytes(file.bytes.size)}</span>
                </div>
              ))}
            </div>
            <span className="lbl">Copy-paste snippet</span>
            <pre className="code-block">{result.snippet}</pre>
            <span className="tiny">The snippet uses srcset so every density ships in one tag. @1x/@2x downloads land in your downloads folder (or the folder you pick), ready to drop into a site.</span>
          </>
        ) : null}
      </div>
    </div>
  )
}

export function PrintDialog() {
  const open = useStore((s) => s.printDialog)
  const close = useStore((s) => s.setPrintDialog)
  const doc = useStore((s) => s.doc)
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const [presetId, setPresetId] = useState('press-x4')
  const [copies, setCopies] = useState(1)
  const [marks, setMarks] = useState({ crop: true, registration: true, colourBars: true, pageInfo: true })
  const [bleed, setBleed] = useState(page.bleed)
  const [standard, setStandard] = useState<ExportOptions['pdfStandard']>('pdfx4')

  useEffect(() => {
    const preset = PRINT_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    setStandard(preset.standard)
    setMarks({ ...preset.marks! })
  }, [presetId])

  if (!open) return null
  const preset = PRINT_PRESETS.find((p) => p.id === presetId)!

  return (
    <Modal
      wide
      title={`Print preview — ${page.name}`}
      onClose={() => close(false)}
      footer={
        <>
          <Button onClick={() => close(false)}>Close</Button>
          <Button
            variant="primary"
            icon="print"
            onClick={() => {
              void printDocument({
                format: 'pdf',
                pdfStandard: standard,
                marks,
                bleed,
                separations: marks.colourBars,
                imposition: { enabled: false, columns: 1, rows: 1, gap: 12 },
              })
            }}
          >
            Print {copies > 1 ? `${copies}×` : ''}
          </Button>
        </>
      }
    >
      <Row>
        <span className="lbl">Printer preset</span>
        <Select value={presetId} onChange={setPresetId} options={PRINT_PRESETS.map((p) => ({ value: p.id, label: p.label }))} width={260} />
        <span className="tiny grow">{preset.description}</span>
      </Row>
      <Row>
        <span className="lbl">Copies</span>
        <NumberField value={copies} min={1} max={99} onChange={(v) => setCopies(Math.round(v))} />
        <span className="lbl">Bleed</span>
        <NumberField value={bleed} min={0} max={36} onChange={setBleed} suffix="pt" />
        <span className="lbl">PDF standard</span>
        <Select value={standard ?? 'none'} onChange={(v) => setStandard(v as ExportOptions['pdfStandard'])} width={200} options={[{ value: 'none', label: 'None' }, { value: 'pdfx4', label: 'PDF/X-4' }, { value: 'pdfa', label: 'PDF/A' }]} />
      </Row>
      <Row wrap>
        <Check label="Crop marks" checked={marks.crop} onChange={(v) => setMarks((m) => ({ ...m, crop: v }))} />
        <Check label="Registration" checked={marks.registration} onChange={(v) => setMarks((m) => ({ ...m, registration: v }))} />
        <Check label="Colour bars" checked={marks.colourBars} onChange={(v) => setMarks((m) => ({ ...m, colourBars: v }))} />
        <Check label="Page info" checked={marks.pageInfo} onChange={(v) => setMarks((m) => ({ ...m, pageInfo: v }))} />
      </Row>
      <PrintPreview marks={marks} bleed={bleed} />
      <span className="tiny">The preview is generated from the live document; printing opens the browser dialog with the same PDF, so what you see is what is sent to the printer.</span>
    </Modal>
  )
}

function PrintPreview({ marks, bleed }: { marks: { crop: boolean; registration: boolean; colourBars: boolean }; bleed: number }) {
  const doc = useStore((s) => s.doc)
  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const src = useMemo(() => separationPreview(doc, page, 'rgb', renderPageForExport, 460), [doc, page])
  const margin = 22
  return (
    <div className="col" style={{ gap: 6 }}>
      <div style={{ position: 'relative', background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: margin }}>
        <img src={src} alt="Print preview" style={{ display: 'block', width: '100%' }} />
        {marks.crop ? <span className="tiny" style={{ position: 'absolute', inset: 4, border: '1px dashed #999', pointerEvents: 'none' }} /> : null}
        {marks.registration ? <span style={{ position: 'absolute', right: 8, top: 8, color: '#444', fontSize: 11 }}>⊕</span> : null}
        {marks.colourBars ? (
          <div style={{ display: 'flex', gap: 0, marginTop: 4 }}>
            {['#00AEEF', '#EC008C', '#FFF200', '#000000', '#F7941D', '#8DC63F', '#92278F', '#00A99D', '#ED1C24', '#1C75BC'].map((c) => (
              <span key={c} style={{ flex: 1, height: 12, background: c }} />
            ))}
          </div>
        ) : null}
        <Col><span className="tiny">Bleed {bleed} pt · {Math.round(page.size.w)} × {Math.round(page.size.h)} pt</span></Col>
      </div>
    </div>
  )
}
