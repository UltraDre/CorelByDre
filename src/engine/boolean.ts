/**
 * Boolean path operations, curve smoothing and path simplification backed by
 * Paper.js (as specified in the project tech stack). Paper is loaded lazily so
 * the editor boots without paying for it, and every entry point degrades to a
 * pure-geometry fallback if the library fails to load.
 */
import type { PathData, SubPath } from '../types'
import { flattenPath, node, pathFromSubpaths, subPath, type Vec } from '../lib/util'

type PaperModule = typeof import('paper')

let paperPromise: Promise<PaperModule | null> | null = null

/** Paper.js needs a canvas scope; a detached one is enough for pure path maths. */
async function getPaper(): Promise<PaperModule | null> {
  if (paperPromise) return paperPromise
  paperPromise = (async () => {
    try {
      const mod = (await import('paper')) as unknown as PaperModule & { default?: PaperModule }
      const paper = (mod.default ?? mod) as PaperModule
      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        paper.setup(canvas)
      }
      return paper
    } catch (error) {
      console.warn('[paper] unavailable, using geometry fallbacks:', error)
      return null
    }
  })()
  return paperPromise
}

export type BooleanOp = 'unite' | 'subtract' | 'intersect' | 'exclude' | 'divide'

type PaperItem = any

function toPaperPath(paper: PaperModule, path: PathData): PaperItem {
  const compound = new paper.CompoundPath({})
  for (const sp of path.subpaths) {
    const p = new paper.Path()
    if (!sp.nodes.length) continue
    p.moveTo(new paper.Point(sp.nodes[0].x, sp.nodes[0].y))
    const n = sp.nodes.length
    const last = sp.closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const a = sp.nodes[i]
      const b = sp.nodes[(i + 1) % n]
      const straight = a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y
      if (straight) p.lineTo(new paper.Point(b.x, b.y))
      else p.cubicCurveTo(
        new paper.Point(a.outX, a.outY),
        new paper.Point(b.inX, b.inY),
        new paper.Point(b.x, b.y),
      )
    }
    if (sp.closed) p.closePath()
    p.fillRule = path.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
    compound.addChild(p)
  }
  compound.fillRule = path.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
  return compound
}

function fromPaperPath(paperItem: unknown): PathData {
  const paths: unknown[] = []
  const collect = (item: any) => {
    if (!item) return
    if (item.className === 'CompoundPath' || item.children) {
      for (const child of item.children ?? []) collect(child)
    } else if (item.segments) {
      paths.push(item)
    }
  }
  collect(paperItem)
  const subpaths: SubPath[] = []
  for (const raw of paths as any[]) {
    const segments = raw.segments ?? []
    if (!segments.length) continue
    const nodes = segments.map((seg: any, i: number) => {
      const cur = seg.point
      const prevHandle = seg.handleIn
      const nextHandle = seg.handleOut
      const inP = { x: cur.x + (prevHandle?.x ?? 0), y: cur.y + (prevHandle?.y ?? 0) }
      const outP = { x: cur.x + (nextHandle?.x ?? 0), y: cur.y + (nextHandle?.y ?? 0) }
      const hasHandles = Boolean(prevHandle?.x || prevHandle?.y || nextHandle?.x || nextHandle?.y)
      void i
      return {
        x: cur.x as number,
        y: cur.y as number,
        inX: inP.x,
        inY: inP.y,
        outX: outP.x,
        outY: outP.y,
        type: (hasHandles ? 'smooth' : 'sharp') as 'smooth' | 'sharp',
      }
    })
    subpaths.push(subPath(nodes, Boolean(raw.closed)))
  }
  return pathFromSubpaths(subpaths)
}

/** Concatenate several paths into one (for boolean input). */
export function combinePaths(paths: PathData[]): PathData {
  return pathFromSubpaths(paths.flatMap((p) => p.subpaths), paths[0]?.fillRule ?? 'nonzero')
}

/**
 * Apply a boolean operation. `a` and `b` must already be in the same coordinate
 * space (callers bake transforms first).
 */
export async function booleanPath(a: PathData, b: PathData, op: BooleanOp): Promise<PathData | null> {
  const paper = await getPaper()
  if (!paper) return null
  try {
    const pa = toPaperPath(paper, a)
    const pb = toPaperPath(paper, b)
    let result: unknown
    switch (op) {
      case 'unite': result = pa.unite(pb); break
      case 'subtract': result = pa.subtract(pb); break
      case 'intersect': result = pa.intersect(pb); break
      case 'exclude': result = pa.exclude(pb); break
      case 'divide': result = pa.divide(pb); break
      default: result = pa
    }
    const out = fromPaperPath(result)
    ;(result as { remove?: () => void })?.remove?.()
    pa.remove?.()
    pb.remove?.()
    return out.subpaths.length ? out : null
  } catch (error) {
    console.warn('[paper] boolean op failed:', error)
    return null
  }
}

/** Curve smoothing that keeps the node count sane (LiveSketch / Vector Smoothing). */
export async function smoothPath(path: PathData, tolerance = 2): Promise<PathData | null> {
  const paper = await getPaper()
  if (!paper) return null
  try {
    const p: PaperItem = toPaperPath(paper, path)
    const simplified: PaperItem = p.simplify(Math.max(0.1, tolerance))
    simplified.smooth({ type: 'continuous' })
    const out = fromPaperPath(simplified)
    simplified.remove?.()
    p.remove?.()
    return out.subpaths.length ? out : null
  } catch {
    return null
  }
}

/** Reduce node count without changing the shape appreciably. */
export async function simplifyPath(path: PathData, tolerance = 1.5): Promise<PathData | null> {
  const paper = await getPaper()
  if (!paper) return null
  try {
    const p = toPaperPath(paper, path)
    p.simplify(Math.max(0.1, tolerance))
    const out = fromPaperPath(p)
    p.remove?.()
    return out.subpaths.length ? out : null
  } catch {
    return null
  }
}

/** Reshape / roughen / twirl etc. via Paper's segment-level methods. */
export async function paperDistort(path: PathData, kind: 'roughen' | 'smooth' | 'flatten', amount: number): Promise<PathData | null> {
  const paper = await getPaper()
  if (!paper) return null
  try {
    const p: PaperItem = toPaperPath(paper, path)
    if (kind === 'roughen') p.roughen(Math.max(0.5, amount * 12), Math.max(0.5, amount * 8))
    else if (kind === 'smooth') p.smooth({ type: 'continuous' })
    else p.flatten(Math.max(0.5, amount * 20))
    const out = fromPaperPath(p)
    p.remove?.()
    return out.subpaths.length ? out : null
  } catch {
    return null
  }
}

/** Fit a smooth curve through a raw point stream (used by tracing and LiveSketch). */
export async function fitCurve(points: Vec[], closed: boolean, tolerance: number): Promise<PathData | null> {
  const paper = await getPaper()
  if (!paper || points.length < 2) return null
  try {
    const p = new paper.Path()
    p.moveTo(new paper.Point(points[0].x, points[0].y))
    for (const pt of points.slice(1)) p.lineTo(new paper.Point(pt.x, pt.y))
    if (closed) p.closePath()
    p.simplify(tolerance)
    p.smooth({ type: 'continuous' })
    const out = fromPaperPath(p)
    p.remove?.()
    return out.subpaths.length ? out : null
  } catch {
    return null
  }
}

/** Fallback boolean when Paper.js is unavailable: bounding-box level behaviour. */
export function fallbackBoolean(a: PathData, b: PathData, op: BooleanOp): PathData | null {
  const loopsA = flattenPath(a, 8)
  const loopsB = flattenPath(b, 8)
  if (op === 'unite') {
    const subpaths: SubPath[] = []
    for (const loop of [...loopsA, ...loopsB]) {
      subpaths.push(subPath(loop.map((p) => node(p.x, p.y)), true))
    }
    return pathFromSubpaths(subpaths)
  }
  // intersect / subtract / divide cannot be done reliably without a clipper, so
  // we report failure and the caller keeps the original objects.
  return null
}
