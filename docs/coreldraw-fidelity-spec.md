# CorelByDre / CorelDRAW-inspired fidelity specification

**Status:** working implementation contract, revision 1
**Baseline:** this repository's current browser-native editor and its editable document schema. The reference is observable CorelDRAW-style desktop behaviour, not a claim to reproduce proprietary implementation details or undocumented file formats.

This document drives implementation and tests. It separates *observable command behaviour* from the internal architecture used here. The UI may be adapted for browser, touch, keyboard-layout and offline constraints; it must not silently present a partial imitation as native CorelDRAW compatibility.

## 1. Product and fidelity boundaries

CorelByDre is an offline-first vector, page-layout and photo-editing application. The fidelity target is the user-facing editing workflow: commands, tool states, property controls, direct manipulation, undo, visible rendering, status feedback and round-trip preservation of the fields the application owns.

- Native `.cbd` and `.cdr` saves are CorelByDre document saves. They are **not** a promise to emit or parse the proprietary native CorelDRAW CDR format.
- SVG, PDF and raster import/export remain separate interchange paths; every new editable field needs a deliberate interchange policy (preserve, translate, rasterize, or warn).
- All edit operations are deterministic and local. No network service or AI feature is required to draw or edit.
- Existing unknown fields and effects must be preserved through load/save where possible. A command that cannot represent an imported feature should report that limitation rather than discard it silently.
- Selection, object ordering, active page/layer, object lock/visibility, zoom and modal focus are part of behaviour, not merely decoration.

## 2. Interaction contract

### 2.1 Document and editing invariants

1. A user command that changes document content creates one undoable history entry; view toggles, modal state, focus and selection-only changes do not dirty the document.
2. Empty selection is a valid state. A formatting dialog opened with no selection edits its future/default colour; it must not create an object or claim to have modified the document.
3. Commands skip locked or non-editable objects and disclose when nothing could be changed. Mixed selections apply a command only to compatible object kinds and leave other kinds intact.
4. Multi-object commands keep stable relative stacking order and operate only within the appropriate page/layer unless the command explicitly supports cross-layer editing.
5. Direct manipulation is previewed while dragging and committed on pointer release. Pointer cancellation, Escape and loss of capture must not leave half-applied geometry or duplicate history entries.
6. Tool switches do not destroy the current selection unless the tool's documented action requires it. Escape cancels the current modal/gesture first; a second Escape clears the selection.
7. Numeric fields validate finite values and clamp to documented bounds. Stored geometry is in document units; displayed values convert from the active unit.

### 2.2 Selection and property bar

- Pick selects, moves, scales and rotates whole objects; Shift-click toggles membership. Marquee selection respects visible/locked layers.
- Shape edits vector nodes/handles. The property bar and context menu should expose the operations relevant to the selected object and selected nodes.
- A one-object selection reports name, kind, position, dimensions, rotation, fill and outline when applicable. A multi-selection reports count and aggregate bounds. An empty selection reports page/tool context.
- Fill and outline swatches are usable as quick defaults and as entry points to the full dialog. UI changes that alter geometry or appearance must flow through undoable store commands.

## 3. Priority 1 — signature tools and dockers

### 3.1 Outline Pen (F12)

The Outline Pen dialog edits outline properties on selected vector objects and exposes defaults when there is no selection.

Required properties:

- width in points, millimetres, inches or pixels, converted to the internal document unit;
- colour and alpha; line cap (`butt`, `round`, `square`); join (`miter`, `round`, `bevel`) and miter limit;
- solid and common dash patterns; outline behind fill; scale-with-object behaviour;
- start and end markers for open paths: none, triangle, stealth, diamond, open V, circle and bar; independent start/end selection and common scale.

Acceptance behaviour:

- F12 opens the dialog; Apply commits exactly one undo step to every compatible selected vector.
- The preview updates as controls change, but does not mutate the document before Apply.
- Marker geometry follows transformed path endpoints and tangents; closed paths do not show endpoint markers. Marker fill/stroke and alpha follow the outline unless a style explicitly says otherwise.
- Stroke bounds, hit testing, selection handles, export and zoom must account for the visual stroke width and markers. The outline's transform policy must agree between screen and export renderers.
- Existing SVG marker/dash/stroke data should be translated where supported and preserved on round trip otherwise.

### 3.2 Uniform Fill (Shift+F11) and Fountain Fill (F11)

Uniform Fill controls a solid RGBA colour. Fountain Fill controls an editable gradient.

Fountain controls:

- linear, radial, conical and rectangular/square geometry;
- two or more ordered colour stops, stop colour/alpha/position, add/remove stop, angle, spread (`pad`, `repeat`, `reflect`) and edge pad;
- geometry is stored in normalized object-bounds coordinates so resizing an object keeps the gradient attached to it;
- selecting a fill type does not flatten a vector object.

Acceptance behaviour:

- Shift+F11 opens Uniform Fill; F11 opens Fountain Fill; Apply is one undoable change.
- A fill applied to a multi-selection affects compatible objects only. No-selection mode changes the future fill colour without dirtying the document.
- Gradient stops remain sorted and at least two stops remain; all values are finite and offsets clamp to 0–1.
- Display, hit-testing and exported SVG/PDF use consistent gradient coordinates, alpha, spread and geometry. Unsupported gradient models produce a warning and preserve source data where feasible.

### 3.3 Extrude tool and docker

The extrude tool creates an editable 3D-style vector extrusion from a vector silhouette; it is a 2D rendering effect, not a general 3D modeller.

Required editable data:

- direction vector (`dx`, `dy`), depth, angle and band/step count;
- side-face colour/opacity, optional shading/fade, optional band lines;
- source path remains the front face and may be node-edited after extrusion.

Acceptance behaviour:

- Drag from the object centre toward an extrusion vanishing direction to establish depth; subsequent docker controls edit the same extrusion metadata.
- The docker can add, edit, reset or remove extrusion on compatible selected vectors. Mixed selection leaves non-vectors unchanged.
- Front face, side bands, bounds, hit-testing, object selection and export agree. Degenerate depth has no ghost side geometry; step count is clamped to a safe range.
- File round-trip retains the full extrusion settings. SVG/PDF export may emit editable expanded paths if a renderer cannot represent the effect directly, with object editability documented.

### 3.4 Lens docker

Lens is a non-destructive effect-stack entry, not a destructive bitmap rewrite.

Modes in this implementation: fisheye, brighten, tint, grayscale, invert, transparency, wireframe and heat map. Parameters are mode-specific (strength, zoom/edge handling or tint colour). Each effect can be enabled, reordered, reset or removed using the normal effect stack.

Acceptance behaviour:

- Lens can be created from the Lens docker or Effects menu for compatible selected objects and is represented in serialized effect data.
- A mode switch retains sensible common parameters, does not replace unrelated effects and is undoable.
- Preview-off, draft display and export have explicit semantics. If a lens needs raster compositing, the renderer must use a consistent resolution policy and must not claim a background-live lens when it only affects the selected object's own rendered pixels.
- Missing/unknown mode data is preserved and handled safely rather than crashing rendering.

### 3.5 Calligraphy and arrowheads

Calligraphy is a pressure-aware broad-nib path tool with configurable nib angle, width and smoothing. Pressure is optional; a mouse-only stroke remains usable. A stroke previews before commit and produces a filled editable outline, with one history entry.

Arrowheads are path endpoint markers, not additional unrelated objects. Their style, scale, outline colour, transparency and transform policy persist through editing, save, undo/redo, rendering and export. The shape tool should expose start/end markers for open curves.

## 4. Priority 2 — workspace chrome, view and shortcuts

### 4.1 Workspace structure

The browser workspace contains title/document controls, a menu bar, context-sensitive property bar, toolbox, page/canvas, dockers, page controls and a detailed status bar. Full-screen preview hides chrome without changing document content; Escape/F9 restores the workspace.

Menu groups and representative responsibilities:

- **File:** New, Open, Import/Place, Save/Save As, Export, Print/Prepress, Options.
- **Edit:** Undo/Redo, Cut/Copy/Paste, Duplicate, Repeat, Delete, Select All/Deselect.
- **View:** display quality, wireframe modes, grid/guides/rulers/page shadow, zoom and full-screen preview.
- **Layout:** pages, page duplication/deletion, guides and page setup.
- **Object:** group/ungroup, combine/break apart, convert to curves, lock, z-order, align/distribute and shaping.
- **Text:** text editing, text-to-curves, typography controls and text docker.
- **Effects / Bitmaps:** live effects, lens, extrusion, image adjustments, masking and retouch.
- **Tools:** direct selection of drawing and editing tools.
- **Window:** every docker can be opened, closed and restored.
- **Help:** searchable shortcut reference, local/offline status and About.

Context-sensitive menu entries remain disabled with a reason when no compatible object/node is selected. Menu actions and keyboard shortcuts call the same store operation.

### 4.2 Shortcut contract

Shortcuts are a keymap, not just menu labels. The implementation must avoid firing while a text/number/select field or content-editable editor owns keyboard focus. `Ctrl` in this list maps to `Cmd` on macOS.

| Command | Default shortcut |
|---|---|
| New / Open / Save / Save As | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Import / Export / Print / Options | Ctrl+I / Ctrl+E / Ctrl+P / Ctrl+J |
| Undo / Redo / Repeat last | Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) / Ctrl+R |
| Duplicate / Group / Ungroup | Ctrl+D / Ctrl+G / Ctrl+U |
| Convert to curves / Combine / Break apart | Ctrl+Q / Ctrl+L / Ctrl+K |
| Z-order one step / front or back | Page Up / Page Down; Shift+Page Up / Shift+Page Down |
| Zoom in / out / fit drawing / fit page | F2 / F3 / F4 / Shift+F4 |
| Full-screen preview | F9; Escape exits |
| Fountain / Uniform Fill / Outline Pen | F11 / Shift+F11 / F12 |
| Pick / Shape / Freehand / Rectangle / Ellipse / Text | V / F10 / F5 / F6 / F7 / F8 |
| Small / large nudge | Arrow keys / Shift+Arrow keys |
| Zoom increment / decrement | Numpad + / Numpad − |

Key handling is platform-aware, does not steal native text editing, prevents browser navigation only for commands owned by the editor, and is documented in the searchable Help dialog. `Ctrl+R` repeats the last repeatable operation with the current selection (initially duplicate or nudge); it must not reload the page.

### 4.3 View and status feedback

- Display modes: enhanced, draft, wireframe and simple wireframe. Preview state is distinct from document rendering/export quality.
- Zoom commands preserve the pointer/selection focus where applicable; Fit Page centres the page and Fit Drawing fits the selected object(s), falling back to the page if nothing is selected.
- Grid, rulers, guides, page shadow, snapping and dynamic guides are explicit state. A view toggle is not a document edit.
- The status bar identifies selection count/kind/bounds, active page, page size, display units, zoom, snap state, current tool/message, online/sync state and renderer capability without hiding useful information on narrow screens.
- Unit labels must match converted numeric values. Internal geometry remains consistent if the display unit changes.

## 5. Priority 3 — node editing and shaping

### 5.1 Nodes and segments

Node types:

- **Sharp/cusp:** incoming and outgoing handles are independent; the node can form a corner.
- **Smooth:** handle directions remain collinear while lengths may differ.
- **Symmetrical:** handles remain collinear and equal length around the anchor.

Required operations:

- select one/multiple nodes; Shift-click adds/toggles; marquee and select-all nodes where practical;
- move nodes and handles; convert selected nodes among the three types; add/delete nodes; close/open subpaths;
- join endpoints, break a curve at nodes, reverse path direction and convert selected segments between line and curve;
- preserve fill rule, subpath closure, control points and node types through undo/redo and serialization.

Acceptance behaviour:

- Handle constraints are enforced when dragging and when converting a node type, not only in a toolbar label.
- Adding/removing nodes changes geometry locally and does not reorder unrelated subpaths. A failed/degenerate operation is a no-op with no history entry.
- Shape-tool interaction uses a clear visual distinction between anchor, selected anchor and handles. Shortcut/type cycling is announced in the status line.

### 5.2 Curve conversion, combine and break apart

- Convert to Curves freezes text and parametric primitives into editable paths; text outlines use the actual selected font's units-per-em and preserve placement/scale. Unsupported glyphs must not disappear silently.
- Combine creates one vector object with multiple subpaths and a defined fill rule; it does not union shapes. Boolean Union/Difference/Intersect are separate shaping operations.
- Break Apart splits a compound path into subpaths while preserving the original visual order and fill/stroke styles.
- All operations are atomic and undoable. Transform, effects and style references are retained or explicitly resolved; child IDs must remain unique.

### 5.3 Contour, blend and envelope

These remain planned work unless implemented and tested; their menu presence alone is not completion.

- **Contour:** live inside/outside/both contour with step count, offset, colour progression and a clear edit/remove path. Geometry must not self-intersect unpredictably; invalid settings warn or clamp.
- **Blend:** live interpolation between start/end objects with step count, object progression, colour/rotation progression and blend-along-path. Source objects stay editable; detaching the blend is a deliberate conversion.
- **Envelope:** editable four-sided/node envelope, common straight/arc presets and object text/vector support. Presets must update the actual control cage and bounds rather than merely changing a label.
- Preview, bounds, hit-test and SVG/PDF export must agree; unsupported live effects need a documented expanded-path/raster fallback.

## 6. Document, rendering and export requirements

For every persisted appearance feature (fill, outline, arrowhead, extrusion, lens, calligraphy path, node type):

1. define a typed schema and default for older documents;
2. add normalization/validation at import boundaries;
3. render consistently at normal, draft and wireframe display quality;
4. account for visual geometry in bounds and hit testing;
5. preserve through duplicate, group, layer/page movement, undo/redo, autosave and file reload;
6. add an export translation/fallback and document unsupported cases;
7. add focused tests for schema, operation, rendering geometry or export.

Every renderer should share geometry definitions instead of implementing separate incompatible marker/extrusion math. Rendering of a preview may cache derived paths, but caches are disposable and must not become document truth.

Current vector-export policy: SVG writes extrusion faces as expanded paths and attaches arrow markers to separate open-subpath strokes, so closed subpaths in a compound path do not receive endpoint markers. PDF keeps open subpaths open, fills only closed subpaths, and draws extrusion faces and endpoint markers as vector operators. These are visual translations for interchange; they do not make the exported PDF/SVG a live editable CorelByDre effect stack. Focused fidelity tests cover the compound-path marker rule and PDF readability with arrows/extrusion; cross-renderer visual comparison remains a manual acceptance item.

## 7. Test and acceptance matrix

| Area | Minimum automated coverage | Manual/browser acceptance |
|---|---|---|
| Fill dialogs | default/no-selection, uniform apply, gradient stop bounds/order and undo | F11/Shift+F11 open, edit preview and cancel/apply |
| Outline Pen | unit conversion, cap/join/dash/marker serialization, undo | F12, marker endpoint orientation, scale policy |
| Extrude | metadata defaults, add/edit/remove, bounds/hit-test | drag gesture, docker controls, export comparison |
| Lens | mode validation, mode processing, stack preservation | docker/menu, draft/preview/export consistency |
| Shortcuts | each command routes to same action as menu; text focus is ignored | platform keys, F2/F3/F4/F9/F10/F11/F12, page ordering, numpad |
| Nodes/shaping | type constraints, open/close/reverse/split/join, compound paths | direct manipulation, mixed selection and undo |
| Persistence | old schema normalization and new fields round-trip | reload a document after each signature operation |
| Workspace | menu enablement and docker visibility | narrow viewport, full-screen preview and Escape recovery |

Release gate for this fidelity tranche: clean typecheck, all existing tests pass, focused new tests pass, production build succeeds, no silent data loss on save/reload, and every shipped command is reachable through both UI and keyboard where specified.

## 8. Current implementation map and open gaps

- `src/types.ts`, `src/store/store.ts`, `src/engine/render.ts`, `src/engine/shapes.ts`, `src/engine/effects.ts`: typed behavior and rendering core.
- `src/ui/CanvasView.tsx`: direct manipulation and canvas interaction.
- `src/ui/AppShell.tsx`, `src/ui/Dialogs.tsx`, `src/ui/Dockers.tsx`: workspace commands, dialogs and docker controls.
- `src/lib/import.ts`, `src/lib/export.ts`, `src/lib/storage.ts`: file interchange and persistence.
- `tests/`: regression coverage.

The priority implementation in this branch is still a tranche, not a claim of full CorelDRAW parity. This branch now has selectable/applicable envelope presets, but not a full interactive envelope cage. In particular, true live contour/blend and blend-along-path, text and bitmap-specific Lens semantics, complete native-file interoperability, broad menu parity, accessibility/pointer edge cases and cross-browser visual equivalence require independent tests and follow-up work.
