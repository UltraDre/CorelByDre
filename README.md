# CorelByDre Graphics Suite

A professional vector-illustration, page-layout and photo-editing studio that runs entirely in
the browser. Installable as a PWA on desktop and mobile, fully usable offline, with optional
collaboration when a server (or just another tab) is available.

**No AI, no machine learning, no generative features — at any phase.** Every "smart" sounding
tool here is a deterministic closed-form operator (flood fill, closed-form curves, fixed
kernels), never a model. See [Deterministic by construction](#deterministic-by-construction).

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173  (LAN + preview friendly: --host 0.0.0.0)
npm run build        # AssemblyScript kernels → tsc → vite build
npm test             # vitest: model, photo, exports, store, collab, import, storage, interaction
node server/sync-server.mjs --port 8787   # optional collaboration relay (no dependencies)
```

`npm run build` also compiles `wasm/kernels.ts` to `public/wasm/kernels.wasm` with
AssemblyScript. When the WASM build is unavailable the app transparently uses the identical
JavaScript kernels (`src/lib/wasm.ts`), so nothing breaks.

### GitHub Pages

The repository includes a Pages workflow at `.github/workflows/pages.yml`. In the repository's
**Settings → Pages**, select **GitHub Actions** as the build and deployment source; pushes to
`main` then build the production bundle and publish `dist/`. The Vite build uses relative asset
URLs, so it works from GitHub Pages' `/<repository>/` project-site path as well as at a domain
root. Do not publish the repository source directory directly: the app must be built first.

---

## Feature map

Every feature is reachable from the UI and implemented in the listed module.

### Vector illustration

| Feature | Where |
| --- | --- |
| Pick, Free transform, Lasso, Zoom, Pan | `src/ui/CanvasView.tsx`, `src/tools/registry.ts` |
| Shape, Smudge, Roughen, Twirl, Attract, Repel, Smear, Knife, Eraser, Crop | `src/engine/shapes.ts` (`distortNodes`, `breakApart`), `CanvasView.tsx` |
| Freehand, 2-Point Line, Bezier, Pen, Polyline, B-Spline, 3-Point Curve, LiveSketch | `src/engine/shapes.ts` (`refineCurve`, `rdp`, `smoothClosedPath`) |
| Rectangle, 3-Point Rectangle, Ellipse, 3-Point Ellipse, Polygon, Star, Complex Star, Graph Paper, Spiral | `src/engine/shapes.ts` (`rectPath`, `threePointRect`, `ellipsePath`, `threePointEllipse`, `polygonPath`, `starPath`, `graphPaperPath`, `spiralPath`) |
| Perspective drawing | `homographyFromQuad` / `perspectiveProject` in `shapes.ts`, applied by the `perspective` tool |
| Self-snapping, object snapping, dynamic guides, grid/guide snapping | `CanvasView.applySnapping`, `DocumentSettings.selfSnapping` |
| Vector smoothing | `DocumentSettings.freehandSmoothing` + `refineCurve` |
| Variable outline | `variableOutline()` (per-node width profile), tool `variableOutline` |
| Symmetry (mirror / radial / kaleidoscope) | `symmetryTransforms()`, `VectorObject.symmetry`, tool `symmetry` |
| Block shadow, contour, drop shadow, transparency, blend, envelope | `src/engine/effects.ts`, `applyEnvelope()` |
| Booleans (weld, trim, intersect, simplify, smooth) | `src/engine/boolean.ts` (Paper.js with a deterministic fallback) |
| Painterly brush engine, 120 presets, Media Tray | `src/engine/brush.ts` (`BRUSH_PRESETS`, `paintStroke`, `presetByID`, media tray) |
| Non-destructive effects stack | `src/engine/effects.ts` (`EFFECT_DEFS`, `runStack`), Effects docker |
| Tracing bitmaps to curves | `src/lib/trace.ts` (deterministic contour tracer + `TraceBitmap` styles) |

### Text

Artistic and paragraph text, variable font axes, OpenType feature toggles, glyph browsing,
bullets/numbering, drop caps, indents, tab stops, hyphenation, columns, text wrap around
objects, text on a path, font embedding and Google Fonts catalogue — all in
`src/lib/text.ts` plus the Text docker (`src/ui/Dockers.tsx`). Fonts are fetched only when
online; the app ships with a curated catalogue so typography works offline.

### Pages, layout and structure

Multi-page documents, the Page docker, page presets, master layers, layers/layer groups,
dynamic guides, align/distribute, PowerClip (place inside / extract), symmetry and shapes
dockers — `src/store/mutations.ts`, `src/store/store.ts`, `src/ui/Dockers.tsx`.

### PHOTO-PAINT

Hue curve, tone curve, levels, vibrance, colour balance, channel mixer, posterize, threshold,
gamma and selective colour adjustments; non-destructive adjustment presets; manual background
removal; subject selection; advanced masking (paint/erase, feather, grow/shrink, invert, magic
wand); Liquify (push/twirl/pinch/restore); Lens correction (distortion, aberration, vignette);
Blur masking (tilt-shift); colour replacement; upsampling; JPEG artifact removal; clone,
healing, smudge, sharpen, dodge/burn retouching — `src/lib/photo.ts` over the WASM/JS image
kernels in `src/lib/wasm.ts` and `wasm/kernels.ts`.

### Colour and fills

PANTONE-style palettes plus document palettes, Color Styles, colour harmonies (complementary,
analogous, triadic, tetradic), fountain fills (linear/radial/conical/rectangular), mesh fills,
vector/bitmap/PostScript pattern fills — `src/lib/color.ts`, `src/lib/patterns.ts`, Color
docker and `ColorStylesPanel`.

### Import / export

Import: CDR (inspect + optional conversion service), PDF, AI, SVG, EPS, WebP, HEIF/HEIC, RAW
(400+ camera extensions via the platform codecs), DWG/DXF, plus raster and Office-style
bitmaps — `src/lib/import.ts`.
Export: SVG, PDF (incl. PDF/X-4 and PDF/A), AI (PDF-compatible), EPS, DXF, PNG/JPEG/WebP/AVIF
rasters, separations, imposition, printer's marks, and the pixel-precise **web export** with
densities, slices and a copy-paste `srcset` snippet — `src/lib/export.ts`,
`src/lib/webexport.ts`, `src/ui/Dialogs.tsx`.

### PWA

Cache-first app shell service worker with runtime caching, background sync + periodic sync,
push notifications (invites, mentions, export completion), install prompts, Window Controls
Overlay support, File System Access open/save with download fallbacks, IndexedDB document
history and autosave, full offline editing — `public/sw.js`, `public/manifest.webmanifest`,
`src/lib/storage.ts`, `src/ui/fileOps.ts`, `src/App.tsx`, `src/ui/AppShell.tsx`
(`useInstallPrompt`, `useOnlineSync`).

---

## Collaboration (optional, offline-first)

Collaboration is built on an operation log with hybrid logical clocks: every edit is an op
tagged with `(wall time, logical counter, actor)`. Merging sorts ops by that clock and applies
per-path last-writer-wins, so merges are commutative, idempotent and converge to identical
documents on every peer. Comments, replies, @mentions and presence (live cursors and
selection boxes on the canvas) ride the same log.

* **No server?** Other tabs/windows on the same origin sync instantly over `BroadcastChannel`.
* **Server?** Run the bundled relay and set it in the Collaborate docker:

  ```bash
  node server/sync-server.mjs --port 8787 --data ./sync-data.json
  ```

  The editor talks to it by long-polling (`src/lib/collab.ts` → `httpTransport`); a
  `WebSocket` endpoint is supported too (`webSocketTransport`).
* **Offline?** Edits queue in the outbox with exponential backoff and flush on reconnect.
  Nothing is ever dropped, and the editor never blocks on the network.

---

## Deterministic by construction

The project brief forbids AI/ML/generative features, so there are none — not even
"convenience" ones:

* Background removal and subject selection are flood fills with tolerance/feather, seeded from
  the image border or the current selection, never a segmentation model.
* Retouching is fixed-radius dab maths; upscaling is Mitchell/bicubic resampling; JPEG
  artifact removal is a deterministic edge-aware smoothing pass.
* Tracing derives contours from a thresholded bitmap and simplifies them with RDP.
* Colour analysis (dominant palettes, histograms, auto levels) is closed-form statistics.
* Mentions are parsed with an explicit token grammar; presence colours come from a hash.

---

## Startup resilience

The editor paints first and asks for permissions second — no optional platform
feature is allowed to become a dead end:

* **Local storage can never block first paint.** IndexedDB is blocked in sandboxed
  or partitioned third-party contexts (iframes, some private modes) and, worse,
  `open()` can fire neither `success` nor `error` at all. `src/lib/storage.ts`
  guards every call with a capability check and a hard deadline, so a failure
  always arrives as a rejection the caller can fall back from. `src/App.tsx` races
  session restore against a 1.5 s budget and opens the workspace regardless; a
  restore that lands late is discarded if the user has already started working.
  A genuine denial is remembered, a transient timeout stays retryable, and the
  status is surfaced with one toast instead of a spinner.
* **Service-worker waits are bounded.** `serviceWorker.ready` never settles when no
  worker activates, which would otherwise wedge autosave queuing, background sync
  and the notification buttons.
* **PDF/AI import configures its worker.** pdf.js v4 only defaults
  `GlobalWorkerOptions.workerSrc` under Node; in a browser the getter throws and
  every PDF import fails. The worker is emitted as a hashed same-origin asset, so
  it is cacheable by the service worker and import keeps working offline. A PDF
  that yields nothing still produces a document with one blank page, never an
  empty page list.
* **Network calls are optional and time out.** The Google Fonts catalogue fetch is
  aborted after 12 s; the curated offline catalogue is always available.

## Performance notes

* Artwork is rendered through one culled pipeline (`src/engine/render.ts`) with per-object
  geometry caches; a second overlay canvas redraws at pointer-move frequency while the
  artwork layer only repaints when the document or view changes.
* All drag state lives in refs and repaints are coalesced into a single
  `requestAnimationFrame`, so dragging thousands of objects never re-renders React.
* Heavy image maths runs in the WASM kernels (AssemblyScript) with inline JS equivalents, and
  expensive exports can be queued through the service worker's background sync.

## Repository layout

```
src/engine/    shapes, booleans, brush engine, effects, renderer
src/lib/       colour, text/fonts, patterns, photo, trace, import, export, web export, storage, collab
src/store/     document mutations, zustand store (undo/redo), collaboration store
src/tools/     tool registry (60 tools, groups, shortcuts)
src/ui/        shell, canvas, toolbox, property bar, dockers, dialogs, home, collaboration UI
server/        dependency-free sync relay
wasm/          AssemblyScript image kernels
tests/         document model, photo operators, exports, store, collaboration,
               PDF import, storage resilience, strict-canvas + pointer interaction smoke tests
```
