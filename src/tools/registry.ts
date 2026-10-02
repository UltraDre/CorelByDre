/**
 * Tool registry — mirrors CorelDRAW's toolbox, including flyout groups.
 * Each tool declares its shortcut, cursor, property bar and whether it draws.
 */

export type ToolID =
  | 'pick' | 'freeTransform' | 'zoom' | 'pan'
  | 'shape' | 'smudge' | 'roughen' | 'twirl' | 'attract' | 'repel' | 'smear'
  | 'knife' | 'eraser' | 'crop' | 'lasso'
  | 'freehand' | 'line2' | 'bezier' | 'pen' | 'bspline' | 'polyline' | 'curve3' | 'liveSketch'
  | 'rectangle' | 'rect3' | 'ellipse' | 'ellipse3'
  | 'polygon' | 'star' | 'complexStar' | 'graphPaper' | 'spiral'
  | 'text' | 'table'
  | 'transparency' | 'blend' | 'contour' | 'dropShadow' | 'envelope' | 'perspective' | 'blockShadow'
  | 'fill' | 'meshFill' | 'smartFill'
  | 'eyedropper'
  | 'brush' | 'variableOutline' | 'symmetry'
  | 'maskBrush' | 'liquify' | 'clone' | 'colorReplace' | 'blurBrush' | 'sharpenBrush' | 'dodgeBrush' | 'burnBrush'
  | 'enhance' | 'perspectiveCorrect' | 'bgRemove' | 'cutout'

export type ToolGroupID =
  | 'pick' | 'shape' | 'crop' | 'zoom' | 'curve' | 'rectangle' | 'ellipse' | 'object'
  | 'text' | 'effect' | 'fill' | 'eyedropper' | 'media' | 'photo' | 'photoSelect' | 'photoRetouch'

export interface ToolDef {
  id: ToolID
  label: string
  group: ToolGroupID
  shortcut?: string
  hint: string
  cursor: string
  /** Draws new geometry (affects the property bar and history labels). */
  draws?: boolean
  /** Photo-editing tools only make sense inside a bitmap context. */
  photo?: boolean
  /** Renders the toolbox icon. */
  icon: string
}

export interface ToolGroupDef {
  id: ToolGroupID
  label: string
  tools: ToolID[]
}

const svg = (body: string, extra = ''): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`

export const TOOLS: Record<ToolID, ToolDef> = {
  /* ------------------------------------------------------------- pick ---- */
  pick: { id: 'pick', label: 'Pick', group: 'pick', shortcut: 'V', hint: 'Select, move, scale and rotate objects', cursor: 'default', icon: svg('<path d="M5 3l6 16 2.2-6.2L19.5 10z"/>') },
  freeTransform: { id: 'freeTransform', label: 'Free transform', group: 'pick', shortcut: 'X', hint: 'Scale, rotate and skew freely', cursor: 'nwse-resize', icon: svg('<path d="M4 9V4h5M20 15v5h-5M9 20H4v-5M15 4h5v5"/>') },
  zoom: { id: 'zoom', label: 'Zoom', group: 'zoom', shortcut: 'Z', hint: 'Click to zoom in, Alt-click to zoom out', cursor: 'zoom-in', icon: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8.5 11h5M11 8.5v5"/>') },
  pan: { id: 'pan', label: 'Pan', group: 'zoom', shortcut: 'H', hint: 'Drag to pan the canvas', cursor: 'grab', icon: svg('<path d="M12 3v8M12 21v-4M3 12h8M21 12h-4"/><circle cx="12" cy="12" r="3"/>') },

  /* ------------------------------------------------------------ shape ---- */
  shape: { id: 'shape', label: 'Shape', group: 'shape', shortcut: 'F10', hint: 'Edit nodes and handles — double-click a segment to add a node', cursor: 'crosshair', icon: svg('<path d="M4 18c4-10 12-10 16 0"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="18" r="2"/><circle cx="12" cy="10.5" r="2"/>') },
  smudge: { id: 'smudge', label: 'Smudge brush', group: 'effect', hint: 'Drag vector edges to smear them', cursor: 'crosshair', icon: svg('<path d="M4 16c3 0 5-6 8-6s5 6 8 6"/><path d="M4 20h16"/>') },
  roughen: { id: 'roughen', label: 'Roughen brush', group: 'effect', hint: 'Adds irregular detail along an edge', cursor: 'crosshair', icon: svg('<path d="M3 16l2-4 2 4 2-6 2 6 2-4 2 4 2-6 2 6"/>') },
  twirl: { id: 'twirl', label: 'Twirl brush', group: 'effect', hint: 'Twists objects around the brush centre', cursor: 'crosshair', icon: svg('<path d="M12 12c3-3 6-2 6 1s-3 5-6 5"/><path d="M12 12c-3 1-4 4-2 6"/>') },
  attract: { id: 'attract', label: 'Attract', group: 'effect', hint: 'Pulls nodes toward the brush', cursor: 'crosshair', icon: svg('<path d="M12 4v6M12 20v-6M4 12h6M20 12h-6"/><path d="M9 9l6 6M15 9l-6 6"/>') },
  repel: { id: 'repel', label: 'Repel', group: 'effect', hint: 'Pushes nodes away from the brush', cursor: 'crosshair', icon: svg('<circle cx="12" cy="12" r="2.5"/><path d="M12 3v4M12 21v-4M3 12h4M21 12h-4M6 6l2.6 2.6M18 18l-2.6-2.6M18 6l-2.6 2.6M6 18l2.6-2.6"/>') },
  smear: { id: 'smear', label: 'Smear', group: 'effect', hint: 'Smears colour like wet paint (photo)', cursor: 'crosshair', photo: true, icon: svg('<circle cx="9" cy="10" r="3"/><circle cx="15" cy="14" r="3"/><path d="M4 20h16"/>') },

  knife: { id: 'knife', label: 'Knife', group: 'crop', hint: 'Slice objects into separate pieces', cursor: 'crosshair', icon: svg('<path d="M4 20l7-7"/><path d="M11 13l7-9 2 2-7 9z"/>') },
  eraser: { id: 'eraser', label: 'Eraser', group: 'crop', shortcut: 'X', hint: 'Erase parts of objects or bitmaps', cursor: 'crosshair', icon: svg('<path d="M4 16l6-6 6 6-4 4H8z"/><path d="M12 8l4-4 6 6-4 4"/>') },
  crop: { id: 'crop', label: 'Crop', group: 'crop', hint: 'Trim the page or a bitmap', cursor: 'crosshair', icon: svg('<path d="M7 3v14h14M3 7h14v14"/>') },
  lasso: { id: 'lasso', label: 'Freehand pick', group: 'pick', hint: 'Draw a lasso to select several objects', cursor: 'crosshair', icon: svg('<path d="M12 4c5 0 8 3 8 6s-3 6-8 6-8-3-8-6 3-6 8-6z"/><path d="M9 16c-1 2 0 4 2 4"/>') },

  /* ------------------------------------------------------------ curve ---- */
  freehand: { id: 'freehand', label: 'Freehand', group: 'curve', shortcut: 'F5', hint: 'Draw freehand curves; smoothing follows the property bar', cursor: 'crosshair', draws: true, icon: svg('<path d="M3 17c5-12 13 4 18-8"/>') },
  line2: { id: 'line2', label: '2-point line', group: 'curve', hint: 'Drag to draw a straight segment', cursor: 'crosshair', draws: true, icon: svg('<path d="M4 20L20 4"/>') },
  bezier: { id: 'bezier', label: 'Bezier', group: 'curve', hint: 'Click to place nodes, drag to pull curve handles', cursor: 'crosshair', draws: true, icon: svg('<path d="M4 18c6 0 8-12 16-12"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="6" r="1.6"/>') },
  pen: { id: 'pen', label: 'Pen', group: 'curve', hint: 'Preview the next segment before you commit it', cursor: 'crosshair', draws: true, icon: svg('<path d="M12 3l4 7-4 11-4-11z"/><path d="M8 10h8"/>') },
  bspline: { id: 'bspline', label: 'B-Spline', group: 'curve', hint: 'Control points bend the curve without passing through them', cursor: 'crosshair', draws: true, icon: svg('<path d="M3 18c4-10 14-10 18 0"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="18" r="1.5"/>') },
  polyline: { id: 'polyline', label: 'Polyline', group: 'curve', hint: 'Click to chain straight segments; double-click to finish', cursor: 'crosshair', draws: true, icon: svg('<path d="M3 20l5-9 5 5 8-12"/>') },
  curve3: { id: 'curve3', label: '3-point curve', group: 'curve', hint: 'Drag a base line, then set the curve height', cursor: 'crosshair', draws: true, icon: svg('<path d="M3 18C8 4 16 4 21 18"/><path d="M3 18h18"/>') },
  liveSketch: { id: 'liveSketch', label: 'LiveSketch', group: 'curve', hint: 'Sketchy strokes snapped to clean curves as you draw', cursor: 'crosshair', draws: true, icon: svg('<path d="M3 16c3-6 4 4 7-2s4 4 7-3"/><path d="M3 20h18"/>') },

  /* -------------------------------------------------------- rectangles --- */
  rectangle: { id: 'rectangle', label: 'Rectangle', group: 'rectangle', shortcut: 'F6', hint: 'Drag to draw; hold Shift for a square', cursor: 'crosshair', draws: true, icon: svg('<rect x="4" y="6" width="16" height="12" rx="1"/>') },
  rect3: { id: 'rect3', label: '3-point rectangle', group: 'rectangle', hint: 'Base line then perpendicular extent', cursor: 'crosshair', draws: true, icon: svg('<path d="M3 16h13l5-9H8z"/>') },

  /* ----------------------------------------------------------- ellipses -- */
  ellipse: { id: 'ellipse', label: 'Ellipse', group: 'ellipse', shortcut: 'F7', hint: 'Drag to draw; hold Ctrl for a circle', cursor: 'crosshair', draws: true, icon: svg('<ellipse cx="12" cy="12" rx="8" ry="6"/>') },
  ellipse3: { id: 'ellipse3', label: '3-point ellipse', group: 'ellipse', hint: 'Drag the major axis, then set the minor radius', cursor: 'crosshair', draws: true, icon: svg('<ellipse cx="12" cy="12" rx="8" ry="6" transform="rotate(-20 12 12)"/>') },

  /* ------------------------------------------------------------ objects -- */
  polygon: { id: 'polygon', label: 'Polygon', group: 'object', shortcut: 'Y', hint: 'Set the side count on the property bar', cursor: 'crosshair', draws: true, icon: svg('<path d="M12 4l7 5-2.6 8h-8.8L5 9z"/>') },
  star: { id: 'star', label: 'Star', group: 'object', hint: 'Star with adjustable point count and sharpness', cursor: 'crosshair', draws: true, icon: svg('<path d="M12 3l2.6 6 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3.2 1.4-6.3L3 9.6 9.4 9z"/>') },
  complexStar: { id: 'complexStar', label: 'Complex star', group: 'object', hint: 'Multi-point star that crosses itself', cursor: 'crosshair', draws: true, icon: svg('<path d="M12 3l3 6 6 1-4 5 1 6-6-3-6 3 1-6-4-5 6-1z"/><path d="M12 8v8M7 12h10"/>') },
  graphPaper: { id: 'graphPaper', label: 'Graph paper', group: 'object', hint: 'Grid of rectangles in one object', cursor: 'crosshair', draws: true, icon: svg('<rect x="3" y="4" width="18" height="16"/><path d="M9 4v16M15 4v16M3 10h18M3 15h18"/>') },
  spiral: { id: 'spiral', label: 'Spiral', group: 'object', hint: 'Adjustable revolutions and divergence', cursor: 'crosshair', draws: true, icon: svg('<path d="M12 12a2 2 0 113 2 5 5 0 10-8-2 7 7 0 1013 3"/>') },

  /* --------------------------------------------------------------- text -- */
  text: { id: 'text', label: 'Text', group: 'text', shortcut: 'F8', hint: 'Click for artistic text, drag for a paragraph frame', cursor: 'text', draws: true, icon: svg('<path d="M5 6h14M12 6v13M9 19h6"/>') },
  table: { id: 'table', label: 'Table', group: 'text', hint: 'Drag to create a table grid of text frames', cursor: 'crosshair', draws: true, icon: svg('<rect x="3" y="4" width="18" height="16"/><path d="M3 10h18M9 10v10M15 10v10"/>') },

  /* ------------------------------------------------------------- effects - */
  transparency: { id: 'transparency', label: 'Transparency', group: 'effect', hint: 'Set object transparency and merge mode', cursor: 'crosshair', icon: svg('<rect x="4" y="4" width="16" height="16" rx="2" opacity="0.5"/><path d="M4 12h16"/>') },
  blend: { id: 'blend', label: 'Blend', group: 'effect', hint: 'Drag between two objects to blend them', cursor: 'crosshair', icon: svg('<circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M8.5 15.5C11 12 13 10 15.5 8.5" stroke-dasharray="2 2"/>') },
  contour: { id: 'contour', label: 'Contour', group: 'effect', hint: 'Add concentric outlines around an object', cursor: 'crosshair', icon: svg('<path d="M12 5l6 7-6 7-6-7z"/><path d="M12 8.5l3.5 3.5L12 15.5 8.5 12z" opacity="0.6"/>') },
  dropShadow: { id: 'dropShadow', label: 'Drop shadow', group: 'effect', hint: 'Drag to offset a soft shadow', cursor: 'crosshair', icon: svg('<rect x="4" y="4" width="12" height="12" rx="1"/><path d="M8 20h12V8" opacity="0.5"/>') },
  envelope: { id: 'envelope', label: 'Envelope', group: 'effect', hint: 'Bend objects with a control grid', cursor: 'crosshair', icon: svg('<path d="M4 18c2-8 14-8 16 0"/><path d="M4 18V6h16v12" stroke-dasharray="2 2"/>') },
  perspective: { id: 'perspective', label: 'Perspective', group: 'effect', hint: 'Draw on a perspective plane defined by vanishing points', cursor: 'crosshair', icon: svg('<path d="M3 20l9-13 9 13z"/><path d="M6 20l6-9 6 9" stroke-dasharray="2 2"/>') },
  blockShadow: { id: 'blockShadow', label: 'Block shadow', group: 'effect', hint: 'Stepped vector shadow with adjustable copies', cursor: 'crosshair', icon: svg('<rect x="3" y="3" width="11" height="11"/><path d="M7 7h11v11H7z" opacity="0.55"/>') },

  /* ---------------------------------------------------------------- fill - */
  fill: { id: 'fill', label: 'Interactive fill', group: 'fill', shortcut: 'G', hint: 'Drag on an object to set a fountain fill interactively', cursor: 'crosshair', icon: svg('<path d="M7 4h10l-1 9H8z"/><path d="M8 13c0 4 2 7 4 7s4-3 4-7"/>') },
  meshFill: { id: 'meshFill', label: 'Mesh fill', group: 'fill', shortcut: 'M', hint: 'Click to add mesh nodes, drag to blend colours', cursor: 'crosshair', icon: svg('<path d="M4 6c5 3 11-3 16 0M4 12c5 3 11-3 16 0M4 18c5 3 11-3 16 0"/><path d="M8 4v16M16 4v16" opacity="0.5"/>') },
  smartFill: { id: 'smartFill', label: 'Smart fill', group: 'fill', hint: 'Click inside an enclosed region to fill it', cursor: 'crosshair', icon: svg('<path d="M12 3l8 8-8 8-8-8z"/><rect x="9" y="9" width="6" height="6" opacity="0.6"/>') },

  eyedropper: { id: 'eyedropper', label: 'Colour eyedropper', group: 'eyedropper', shortcut: 'I', hint: 'Pick a colour from the canvas or another object', cursor: 'crosshair', icon: svg('<path d="M4 20l3-1 9-9-2-2-9 9z"/><path d="M14 6l4-2 2 2-2 4z"/>') },

  /* --------------------------------------------------------------- media - */
  brush: { id: 'brush', label: 'Painterly brush', group: 'media', shortcut: 'B', hint: 'Paint with traditional media brushes', cursor: 'crosshair', draws: true, icon: svg('<path d="M6 20c0-3 3-4 5-6l8-9 3 3-9 8c-2 2-3 5-6 5z"/><path d="M4 21h4"/>') },
  variableOutline: { id: 'variableOutline', label: 'Variable outline', group: 'media', hint: 'Drag a stroke to change its width profile', cursor: 'crosshair', icon: svg('<path d="M3 17c6 0 12-8 18-8"/><path d="M3 13c6 0 12-8 18-8" opacity="0.6"/>') },
  symmetry: { id: 'symmetry', label: 'Symmetry', group: 'media', hint: 'Mirror your drawing across symmetry axes', cursor: 'crosshair', draws: true, icon: svg('<path d="M12 3v18" stroke-dasharray="3 3"/><path d="M9 8L4 12l5 4zM15 8l5 4-5 4z"/>') },

  /* --------------------------------------------------------------- photo - */
  maskBrush: { id: 'maskBrush', label: 'Mask brush', group: 'photoSelect', shortcut: 'K', photo: true, hint: 'Paint a mask to hide or reveal areas', cursor: 'crosshair', icon: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/>') },
  cutout: { id: 'cutout', label: 'Cutout / background removal', group: 'photoSelect', photo: true, hint: 'Brush the background away, then refine the edge', cursor: 'crosshair', icon: svg('<path d="M4 4h16v16H4z"/><path d="M9 20l11-11" stroke-dasharray="3 3"/><circle cx="9" cy="9" r="2.6"/>') },
  bgRemove: { id: 'bgRemove', label: 'Subject select', group: 'photoSelect', photo: true, hint: 'Flood-based background selection with tolerance', cursor: 'crosshair', icon: svg('<circle cx="12" cy="9" r="3.4"/><path d="M5 20c1.6-4 4-6 7-6s5.4 2 7 6"/>') },
  liquify: { id: 'liquify', label: 'Liquify', group: 'photoRetouch', shortcut: 'L', photo: true, hint: 'Push, twirl, pinch or bloat pixels', cursor: 'crosshair', icon: svg('<path d="M12 3c4 5 6 8 6 11a6 6 0 11-12 0c0-3 2-6 6-11z"/>') },
  clone: { id: 'clone', label: 'Clone / heal', group: 'photoRetouch', photo: true, hint: 'Alt-click to sample, then paint to retouch', cursor: 'crosshair', icon: svg('<circle cx="12" cy="9" r="4"/><circle cx="12" cy="9" r="4" transform="translate(4 4)" opacity="0.5"/><path d="M6 18l12 3"/>') },
  colorReplace: { id: 'colorReplace', label: 'Replace colour', group: 'photoRetouch', photo: true, hint: 'Swap one colour for another with tolerance', cursor: 'crosshair', icon: svg('<circle cx="8" cy="8" r="4"/><circle cx="16" cy="16" r="4" opacity="0.55"/>') },
  blurBrush: { id: 'blurBrush', label: 'Blur', group: 'photoRetouch', photo: true, hint: 'Soften detail locally', cursor: 'crosshair', icon: svg('<path d="M4 12c2-4 4-4 6 0s4 4 6 0 3-3 4-1"/>') },
  sharpenBrush: { id: 'sharpenBrush', label: 'Sharpen', group: 'photoRetouch', photo: true, hint: 'Increase local contrast', cursor: 'crosshair', icon: svg('<path d="M12 3l2 6h6l-5 4 2 7-5-4-5 4 2-7-5-4h6z"/>') },
  dodgeBrush: { id: 'dodgeBrush', label: 'Dodge', group: 'photoRetouch', photo: true, hint: 'Lighten pixels under the brush', cursor: 'crosshair', icon: svg('<circle cx="12" cy="12" r="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>') },
  burnBrush: { id: 'burnBrush', label: 'Burn', group: 'photoRetouch', photo: true, hint: 'Darken pixels under the brush', cursor: 'crosshair', icon: svg('<circle cx="12" cy="12" r="5" fill="currentColor" opacity="0.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>') },
  enhance: { id: 'enhance', label: 'Enhance', group: 'photoRetouch', photo: true, hint: 'Manual correction workflow: adjust, compare, apply', cursor: 'crosshair', icon: svg('<path d="M12 4l2 5h5l-4 3.5L16.5 18 12 15l-4.5 3L9 12.5 5 9h5z"/>') },
  perspectiveCorrect: { id: 'perspectiveCorrect', label: 'Perspective correction', group: 'photo', photo: true, hint: 'Drag four corners to square up a photo', cursor: 'crosshair', icon: svg('<path d="M4 8l16-3v14L4 16z"/><path d="M4 8v8M20 5v14" stroke-dasharray="2 2"/>') },
}

export const TOOL_GROUPS: ToolGroupDef[] = [
  { id: 'pick', label: 'Pick tools', tools: ['pick', 'freeTransform', 'lasso', 'zoom', 'pan'] },
  { id: 'shape', label: 'Shape tools', tools: ['shape', 'smudge', 'roughen', 'twirl', 'attract', 'repel', 'smear', 'knife', 'eraser', 'crop'] },
  { id: 'zoom', label: 'Zoom tools', tools: ['zoom', 'pan'] },
  { id: 'curve', label: 'Curve tools', tools: ['freehand', 'line2', 'bezier', 'pen', 'bspline', 'polyline', 'curve3', 'liveSketch'] },
  { id: 'rectangle', label: 'Rectangle tools', tools: ['rectangle', 'rect3'] },
  { id: 'ellipse', label: 'Ellipse tools', tools: ['ellipse', 'ellipse3'] },
  { id: 'object', label: 'Object tools', tools: ['polygon', 'star', 'complexStar', 'graphPaper', 'spiral'] },
  { id: 'text', label: 'Text tools', tools: ['text', 'table'] },
  { id: 'effect', label: 'Interactive effects', tools: ['transparency', 'blend', 'contour', 'dropShadow', 'envelope', 'perspective', 'blockShadow'] },
  { id: 'fill', label: 'Fill tools', tools: ['fill', 'meshFill', 'smartFill', 'eyedropper'] },
  { id: 'media', label: 'Media & symmetry', tools: ['brush', 'variableOutline', 'symmetry'] },
  { id: 'photoSelect', label: 'Selection & masking', tools: ['maskBrush', 'cutout', 'bgRemove'] },
  { id: 'photoRetouch', label: 'Retouch', tools: ['liquify', 'clone', 'colorReplace', 'blurBrush', 'sharpenBrush', 'dodgeBrush', 'burnBrush', 'enhance'] },
  { id: 'photo', label: 'Photo corrections', tools: ['perspectiveCorrect'] },
]

/** The toolbox shows a primary tool per group plus a flyout with the rest. */
export const TOOLBOX_ORDER: ToolGroupID[] = [
  'pick', 'shape', 'zoom', 'curve', 'rectangle', 'ellipse', 'object', 'text', 'effect', 'fill', 'media', 'photoSelect', 'photoRetouch', 'photo',
]

export const PHOTO_TOOLS = new Set<ToolID>(Object.values(TOOLS).filter((t) => t.photo).map((t) => t.id))

export function toolDef(id: ToolID): ToolDef {
  return TOOLS[id] ?? TOOLS.pick
}

export function toolsInGroup(id: ToolGroupID): ToolDef[] {
  const group = TOOL_GROUPS.find((g) => g.id === id)
  if (!group) return []
  const seen = new Set<ToolID>()
  return group.tools
    .map((t) => TOOLS[t])
    .filter((t): t is ToolDef => {
      if (!t || seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
}

export function shortcutFor(id: ToolID): string {
  return TOOLS[id]?.shortcut ?? ''
}

/** Keyboard map used by the global handler. */
export const SHORTCUTS: Record<string, ToolID> = (() => {
  const map: Record<string, ToolID> = {}
  for (const def of Object.values(TOOLS)) {
    if (def.shortcut) {
      for (const key of def.shortcut.split('/')) map[key.toLowerCase()] = def.id
    }
  }
  return map
})()
