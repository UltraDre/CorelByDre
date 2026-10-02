import type { Matrix, PathData, PathNode, Rect, SceneObject, SubPath } from '../types'

/* ------------------------------------------------------------------ ids ---- */

let counter = 0
export function uid(prefix = 'o'): string {
  counter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`
}

/* ----------------------------------------------------------------- math ---- */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const TAU = Math.PI * 2
export const DEG = Math.PI / 180
export const round = (v: number, digits = 3) => {
  const f = 10 ** digits
  return Math.round(v * f) / f
}
export const nearly = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

export interface Vec { x: number; y: number }
export const v = (x: number, y: number): Vec => ({ x, y })
export const vAdd = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
export const vSub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
export const vScale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s })
export const vLen = (a: Vec) => Math.hypot(a.x, a.y)
export const vDist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)
export const vNorm = (a: Vec): Vec => {
  const l = vLen(a)
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}
export const vLerp = (a: Vec, b: Vec, t: number): Vec => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) })
export const vRotate = (a: Vec, rad: number): Vec => ({
  x: a.x * Math.cos(rad) - a.y * Math.sin(rad),
  y: a.x * Math.sin(rad) + a.y * Math.cos(rad),
})
export const vPerp = (a: Vec): Vec => ({ x: -a.y, y: a.x })

/* -------------------------------------------------------------- matrices --- */

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function matMul(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

export function matApply(m: Matrix, p: Vec): Vec {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

export function matInvert(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) return { ...IDENTITY }
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

export function matTranslate(x: number, y: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
}
export function matScale(sx: number, sy = sx): Matrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }
}
export function matRotate(rad: number): Matrix {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 }
}
export function matSkew(kx: number, ky: number): Matrix {
  return { a: 1, b: Math.tan(ky), c: Math.tan(kx), d: 1, e: 0, f: 0 }
}
/** Rotation/scale/skew about an arbitrary origin. */
export function matAbout(m: Matrix, origin: Vec): Matrix {
  return matMul(matTranslate(origin.x, origin.y), matMul(m, matTranslate(-origin.x, -origin.y)))
}

export function matToSvg(m: Matrix): string {
  return `matrix(${round(m.a, 6)},${round(m.b, 6)},${round(m.c, 6)},${round(m.d, 6)},${round(m.e, 4)},${round(m.f, 4)})`
}

export function matToArr(m: Matrix): [number, number, number, number, number, number] {
  return [m.a, m.b, m.c, m.d, m.e, m.f]
}

/** Decompose for the transform docker (rotation, scale, skew, translation). */
export function matDecompose(m: Matrix) {
  const scaleX = Math.hypot(m.a, m.b)
  const rotation = Math.atan2(m.b, m.a)
  const denom = scaleX || 1
  const skewX = Math.atan2(m.a * m.c + m.b * m.d, denom * denom)
  const scaleY = (m.a * m.d - m.b * m.c) / denom
  return { scaleX, scaleY, rotation, skewX, tx: m.e, ty: m.f }
}

export function composeTransform(t: {
  tx?: number; ty?: number; scaleX?: number; scaleY?: number
  rotation?: number; skewX?: number; skewY?: number; origin?: Vec
}): Matrix {
  let m = matTranslate(t.tx ?? 0, t.ty ?? 0)
  m = matMul(m, matScale(t.scaleX ?? 1, t.scaleY ?? (t.scaleX ?? 1)))
  if (t.skewX || t.skewY) m = matMul(m, matSkew(t.skewX ?? 0, t.skewY ?? 0))
  if (t.rotation) m = matMul(m, matRotate(t.rotation))
  if (t.origin) m = matAbout(m, t.origin)
  return m
}

/* --------------------------------------------------------------- rects ----- */

export const rectOf = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
export const rectNorm = (r: Rect): Rect => ({
  x: r.w < 0 ? r.x + r.w : r.x,
  y: r.h < 0 ? r.y + r.h : r.y,
  w: Math.abs(r.w),
  h: Math.abs(r.h),
})
export const rectUnion = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
export const rectContains = (r: Rect, p: Vec) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
export const rectIntersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
export const rectInflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 })
export const rectCenter = (r: Rect): Vec => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
export const rectFromPoints = (a: Vec, b: Vec): Rect => rectNorm({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y })

/* ---------------------------------------------------------------- paths ---- */

export function node(x: number, y: number, type: PathNode['type'] = 'sharp'): PathNode {
  return { x, y, inX: x, inY: y, outX: x, outY: y, type }
}

export function makeSmoothNode(x: number, y: number, inX: number, inY: number, outX: number, outY: number): PathNode {
  return { x, y, inX, inY, outX, outY, type: 'smooth' }
}

export const subPath = (nodes: PathNode[], closed = false): SubPath => ({ nodes, closed })

export function pathFromSubpaths(subpaths: SubPath[], fillRule: 'nonzero' | 'evenodd' = 'nonzero'): PathData {
  return { subpaths, fillRule }
}

/** Sample a cubic segment (used by renderers, exporters and hit-testing). */
export function cubicAt(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

export function cubicDeriv(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const mt = 1 - t
  return {
    x: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  }
}

/** Flatten a path to polylines (document units) for hit-testing and export. */
export function flattenPath(path: PathData, steps = 16, matrix?: Matrix): Vec[][] {
  const out: Vec[][] = []
  for (const sp of path.subpaths) {
    if (sp.nodes.length === 0) continue
    const pts: Vec[] = []
    const n = sp.nodes.length
    const push = (p: Vec) => pts.push(matrix ? matApply(matrix, p) : p)
    push({ x: sp.nodes[0].x, y: sp.nodes[0].y })
    const last = sp.closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const a = sp.nodes[i]
      const b = sp.nodes[(i + 1) % n]
      const p0 = { x: a.x, y: a.y }
      const p1 = { x: a.outX, y: a.outY }
      const p2 = { x: b.inX, y: b.inY }
      const p3 = { x: b.x, y: b.y }
      const straight = p1.x === p0.x && p1.y === p0.y && p2.x === p3.x && p2.y === p3.y
      if (straight) {
        push(p3)
      } else {
        for (let s = 1; s <= steps; s++) push(cubicAt(p0, p1, p2, p3, s / steps))
      }
    }
    out.push(pts)
  }
  return out
}

export function pathBounds(path: PathData, matrix?: Matrix): Rect | null {
  const polys = flattenPath(path, 12, matrix)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const poly of polys) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function pathToSvgD(path: PathData, transform?: Matrix, precision = 3): string {
  const parts: string[] = []
  for (const sp of path.subpaths) {
    const n = sp.nodes.length
    if (n === 0) continue
    const pt = (x: number, y: number) => {
      if (!transform) return `${round(x, precision)} ${round(y, precision)}`
      const p = matApply(transform, { x, y })
      return `${round(p.x, precision)} ${round(p.y, precision)}`
    }
    parts.push(`M ${pt(sp.nodes[0].x, sp.nodes[0].y)}`)
    const last = sp.closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const a = sp.nodes[i]
      const b = sp.nodes[(i + 1) % n]
      const straight = a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y
      if (straight) parts.push(`L ${pt(b.x, b.y)}`)
      else parts.push(`C ${pt(a.outX, a.outY)} ${pt(b.inX, b.inY)} ${pt(b.x, b.y)}`)
    }
    if (sp.closed) parts.push('Z')
  }
  return parts.join(' ')
}

/** Path2D (browser) from our model — used by every canvas painter. */
export function pathToPath2D(path: PathData, transform?: Matrix): Path2D {
  const p = new Path2D()
  for (const sp of path.subpaths) {
    const n = sp.nodes.length
    if (n === 0) continue
    const pt = (x: number, y: number) => (transform ? matApply(transform, { x, y }) : { x, y })
    const first = pt(sp.nodes[0].x, sp.nodes[0].y)
    p.moveTo(first.x, first.y)
    const last = sp.closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const a = sp.nodes[i]
      const b = sp.nodes[(i + 1) % n]
      const straight = a.outX === a.x && a.outY === a.y && b.inX === b.x && b.inY === b.y
      if (straight) {
        const q = pt(b.x, b.y)
        p.lineTo(q.x, q.y)
      } else {
        const c1 = pt(a.outX, a.outY)
        const c2 = pt(b.inX, b.inY)
        const q = pt(b.x, b.y)
        p.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, q.x, q.y)
      }
    }
    if (sp.closed) p.closePath()
  }
  return p
}

/** Build a path from a polyline, smoothing corners with Catmull-Rom → bezier fits. */
export function pathFromPoints(points: Vec[], closed = false, tension = 1): PathData {
  if (points.length < 2) return pathFromSubpaths([subPath(points.map((p) => node(p.x, p.y)), closed)])
  const nodes: PathNode[] = points.map((p) => node(p.x, p.y))
  for (let i = 0; i < nodes.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length]
    const next = points[(i + 1) % points.length]
    const cur = points[i]
    if (!closed && (i === 0 || i === points.length - 1)) continue
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    const k = tension / 6
    nodes[i].inX = cur.x - dx * k
    nodes[i].inY = cur.y - dy * k
    nodes[i].outX = cur.x + dx * k
    nodes[i].outY = cur.y + dy * k
    nodes[i].type = 'smooth'
  }
  return pathFromSubpaths([subPath(nodes, closed)])
}

/* --------------------------------------------------------- hit testing ----- */

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside
  }
  return inside
}

export function distToPolyline(p: Vec, poly: Vec[]): number {
  let best = Infinity
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i]
    const b = poly[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    t = clamp(t, 0, 1)
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    if (d < best) best = d
  }
  return best
}

/* ---------------------------------------------------------------- trees ---- */

export function walkObjects(objects: SceneObject[], fn: (o: SceneObject, parent?: SceneObject) => void, parent?: SceneObject): void {
  for (const o of objects) {
    fn(o, parent)
    if (o.kind === 'group') walkObjects(o.children, fn, o)
  }
}

export function findObject(objects: SceneObject[], id: string): SceneObject | null {
  for (const o of objects) {
    if (o.id === id) return o
    if (o.kind === 'group') {
      const found = findObject(o.children, id)
      if (found) return found
    }
  }
  return null
}

export function filterObjects(objects: SceneObject[], pred: (o: SceneObject) => boolean): SceneObject[] {
  const out: SceneObject[] = []
  walkObjects(objects, (o) => {
    if (pred(o)) out.push(o)
  })
  return out
}

/* ------------------------------------------------------------- strings ----- */

export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 10 ** digits) / 10 ** digits
  return String(r)
}

const UNIT_FACTORS: Record<string, number> = { pt: 1, mm: 25.4 / 72, in: 1 / 72, px: 96 / 72, cm: 2.54 / 72, pica: 1 / 12 }

export function toDisplay(pts: number, unit: string): number {
  return pts / (UNIT_FACTORS[unit] ?? 1)
}
export function fromDisplay(value: number, unit: string): number {
  return value * (UNIT_FACTORS[unit] ?? 1)
}
export function unitLabel(unit: string): string {
  return unit === 'in' ? '"' : unit
}

export function parseNumber(input: string, unit = 'pt'): number {
  const trimmed = input.trim().toLowerCase()
  const m = trimmed.match(/^(-?[\d.]+)\s*(pt|mm|cm|in|px|pc|")?$/)
  if (!m) return NaN
  const n = Number(m[1])
  const u = m[2] === '"' ? 'in' : m[2] || unit
  return (n * (UNIT_FACTORS[u] ?? 1))
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled'
}

/* ---------------------------------------------------------------- rng ------ */

/** Deterministic PRNG (mulberry32) — brushes and textures must be reproducible. */
export function makeRng(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* --------------------------------------------------------------- misc ------ */

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ka = Object.keys(ao)
    if (ka.length !== Object.keys(bo).length) return false
    return ka.every((k) => deepEqual(ao[k], bo[k]))
  }
  return false
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export function debounce<F extends (...args: never[]) => void>(fn: F, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...args: Parameters<F>) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

export function throttle<F extends (...args: never[]) => void>(fn: F, ms: number) {
  let last = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  return (...args: Parameters<F>) => {
    const now = performance.now()
    if (now - last >= ms) {
      last = now
      fn(...args)
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = undefined
        last = performance.now()
        fn(...args)
      }, ms - (now - last))
    }
  }
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl'
