/**
 * Live tool options (shape counts, stroke widths, brush preset, photo brush
 * settings). Kept outside React so the canvas can read them every frame, with a
 * tiny subscription so the property bar stays in sync.
 */
import { useSyncExternalStore } from 'react'
import type { LiquifyMode } from '../lib/photo'
import type { RetouchTool } from '../lib/photo'

export interface ToolOptions {
  /* geometry */
  polygonSides: number
  starPoints: number
  starSharpness: number
  complexStarPoints: number
  complexStarSharpness: number
  spiralRevolutions: number
  spiralDivergence: number
  spiralSymmetrical: boolean
  graphCols: number
  graphRows: number
  rectCorner: number
  ellipsePie: 'pie' | 'chord' | 'arc'
  ellipseStart: number
  ellipseEnd: number
  /* curves */
  freehandSmoothing: number
  brushWidth: number
  brushPreset: string
  brushPressure: boolean
  variableWidth: number
  /* effects */
  distortRadius: number
  distortStrength: number
  transparency: number
  blendMode: string
  contourSteps: number
  contourOffset: number
  shadowDx: number
  shadowDy: number
  shadowBlur: number
  blockShadowSteps: number
  /* symmetry */
  symmetryEnabled: boolean
  symmetryMode: 'mirror' | 'radial' | 'kaleidoscope'
  symmetryCount: number
  /* photo */
  photoRadius: number
  photoHardness: number
  photoOpacity: number
  photoStrength: number
  liquifyMode: LiquifyMode
  retouchTool: RetouchTool
  maskMode: 'paint' | 'erase'
  colorReplaceFrom: string
  colorReplaceTo: string
  colorReplaceTolerance: number
  /* text */
  textFont: string
  textSize: number
  textAlign: 'left' | 'center' | 'right' | 'justify' | 'force'
  textBold: boolean
  textItalic: boolean
  textLineHeight: number
  textLetterSpacing: number
}

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  polygonSides: 6,
  starPoints: 5,
  starSharpness: 0.5,
  complexStarPoints: 7,
  complexStarSharpness: 0.7,
  spiralRevolutions: 4,
  spiralDivergence: 1,
  spiralSymmetrical: false,
  graphCols: 6,
  graphRows: 6,
  rectCorner: 0,
  ellipsePie: 'pie',
  ellipseStart: 0,
  ellipseEnd: 360,
  freehandSmoothing: 0.5,
  brushWidth: 8,
  brushPreset: 'marker-round',
  brushPressure: true,
  variableWidth: 6,
  distortRadius: 60,
  distortStrength: 0.5,
  transparency: 0.6,
  blendMode: 'multiply',
  contourSteps: 3,
  contourOffset: 8,
  shadowDx: 8,
  shadowDy: 8,
  shadowBlur: 12,
  blockShadowSteps: 6,
  symmetryEnabled: false,
  symmetryMode: 'mirror',
  symmetryCount: 6,
  photoRadius: 40,
  photoHardness: 0.5,
  photoOpacity: 0.85,
  photoStrength: 0.5,
  liquifyMode: 'push',
  retouchTool: 'smudge',
  maskMode: 'paint',
  colorReplaceFrom: '#c8102e',
  colorReplaceTo: '#0057b8',
  colorReplaceTolerance: 40,
  textFont: 'Inter',
  textSize: 24,
  textAlign: 'left',
  textBold: false,
  textItalic: false,
  textLineHeight: 1.2,
  textLetterSpacing: 0,
}

let options: ToolOptions = { ...DEFAULT_TOOL_OPTIONS }
const listeners = new Set<() => void>()

export function toolOptions(): ToolOptions {
  return options
}

export function setToolOptions(patch: Partial<ToolOptions>): void {
  options = { ...options, ...patch }
  listeners.forEach((fn) => fn())
}

export function resetToolOptions(): void {
  options = { ...DEFAULT_TOOL_OPTIONS }
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useToolOptions(): ToolOptions {
  return useSyncExternalStore(subscribe, toolOptions, toolOptions)
}
