/**
 * CorelByDre document model.
 *
 * Design notes
 *  - The document is an immutable tree. Mutations go through the helpers in
 *    `store/mutations.ts`, which clone only the nodes along the changed path
 *    (structural sharing). Undo/redo is therefore just a stack of document
 *    references, and unchanged objects keep their identity, which the renderer
 *    uses as a cache key.
 *  - Geometry is stored in document units (1 unit = 1 pt at 100% zoom).
 */

export type ID = string

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity'

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]

/** Index used by the WASM blend kernel — must match BLEND_MODES order. */
export const BLEND_INDEX: Record<BlendMode, number> = BLEND_MODES.reduce(
  (acc, mode, i) => { acc[mode] = i; return acc },
  {} as Record<BlendMode, number>,
)

/* --------------------------------------------------------------- colour ---- */

export interface RGB { r: number; g: number; b: number }
export interface RGBA extends RGB { a: number }

export interface GradientStop { offset: number; color: RGBA }

export type FountainType = 'linear' | 'radial' | 'conical' | 'square'

export interface FountainFill {
  type: 'fountain'
  fountain: FountainType
  stops: GradientStop[]
  /** Fill-space geometry, normalised to the object bounding box (0..1). */
  start: { x: number; y: number }
  end: { x: number; y: number }
  spread: 'pad' | 'repeat' | 'reflect'
  angle: number
  edgePad: number
}

export interface MeshNode { color: RGBA; x: number; y: number }
export interface MeshFill {
  type: 'mesh'
  rows: number
  cols: number
  /** (rows+1) x (cols+1) nodes, row-major, positions normalised to the bbox. */
  nodes: MeshNode[]
}

export interface PatternFill {
  type: 'pattern'
  pattern: 'vector' | 'bitmap'
  /** Preset id resolved by lib/patterns.ts. */
  preset: string
  fg: RGBA
  bg: RGBA
  scale: number
  rotation: number
  tileSize: number
  dataUrl?: string
}

export interface TextureFill {
  type: 'texture'
  preset: string
  fg: RGBA
  bg: RGBA
  scale: number
  seed: number
}

export interface PostScriptFill { type: 'postscript'; preset: string; fg: RGBA; bg: RGBA; scale: number }

export type Fill = { type: 'none' } | { type: 'uniform'; color: RGBA }
  | FountainFill | MeshFill | PatternFill | TextureFill | PostScriptFill

export interface Stroke {
  color: RGBA
  width: number
  cap: 'butt' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
  miterLimit: number
  dash?: number[]
  /** Variable outline width profile (normalised 0..1 across the path). */
  profile?: number[]
  behind: boolean
}

/* ------------------------------------------------------------ geometry ----- */

export type NodeType = 'sharp' | 'smooth' | 'symmetric'

export interface PathNode {
  x: number
  y: number
  /** Absolute control points; equal to (x,y) for a corner. */
  inX: number
  inY: number
  outX: number
  outY: number
  type: NodeType
}

export interface SubPath { nodes: PathNode[]; closed: boolean }

export interface PathData { subpaths: SubPath[]; fillRule: 'nonzero' | 'evenodd' }

export interface Rect { x: number; y: number; w: number; h: number }

export interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }

/** Parametric primitives keep their parameters so they stay editable. */
export type Primitive =
  | { type: 'rect'; w: number; h: number; r: number; corners: [number, number, number, number] }
  | { type: 'ellipse'; rx: number; ry: number; start: number; end: number; pieMode: 'pie' | 'chord' | 'arc' }
  | { type: 'polygon'; sides: number; radius: number; sharp: boolean }
  | { type: 'star'; points: number; radius: number; innerRadius: number; sharpness: number }
  | { type: 'spiral'; revolutions: number; radius: number; divergence: number; symmetrical: boolean }
  | { type: 'graphPaper'; cols: number; rows: number; w: number; h: number }
  | { type: 'line'; x2: number; y2: number }
  | { type: 'freehand' }
  | { type: 'text' }
  | { type: 'trace' }

/* -------------------------------------------------------------- effects ---- */

export type AdjustmentType =
  | 'brightness-contrast' | 'tone-curve' | 'hue-curve' | 'levels' | 'vibrance'
  | 'color-balance' | 'channel-mixer' | 'desaturate' | 'posterize' | 'threshold'
  | 'gamma' | 'selective-color'

export interface CurvePoint { x: number; y: number }

export interface Adjustment {
  id: ID
  type: 'adjustment'
  kind: AdjustmentType
  enabled: boolean
  opacity: number
  blend: BlendMode
  params: Record<string, number | number[] | string | CurvePoint[] | Record<string, number>>
}

export type EffectType =
  | 'gaussian-blur' | 'sharpen' | 'jpeg-restore' | 'noise' | 'pixelate'
  | 'lens' | 'blur-mask' | 'color-replace' | 'artistic' | 'block-shadow'
  | 'perspective' | 'liquify' | 'envelope' | 'roughen' | 'twirl'
  | 'smudge' | 'attract-repel' | 'upsample' | 'canvas-opacity'

export interface Effect {
  id: ID
  type: 'effect'
  kind: EffectType
  enabled: boolean
  opacity: number
  blend: BlendMode
  params: Record<string, number | number[] | string | boolean>
}

export type NonDestructive = Adjustment | Effect

/* -------------------------------------------------------------- objects ---- */

export interface ObjectBase {
  id: ID
  name: string
  transform: Matrix
  opacity: number
  blend: BlendMode
  locked: boolean
  visible: boolean
  printable: boolean
  /** Non-destructive adjustment/effect stack, applied bottom-up. */
  effects: NonDestructive[]
  /** Block shadow (vector drop shadow with stepped offsets). */
  blockShadow?: BlockShadow
  /** PowerClip: this object clips the objects listed in `clips`. */
  clip?: { id: ID; powerClip: boolean }
  styleRef?: ID
}

export interface BlockShadow {
  enabled: boolean
  dx: number
  dy: number
  steps: number
  color: RGBA
  feather: number
  opacity: number
  behindFill: boolean
}

export interface VectorObject extends ObjectBase {
  kind: 'vector'
  path: PathData
  primitive: Primitive
  fill: Fill
  stroke: Stroke | null
  /** Painterly brush: the stroke is rendered with a media engine instead of a flat line. */
  brush?: BrushStroke
  /** Envelope distortion applied to the rendered path (non-destructive). */
  envelope?: Envelope
  /** Perspective drawing guides baked into the object's path. */
  perspective?: PerspectiveGuide
  /** Symmetry source (mirrored copies generated on edit). */
  symmetry?: SymmetrySettings
}

export interface Envelope {
  preset: string
  /** 4x4 control grid of normalised offsets, row-major. */
  grid: { x: number; y: number }[]
  rows: number
  cols: number
  strength: number
}

export interface PerspectiveGuide {
  /** Vanishing points, normalised to the page. */
  vp1: { x: number; y: number }
  vp2: { x: number; y: number }
  thirdDim: boolean
}

export interface SymmetrySettings {
  mode: 'none' | 'mirror-x' | 'mirror-y' | 'radial' | 'kaleidoscope'
  mirrors: number
  center: { x: number; y: number }
  reflect: boolean
}

export interface BrushStroke {
  preset: string
  /** Stroke spine (the original path), sampled for rendering. */
  points: { x: number; y: number; p: number }[]
  size: number
  sizeVariation: number
  opacityVariation: number
  spacing: number
  rotation: number
  flow: number
  media: 'watercolor' | 'oil' | 'pastel' | 'marker' | 'pencil' | 'ink'
  color: RGBA
  colorVariation: number
  jitter: number
  seed: number
  /** Build-up passes for wet media. */
  buildup: number
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  fontWeight: number
  fontStyle: 'normal' | 'italic'
  variableAxes: Record<string, number>
  letterSpacing: number
  wordSpacing: number
  lineHeight: number
  align: 'left' | 'center' | 'right' | 'justify' | 'force'
  color: RGBA
  outline?: Stroke | null
  /** OpenType features by 4-char tag, e.g. { liga: true, dlig: false } */
  openType: Record<string, boolean>
  superSub: 'none' | 'super' | 'sub'
  caps: 'none' | 'small' | 'all'
  /** Character/paragraph options */
  bullet: 'none' | 'bullet' | 'number' | 'roman' | 'alpha'
  bulletIndent: number
  bulletChar: string
  dropCap: number
  paragraphSpacing: number
  indents: { left: number; right: number; first: number }
  tabStops: number[]
  hyphenate: boolean
}

export interface TextObject extends ObjectBase {
  kind: 'text'
  mode: 'artistic' | 'paragraph'
  content: string
  style: TextStyle
  /** Paragraph text frame (document units). */
  frame: Rect
  /** Text on a path — an id of a vector object whose path is the baseline. */
  onPathId?: ID
  onPathOffset: number
  onPathSide: 'above' | 'below'
  /** Wrapping: ids of objects the text flows around. */
  wrapAround: ID[]
  wrapOffset: number
  /** Column layout for paragraph frames. */
  columns: number
  columnGutter: number
  fitToFrame: boolean
}

export interface MaskData {
  /** Encoded alpha mask (grayscale PNG data URL) at bitmap resolution. */
  dataUrl?: string
  /** Non-destructive adjustments to the mask. */
  feather: number
  contrast: number
  invert: boolean
  /** Selection rectangles/ellipses/paths used before rasterisation. */
  shapes: { kind: 'rect' | 'ellipse'; rect: Rect; mode: 'add' | 'subtract' | 'replace' }[]
  opacity: number
}

export interface BitmapObject extends ObjectBase {
  kind: 'bitmap'
  dataUrl: string
  width: number
  height: number
  /** Document-space placement of the bitmap before `transform`. */
  rect: Rect
  mask?: MaskData
  /** Crop in source pixels. */
  crop?: Rect
  /** Photographic corrections kept as data so they stay reversible. */
  hasAlpha: boolean
}

export interface GroupObject extends ObjectBase {
  kind: 'group'
  children: SceneObject[]
  /** Group clip (used by PowerClip frames). */
  clipRect?: Rect | null
}

export type SceneObject = VectorObject | TextObject | BitmapObject | GroupObject

/* --------------------------------------------------------------- layers ---- */

export type LayerKind = 'normal' | 'master' | 'guide'

export interface Layer {
  id: ID
  name: string
  kind: LayerKind
  visible: boolean
  locked: boolean
  printable: boolean
  objects: SceneObject[]
  opacity: number
  blend: BlendMode
}

export interface Guide { id: ID; axis: 'x' | 'y'; pos: number; locked: boolean; color: RGBA }

export interface PageSize { w: number; h: number; unit: 'pt' | 'mm' | 'in' | 'px'; name?: string }

export interface Page {
  id: ID
  name: string
  size: PageSize
  bleed: number
  orientation: 'portrait' | 'landscape'
  background: RGBA
  layers: Layer[]
  guides: Guide[]
  /** Master layer ids inherited from the document. */
  masters: ID[]
}

export interface ColorStyle { id: ID; name: string; color: RGBA; kind: 'harmony' | 'spot' | 'process' }

export interface DocumentSettings {
  gridStep: number
  snapToGrid: boolean
  snapToObjects: boolean
  snapToGuides: boolean
  dynamicGuides: boolean
  selfSnapping: boolean
  /** Snap threshold in screen pixels. */
  snapTolerance: number
  showRulers: boolean
  /** Units shown in the UI. */
  displayUnit: 'pt' | 'mm' | 'in' | 'px'
  nudgeStep: number
  duplicateOffset: number
  /** 0..1 — smoothing applied to freehand strokes. */
  vectorSmoothing: number
  liveSketch: boolean
  colorMode: 'RGB' | 'CMYK' | 'Grayscale' | 'Lab'
  renderingIntent: 'perceptual' | 'relative-colorimetric' | 'saturation' | 'absolute-colorimetric'
  proofing: boolean
}

export interface Document {
  id: ID
  name: string
  version: number
  createdAt: number
  modifiedAt: number
  pages: Page[]
  activePageId: ID
  colorStyles: ColorStyle[]
  palette: { id: string; name: string }
  settings: DocumentSettings
  /** Embedded font faces so documents survive without the original font installed. */
  embeddedFonts: { family: string; dataUrl: string; axes?: Record<string, { min: number; max: number; default: number }> }[]
  meta: { author: string; title: string; subject: string; keywords: string }
}

/* --------------------------------------------------------------- shapes ---- */

export interface SelectionState {
  ids: ID[]
  pageId: ID
  layerId: ID
}

export interface TransformState {
  /** Live transform being dragged, applied to the preview. */
  dx: number
  dy: number
  sx: number
  sy: number
  rotate: number
  skewX: number
  skewY: number
  originX: number
  originY: number
}

export interface ViewState {
  zoom: number
  panX: number
  panY: number
  showGrid: boolean
  showGuides: boolean
  showRulers: boolean
  showPageShadow: boolean
  wireframe: boolean
  snapPreview?: { x?: number[]; y?: number[] }
}
