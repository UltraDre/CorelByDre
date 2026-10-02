/**
 * Home dashboard — the first screen: create, open, recent documents, templates
 * and a short orientation to the suite. Works entirely offline; "recent" comes
 * from IndexedDB.
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store/store'
import { BrandMark, Icon, type IconName } from './icons'
import { Button } from './widgets'
import { listDocuments, formatBytes, persistStorage, estimateStorage, type StoredDocument } from '../lib/storage'
import { newDocument, openDocument, openRecent, placeImage } from './fileOps'
import { PAGE_PRESETS } from '../store/mutations'
import { kernelStatus } from '../lib/wasm'
import { fonts } from '../lib/text'

const HIGHLIGHTS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'shape', title: 'Vector illustration', body: 'Bezier, Pen, Freehand, Smart drawing, symmetry, envelopes and live effects on a 60 fps canvas.' },
  { icon: 'text', title: 'Typography', body: 'Artistic and paragraph text, variable fonts, OpenType features, text on a path and full glyph browsing.' },
  { icon: 'photo', title: 'PHOTO-PAINT', body: 'Hue and tone curves, masking, subject selection, Liquify, lens correction and retouching — all offline.' },
  { icon: 'separations', title: 'Print ready', body: 'PDF/X-4, PDF/A, separations, printer’s marks, imposition and a real-time print preview.' },
]

export function Home() {
  const setHome = useStore((s) => s.setHome)
  const setExportDialog = useStore((s) => s.setExportDialog)
  const setPrintDialog = useStore((s) => s.setPrintDialog)
  const installPrompt = useStore((s) => s.installPrompt)
  const theme = useStore((s) => s.theme)
  const [recent, setRecent] = useState<StoredDocument[]>([])
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [fontCount, setFontCount] = useState(() => fonts.list().length)

  useEffect(() => {
    void listDocuments().then((docs) => setRecent(docs.slice(0, 8))).catch(() => undefined)
    void estimateStorage().then(setStorage).catch(() => undefined)
    return fonts.subscribe(() => setFontCount(fonts.list().length))
  }, [])

  return (
    <div className="home">
      <div className="home-inner">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <h1><span>CorelByDre</span> Graphics Suite</h1>
            <p className="lead">
              A complete vector illustration, page layout and photo-editing studio that runs in your browser and keeps working
              offline. Nothing you draw leaves this device unless you choose to sync it.
            </p>
          </div>
          <div className="col" style={{ alignItems: 'flex-end', gap: 8 }}>
            <Row>
              <Button icon="sun" onClick={() => useStore.getState().setTheme(theme === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? 'Light' : 'Dark'} mode
              </Button>
              {installPrompt ? (
                <Button variant="primary" icon="install" onClick={() => {
                  const event = installPrompt as { prompt?: () => Promise<void> }
                  void event.prompt?.()
                  useStore.getState().setInstallPrompt(null)
                }}>Install app</Button>
              ) : null}
            </Row>
            <span className="tiny">Kernels: {kernelStatus() === 'ready' ? 'WASM (fast)' : 'JavaScript fallback'} · {fontCount} fonts</span>
          </div>
        </div>

        <div className="home-grid">
          <button type="button" className="home-card" title="New document" data-tooltip="New document" onClick={() => void newDocument()}>
            <h4><Icon name="new" size={15} /> New document</h4>
            <p>Start from A4 and change the size any time in the Pages docker.</p>
          </button>
          <button type="button" className="home-card" title="Open CorelDRAW (.cdr), SVG, PDF, AI, EPS, DXF or image files" data-tooltip="Open CDR / design file" onClick={() => void openDocument()}>
            <h4><Icon name="open" size={15} /> Open / Import CDR…</h4>
            <p>CorelDRAW (.cdr), SVG, PDF, AI, EPS, DXF, WebP, HEIF, RAW, images and CorelByDre files.</p>
          </button>
          <button type="button" className="home-card" title="Place image or import CDR / vector artwork onto the active page" data-tooltip="Import / Place into page" onClick={() => { setHome(false); void placeImage() }}>
            <h4><Icon name="photo" size={15} /> Import / Place</h4>
            <p>Import a .cdr, vector or photo onto the page; PHOTO-PAINT dockers pick it up automatically.</p>
          </button>
          <button type="button" className="home-card" title="Export or save as CDR, SVG, PDF, AI, EPS, DXF, PNG, JPEG, WebP or AVIF" data-tooltip="Export / Save as CDR" onClick={() => { setHome(false); setExportDialog(true) }}>
            <h4><Icon name="export" size={15} /> Save CDR / Export</h4>
            <p>CorelDRAW (.cdr), SVG, PDF/X-4, PDF/A, AI, EPS, DXF, PNG, JPEG, WebP and AVIF.</p>
          </button>
          <button type="button" className="home-card" title="Print & prepress preview" data-tooltip="Print & prepress" onClick={() => { setHome(false); setPrintDialog(true) }}>
            <h4><Icon name="print" size={15} /> Print & prepress</h4>
            <p>Real-time preview, marks, bleed, separations and imposition.</p>
          </button>
        </div>

        <div className="home-section">
          <h2>Templates</h2>
          <div className="template-strip">
            {PAGE_PRESETS.map((preset) => (
              <button key={preset.id} type="button" className="template-card" title={`Create ${preset.label}`} data-tooltip={preset.label} onClick={() => void newDocument(preset.id)}>
                <div className="thumb" style={{ aspectRatio: `${preset.w} / ${preset.h}`, maxHeight: 110 }}>
                  {preset.label.split(' ')[0]}
                </div>
                <strong style={{ fontSize: 12 }}>{preset.label}</strong>
                <div className="meta tiny">{Math.round(preset.w)} × {Math.round(preset.h)} pt</div>
              </button>
            ))}
          </div>
        </div>

        {recent.length ? (
          <div className="home-section">
            <h2>Recent documents <span className="tiny">(stored on this device)</span></h2>
            <div className="recent-grid">
              {recent.map((doc) => (
                <button key={doc.id} type="button" className="recent" onClick={() => void openRecent(doc.id)}>
                  {doc.thumbnail ? <img src={doc.thumbnail} alt="" /> : <div style={{ height: 120, display: 'grid', placeItems: 'center' }}><Icon name="pages" /></div>}
                  <strong>{doc.name}</strong>
                  <span className="meta">{new Date(doc.modifiedAt).toLocaleString()} · {doc.pageCount} page(s) · {formatBytes(doc.size)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="home-section">
          <h2>What is inside</h2>
          <div className="home-grid">
            {HIGHLIGHTS.map((h) => (
              <div key={h.title} className="home-card">
                <h4><Icon name={h.icon} size={15} /> {h.title}</h4>
                <p>{h.body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="home-section">
          <h2>Offline & privacy</h2>
          <Row wrap>
            <span className="chip"><Icon name="check" size={12} /> Works offline — a service worker caches the whole app shell</span>
            <span className="chip"><Icon name="check" size={12} /> Autosave to IndexedDB every few seconds</span>
            <span className="chip"><Icon name="check" size={12} /> No AI or generative features anywhere</span>
            <span className="chip"><Icon name="check" size={12} /> Cloud sync is optional and degrades gracefully</span>
          </Row>
          <Row>
            <Button small icon="install" onClick={() => void persistStorage().then((granted: boolean) => useStore.getState().toast(granted ? 'success' : 'info', granted ? 'Storage will be kept on this device' : 'Storage persistence was not granted'))}>
              Request persistent storage
            </Button>
            {storage ? <span className="tiny">{formatBytes(storage.usage)} used of {formatBytes(storage.quota)} available</span> : null}
          </Row>
        </div>

        <div className="row" style={{ marginTop: 26 }}>
          <BrandMark size={26} />
          <span className="tiny">
            CorelByDre is an independent, browser-based studio inspired by professional vector and photo workflows.
            Formats such as CDR and DWG are handled through documented, limited interop paths.
          </span>
        </div>
      </div>
    </div>
  )
}

function Row({ children, wrap }: { children: React.ReactNode; wrap?: boolean }) {
  return <div className={`row ${wrap ? 'wrap' : ''}`} style={{ gap: 8 }}>{children}</div>
}
