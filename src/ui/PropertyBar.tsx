/**
 * Context-sensitive property bar. It follows the active tool the way CorelDRAW
 * does: shape tools show geometry options, text tools show type controls, photo
 * tools show brush settings, and the selection tools show transform + align.
 */
import { useStore } from '../store/store'
import { TOOLS, type ToolID } from '../tools/registry'
import { setToolOptions, useToolOptions } from './toolOptions'
import { Button, Check, ColorSwatch, IconButton, NumberField, Popover, Select, Slider } from './widgets'
import { Icon } from './icons'
import { BRUSH_PRESETS } from '../engine/brush'
import { fonts } from '../lib/text'
import { hex, css } from '../lib/color'
import { unitLabel } from '../lib/util'
import { IMAGE_TRACE_STYLES, preloadBitmap, traceSelection } from '../lib/trace'
import { kernelStatus } from '../lib/wasm'
import { findBitmap } from './photoSession'

export function PropertyBar() {
  const tool = useStore((s) => s.tool)
  const options = useToolOptions()
  const doc = useStore((s) => s.doc)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const selection = useStore((s) => s.selection)
  const fillColor = useStore((s) => s.fillColor)
  const strokeColor = useStore((s) => s.strokeColor)
  const zoomTo = useStore((s) => s.zoomTo)
  const alignSelection = useStore((s) => s.alignSelection)
  const groupSelection = useStore((s) => s.groupSelection)
  const ungroupSelection = useStore((s) => s.ungroupSelection)
  const setPreviewEffects = useStore((s) => s.setPreviewEffects)
  const applyTextStyle = useStore((s) => s.applyTextStyle)
  const selected = useStore((s) => s.selectedObjects)()
  const nodeCount = useStore((s) => s.nodeSelection.length)
  const previewOn = useStore((s) => s.previewEffects)
  const def = TOOLS[tool]
  const unit = doc.settings.displayUnit

  const hasVector = selected.some((o) => o.kind === 'vector')
  const hasText = selected.some((o) => o.kind === 'text')
  const textObj = selected.find((o) => o.kind === 'text')
  const canUngroup = selected.some((o) => o.kind === 'group')

  return (
    <div className="propbar">
      <div className="prop-group tool-title">
        <span dangerouslySetInnerHTML={{ __html: def.icon }} style={{ display: 'inline-flex', width: 20, height: 20 }} />
        <span>{def.label}</span>
      </div>

      {/* ---------------------------------------------------------- pick --- */}
      {(tool === 'pick' || tool === 'freeTransform') ? (
        <>
          <div className="prop-group">
            <IconButton icon="align-left" title="Align left" disabled={!selection.length} onClick={() => alignSelection('left')} />
            <IconButton icon="align-center" title="Align centres horizontally" disabled={!selection.length} onClick={() => alignSelection('hcenter')} />
            <IconButton icon="align-right" title="Align right" disabled={!selection.length} onClick={() => alignSelection('right')} />
            <IconButton icon="align-top" title="Align top" disabled={!selection.length} onClick={() => alignSelection('top')} />
            <IconButton icon="align-middle" title="Align centres vertically" disabled={!selection.length} onClick={() => alignSelection('vcenter')} />
            <IconButton icon="align-bottom" title="Align bottom" disabled={!selection.length} onClick={() => alignSelection('bottom')} />
            <IconButton icon="distribute-h" title="Distribute horizontally" disabled={selection.length < 3} onClick={() => alignSelection('hdistribute')} />
            <IconButton icon="distribute-v" title="Distribute vertically" disabled={selection.length < 3} onClick={() => alignSelection('vdistribute')} />
          </div>
          <div className="prop-group">
            <Button icon="group" small disabled={selection.length < 2} onClick={groupSelection}>Group</Button>
            <Button icon="ungroup" small disabled={!canUngroup} onClick={ungroupSelection}>Ungroup</Button>
          </div>
          {selected.length === 1 ? (
            <div className="prop-group">
              <span className="prop-label">X</span>
              <NumberField value={round(selected[0].transform.e)} onChange={(v) => moveTo(v, null)} suffix={unitLabel(unit)} />
              <span className="prop-label">Y</span>
              <NumberField value={round(selected[0].transform.f)} onChange={(v) => moveTo(null, v)} suffix={unitLabel(unit)} />
            </div>
          ) : null}
          <div className="prop-group">
            <span className="prop-label">Objects</span>
            <span className="badge">{selected.length || 0}</span>
          </div>
        </>
      ) : null}

      {/* --------------------------------------------------------- shape --- */}
      {tool === 'shape' ? (
        <div className="prop-group">
          <span className="prop-label">Nodes</span>
          <span className="badge">{nodeCount}</span>
          <Button small onClick={() => {
            const state = useStore.getState()
            const id = state.selection[0]
            void id
            state.toast('info', 'Node tools', 'Drag nodes on the canvas; double-click a segment to add a node; Alt-click a node to toggle smooth.')
          }} icon="info">Node hints</Button>
        </div>
      ) : null}

      {/* ------------------------------------------------- curve / media --- */}
      {['freehand', 'liveSketch', 'bspline', 'curve3'].includes(tool) ? (
        <div className="prop-group">
          <span className="prop-label">Smoothing</span>
          <input
            className="slider"
            style={{ width: 110 }}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={options.freehandSmoothing}
            onChange={(e) => {
              setToolOptions({ freehandSmoothing: Number(e.target.value) })
            }}
          />
          <span className="tiny mono">{Math.round(options.freehandSmoothing * 100)}%</span>
        </div>
      ) : null}

      {tool === 'brush' ? (
        <>
          <div className="prop-group">
            <span className="prop-label">Preset</span>
            <Select
              value={options.brushPreset}
              width={168}
              onChange={(v) => setToolOptions({ brushPreset: v })}
              options={BRUSH_PRESETS.slice(0, 140).map((p) => ({ value: p.id, label: `${p.category} · ${p.name}` }))}
            />
          </div>
          <div className="prop-group">
            <span className="prop-label">Size</span>
            <input className="slider" style={{ width: 90 }} type="range" min={1} max={120} value={options.brushWidth} onChange={(e) => setToolOptions({ brushWidth: Number(e.target.value) })} />
            <span className="tiny mono">{options.brushWidth}px</span>
            <Check label="Pressure" checked={options.brushPressure} onChange={(v) => setToolOptions({ brushPressure: v })} />
          </div>
        </>
      ) : null}

      {/* --------------------------------------------- rectangle/ellipse -- */}
      {tool === 'rectangle' || tool === 'rect3' ? (
        <div className="prop-group">
          <span className="prop-label">Corner radius</span>
          <NumberField value={options.rectCorner} min={0} max={400} onChange={(v) => setToolOptions({ rectCorner: v })} suffix={unitLabel(unit)} />
          <Button small onClick={() => setToolOptions({ rectCorner: 0 })}>Square</Button>
          <Button small onClick={() => setToolOptions({ rectCorner: 24 })}>Rounded</Button>
        </div>
      ) : null}

      {tool === 'ellipse' || tool === 'ellipse3' ? (
        <div className="prop-group">
          <Button small active={options.ellipsePie === 'pie'} onClick={() => setToolOptions({ ellipsePie: 'pie' })}>Pie</Button>
          <Button small active={options.ellipsePie === 'arc'} onClick={() => setToolOptions({ ellipsePie: 'arc' })}>Arc</Button>
          <Button small active={options.ellipsePie === 'chord'} onClick={() => setToolOptions({ ellipsePie: 'chord' })}>Chord</Button>
          <span className="prop-label">Start</span>
          <NumberField value={options.ellipseStart} min={0} max={360} onChange={(v) => setToolOptions({ ellipseStart: v })} suffix="°" />
          <span className="prop-label">End</span>
          <NumberField value={options.ellipseEnd} min={0} max={360} onChange={(v) => setToolOptions({ ellipseEnd: v })} suffix="°" />
        </div>
      ) : null}

      {/* ------------------------------------------------ polygon/star ----- */}
      {tool === 'polygon' ? (
        <div className="prop-group">
          <span className="prop-label">Sides</span>
          <NumberField value={options.polygonSides} min={3} max={64} onChange={(v) => setToolOptions({ polygonSides: Math.round(v) })} />
        </div>
      ) : null}

      {tool === 'star' || tool === 'complexStar' ? (
        <div className="prop-group">
          <span className="prop-label">Points</span>
          <NumberField value={tool === 'star' ? options.starPoints : options.complexStarPoints} min={3} max={40} onChange={(v) => setToolOptions(tool === 'star' ? { starPoints: Math.round(v) } : { complexStarPoints: Math.round(v) })} />
          <span className="prop-label">Sharpness</span>
          <NumberField value={tool === 'star' ? options.starSharpness : options.complexStarSharpness} min={0} max={1} step={0.05} onChange={(v) => setToolOptions(tool === 'star' ? { starSharpness: v } : { complexStarSharpness: v })} />
        </div>
      ) : null}

      {tool === 'spiral' ? (
        <div className="prop-group">
          <span className="prop-label">Revolutions</span>
          <NumberField value={options.spiralRevolutions} min={1} max={20} onChange={(v) => setToolOptions({ spiralRevolutions: v })} />
          <span className="prop-label">Divergence</span>
          <NumberField value={options.spiralDivergence} min={0.2} max={3} step={0.05} onChange={(v) => setToolOptions({ spiralDivergence: v })} />
          <Check label="Symmetrical" checked={options.spiralSymmetrical} onChange={(v) => setToolOptions({ spiralSymmetrical: v })} />
        </div>
      ) : null}

      {tool === 'graphPaper' ? (
        <div className="prop-group">
          <span className="prop-label">Columns</span>
          <NumberField value={options.graphCols} min={1} max={40} onChange={(v) => setToolOptions({ graphCols: Math.round(v) })} />
          <span className="prop-label">Rows</span>
          <NumberField value={options.graphRows} min={1} max={40} onChange={(v) => setToolOptions({ graphRows: Math.round(v) })} />
        </div>
      ) : null}

      {/* --------------------------------------------------------- text ---- */}
      {tool === 'text' || hasText ? (
        <>
          <div className="prop-group">
            <Select
              value={textObj && textObj.kind === 'text' ? textObj.style.fontFamily : options.textFont}
              width={170}
              onChange={(v) => {
                setToolOptions({ textFont: v })
                fonts.load(v)
                applyTextStyle({ fontFamily: v })
              }}
              options={fonts.list().slice(0, 400).map((f) => ({ value: f.family, label: f.variable ? `${f.family} (variable)` : f.family }))}
            />
            <NumberField
              value={textObj && textObj.kind === 'text' ? textObj.style.fontSize : options.textSize}
              min={1}
              max={800}
              onChange={(v) => { setToolOptions({ textSize: v }); applyTextStyle({ fontSize: v }) }}
              suffix="pt"
            />
          </div>
          <div className="prop-group">
            <Button small active={textObj?.kind === 'text' ? textObj.style.fontWeight >= 600 : options.textBold} onClick={() => {
              const next = !(textObj?.kind === 'text' ? textObj.style.fontWeight >= 600 : options.textBold)
              setToolOptions({ textBold: next })
              applyTextStyle({ fontWeight: next ? 700 : 400 })
            }}><b>B</b></Button>
            <Button small active={textObj?.kind === 'text' ? textObj.style.fontStyle === 'italic' : options.textItalic} onClick={() => {
              const next = !(textObj?.kind === 'text' ? textObj.style.fontStyle === 'italic' : options.textItalic)
              setToolOptions({ textItalic: next })
              applyTextStyle({ fontStyle: next ? 'italic' : 'normal' })
            }}><i>I</i></Button>
            <Button small onClick={() => applyTextStyle({ align: 'left' })} title="Align left">⌫</Button>
            <Button small onClick={() => applyTextStyle({ align: 'center' })} title="Centre">↔</Button>
            <Button small onClick={() => applyTextStyle({ align: 'right' })} title="Align right">⌦</Button>
            <Button small onClick={() => applyTextStyle({ align: 'justify' })} title="Justify">≡</Button>
          </div>
          <div className="prop-group">
            <span className="prop-label">Leading</span>
            <NumberField value={textObj?.kind === 'text' ? textObj.style.lineHeight : options.textLineHeight} min={0.5} max={4} step={0.05} onChange={(v) => { setToolOptions({ textLineHeight: v }); applyTextStyle({ lineHeight: v }) }} />
            <span className="prop-label">Tracking</span>
            <NumberField value={textObj?.kind === 'text' ? textObj.style.letterSpacing : options.textLetterSpacing} min={-5} max={40} step={0.1} onChange={(v) => { setToolOptions({ textLetterSpacing: v }); applyTextStyle({ letterSpacing: v }) }} />
          </div>
        </>
      ) : null}

      {/* ------------------------------------------ curve authoring / misc -- */}
      {['pen', 'bezier', 'polyline', 'bspline', 'line2'].includes(tool) ? (
        <div className="prop-group">
          <span className="prop-label">Stroke</span>
          <ColorSwatch color={strokeColor} onClick={() => undefined} />
          <span className="prop-label">Width</span>
          <NumberField
            value={selected.find((o) => o.kind === 'vector')?.stroke?.width ?? 1}
            min={0.1}
            max={100}
            step={0.1}
            onChange={(v) => {
              useStore.getState().applyStrokeToSelection({ width: v })
            }}
            suffix={unit === 'in' ? 'in' : 'px'}
          />
          {tool === 'pen' || tool === 'bezier' ? <span className="tiny">Click to add nodes · drag for bezier handles · Enter finishes</span> : null}
        </div>
      ) : null}

      {tool === 'crop' ? (
        <div className="prop-group">
          <span className="tiny">Drag a rectangle to crop the page to that size.</span>
          <Button small onClick={() => useStore.getState().commit('Reset page', (d) => ({ ...d, pages: d.pages.map((p) => p.id === d.activePageId ? { ...p, size: { ...p.size, w: 210, h: 297 } } : p) }))}>A4 page</Button>
        </div>
      ) : null}

      {['fill', 'meshFill', 'smartFill', 'eyedropper'].includes(tool) ? (
        <div className="prop-group">
          <ColorSwatch color={fillColor} />
          <span className="tiny">{tool === 'meshFill' ? 'Click an object to apply a 3×3 mesh fountain fill' : tool === 'smartFill' ? 'Click inside a shape to fill it' : tool === 'fill' ? 'Click an object to fill · Alt-click to stroke' : 'Click the canvas to pick a colour'}</span>
          <Button small onClick={() => useStore.getState().applyFillToSelection({ type: 'uniform', color: fillColor })} disabled={!selection.length}>Apply to selection</Button>
        </div>
      ) : null}

      {['contour', 'dropShadow', 'blockShadow', 'blend', 'envelope', 'perspective', 'transparency', 'blockShadow'].includes(tool) ? (
        <div className="prop-group">
          {tool === 'contour' ? (
            <>
              <span className="prop-label">Steps</span>
              <NumberField value={options.contourSteps} min={1} max={40} onChange={(v) => setToolOptions({ contourSteps: Math.round(v) })} />
              <span className="prop-label">Offset</span>
              <NumberField value={options.contourOffset} min={-40} max={40} step={0.5} onChange={(v) => setToolOptions({ contourOffset: v })} />
            </>
          ) : null}
          {tool === 'dropShadow' ? (
            <>
              <span className="prop-label">X</span>
              <NumberField value={options.shadowDx} min={-80} max={80} onChange={(v) => setToolOptions({ shadowDx: v })} />
              <span className="prop-label">Y</span>
              <NumberField value={options.shadowDy} min={-80} max={80} onChange={(v) => setToolOptions({ shadowDy: v })} />
              <span className="prop-label">Feather</span>
              <NumberField value={options.shadowBlur} min={0} max={80} onChange={(v) => setToolOptions({ shadowBlur: v })} />
            </>
          ) : null}
          {tool === 'blockShadow' ? (
            <>
              <span className="prop-label">Steps</span>
              <NumberField value={options.blockShadowSteps} min={1} max={32} onChange={(v) => setToolOptions({ blockShadowSteps: Math.round(v) })} />
              <span className="prop-label">Merge</span>
              <Select value={options.blendMode} width={120} onChange={(v) => setToolOptions({ blendMode: v })} options={['normal', 'multiply', 'overlay'].map((v) => ({ value: v, label: v }))} />
            </>
          ) : null}
          <Button small disabled={!selection.length} onClick={() => {
            const kinds: Record<string, string> = { contour: 'contour', dropShadow: 'drop-shadow', blockShadow: 'block-shadow', blend: 'blend', envelope: 'envelope', perspective: 'perspective', transparency: 'transparency' }
            useStore.getState().addEffect(kinds[tool] ?? tool, 'effect')
          }}>Apply to selection</Button>
          <span className="tiny">Live previews stay editable in the Effects docker.</span>
        </div>
      ) : null}

      {tool === 'perspectiveCorrect' ? (
        <div className="prop-group">
          <span className="tiny">Select a bitmap, then apply a full-frame lens/perspective correction. Use the Lens docker for fine control.</span>
          <Button small onClick={() => useStore.getState().setDocker('adjustments', true)}>Open Adjustments</Button>
        </div>
      ) : null}

      {tool === 'table' ? (
        <div className="prop-group">
          <span className="prop-label">Font</span>
          <Select value={options.textFont} width={150} onChange={(v) => setToolOptions({ textFont: v })} options={fonts.list().slice(0, 80).map((f) => ({ value: f.family, label: f.family }))} />
          <span className="prop-label">Size</span>
          <NumberField value={options.textSize} min={4} max={400} onChange={(v) => setToolOptions({ textSize: v })} />
        </div>
      ) : null}

      {['lasso', 'zoom', 'pan'].includes(tool) ? (
        <div className="prop-group">
          <span className="tiny">
            {tool === 'lasso' ? 'Drag a freehand selection marquee · hold Shift to add' : tool === 'zoom' ? 'Drag a rectangle to zoom into it · click to zoom in · Alt-click to zoom out' : 'Drag to pan · Space works with any tool'}
          </span>
          <span className="chip">{Math.round(view.zoom * 100)}%</span>
        </div>
      ) : null}

      {/* ------------------------------------------------------- effects --- */}
      {['smudge', 'roughen', 'twirl', 'attract', 'repel', 'smear'].includes(tool) ? (
        <div className="prop-group">
          <span className="prop-label">Radius</span>
          <NumberField value={options.distortRadius} min={2} max={600} onChange={(v) => setToolOptions({ distortRadius: v })} />
          <span className="prop-label">Strength</span>
          <NumberField value={options.distortStrength} min={0} max={4} step={0.05} onChange={(v) => setToolOptions({ distortStrength: v })} />
        </div>
      ) : null}

      {tool === 'transparency' ? (
        <div className="prop-group">
          <span className="prop-label">Opacity</span>
          <Slider value={options.transparency} min={0} max={1} step={0.01} onChange={(v) => setToolOptions({ transparency: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <span className="prop-label">Merge</span>
          <Select value={options.blendMode} width={120} onChange={(v) => setToolOptions({ blendMode: v })} options={['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'].map((v) => ({ value: v, label: v }))} />
        </div>
      ) : null}

      {tool === 'symmetry' ? (
        <div className="prop-group">
          <span className="prop-label">Mode</span>
          <Select value={options.symmetryMode} width={130} onChange={(v) => setToolOptions({ symmetryMode: v as typeof options.symmetryMode })} options={[{ value: 'mirror', label: 'Mirror' }, { value: 'radial', label: 'Radial' }, { value: 'kaleidoscope', label: 'Kaleidoscope' }]} />
          <span className="prop-label">Mirrors</span>
          <NumberField value={options.symmetryCount} min={2} max={64} onChange={(v) => setToolOptions({ symmetryCount: Math.round(v) })} />
        </div>
      ) : null}

      {tool === 'variableOutline' ? (
        <div className="prop-group">
          <span className="prop-label">Width</span>
          <NumberField value={options.variableWidth} min={0.1} max={60} step={0.1} onChange={(v) => setToolOptions({ variableWidth: v })} />
        </div>
      ) : null}

      {['maskBrush', 'cutout', 'bgRemove', 'clone', 'liquify', 'blurBrush', 'sharpenBrush', 'dodgeBrush', 'burnBrush', 'colorReplace', 'enhance'].includes(tool) ? (
        <>
          <div className="prop-group">
            <span className="prop-label">Size</span>
            <NumberField value={options.photoRadius} min={1} max={600} onChange={(v) => setToolOptions({ photoRadius: v })} suffix="px" />
            <span className="prop-label">Hardness</span>
            <input className="slider" style={{ width: 80 }} type="range" min={0} max={1} step={0.01} value={options.photoHardness} onChange={(e) => setToolOptions({ photoHardness: Number(e.target.value) })} />
            <span className="prop-label">Opacity</span>
            <input className="slider" style={{ width: 80 }} type="range" min={0} max={1} step={0.01} value={options.photoOpacity} onChange={(e) => setToolOptions({ photoOpacity: Number(e.target.value) })} />
          </div>
          {['maskBrush', 'cutout'].includes(tool) ? (
            <div className="prop-group">
              <Button small active={options.maskMode === 'paint'} onClick={() => setToolOptions({ maskMode: 'paint' })}>Paint mask</Button>
              <Button small active={options.maskMode === 'erase'} onClick={() => setToolOptions({ maskMode: 'erase' })}>Erase mask</Button>
            </div>
          ) : null}
          {tool === 'liquify' ? (
            <div className="prop-group">
              <Select value={options.liquifyMode} width={120} onChange={(v) => setToolOptions({ liquifyMode: v as typeof options.liquifyMode })} options={[{ value: 'push', label: 'Push' }, { value: 'twirl', label: 'Twirl' }, { value: 'pinch', label: 'Pinch' }, { value: 'restore', label: 'Restore' }]} />
            </div>
          ) : null}
          {['blurBrush', 'sharpenBrush', 'dodgeBrush', 'burnBrush'].includes(tool) ? (
            <div className="prop-group">
              <span className="prop-label">Strength</span>
              <input className="slider" style={{ width: 90 }} type="range" min={0} max={1} step={0.01} value={options.photoStrength} onChange={(e) => setToolOptions({ photoStrength: Number(e.target.value) })} />
              <IconButton icon="refresh" title="Clone source: Alt-click to set" />
            </div>
          ) : null}
        </>
      ) : null}

      {/* ------------------------------------------------- shared right ---- */}
      <div className="prop-group" style={{ marginLeft: 'auto' }}>
        <Popover label="Fill" icon="palette">
          <div className="col">
            <div className="row">
              <ColorSwatch color={fillColor} size={30} />
              <span className="tiny mono">{hex(fillColor)}</span>
            </div>
            <Button small onClick={() => useStore.getState().applyFillToSelection({ type: 'uniform', color: fillColor })} disabled={!selection.length}>Apply to selection</Button>
            <Button small onClick={() => useStore.getState().applyFillToSelection({ type: 'none' })} disabled={!selection.length}>No fill</Button>
          </div>
        </Popover>
        <Popover label="Stroke" icon="pen">
          <div className="col">
            <div className="row">
              <ColorSwatch color={strokeColor} size={30} />
              <span className="tiny mono">{hex(strokeColor)}</span>
            </div>
            <Slider label="Width" value={options.brushWidth} min={0} max={40} step={0.25} onChange={(v) => {
              setToolOptions({ brushWidth: v })
              useStore.getState().applyStrokeToSelection({ width: v, color: strokeColor })
            }} />
            <Button small onClick={() => useStore.getState().applyStrokeToSelection({ color: strokeColor })} disabled={!selection.length}>Apply colour</Button>
            <Button small onClick={() => useStore.getState().applyStrokeToSelection({ color: { ...strokeColor, a: 0 }, width: 0 })} disabled={!selection.length}>Remove outline</Button>
          </div>
        </Popover>
        {hasVector ? (
          <Popover label="Trace" icon="ring">
            <div className="col">
              <span className="tiny">Convert the selected bitmap to vector curves. Deterministic edge tracing — no AI.</span>
              {IMAGE_TRACE_STYLES.map((style) => (
                <Button
                  key={style.id}
                  small
                  title={style.detail}
                  onClick={async () => {
                    const state = useStore.getState()
                    const bitmap = state.selection.map((id) => findBitmap(state.doc, id)).find(Boolean)
                    if (!bitmap) {
                      state.toast('warn', 'Select a bitmap first')
                      return
                    }
                    await preloadBitmap(bitmap)
                    const { doc: next, ids } = traceSelection(state.doc, state.selection, style.id)
                    if (!ids.length) {
                      state.toast('warn', 'Nothing to trace', 'Try another trace style or raise the detail.')
                      return
                    }
                    state.commit(`Trace (${style.label})`, () => next, { selection: ids })
                    state.toast('success', `Traced with ${style.label}`, `${ids.length} vector object(s) created.`)
                  }}
                >
                  {style.label}
                </Button>
              ))}
            </div>
          </Popover>
        ) : null}
        <span className="prop-label">Zoom</span>
        <Select
          value={String(Math.round(view.zoom * 100))}
          width={92}
          onChange={(v) => zoomTo(Number(v) / 100)}
          options={[10, 25, 50, 75, 100, 150, 200, 400, 800].map((z) => ({ value: String(z), label: `${z}%` }))}
        />
        <IconButton icon="grid" title="Grid" active={view.showGrid} onClick={() => setView({ showGrid: !view.showGrid })} />
        <IconButton icon="guides" title="Guides" active={view.showGuides} onClick={() => setView({ showGuides: !view.showGuides })} />
        <IconButton icon="ruler" title="Rulers" active={view.showRulers} onClick={() => { setView({ showRulers: !view.showRulers }); useStore.getState().commit('Rulers', (d) => ({ ...d, settings: { ...d.settings, showRulers: !view.showRulers } })) }} />
        <IconButton icon="wireframe" title="Wireframe" active={view.wireframe} onClick={() => setView({ wireframe: !view.wireframe })} />
        <Button small active={previewOn} onClick={() => setPreviewEffects(!previewOn)} icon="effects" title="Preview non-destructive effects">
          Effects
        </Button>
        <span className="tiny mono" style={{ color: 'var(--text-faint)' }} title="Image kernel backend">
          <Icon name="info" size={12} /> {kernelStatus() === 'ready' ? 'WASM' : 'JS'}
        </span>
        <span className="tiny mono" style={{ color: 'var(--text-faint)' }}>{doc.pages.length} pages</span>
        {selection.length ? <span className="chip on">{selection.length} selected</span> : null}
      </div>
    </div>
  )
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

function moveTo(x: number | null, y: number | null) {
  const state = useStore.getState()
  const id = state.selection[0]
  if (!id) return
  state.commit('Move', (doc) => ({
    ...doc,
    pages: doc.pages.map((pg) => ({
      ...pg,
      layers: pg.layers.map((layer) => ({
        ...layer,
        objects: layer.objects.map((o) => (o.id === id ? { ...o, transform: { ...o.transform, e: x ?? o.transform.e, f: y ?? o.transform.f } } : o)),
      })),
    })),
  }))
}

export type { ToolID }
