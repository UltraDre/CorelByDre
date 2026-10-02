/**
 * Export and print dialogs, including the real-time print preview with colour
 * separations, printer's marks and imposition.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ExportOptions } from '../lib/export'
import { DEFAULT_EXPORT, PRINT_PRESETS, separationPreview } from '../lib/export'
import { useStore } from '../store/store'
import { Button, Check, Col, Modal, NumberField, Row, Select, Slider, Tabs } from './widgets'
import { printDocument, renderPageForExport, runExport, runWebExport, type ExportRequest } from './fileOps'
import { DEFAULT_WEB_EXPORT, defaultWebRenderer, exportWeb, formatBytes, type WebExportOptions, type WebExportResult } from '../lib/webexport'

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
