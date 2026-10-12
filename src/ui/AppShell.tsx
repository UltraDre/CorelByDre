/**
 * Application shell: title bar (Window Controls Overlay aware), menu bar,
 * property bar, toolbox, canvas, docker stack and status bar — plus the global
 * keyboard shortcuts and the online/offline + background-sync plumbing.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore, type DockerID } from '../store/store'
import { SHORTCUTS } from '../tools/registry'
import { CanvasView } from './CanvasView'
import { Toolbox } from './Toolbox'
import { PropertyBar } from './PropertyBar'
import {
  AdjustmentsDocker, BrushDocker, ColorDocker, EffectsDocker, HistoryDocker, LayersDocker, MaskingDocker,
  ExtrudeDocker, LensDocker, ObjectDocker, PagesDocker, PrintDocker, RetouchDocker, ShapingDocker, SymbolsDocker, TextDocker,
} from './Dockers'
import { CommentsDocker, NotificationCentre, PresenceAvatars, ShareDocker } from './Collab'
import { useCollab } from '../store/collab'
import { Home } from './Home'
import { BrandMark, Icon, type IconName } from './icons'
import { Button, HoverTooltip, IconButton, Toasts } from './widgets'
import { AppSettingsDialog, ExportDialog, FillDialog, OutlinePenDialog, PrintDialog, ShortcutHelpDialog } from './Dialogs'
import { autosave, importIntoDocument, newDocument, openDocument, placeImage, printDocument, saveDocument } from './fileOps'
import { kernelStatus } from '../lib/wasm'
import { MOD_KEY_LABEL, uid } from '../lib/util'
import type { NonDestructive, SceneObject } from '../types'
import { listSyncJobs, requestBackgroundSync, type SyncJob } from '../lib/storage'

/* ================================================================== shell === */

export function AppShell() {
  const theme = useStore((s) => s.theme)
  const homeVisible = useStore((s) => s.homeVisible)
  const dirty = useStore((s) => s.dirty)
  const doc = useStore((s) => s.doc)
  const fullScreenPreview = useStore((s) => s.view.fullScreenPreview)

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
    <div className={`app ${fullScreenPreview ? 'is-preview' : ''}`}>
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
      <FillDialog />
      <OutlinePenDialog />
      <AppSettingsDialog />
      <ShortcutHelpDialog />
      <Toasts />
      <HoverTooltip />
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
      <button type="button" className="btn ghost small" onClick={() => setHome(true)} title="Home — templates, recent files and install" aria-label="Home" data-tooltip="Home">
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
      <IconButton icon="open" title={`Open CDR / Document (${MOD_KEY_LABEL}+O)`} onClick={() => void openDocument()} />
      <IconButton icon="save" title={`Save as CDR (${MOD_KEY_LABEL}+S)`} onClick={() => void saveDocument(false, 'cdr')} />
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

function fitToView(drawing: boolean): void {
  const state = useStore.getState()
  const page = state.activePage()
  const host = document.querySelector<HTMLElement>('.canvas-wrap')
  const width = Math.max(1, (host?.clientWidth ?? window.innerWidth * 0.7) - (state.view.showRulers ? 20 : 0))
  const height = Math.max(1, (host?.clientHeight ?? window.innerHeight * 0.7) - (state.view.showRulers ? 20 : 0))
  const selectedBounds = drawing ? state.selectionBounds() : null
  const bounds = selectedBounds ?? { x: 0, y: 0, w: page.size.w, h: page.size.h }
  const zoom = Math.max(0.02, Math.min(8, (width - 64) / Math.max(1, bounds.w), (height - 64) / Math.max(1, bounds.h)))
  state.setView({ zoom, panX: (width - bounds.w * zoom) / 2 - bounds.x * zoom, panY: (height - bounds.h * zoom) / 2 - bounds.y * zoom })
}

function cloneNonDestructive(effect: NonDestructive): NonDestructive {
  return effect.type === 'effect'
    ? { ...effect, id: uid('fx'), params: { ...effect.params } }
    : { ...effect, id: uid('adj'), params: { ...effect.params } }
}

function cloneForPaste(object: SceneObject): SceneObject {
  const clone = {
    ...object,
    id: uid('obj'),
    transform: { ...object.transform },
    effects: object.effects.map(cloneNonDestructive),
  }
  return clone.kind === 'group' ? { ...clone, children: clone.children.map(cloneForPaste) } : clone
}

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

  const menus: { id: string; label: string; items: MenuItem[] }[] = useMemo(() => {
    const page = store.doc.pages.find((p) => p.id === store.doc.activePageId) ?? store.doc.pages[0]
    const selectedObjects = store.selectedObjects()
    const selectedVectors = selectedObjects.filter((o) => o.kind === 'vector')
    const selectedText = selectedObjects.some((o) => o.kind === 'text')
    const selectAll = () => store.setSelection(page.layers.flatMap((l) => l.objects).map((o) => o.id))
    return [
      {
        id: 'file', label: 'File', items: [
          { label: 'New…', shortcut: `${MOD_KEY_LABEL}+N`, action: () => void newDocument() },
          { label: 'Open (.cdr, .cbd, .svg, .pdf)…', shortcut: `${MOD_KEY_LABEL}+O`, action: () => void openDocument() },
          { label: 'Import / Place…', shortcut: `${MOD_KEY_LABEL}+I`, action: () => void importIntoDocument() },
          { label: 'Place image…', action: () => void placeImage() },
          { separator: true, label: '' },
          { label: 'Save (.cdr)', shortcut: `${MOD_KEY_LABEL}+S`, action: () => void saveDocument(false, 'cdr') },
          { label: 'Save as CDR…', shortcut: `${MOD_KEY_LABEL}+⇧+S`, action: () => void saveDocument(true, 'cdr') },
          { label: 'Save as CBD…', action: () => void saveDocument(true, 'cbd') },
          { separator: true, label: '' },
          { label: 'Export…', shortcut: `${MOD_KEY_LABEL}+E`, action: () => store.setExportDialog(true) },
          { label: 'Print preview…', shortcut: `${MOD_KEY_LABEL}+P`, action: () => store.setPrintDialog(true) },
          { label: 'Print to PDF (press preset)', action: () => void printDocument({ format: 'pdf', pdfStandard: 'pdfx4', marks: { crop: true, registration: true, colourBars: true, pageInfo: true }, separations: true }) },
          { separator: true, label: '' },
          { label: 'Options…', shortcut: `${MOD_KEY_LABEL}+J`, action: () => store.setSettingsDialog(true) },
        ],
      },
      {
        id: 'edit', label: 'Edit', items: [
          { label: 'Undo', shortcut: `${MOD_KEY_LABEL}+Z`, disabled: !store.history.length, action: store.undo },
          { label: 'Redo', shortcut: `${MOD_KEY_LABEL}+⇧+Z`, disabled: !store.future.length, action: store.redo },
          { separator: true, label: '' },
          { label: 'Cut', shortcut: `${MOD_KEY_LABEL}+X`, disabled: !selection.length, action: () => { store.setClipboard(selectedObjects); store.deleteSelection() } },
          { label: 'Copy', shortcut: `${MOD_KEY_LABEL}+C`, disabled: !selection.length, action: () => store.setClipboard(selectedObjects) },
          { label: 'Paste', shortcut: `${MOD_KEY_LABEL}+V`, disabled: !store.clipboard.length, action: () => store.addObjectsToActiveLayer(store.clipboard.map(cloneForPaste), 'Paste') },
          { label: 'Duplicate', shortcut: `${MOD_KEY_LABEL}+D`, disabled: !selection.length, action: store.duplicateSelection },
          { label: 'Repeat last action', shortcut: `${MOD_KEY_LABEL}+R`, disabled: !store.lastRepeat, action: store.repeatLast },
          { label: store.tool === 'shape' && store.nodeSelection.length ? 'Delete selected nodes' : 'Delete', shortcut: 'Del', disabled: !selection.length, action: store.tool === 'shape' && store.nodeSelection.length ? store.deleteNodeSelection : store.deleteSelection },
          { separator: true, label: '' },
          { label: 'Select all', shortcut: `${MOD_KEY_LABEL}+A`, action: selectAll },
          { label: 'Deselect', shortcut: 'Esc', action: store.clearSelection },
        ],
      },
      {
        id: 'view', label: 'View', items: [
          { label: 'Grid', checked: store.view.showGrid, action: () => store.setView({ showGrid: !store.view.showGrid }) },
          { label: 'Guides', checked: store.view.showGuides, action: () => store.setView({ showGuides: !store.view.showGuides }) },
          { label: 'Rulers', checked: store.view.showRulers, action: () => store.setView({ showRulers: !store.view.showRulers }) },
          { label: 'Page shadow', checked: store.view.showPageShadow, action: () => store.setView({ showPageShadow: !store.view.showPageShadow }) },
          { label: 'Preview live effects', checked: store.previewEffects, action: () => store.setPreviewEffects(!store.previewEffects) },
          { separator: true, label: '' },
          ...([
            ['enhanced', 'Enhanced'], ['simple-wireframe', 'Simple wireframe'], ['wireframe', 'Wireframe'], ['draft', 'Draft'],
          ] as const).map(([mode, label]) => ({
            label: `Display: ${label}`,
            checked: store.view.displayMode === mode,
            action: () => store.setView({ displayMode: mode, wireframe: mode === 'wireframe' || mode === 'simple-wireframe' }),
          })),
          { label: 'Full-screen preview', shortcut: 'F9', checked: store.view.fullScreenPreview, action: () => store.setView({ fullScreenPreview: !store.view.fullScreenPreview }) },
          { separator: true, label: '' },
          { label: 'Fit drawing', shortcut: 'F4', action: () => fitToView(true) },
          { label: 'Fit page', shortcut: '⇧+F4', action: () => fitToView(false) },
          { label: 'Zoom in', shortcut: 'F2', action: () => store.zoomTo(store.view.zoom * 1.2) },
          { label: 'Zoom out', shortcut: 'F3', action: () => store.zoomTo(store.view.zoom / 1.2) },
          { label: '100 %', shortcut: `${MOD_KEY_LABEL}+0`, action: () => store.zoomTo(1) },
        ],
      },
      {
        id: 'layout', label: 'Layout', items: [
          { label: 'Insert page', action: store.addPage },
          { label: 'Duplicate page', disabled: !page, action: () => store.duplicatePage(page.id) },
          { label: 'Delete current page', disabled: store.doc.pages.length <= 1, action: () => store.deletePage(page.id) },
          { separator: true, label: '' },
          { label: 'Add vertical guide', action: () => store.addGuide('x', page.size.w / 2) },
          { label: 'Add horizontal guide', action: () => store.addGuide('y', page.size.h / 2) },
          { label: 'Pages docker', checked: store.dockers.pages, action: () => store.toggleDocker('pages') },
        ],
      },
      {
        id: 'object', label: 'Object', items: [
          { label: 'Group', shortcut: `${MOD_KEY_LABEL}+G`, disabled: selection.length < 2, action: store.groupSelection },
          { label: 'Ungroup', shortcut: `${MOD_KEY_LABEL}+U`, disabled: !selectedObjects.some((o) => o.kind === 'group'), action: store.ungroupSelection },
          { label: 'Combine', shortcut: `${MOD_KEY_LABEL}+L`, disabled: selectedVectors.length < 2, action: store.combineSelection },
          { label: 'Break apart', shortcut: `${MOD_KEY_LABEL}+K`, disabled: !selectedVectors.some((o) => o.path.subpaths.length > 1), action: store.breakApartSelection },
          { label: 'Convert to curves', shortcut: `${MOD_KEY_LABEL}+Q`, disabled: !selectedText && !selectedVectors.some((o) => o.primitive.type !== 'freehand'), action: () => void store.convertSelectionToCurves() },
          { label: 'Make nodes sharp', shortcut: 'C', disabled: store.tool !== 'shape' || !store.nodeSelection.length, action: () => store.applyNodeType('sharp') },
          { label: 'Make nodes smooth', shortcut: 'S', disabled: store.tool !== 'shape' || !store.nodeSelection.length, action: () => store.applyNodeType('smooth') },
          { label: 'Make nodes symmetrical', shortcut: 'Y', disabled: store.tool !== 'shape' || !store.nodeSelection.length, action: () => store.applyNodeType('symmetric') },
          { label: 'Delete selected nodes', shortcut: 'Del', disabled: store.tool !== 'shape' || !store.nodeSelection.length, action: store.deleteNodeSelection },
          { label: 'Close curve', disabled: !selectedVectors.some((o) => o.path.subpaths.some((sub) => !sub.closed)), action: store.closeSelectedCurves },
          { label: 'Join endpoints', disabled: !selectedVectors.length, action: store.joinSelectedCurves },
          { label: 'Reverse curve direction', disabled: !selectedVectors.length, action: store.reverseSelectedCurves },
          { label: 'Break curve at node', disabled: store.tool !== 'shape' || !store.nodeSelection.length, action: store.breakSelectedCurve },
          { separator: true, label: '' },
          { label: 'Lock / unlock', disabled: !selection.length, action: store.lockSelection },
          { label: 'To front', shortcut: '⇧+Page Up', disabled: !selection.length, action: () => store.reorderSelection('front') },
          { label: 'Forward', shortcut: 'Page Up', disabled: !selection.length, action: () => store.reorderSelection('forward') },
          { label: 'Backward', shortcut: 'Page Down', disabled: !selection.length, action: () => store.reorderSelection('backward') },
          { label: 'To back', shortcut: '⇧+Page Down', disabled: !selection.length, action: () => store.reorderSelection('back') },
          { separator: true, label: '' },
          { label: 'Align left', shortcut: 'L', disabled: selection.length < 2, action: () => store.alignSelection('left') },
          { label: 'Align centre', shortcut: 'C', disabled: selection.length < 2, action: () => store.alignSelection('hcenter') },
          { label: 'Align right', shortcut: 'R', disabled: selection.length < 2, action: () => store.alignSelection('right') },
          { label: 'Align top', shortcut: 'T', disabled: selection.length < 2, action: () => store.alignSelection('top') },
          { label: 'Align middle', shortcut: 'E', disabled: selection.length < 2, action: () => store.alignSelection('vcenter') },
          { label: 'Align bottom', shortcut: 'B', disabled: selection.length < 2, action: () => store.alignSelection('bottom') },
          { label: 'Distribute horizontally', disabled: selection.length < 3, action: () => store.alignSelection('hdistribute') },
          { label: 'Distribute vertically', disabled: selection.length < 3, action: () => store.alignSelection('vdistribute') },
        ],
      },
      {
        id: 'text', label: 'Text', items: [
          { label: 'Edit selected text', shortcut: 'Ctrl+T', disabled: !selectedText, action: () => { const text = selectedObjects.find((o) => o.kind === 'text'); if (text) store.setEditingText(text.id) } },
          { label: 'Convert to curves', shortcut: `${MOD_KEY_LABEL}+Q`, disabled: !selectedText, action: () => void store.convertSelectionToCurves() },
          { label: 'Text docker', checked: store.dockers.text, action: () => store.toggleDocker('text') },
          { label: 'Font catalogue', action: () => store.toggleDocker('text') },
        ],
      },
      {
        id: 'effects', label: 'Effects', items: [
          { label: 'Extrude selected objects', disabled: !selectedVectors.length, action: () => store.applyExtrudeToSelection() },
          { label: 'Extrude tool', action: () => store.setTool('extrude') },
          { label: 'Add lens to selection', disabled: !selectedVectors.length, action: () => { store.addEffect('lens', 'effect'); store.setDocker('lens', true) } },
          { label: 'Lens docker', checked: store.dockers.lens, action: () => store.toggleDocker('lens') },
          { label: 'Effects docker', checked: store.dockers.effects, action: () => store.toggleDocker('effects') },
        ],
      },
      {
        id: 'bitmaps', label: 'Bitmaps', items: [
          { label: 'Adjustments docker', checked: store.dockers.adjustments, action: () => store.toggleDocker('adjustments') },
          { label: 'Masking docker', checked: store.dockers.masking, action: () => store.toggleDocker('masking') },
          { label: 'Retouch docker', checked: store.dockers.retouch, action: () => store.toggleDocker('retouch') },
          { label: 'Lens correction', disabled: !selectedObjects.some((o) => o.kind === 'bitmap'), action: () => store.addEffect('lens', 'effect') },
        ],
      },
      {
        id: 'tools', label: 'Tools', items: [
          { label: 'Pick tool', shortcut: 'V', action: () => store.setTool('pick') },
          { label: 'Shape tool', shortcut: 'F10', action: () => store.setTool('shape') },
          { label: 'Freehand', shortcut: 'F5', action: () => store.setTool('freehand') },
          { label: 'Rectangle', shortcut: 'F6', action: () => store.setTool('rectangle') },
          { label: 'Ellipse', shortcut: 'F7', action: () => store.setTool('ellipse') },
          { label: 'Text', shortcut: 'F8', action: () => store.setTool('text') },
          { label: 'Calligraphy', action: () => store.setTool('calligraphy') },
          { label: 'Extrude', action: () => store.setTool('extrude') },
        ],
      },
      {
        id: 'window', label: 'Window', items: (Object.keys(store.dockers) as DockerID[]).map((id) => ({
          label: id === 'lens' ? 'Lens' : id === 'extrude' ? 'Extrude' : id.charAt(0).toUpperCase() + id.slice(1),
          checked: store.dockers[id], action: () => store.toggleDocker(id),
        })),
      },
      {
        id: 'help', label: 'Help', items: [
          { label: 'Keyboard shortcuts…', action: () => store.setShortcutsDialog(true) },
          { label: 'Offline status', action: () => store.toast(navigator.onLine ? 'success' : 'warn', navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? 'Sync is available; document editing and exports remain local.' : 'Everything still works offline — documents autosave locally.') },
          { label: 'About CorelByDre', action: () => store.toast('info', 'CorelByDre Graphics Suite', 'A browser-native vector, page-layout and photo studio. This is a deterministic, editable recreation, not CorelDRAW source code.') },
        ],
      },
    ]
  }, [store, selection])

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
  history: 'history', print: 'print', shaping: 'node', extrude: 'effects', lens: 'lens', symbols: 'ring',
  comments: 'comment', collab: 'users',
}

const DOCKER_LABELS: Record<DockerID, string> = {
  object: 'Object Properties',
  color: 'Color & Fill',
  layers: 'Layers',
  pages: 'Pages',
  effects: 'Live Effects',
  adjustments: 'Photo Adjustments',
  masking: 'Masking',
  retouch: 'Photo Retouch',
  text: 'Text & Typography',
  brush: 'Brush Settings',
  history: 'Undo History',
  print: 'Print & Prepress',
  shaping: 'Shaping & Booleans',
  extrude: 'Extrude',
  lens: 'Lens',
  symbols: 'Symbols',
  comments: 'Comments',
  collab: 'Collaborate & Share',
}

export function DockersPanel() {
  const dockers = useStore((s) => s.dockers)
  const toggle = useStore((s) => s.toggleDocker)
  const [collapsed, setCollapsed] = useState(false)
  const openIds = (Object.keys(dockers) as DockerID[]).filter((id) => dockers[id])

  return (
    <aside className={`dockers ${collapsed ? 'collapsed' : ''}`}>
      <div className="dockers-rail" style={{ flexDirection: 'row', flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
        <button type="button" title={collapsed ? 'Show dockers' : 'Collapse dockers'} aria-label={collapsed ? 'Show dockers' : 'Collapse dockers'} data-tooltip={collapsed ? 'Show dockers' : 'Collapse dockers'} onClick={() => setCollapsed((c) => !c)}>
          <Icon name={collapsed ? 'drag' : 'close'} size={14} />
        </button>
        {(Object.keys(dockers) as DockerID[]).map((id) => (
          <button
            key={id}
            type="button"
            className={dockers[id] ? 'on' : ''}
            title={DOCKER_LABELS[id] ?? id}
            aria-label={DOCKER_LABELS[id] ?? id}
            data-tooltip={DOCKER_LABELS[id] ?? id}
            onClick={() => toggle(id)}
          >
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
          {openIds.includes('extrude') ? <ExtrudeDocker /> : null}
          {openIds.includes('lens') ? <LensDocker /> : null}
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
  const selectedObjects = useStore.getState().selectedObjects()
  const selectedBounds = useStore.getState().selectionBounds()
  const factor = unit === 'in' ? 1 / 72 : unit === 'mm' ? 25.4 / 72 : unit === 'px' ? 4 / 3 : 1
  const fmt = (value: number) => (value * factor).toFixed(unit === 'px' ? 0 : 2)
  const selectedDescription = selectedObjects.length === 1
    ? `${selectedObjects[0].kind}: ${selectedObjects[0].name}`
    : `${selection.length} object${selection.length === 1 ? '' : 's'} selected`

  return (
    <footer className="statusbar">
      <span>{status}</span>
      <span className="spacer" />
      <span title={selectedBounds ? `${selectedDescription}; x ${fmt(selectedBounds.x)}, y ${fmt(selectedBounds.y)}, w ${fmt(selectedBounds.w)}, h ${fmt(selectedBounds.h)} ${unit}` : selectedDescription}>
        {selection.length ? selectedDescription : 'No selection'}
        {selectedBounds ? ` · ${fmt(selectedBounds.w)} × ${fmt(selectedBounds.h)} ${unit}` : ''}
      </span>
      <button type="button" className="sbtn" title="Toggle grid" onClick={() => useStore.getState().setView({ showGrid: !view.showGrid })}>
        Grid {view.showGrid ? 'on' : 'off'}
      </button>
      <button type="button" className="sbtn" title="Toggle rulers" onClick={() => useStore.getState().setView({ showRulers: !view.showRulers })}>
        Rulers {view.showRulers ? 'on' : 'off'}
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
      <span>{fmt(page.size.w)} × {fmt(page.size.h)} {unit}</span>
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
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const store = useStore.getState()
      const mod = e.metaKey || e.ctrlKey
      const modalOpen = store.exportDialog || store.printDialog || store.fillDialog !== null || store.outlineDialog || store.settingsDialog || store.shortcutsDialog
      if (modalOpen && e.key !== 'Escape') return

      if (mod) {
        switch (e.key.toLowerCase()) {
          case 'z': e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return
          case 'y': e.preventDefault(); store.redo(); return
          case 's': e.preventDefault(); void saveDocument(e.shiftKey, 'cdr'); return
          case 'o': e.preventDefault(); void openDocument(); return
          case 'n': e.preventDefault(); void newDocument(); return
          case 'i': e.preventDefault(); void importIntoDocument(); return
          case 'e': e.preventDefault(); store.setExportDialog(true); return
          case 'p': e.preventDefault(); store.setPrintDialog(true); return
          case 'j': e.preventDefault(); store.setSettingsDialog(true); return
          case 'r': e.preventDefault(); store.repeatLast(); return
          case 'q': e.preventDefault(); void store.convertSelectionToCurves(); return
          case 'l': e.preventDefault(); store.combineSelection(); return
          case 'k': e.preventDefault(); store.breakApartSelection(); return
          case 'd': e.preventDefault(); store.duplicateSelection(); return
          case 'g': e.preventDefault(); e.shiftKey ? store.ungroupSelection() : store.groupSelection(); return
          case 'u': e.preventDefault(); store.ungroupSelection(); return
          case 'x': e.preventDefault(); store.setClipboard(store.selectedObjects()); store.deleteSelection(); return
          case 'a': {
            e.preventDefault()
            const page = store.doc.pages.find((p) => p.id === store.doc.activePageId) ?? store.doc.pages[0]
            store.setSelection(page.layers.flatMap((l) => l.objects).map((o) => o.id))
            return
          }
          case 'c': e.preventDefault(); store.setClipboard(store.selectedObjects()); return
          case 'v': {
            e.preventDefault()
            if (store.clipboard.length) store.addObjectsToActiveLayer(store.clipboard.map(cloneForPaste), 'Paste')
            return
          }
          case '0': e.preventDefault(); store.zoomTo(1); return
          case '=': case '+': e.preventDefault(); store.zoomTo(store.view.zoom * 1.25); return
          case '-': e.preventDefault(); store.zoomTo(store.view.zoom / 1.25); return
          default: return
        }
      }

      if (e.key === 'F2') { e.preventDefault(); store.zoomTo(store.view.zoom * 1.2); return }
      if (e.key === 'F3') { e.preventDefault(); store.zoomTo(store.view.zoom / 1.2); return }
      if (e.key === 'F4') { e.preventDefault(); fitToView(!e.shiftKey); return }
      if (e.key === 'F9') { e.preventDefault(); store.setView({ fullScreenPreview: !store.view.fullScreenPreview }); return }
      if (e.key === 'F11') { e.preventDefault(); store.setFillDialog(e.shiftKey ? 'uniform' : 'fountain'); return }
      if (e.key === 'F12') { e.preventDefault(); store.setOutlineDialog(true); return }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault()
        const direction = e.key === 'PageUp' ? (e.shiftKey ? 'front' : 'forward') : (e.shiftKey ? 'back' : 'backward')
        store.reorderSelection(direction)
        return
      }
      if (e.code === 'NumpadAdd' || e.key === '+') { e.preventDefault(); store.zoomTo(store.view.zoom * 1.25); return }
      if (e.code === 'NumpadSubtract' || e.key === '-') { e.preventDefault(); store.zoomTo(store.view.zoom / 1.25); return }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        if (store.tool === 'shape' && store.nodeSelection.length) store.deleteNodeSelection()
        else store.deleteSelection()
        return
      }
      if (e.key === 'Escape') {
        if (!modalOpen && store.view.fullScreenPreview) store.setView({ fullScreenPreview: false })
        else if (!modalOpen) store.clearSelection()
        return
      }
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? store.doc.settings.nudgeStep * 10 : store.doc.settings.nudgeStep
        e.preventDefault()
        store.nudgeSelection(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
        return
      }
      const key = e.key.toLowerCase()
      if (store.tool === 'shape' && store.nodeSelection.length) {
        const nodeType = key === 'c' ? 'sharp' : key === 's' ? 'smooth' : key === 'y' ? 'symmetric' : null
        if (nodeType) { e.preventDefault(); store.applyNodeType(nodeType); return }
      }
      if (!mod && store.selection.length > 1) {
        const align = key === 'l' ? 'left' : key === 'c' ? 'hcenter' : key === 'r' ? 'right' : key === 't' ? 'top' : key === 'e' ? 'vcenter' : key === 'b' ? 'bottom' : null
        if (align) { e.preventDefault(); store.alignSelection(align); return }
      }
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
