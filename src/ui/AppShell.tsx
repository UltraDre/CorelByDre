/**
 * Application shell: title bar (Window Controls Overlay aware), menu bar,
 * property bar, toolbox, canvas, docker stack and status bar — plus the global
 * keyboard shortcuts and the online/offline + background-sync plumbing.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore, type DockerID } from '../store/store'
import { SHORTCUTS, toolDef } from '../tools/registry'
import { CanvasView } from './CanvasView'
import { Toolbox } from './Toolbox'
import { PropertyBar } from './PropertyBar'
import {
  AdjustmentsDocker, BrushDocker, ColorDocker, EffectsDocker, HistoryDocker, LayersDocker, MaskingDocker,
  ObjectDocker, PagesDocker, PrintDocker, RetouchDocker, ShapingDocker, SymbolsDocker, TextDocker,
} from './Dockers'
import { CommentsDocker, NotificationCentre, PresenceAvatars, ShareDocker } from './Collab'
import { useCollab } from '../store/collab'
import { Home } from './Home'
import { BrandMark, Icon, type IconName } from './icons'
import { Button, IconButton, Toasts } from './widgets'
import { ExportDialog, PrintDialog } from './Dialogs'
import { autosave, newDocument, openDocument, placeImage, printDocument, saveDocument } from './fileOps'
import { kernelStatus } from '../lib/wasm'
import { MOD_KEY_LABEL } from '../lib/util'
import { listSyncJobs, requestBackgroundSync, type SyncJob } from '../lib/storage'

/* ================================================================== shell === */

export function AppShell() {
  const theme = useStore((s) => s.theme)
  const homeVisible = useStore((s) => s.homeVisible)
  const dirty = useStore((s) => s.dirty)
  const doc = useStore((s) => s.doc)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!useStore.getState().dirty) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => {
    const unsubscribe = useStore.subscribe(
      (s) => s.dirty,
      (isDirty) => { if (isDirty) void autosave() },
    )
    return unsubscribe
  }, [])

  useInstallPrompt()
  useOnlineSync()
  useShortcuts()

  return (
    <div className="app">
      <TitleBar />
      <MenuBar />
      <PropertyBar />
      <div className="main">
        <Toolbox />
        <CanvasView />
        <DockersPanel />
      </div>
      <StatusBar />
      {homeVisible ? <Home /> : null}
      <ExportDialog />
      <PrintDialog />
      <Toasts />
      <span hidden>{doc.id}{dirty ? '' : ''}</span>
    </div>
  )
}

/* ============================================================== title bar === */

function TitleBar() {
  const doc = useStore((s) => s.doc)
  const dirty = useStore((s) => s.dirty)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const setHome = useStore((s) => s.setHome)
  const setExportDialog = useStore((s) => s.setExportDialog)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.history.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const installPrompt = useStore((s) => s.installPrompt)

  return (
    <header className="titlebar">
      <button type="button" className="btn ghost small" onClick={() => setHome(true)} title="Home — templates, recent files and install">
        <BrandMark size={18} />
      </button>
      <span className="brand">
        CorelByDre
        <small>Graphics Suite</small>
      </span>
      <span className="doc-name">
        {doc.name}{dirty ? <span className="dirty-dot"> •</span> : ''} — {doc.pages.length} page{doc.pages.length === 1 ? '' : 's'}
      </span>
      <span className="spacer" />
      <IconButton icon="open" title={`Open (${MOD_KEY_LABEL}+O)`} onClick={() => void openDocument()} />
      <IconButton icon="save" title={`Save (${MOD_KEY_LABEL}+S)`} onClick={() => void saveDocument()} />
      <IconButton icon="export" title={`Export (${MOD_KEY_LABEL}+E)`} onClick={() => setExportDialog(true)} />
      <IconButton icon="print" title={`Print (${MOD_KEY_LABEL}+P)`} onClick={() => useStore.getState().setPrintDialog(true)} />
      <IconButton icon="undo" title={`Undo (${MOD_KEY_LABEL}+Z)`} onClick={undo} disabled={!canUndo} />
      <IconButton icon="redo" title={`Redo (${MOD_KEY_LABEL}+⇧+Z)`} onClick={redo} disabled={!canRedo} />
      <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} title="Switch dark / light" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
      <PresenceAvatars compact />
      <NotificationCentre />
      <IconButton icon="users" title="Collaborate — invite, presence, sync" onClick={() => useStore.getState().toggleDocker('collab')} />
      <IconButton icon="comment" title="Comments" onClick={() => useStore.getState().toggleDocker('comments')} />
      {installPrompt ? <IconButton icon="install" title="Install CorelByDre" onClick={() => void (installPrompt as { prompt?: () => Promise<void> }).prompt?.()} /> : null}
    </header>
  )
}

/* =============================================================== menu bar === */

interface MenuItem {
  label: string
  shortcut?: string
  action?: () => void
  disabled?: boolean
  checked?: boolean
  separator?: boolean
}

function MenuBar() {
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const store = useStore()
  const selection = store.selection

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const menus: { id: string; label: string; items: MenuItem[] }[] = useMemo(() => [
    {
      id: 'file', label: 'File', items: [
        { label: 'New…', shortcut: `${MOD_KEY_LABEL}+N`, action: () => void newDocument() },
        { label: 'Open…', shortcut: `${MOD_KEY_LABEL}+O`, action: () => void openDocument() },
        { label: 'Place image…', action: () => void placeImage() },
        { separator: true, label: '' },
        { label: 'Save', shortcut: `${MOD_KEY_LABEL}+S`, action: () => void saveDocument() },
        { label: 'Save as…', shortcut: `${MOD_KEY_LABEL}+⇧+S`, action: () => void saveDocument(true) },
        { separator: true, label: '' },
        { label: 'Export…', shortcut: `${MOD_KEY_LABEL}+E`, action: () => store.setExportDialog(true) },
        { label: 'Print preview…', shortcut: `${MOD_KEY_LABEL}+P`, action: () => store.setPrintDialog(true) },
        { label: 'Print to PDF (press preset)', action: () => void printDocument({ format: 'pdf', pdfStandard: 'pdfx4', marks: { crop: true, registration: true, colourBars: true, pageInfo: true }, separations: true }) },
      ],
    },
    {
      id: 'edit', label: 'Edit', items: [
        { label: 'Undo', shortcut: `${MOD_KEY_LABEL}+Z`, disabled: !store.history.length, action: store.undo },
        { label: 'Redo', shortcut: `${MOD_KEY_LABEL}+⇧+Z`, disabled: !store.future.length, action: store.redo },
        { separator: true, label: '' },
        { label: 'Duplicate', shortcut: `${MOD_KEY_LABEL}+D`, disabled: !selection.length, action: store.duplicateSelection },
        { label: 'Delete', shortcut: 'Del', disabled: !selection.length, action: store.deleteSelection },
        { label: 'Select all', shortcut: `${MOD_KEY_LABEL}+A`, action: () => {
          const page = store.doc.pages.find((p) => p.id === store.doc.activePageId) ?? store.doc.pages[0]
          store.setSelection(page.layers.flatMap((l) => l.objects).map((o) => o.id))
        } },
        { label: 'Deselect', shortcut: 'Esc', action: store.clearSelection },
      ],
    },
    {
      id: 'object', label: 'Object', items: [
        { label: 'Group', shortcut: `${MOD_KEY_LABEL}+G`, disabled: selection.length < 2, action: store.groupSelection },
        { label: 'Ungroup', shortcut: `${MOD_KEY_LABEL}+U`, action: store.ungroupSelection },
        { separator: true, label: '' },
        { label: 'Align left', disabled: !selection.length, action: () => store.alignSelection('left') },
        { label: 'Align centre', disabled: !selection.length, action: () => store.alignSelection('hcenter') },
        { label: 'Align right', disabled: !selection.length, action: () => store.alignSelection('right') },
        { label: 'Distribute horizontally', disabled: selection.length < 3, action: () => store.alignSelection('hdistribute') },
        { label: 'Distribute vertically', disabled: selection.length < 3, action: () => store.alignSelection('vdistribute') },
      ],
    },
    {
      id: 'view', label: 'View', items: [
        { label: 'Grid', checked: store.view.showGrid, action: () => store.setView({ showGrid: !store.view.showGrid }) },
        { label: 'Guides', checked: store.view.showGuides, action: () => store.setView({ showGuides: !store.view.showGuides }) },
        { label: 'Rulers', checked: store.view.showRulers, action: () => store.setView({ showRulers: !store.view.showRulers }) },
        { label: 'Wireframe', checked: store.view.wireframe, action: () => store.setView({ wireframe: !store.view.wireframe }) },
        { label: 'Preview live effects', checked: store.previewEffects, action: () => store.setPreviewEffects(!store.previewEffects) },
        { separator: true, label: '' },
        { label: 'Zoom to fit', action: () => {
          const page = store.doc.pages.find((p) => p.id === store.doc.activePageId) ?? store.doc.pages[0]
          store.setView({ zoom: 1, panX: 40, panY: 40 })
          void page
        } },
        { label: '100 %', action: () => store.zoomTo(1) },
      ],
    },
    {
      id: 'window', label: 'Window', items: (Object.keys(store.dockers) as DockerID[]).map((id) => ({
        label: id.charAt(0).toUpperCase() + id.slice(1),
        checked: store.dockers[id],
        action: () => store.toggleDocker(id),
      })),
    },
    {
      id: 'help', label: 'Help', items: [
        { label: 'Keyboard shortcuts…', action: () => store.toast('info', 'Shortcuts', Object.entries(SHORTCUTS).slice(0, 12).map(([k, v]) => `${k.toUpperCase()} — ${toolDef(v).label}`).join(' · ')) },
        { label: 'Offline status', action: () => store.toast(navigator.onLine ? 'success' : 'warn', navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? 'Cloud sync is available; exports continue locally.' : 'Everything still works — documents autosave locally.') },
        { label: 'About CorelByDre', action: () => store.toast('info', 'CorelByDre Graphics Suite', 'A browser-native vector, layout and photo studio. No AI features: every tool is a deterministic operator you control.') },
      ],
    },
  ], [store, selection])

  return (
    <nav className="menubar" ref={ref}>
      {menus.map((menu) => (
        <div key={menu.id} className={`menu ${open === menu.id ? 'open' : ''}`}>
          <button
            type="button"
            onClick={() => setOpen(open === menu.id ? null : menu.id)}
            onMouseEnter={() => { if (open) setOpen(menu.id) }}
          >
            {menu.label}
          </button>
          {open === menu.id ? (
            <div className="menu-popup">
              {menu.items.map((item, i) =>
                item.separator ? (
                  <div key={`sep-${i}`} className="menu-sep" />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    className="menu-item"
                    disabled={item.disabled}
                    onClick={() => { item.action?.(); setOpen(null) }}
                  >
                    <span style={{ width: 14 }}>{item.checked ? <Icon name="check" size={13} /> : null}</span>
                    {item.label}
                    {item.shortcut ? <span className="kbd">{item.shortcut}</span> : null}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      ))}
    </nav>
  )
}

/* ================================================================ dockers === */

const DOCKER_ICONS: Record<DockerID, IconName> = {
  object: 'shape', color: 'palette', layers: 'layers', pages: 'pages', effects: 'effects',
  adjustments: 'photo', masking: 'mask', retouch: 'wrench', text: 'text', brush: 'brush',
  history: 'history', print: 'print', shaping: 'node', symbols: 'ring',
  comments: 'comment', collab: 'users',
}

export function DockersPanel() {
  const dockers = useStore((s) => s.dockers)
  const toggle = useStore((s) => s.toggleDocker)
  const [collapsed, setCollapsed] = useState(false)
  const openIds = (Object.keys(dockers) as DockerID[]).filter((id) => dockers[id])

  return (
    <aside className={`dockers ${collapsed ? 'collapsed' : ''}`}>
      <div className="dockers-rail" style={{ flexDirection: 'row', flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
        <button type="button" title={collapsed ? 'Show dockers' : 'Collapse dockers'} onClick={() => setCollapsed((c) => !c)}>
          <Icon name={collapsed ? 'drag' : 'close'} size={14} />
        </button>
        {(Object.keys(dockers) as DockerID[]).map((id) => (
          <button key={id} type="button" className={dockers[id] ? 'on' : ''} title={id} onClick={() => toggle(id)}>
            <Icon name={DOCKER_ICONS[id]} size={14} />
          </button>
        ))}
      </div>
      {!collapsed ? (
        <div className="dockers-body">
          {openIds.includes('object') ? <ObjectDocker /> : null}
          {openIds.includes('color') ? <ColorDocker /> : null}
          {openIds.includes('layers') ? <LayersDocker /> : null}
          {openIds.includes('pages') ? <PagesDocker /> : null}
          {openIds.includes('effects') ? <EffectsDocker /> : null}
          {openIds.includes('adjustments') ? <AdjustmentsDocker /> : null}
          {openIds.includes('masking') ? <MaskingDocker /> : null}
          {openIds.includes('retouch') ? <RetouchDocker /> : null}
          {openIds.includes('text') ? <TextDocker /> : null}
          {openIds.includes('brush') ? <BrushDocker /> : null}
          {openIds.includes('history') ? <HistoryDocker /> : null}
          {openIds.includes('print') ? <PrintDocker /> : null}
          {openIds.includes('shaping') ? <ShapingDocker /> : null}
          {openIds.includes('symbols') ? <SymbolsDocker /> : null}
          {openIds.includes('comments') ? <CommentsDocker /> : null}
          {openIds.includes('collab') ? <ShareDocker /> : null}
          {openIds.length === 0 ? (
            <div className="col" style={{ padding: 12 }}>
              <span className="tiny">All dockers are closed. Use the buttons above or the Window menu to bring them back.</span>
              <Button small onClick={() => ['object', 'color', 'layers'].forEach((id) => toggle(id as DockerID))}>Restore defaults</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}

/* ============================================================== status bar === */

function StatusBar() {
  const status = useStore((s) => s.statusMessage)
  const doc = useStore((s) => s.doc)
  const view = useStore((s) => s.view)
  const selection = useStore((s) => s.selection)
  const commit = useStore((s) => s.commit)
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [jobs, setJobs] = useState<SyncJob[]>([])

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    void listSyncJobs().then(setJobs).catch(() => undefined)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
  const unit = doc.settings.displayUnit

  return (
    <footer className="statusbar">
      <span>{status}</span>
      <span className="spacer" />
      <span>{selection.length ? `${selection.length} selected` : 'No selection'}</span>
      <button type="button" className="sbtn" title="Toggle grid" onClick={() => useStore.getState().setView({ showGrid: !view.showGrid })}>
        Grid {view.showGrid ? 'on' : 'off'}
      </button>
      <button type="button" className="sbtn" title="Toggle snapping" onClick={() => commit('Snapping', (d) => ({ ...d, settings: { ...d.settings, snapToObjects: !d.settings.snapToObjects, snapToGuides: !d.settings.snapToGuides } }))}>
        Snap {doc.settings.snapToObjects || doc.settings.snapToGuides ? 'on' : 'off'}
      </button>
      <select
        className="sbtn"
        value={unit}
        onChange={(e) => commit('Units', (d) => ({ ...d, settings: { ...d.settings, displayUnit: e.target.value as typeof unit } }))}
        title="Display units"
      >
        {['pt', 'mm', 'in', 'px'].map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
      <span>{page.name}</span>
      <span>{Math.round(page.size.w)} × {Math.round(page.size.h)} {unit}</span>
      <span>{Math.round(view.zoom * 100)}%</span>
      <span title="Image kernels">{kernelStatus() === 'ready' ? 'WASM' : 'JS'}</span>
      <CollabStatus />
      <button
        type="button"
        className="sbtn"
        title={online ? 'Online — sync queue' : 'Offline — changes are queued locally'}
        onClick={() => void requestBackgroundSync().then(() => listSyncJobs().then(setJobs))}
      >
        <Icon name={online ? 'cloud' : 'warning'} size={12} /> {online ? `Sync${jobs.length ? ` (${jobs.length})` : ''}` : 'Offline'}
      </button>
    </footer>
  )
}

/* ============================================================ collab status === */

function CollabStatus() {
  const room = useCollab((s) => s.room)
  const connected = useCollab((s) => s.connected)
  const syncing = useCollab((s) => s.syncing)
  const outbox = useCollab((s) => s.outbox)
  const comments = useCollab((s) => s.comments.filter((c) => !c.resolved).length)
  const peers = useCollab((s) => Object.keys(s.peers).length)
  if (!room) return null
  return (
    <button
      type="button"
      className="sbtn"
      title={connected ? 'Collaboration live' : 'Offline — edits are queued and sync on reconnect'}
      onClick={() => void useCollab.getState().flush()}
    >
      <Icon name={syncing ? 'refresh' : connected ? 'users' : 'warning'} size={12} />
      {syncing ? 'Syncing' : connected ? `Live · ${peers}` : `Queued ${outbox}`}
      {comments ? ` · ${comments} comments` : ''}
    </button>
  )
}

/* ================================================================ plumbing === */

function useInstallPrompt(): void {
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      useStore.getState().setInstallPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])
}

function useOnlineSync(): void {
  useEffect(() => {
    const onOnline = () => {
      void requestBackgroundSync()
      useStore.getState().toast('info', 'Back online', 'Queued saves and exports are syncing.')
    }
    const onOffline = () => {
      useStore.getState().toast('warn', 'You are offline', 'Editing, autosave and export keep working — sync will resume automatically.')
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const store = useStore.getState()
      const mod = e.metaKey || e.ctrlKey

      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'z': e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return
          case 'y': e.preventDefault(); store.redo(); return
          case 's': e.preventDefault(); void saveDocument(e.shiftKey); return
          case 'o': e.preventDefault(); void openDocument(); return
          case 'e': e.preventDefault(); store.setExportDialog(true); return
          case 'p': e.preventDefault(); store.setPrintDialog(true); return
          case 'd': e.preventDefault(); store.duplicateSelection(); return
          case 'g': e.preventDefault(); e.shiftKey ? store.ungroupSelection() : store.groupSelection(); return
          case 'a': {
            e.preventDefault()
            const page = store.doc.pages.find((p) => p.id === store.doc.activePageId) ?? store.doc.pages[0]
            store.setSelection(page.layers.flatMap((l) => l.objects).map((o) => o.id))
            return
          }
          case 'c': e.preventDefault(); store.setClipboard(store.selectedObjects()); return
          case 'v': {
            e.preventDefault()
            if (store.clipboard.length) store.addObjectsToActiveLayer(store.clipboard.map((o) => ({ ...o, id: `${o.id}-copy-${Date.now().toString(36)}` })), 'Paste')
            return
          }
          case '0': e.preventDefault(); store.zoomTo(1); return
          case '=': case '+': e.preventDefault(); store.zoomTo(store.view.zoom * 1.25); return
          case '-': e.preventDefault(); store.zoomTo(store.view.zoom / 1.25); return
          default: return
        }
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        store.deleteSelection()
        return
      }
      if (e.key === 'Escape') {
        store.clearSelection()
        return
      }
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? store.doc.settings.nudgeStep * 10 : store.doc.settings.nudgeStep
        e.preventDefault()
        store.nudgeSelection(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
        return
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const tool = SHORTCUTS[key]
      if (tool) {
        e.preventDefault()
        store.setTool(tool)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function ShellSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="col">
      <h3 className="lbl">{title}</h3>
      {children}
    </section>
  )
}
