import type { Envelope, PathData, PathNode, Primitive, Rect, SubPath, SymmetrySettings } from '../types'
import {
  DEG, TAU, clamp, cubicAt, flattenPath, makeSmoothNode, matApply, node, pathFromPoints, pathFromSubpaths,
  rectCenter, subPath, v, vLerp, vNorm, vPerp, vDist, type Vec,
} from '../lib/util'

/* ------------------------------------------------------- primitive shapes -- */

export function rectPath(w: number, h: number, r = 0, corners: [number, number, number, number] = [1, 1, 1, 1]): PathData {
  const radius = clamp(r, 0, Math.min(w, h) / 2)
  const [tl, tr, br, bl] = corners
  const nodes: PathNode[] = []
  const corner = (x: number, y: number, k: number, from: Vec, to: Vec) => {
    if (radius <= 0 || k <= 0) {
      nodes.push(node(x, y))
      return
    }
    const rr = radius * k
    const a = vLerp(v(x, y), from, clamp(rr / Math.max(1e-6, vDist(v(x, y), from)), 0, 1))
    const b = vLerp(v(x, y), to, clamp(rr / Math.max(1e-6, vDist(v(x, y), to)), 0, 1))
    // Approximate the arc with two cubic segments for a clean circular corner.
    const c1 = vLerp(a, v(x, y), 0.5523)
    const c2 = vLerp(b, v(x, y), 0.5523)
    nodes.push(node(a.x, a.y))
    nodes.push(makeSmoothNode(x, y, c1.x, c1.y, c2.x, c2.y))
    nodes.push(node(b.x, b.y))
  }
  corner(w, 0, tr, v(w, h), v(0, 0))
  corner(w, h, br, v(0, h), v(w, 0))
  corner(0, h, bl, v(0, 0), v(0, h))
  corner(0, 0, tl, v(w, 0), v(0, h))
  return pathFromSubpaths([subPath(dedupe(nodes), true)])
}

export function ellipsePath(rx: number, ry: number, start = 0, end = 360, pieMode: 'pie' | 'chord' | 'arc' = 'pie'): PathData {
  const full = Math.abs(end - start) >= 359.999
  const k = 0.5522847498307936
  if (full) {
    const nodes = [
      makeSmoothNode(0, -ry, -rx * k, -ry, rx * k, -ry),
      makeSmoothNode(rx, 0, rx, -ry * k, rx, ry * k),
      makeSmoothNode(0, ry, rx * k, ry, -rx * k, ry),
      makeSmoothNode(-rx, 0, -rx, ry * k, -rx, -ry * k),
    ]
    return pathFromSubpaths([subPath(nodes, true)])
  }
  const a0 = start * DEG
  const a1 = end * DEG
  const n = Math.max(1, Math.ceil(Math.abs(end - start) / 45))
  const nodes: PathNode[] = []
  const at = (a: number) => v(rx * Math.cos(a), ry * Math.sin(a))
  const tan = (a: number) => v(-rx * Math.sin(a), ry * Math.cos(a))
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    const p = at(a)
    const t = tan(a)
    const seg = Math.abs(a1 - a0) / n
    const h = (4 / 3) * Math.tan(seg / 4)
    nodes.push(makeSmoothNode(p.x, p.y, p.x - t.x * h, p.y - t.y * h, p.x + t.x * h, p.y + t.y * h))
  }
  if (pieMode === 'pie') nodes.push(node(0, 0))
  else if (pieMode === 'chord') {
    const a = at(a0)
    const b = at(a1)
    if (vDist(a, b) > 1e-6) nodes.push(node(0, 0))
  }
  return pathFromSubpaths([subPath(nodes, true)])
}

export function polygonPath(sides: number, radius: number, sharp = true): PathData {
  const n = Math.max(3, Math.round(sides))
  const nodes: PathNode[] = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (TAU * i) / n
    nodes.push(node(radius * Math.cos(a), radius * Math.sin(a)))
  }
  if (sharp) return pathFromSubpaths([subPath(nodes, true)])
  return smoothClosedPath(nodes, 0.28)
}

export function starPath(points: number, radius: number, innerRadius: number, sharpness = 1): PathData {
  const n = Math.max(3, Math.round(points))
  const nodes: PathNode[] = []
  const inner = innerRadius <= 1 ? clamp(innerRadius, 0, 1) * radius : Math.min(radius, innerRadius)
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / n
    const r = i % 2 === 0 ? radius : inner
    nodes.push(node(r * Math.cos(a), r * Math.sin(a)))
  }
  if (sharpness >= 1) return pathFromSubpaths([subPath(nodes, true)])
  // Rounded star: blend each corner toward a circular arc.
  const smoothed = nodes.map((nd, i) => {
    const prev = nodes[(i - 1 + nodes.length) % nodes.length]
    const next = nodes[(i + 1) % nodes.length]
    const t = (1 - sharpness) * 0.42
    return makeSmoothNode(
      nd.x, nd.y,
      nd.x + (prev.x - nd.x) * t, nd.y + (prev.y - nd.y) * t,
      nd.x + (next.x - nd.x) * t, nd.y + (next.y - nd.y) * t,
    )
  })
  return pathFromSubpaths([subPath(smoothed, true)])
}

export function spiralPath(revolutions: number, radius: number, divergence = 1, symmetrical = false): PathData {
  const revs = Math.max(0.25, revolutions)
  const steps = Math.max(24, Math.round(revs * 48))
  const pts: Vec[] = []
  const exponent = symmetrical ? 1 : clamp(divergence, 0.2, 4)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = t * revs * TAU
    const r = radius * (symmetrical ? t : t ** exponent)
    pts.push(v(r * Math.cos(a), r * Math.sin(a)))
  }
  // Resample to a compact node list using the one-euro smoother's output shape.
  const simplified = rdp(pts, radius * 0.004)
  return pathFromPoints(simplified, false, 0.9)
}

export function graphPaperPath(cols: number, rows: number, w: number, h: number): PathData {
  const subpaths: SubPath[] = []
  const cw = w / cols
  const ch = h / rows
  for (let r = 0; r <= rows; r++) {
    subpaths.push(subPath([node(0, r * ch), node(w, r * ch)], false))
  }
  for (let c = 0; c <= cols; c++) {
    subpaths.push(subPath([node(c * cw, 0), node(c * cw, h)], false))
  }
  return pathFromSubpaths(subpaths)
}

/** 3-point rectangle: base line + drag distance defines the perpendicular extent. */
export function threePointRect(p1: Vec, p2: Vec, p3: Vec): PathData {
  const dir = vNorm({ x: p2.x - p1.x, y: p2.y - p1.y })
  const nrm = vPerp(dir)
  const d = (p3.x - p2.x) * nrm.x + (p3.y - p2.y) * nrm.y
  const c1 = v(p1.x + nrm.x * d, p1.y + nrm.y * d)
  const c2 = v(p2.x + nrm.x * d, p2.y + nrm.y * d)
  return pathFromSubpaths([subPath([node(p1.x, p1.y), node(p2.x, p2.y), node(c2.x, c2.y), node(c1.x, c1.y)], true)])
}

/** 3-point ellipse: base line = major axis, third point = minor radius. */
export function threePointEllipse(p1: Vec, p2: Vec, p3: Vec): PathData {
  const cx = (p1.x + p2.x) / 2
  const cy = (p1.y + p2.y) / 2
  const rx = vDist(p1, p2) / 2
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
  const d = vNorm({ x: p2.x - p1.x, y: p2.y - p1.y })
  const nrm = vPerp(d)
  const ry = Math.abs((p3.x - cx) * nrm.x + (p3.y - cy) * nrm.y)
  const base = ellipsePath(rx, Math.max(ry, 0.1))
  return transformPath(base, { a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle), e: cx, f: cy })
}

export function primitiveToPath(p: Primitive, size?: { w: number; h: number }): PathData {
  switch (p.type) {
    case 'rect': return rectPath(p.w, p.h, p.r, p.corners)
    case 'ellipse': return ellipsePath(p.rx, p.ry, p.start, p.end, p.pieMode)
    case 'polygon': return polygonPath(p.sides, p.radius, p.sharp)
    case 'star': return starPath(p.points, p.radius, p.innerRadius, p.sharpness)
    case 'spiral': return spiralPath(p.revolutions, p.radius, p.divergence, p.symmetrical)
    case 'graphPaper': return graphPaperPath(p.cols, p.rows, p.w, p.h)
    case 'line': return pathFromSubpaths([subPath([node(0, 0), node(p.x2, p.y2)], false)])
    default: return size ? rectPath(size.w, size.h) : rectPath(1, 1)
  }
}

/* ------------------------------------------------------------ path utils --- */

export function transformPath(path: PathData, m: { a: number; b: number; c: number; d: number; e: number; f: number }): PathData {
  return {
    fillRule: path.fillRule,
    subpaths: path.subpaths.map((sp) => ({
      closed: sp.closed,
      nodes: sp.nodes.map((n) => {
        const p = matApply(m as never, { x: n.x, y: n.y })
        const i = matApply(m as never, { x: n.inX, y: n.inY })
        const o = matApply(m as never, { x: n.outX, y: n.outY })
        return { ...n, x: p.x, y: p.y, inX: i.x, inY: i.y, outX: o.x, outY: o.y }
      }),
    })),
  }
}

function dedupe(nodes: PathNode[]): PathNode[] {
  const out: PathNode[] = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - n.x) < 1e-6 && Math.abs(last.y - n.y) < 1e-6) continue
    out.push(n)
  }
  return out.length ? out : nodes
}

export function smoothClosedPath(nodes: PathNode[], tension = 0.28): PathData {
  const out = nodes.map((nd, i) => {
    const prev = nodes[(i - 1 + nodes.length) % nodes.length]
    const next = nodes[(i + 1) % nodes.length]
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    return makeSmoothNode(nd.x, nd.y, nd.x - dx * tension, nd.y - dy * tension, nd.x + dx * tension, nd.y + dy * tension)
  })
  return pathFromSubpaths([subPath(out, true)])
}

/** Ramer-Douglas-Peucker on a polyline. */
export function rdp(points: Vec[], epsilon: number): Vec[] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    if (e <= s + 1) continue
    const a = points[s]
    const b = points[e]
    const vx = b.x - a.x
    const vy = b.y - a.y
    const len2 = vx * vx + vy * vy
    let maxD = -1
    let maxI = -1
    for (let i = s + 1; i < e; i++) {
      const p = points[i]
      let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
      t = clamp(t, 0, 1)
      const d = Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1
      stack.push([s, maxI], [maxI, e])
    }
  }
  const out: Vec[] = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}

/** Catmull-Rom spline refinement of a polyline (used by LiveSketch + smoothing). */
export function refineCurve(points: Vec[], tension = 1, closed = false): PathData {
  const cleaned = rdp(points, 0.6)
  return pathFromPoints(cleaned, closed, tension)
}

/* ------------------------------------------------------------ offsets ------ */

/**
 * Path offsetting for the Contour tool and variable outlines: sample the path,
 * push each sample along its normal, then rebuild a smoothed path.
 */
export function offsetPath(path: PathData, distance: number, quality = 12): PathData {
  const loops = flattenPath(path, quality)
  const out: SubPath[] = []
  for (const loop of loops) {
    const pts: Vec[] = []
    for (let i = 0; i < loop.length; i++) {
      const prev = loop[(i - 1 + loop.length) % loop.length]
      const next = loop[(i + 1) % loop.length]
      const dir = vNorm({ x: next.x - prev.x, y: next.y - prev.y })
      const nrm = vPerp(dir)
      pts.push({ x: loop[i].x + nrm.x * distance, y: loop[i].y + nrm.y * distance })
    }
    const simplified = rdp(pts, Math.max(0.25, Math.abs(distance) * 0.02))
    const built = pathFromPoints(simplified, true, 0.9)
    out.push(...built.subpaths)
  }
  return pathFromSubpaths(out, path.fillRule)
}

/** Variable outline: apply a width profile to a path by generating an outline shape. */
export function variableOutline(path: PathData, baseWidth: number, profile: number[]): PathData {
  const loops = flattenPath(path, 16)
  const out: SubPath[] = []
  for (const loop of loops) {
    const left: Vec[] = []
    const right: Vec[] = []
    const n = loop.length
    for (let i = 0; i < n; i++) {
      const prev = loop[(i - 1 + n) % n]
      const next = loop[(i + 1) % n]
      const dir = vNorm({ x: next.x - prev.x, y: next.y - prev.y })
      const nrm = vPerp(dir)
      const t = n <= 1 ? 0 : i / (n - 1)
      const w = (baseWidth / 2) * sampleProfile(profile, t)
      left.push({ x: loop[i].x + nrm.x * w, y: loop[i].y + nrm.y * w })
      right.push({ x: loop[i].x - nrm.x * w, y: loop[i].y - nrm.y * w })
    }
    const poly = [...left, ...right.reverse()]
    out.push(...pathFromPoints(rdp(poly, 0.4), true, 0.9).subpaths)
  }
  return pathFromSubpaths(out)
}

export function sampleProfile(profile: number[], t: number): number {
  if (!profile.length) return 1
  const x = clamp(t, 0, 1) * (profile.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = profile[i]
  const b = profile[Math.min(profile.length - 1, i + 1)]
  return a + (b - a) * f
}

/* ------------------------------------------------------------ envelopes ---- */

export const ENVELOPE_PRESETS: { id: string; label: string; grid: (rows: number, cols: number) => { x: number; y: number }[]; rows: number; cols: number }[] = [
  {
    id: 'arc-up', label: 'Arc up', rows: 1, cols: 4,
    grid: (_r, cols) => Array.from({ length: 5 }, (_, i) => ({ x: 0, y: -Math.sin((i / cols) * Math.PI) * 0.28 })),
  },
  {
    id: 'arc-down', label: 'Arc down', rows: 1, cols: 4,
    grid: (_r, cols) => Array.from({ length: 5 }, (_, i) => ({ x: 0, y: Math.sin((i / cols) * Math.PI) * 0.28 })),
  },
  {
    id: 'wave', label: 'Wave', rows: 1, cols: 6,
    grid: (_r, cols) => Array.from({ length: 7 }, (_, i) => ({ x: 0, y: Math.sin((i / cols) * TAU) * 0.18 })),
  },
  {
    id: 'fish-eye', label: 'Fisheye', rows: 2, cols: 2,
    grid: () => [
      { x: 0, y: -0.22 }, { x: 0, y: -0.22 }, { x: 0, y: -0.22 },
      { x: -0.12, y: 0 }, { x: -0.3, y: 0 }, { x: 0.12, y: 0 },
      { x: 0, y: 0.22 }, { x: 0, y: 0.22 }, { x: 0, y: 0.22 },
    ],
  },
  {
    id: 'bulge', label: 'Bulge', rows: 2, cols: 2,
    grid: () => [
      { x: 0.08, y: 0.14 }, { x: 0, y: 0.1 }, { x: -0.08, y: 0.14 },
      { x: 0.12, y: 0 }, { x: 0, y: -0.16 }, { x: -0.12, y: 0 },
      { x: 0.08, y: -0.14 }, { x: 0, y: -0.1 }, { x: -0.08, y: -0.14 },
    ],
  },
  {
    id: 'perspective-top', label: 'Perspective (top)', rows: 2, cols: 2,
    grid: () => [
      { x: 0.24, y: 0 }, { x: 0.12, y: 0.05 }, { x: -0.24, y: 0 },
      { x: 0.12, y: 0 }, { x: 0, y: 0.02 }, { x: -0.12, y: 0 },
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    ],
  },
  {
    id: 'skew-left', label: 'Skew left', rows: 1, cols: 2,
    grid: () => [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0.3, y: 0 },
      { x: 0, y: 0 }, { x: 0.15, y: 0 }, { x: 0.3, y: 0 },
    ],
  },
  {
    id: 'bend-right', label: 'Bend right', rows: 1, cols: 3,
    grid: (_r, cols) => Array.from({ length: 4 }, (_, i) => ({ x: (i / cols) * (i / cols) * 0.3, y: 0 })),
  },
]

export function envelopePreset(id: string): Envelope {
  const preset = ENVELOPE_PRESETS.find((p) => p.id === id) ?? ENVELOPE_PRESETS[0]
  return { preset: preset.id, rows: preset.rows, cols: preset.cols, grid: preset.grid(preset.rows, preset.cols), strength: 1 }
}

/** Bilinear envelope deformation of a path, in the path's own bounding box space. */
export function applyEnvelope(path: PathData, env: Envelope): PathData {
  const pts = flattenPath(path, 10)
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const loop of pts) for (const p of loop) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  const w = Math.max(1e-6, maxX - minX)
  const h = Math.max(1e-6, maxY - minY)
  const warp = (p: Vec): Vec => {
    const u = (p.x - minX) / w
    const vv = (p.y - minY) / h
    const d = sampleEnvelope(env, u, vv)
    return { x: p.x + d.x * w * env.strength, y: p.y + d.y * h * env.strength }
  }
  const out: SubPath[] = []
  for (const loop of pts) {
    const warped = loop.map(warp)
    out.push(...pathFromPoints(rdp(warped, 0.3), true, 0.9).subpaths)
  }
  return pathFromSubpaths(out, path.fillRule)
}

export function sampleEnvelope(env: Envelope, u: number, v: number): { x: number; y: number } {
  const cols = env.cols
  const rows = env.rows
  const gx = clamp(u, 0, 1) * cols
  const gy = clamp(v, 0, 1) * rows
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const x1 = Math.min(cols, x0 + 1)
  const y1 = Math.min(rows, y0 + 1)
  const fx = gx - x0
  const fy = gy - y0
  const at = (cx: number, cy: number) => env.grid[clamp(cy, 0, rows) * (cols + 1) + clamp(cx, 0, cols)] ?? { x: 0, y: 0 }
  const a = at(x0, y0)
  const b = at(x1, y0)
  const c = at(x0, y1)
  const d = at(x1, y1)
  return {
    x: (a.x * (1 - fx) + b.x * fx) * (1 - fy) + (c.x * (1 - fx) + d.x * fx) * fy,
    y: (a.y * (1 - fx) + b.y * fx) * (1 - fy) + (c.y * (1 - fx) + d.y * fx) * fy,
  }
}

/* ------------------------------------------------------------ symmetry ----- */

/**
 * Replicate a path according to symmetry settings (CorelDRAW's Symmetry drawing
 * mode). The original is one instance; mirrors are generated deterministically.
 */
export function symmetryTransforms(sym: SymmetrySettings): { a: number; b: number; c: number; d: number; e: number; f: number }[] {
  const out: { a: number; b: number; c: number; d: number; e: number; f: number }[] = []
  const { center, mode, mirrors } = sym
  const mirrorX = (): typeof out[number] => ({ a: -1, b: 0, c: 0, d: 1, e: center.x * 2, f: 0 })
  const mirrorY = (): typeof out[number] => ({ a: 1, b: 0, c: 0, d: -1, e: 0, f: center.y * 2 })
  if (mode === 'none') return out
  if (mode === 'mirror-x') out.push(mirrorX())
  else if (mode === 'mirror-y') out.push(mirrorY())
  else {
    const n = Math.max(2, Math.round(mirrors))
    for (let i = 1; i < n; i++) {
      const ang = (TAU * i) / n
      const cos = Math.cos(ang)
      const sin = Math.sin(ang)
      out.push({
        a: cos, b: sin, c: -sin, d: cos,
        e: center.x - cos * center.x + sin * center.y,
        f: center.y - sin * center.x - cos * center.y,
      })
      if (mode === 'kaleidoscope' && sym.reflect) {
        out.push({
          a: cos * -1, b: sin, c: sin * 1, d: cos,
          e: center.x + cos * center.x - sin * center.y,
          f: center.y - sin * center.x - cos * center.y,
        })
      }
    }
  }
  return out
}

/* --------------------------------------------------------- perspective ----- */

/**
 * Perspective drawing: map a point from the "drawing plane" onto one of the
 * three faces defined by two vanishing points (CorelDRAW's 2-point perspective).
 * Pure projection maths — no estimation.
 */
export function perspectiveProject(
  p: Vec,
  origin: Vec,
  axisX: Vec,
  axisY: Vec,
  vp: Vec,
): Vec {
  // Ray from the vanishing point through the point's projection onto the axis.
  const denomX = vp.x - origin.x || 1e-6
  const denomY = vp.y - origin.y || 1e-6
  const t = ((p.x - origin.x) * axisX.y - (p.y - origin.y) * axisX.x) / (axisY.x * axisX.y - axisY.y * axisX.x || 1e-6)
  const u = ((p.x - origin.x) * axisY.y - (p.y - origin.y) * axisY.x) / (axisX.x * axisY.y - axisX.y * axisY.x || 1e-6)
  const scale = 1 / (1 + t * 0.35 + u * 0.35 * ((vp.x - origin.x) / denomX) * ((vp.y - origin.y) / denomY) * 0)
  return { x: origin.x + (p.x - origin.x) * scale, y: origin.y + (p.y - origin.y) * scale }
}

/** Sample a homography from four source points to four destination points. */
export function homographyFromQuad(src: Vec[], dst: Vec[]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: X, y: Y } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y])
    b.push(X)
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y])
    b.push(Y)
  }
  // Gaussian elimination with partial pivoting.
  const n = 8
  for (let i = 0; i < n; i++) {
    let pivot = i
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r
    ;[A[i], A[pivot]] = [A[pivot], A[i]]
    ;[b[i], b[pivot]] = [b[pivot], b[i]]
    const pv = A[i][i] || 1e-12
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / pv
      if (!f) continue
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]
      b[r] -= f * b[i]
    }
  }
  const h = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i]
    for (let c = i + 1; c < n; c++) sum -= A[i][c] * h[c]
    h[i] = sum / (A[i][i] || 1e-12)
  }
  return [...h, 1]
}

/* ----------------------------------------------------------- shaping ------- */

/** Convex/concave hull for the "Bounding box from shape" and lasso helpers. */
export function convexHull(points: Vec[]): Vec[] {
  if (points.length < 3) return points
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Vec[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Vec[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

export function pathUnionBounds(paths: PathData[]): Rect | null {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const p of paths) {
    for (const loop of flattenPath(p, 6)) {
      for (const q of loop) {
        minX = Math.min(minX, q.x); minY = Math.min(minY, q.y)
        maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y)
      }
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Distribute points evenly between two positions (used by graph paper & fills). */
export function linspace(a: number, b: number, count: number): number[] {
  if (count <= 1) return [a]
  return Array.from({ length: count }, (_, i) => a + ((b - a) * i) / (count - 1))
}

/** Split a path into individual subpaths (Break Apart). */
export function breakApart(path: PathData): PathData[] {
  return path.subpaths.map((sp) => pathFromSubpaths([sp], path.fillRule))
}

/** Join subpaths whose endpoints are within `tolerance`. */
export function joinSubpaths(path: PathData, tolerance: number): PathData {
  const subs = path.subpaths.map((s) => ({ ...s, nodes: [...s.nodes] }))
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < subs.length; i++) {
      for (let j = i + 1; j < subs.length; j++) {
        const a = subs[i]
        const b = subs[j]
        if (!a.nodes.length || !b.nodes.length) continue
        const aStart = a.nodes[0]
        const aEnd = a.nodes[a.nodes.length - 1]
        const bStart = b.nodes[0]
        const bEnd = b.nodes[b.nodes.length - 1]
        const close = (p: PathNode, q: PathNode) => Math.hypot(p.x - q.x, p.y - q.y) <= tolerance
        if (close(aEnd, bStart)) {
          subs[i] = { closed: a.closed || b.closed, nodes: [...a.nodes, ...b.nodes] }
        } else if (close(bEnd, aStart)) {
          subs[i] = { closed: a.closed || b.closed, nodes: [...b.nodes, ...a.nodes] }
        } else if (close(aEnd, bEnd)) {
          subs[i] = { closed: a.closed || b.closed, nodes: [...a.nodes, ...b.nodes.slice().reverse()] }
        } else if (close(aStart, bStart)) {
          subs[i] = { closed: a.closed || b.closed, nodes: [...a.nodes.slice().reverse(), ...b.nodes] }
        } else continue
        subs.splice(j, 1)
        merged = true
        break outer
      }
    }
  }
  return pathFromSubpaths(subs, path.fillRule)
}

/* ------------------------------------------------- node-level editing ------ */

export function moveNode(path: PathData, sub: number, index: number, dx: number, dy: number, moveHandles = true): PathData {
  const subpaths = path.subpaths.map((sp, si) => {
    if (si !== sub) return sp
    return {
      ...sp,
      nodes: sp.nodes.map((n, ni) => (ni === index
        ? {
          ...n,
          x: n.x + dx,
          y: n.y + dy,
          inX: moveHandles ? n.inX + dx : n.inX,
          inY: moveHandles ? n.inY + dy : n.inY,
          outX: moveHandles ? n.outX + dx : n.outX,
          outY: moveHandles ? n.outY + dy : n.outY,
        }
        : n)),
    }
  })
  return { ...path, subpaths }
}

export function insertNode(path: PathData, sub: number, segment: number, t: number): PathData {
  const sp = path.subpaths[sub]
  if (!sp) return path
  const n = sp.nodes.length
  const a = sp.nodes[segment]
  const b = sp.nodes[(segment + 1) % n]
  const p0 = { x: a.x, y: a.y }
  const p1 = { x: a.outX, y: a.outY }
  const p2 = { x: b.inX, y: b.inY }
  const p3 = { x: b.x, y: b.y }
  const mid = cubicAt(p0, p1, p2, p3, t)
  const nodes = [...sp.nodes]
  nodes.splice(segment + 1, 0, makeSmoothNode(mid.x, mid.y, mid.x, mid.y, mid.x, mid.y))
  return { ...path, subpaths: path.subpaths.map((s, i) => (i === sub ? { ...s, nodes } : s)) }
}

export function deleteNode(path: PathData, sub: number, index: number): PathData {
  const sp = path.subpaths[sub]
  if (!sp || sp.nodes.length <= 2) return path
  const nodes = sp.nodes.filter((_, i) => i !== index)
  return { ...path, subpaths: path.subpaths.map((s, i) => (i === sub ? { ...s, nodes } : s)) }
}

export function setNodeType(path: PathData, sub: number, index: number, type: PathNode['type']): PathData {
  const subpaths = path.subpaths.map((sp, si) => {
    if (si !== sub) return sp
    const nodes = sp.nodes.map((n, ni) => {
      if (ni !== index) return n
      if (type === 'sharp') return { ...n, inX: n.x, inY: n.y, outX: n.x, outY: n.y, type }
      const prev = sp.nodes[(ni - 1 + sp.nodes.length) % sp.nodes.length]
      const next = sp.nodes[(ni + 1) % sp.nodes.length]
      const dx = next.x - prev.x
      const dy = next.y - prev.y
      return { ...n, inX: n.x - dx * 0.25, inY: n.y - dy * 0.25, outX: n.x + dx * 0.25, outY: n.y + dy * 0.25, type }
    })
    return { ...sp, nodes }
  })
  return { ...path, subpaths }
}

/** Symmetric handle dragging: mirror the opposite handle to keep the curve smooth. */
export function dragHandle(path: PathData, sub: number, index: number, which: 'in' | 'out', target: Vec): PathData {
  const sp = path.subpaths[sub]
  if (!sp) return path
  const n = sp.nodes[index]
  const subpaths = path.subpaths.map((s, si) => {
    if (si !== sub) return s
    return {
      ...s,
      nodes: s.nodes.map((nd, ni) => {
        if (ni !== index) return nd
        const updated = { ...n }
        if (which === 'in') {
          updated.inX = target.x
          updated.inY = target.y
        } else {
          updated.outX = target.x
          updated.outY = target.y
        }
        if (nd.type === 'symmetric') {
          const mx = nd.x * 2 - target.x
          const my = nd.y * 2 - target.y
          if (which === 'in') {
            updated.outX = mx
            updated.outY = my
          } else {
            updated.inX = mx
            updated.inY = my
          }
        } else if (nd.type === 'smooth') {
          const dx = target.x - nd.x
          const dy = target.y - nd.y
          const len = Math.hypot(dx, dy) || 1
          const other = which === 'in' ? { x: nd.outX - nd.x, y: nd.outY - nd.y } : { x: nd.inX - nd.x, y: nd.inY - nd.y }
          const otherLen = Math.hypot(other.x, other.y)
          if (otherLen > 1e-6) {
            const nx = nd.x - (dx / len) * otherLen
            const ny = nd.y - (dy / len) * otherLen
            if (which === 'in') {
              updated.outX = nx
              updated.outY = ny
            } else {
              updated.inX = nx
              updated.inY = ny
            }
          }
        }
        return updated
      }),
    }
  })
  return { ...path, subpaths }
}

/** Geometric centre helpers used by transforms and the rotation handles. */
export function pathCenter(path: PathData): Vec {
  const loops = flattenPath(path, 8)
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const l of loops) for (const p of l) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) return v(0, 0)
  return rectCenter({ x: minX, y: minY, w: maxX - minX, h: maxY - minY })
}

/** Distortion brushes (Smudge / Roughen / Twirl / Attract / Repel) on node data. */
export type DistortKind = 'smudge' | 'roughen' | 'twirl' | 'attract' | 'repel'

export function distortNodes(
  path: PathData,
  kind: DistortKind,
  center: Vec,
  radius: number,
  strength: number,
  drag: Vec,
  seed = 1,
): PathData {
  const r2 = radius * radius
  const subpaths = path.subpaths.map((sp) => ({
    ...sp,
    nodes: sp.nodes.map((n) => {
      const dx = n.x - center.x
      const dy = n.y - center.y
      const d2 = dx * dx + dy * dy
      if (d2 > r2) return n
      const d = Math.sqrt(d2) || 1e-6
      const falloff = 1 - d / radius
      const w = falloff * falloff * strength
      let nx = n.x
      let ny = n.y
      if (kind === 'smudge') {
        nx += drag.x * w
        ny += drag.y * w
      } else if (kind === 'roughen') {
        // Deterministic pseudo-noise from the node position + seed.
        const h = Math.sin((n.x * 12.9898 + n.y * 78.233 + seed) * 43758.5453)
        const h2 = Math.sin((n.x * 39.3468 + n.y * 11.135 + seed * 1.7) * 24634.6345)
        nx += h * radius * 0.12 * w
        ny += h2 * radius * 0.12 * w
      } else if (kind === 'twirl') {
        const ang = w * 2.4
        const cos = Math.cos(ang)
        const sin = Math.sin(ang)
        nx = center.x + dx * cos - dy * sin
        ny = center.y + dx * sin + dy * cos
      } else {
        const scale = kind === 'attract' ? 1 - w * 0.6 : 1 + w * 0.6
        nx = center.x + dx * scale
        ny = center.y + dy * scale
      }
      const ddx = nx - n.x
      const ddy = ny - n.y
      return {
        ...n,
        x: nx, y: ny,
        inX: n.inX + ddx, inY: n.inY + ddy,
        outX: n.outX + ddx, outY: n.outY + ddy,
      }
    }),
  }))
  return { ...path, subpaths }
}

/** Scale a path about a point. */
export function scalePathAbout(path: PathData, sx: number, sy: number, origin: Vec): PathData {
  return {
    ...path,
    subpaths: path.subpaths.map((sp) => ({
      ...sp,
      nodes: sp.nodes.map((n) => ({
        ...n,
        x: origin.x + (n.x - origin.x) * sx,
        y: origin.y + (n.y - origin.y) * sy,
        inX: origin.x + (n.inX - origin.x) * sx,
        inY: origin.y + (n.inY - origin.y) * sy,
        outX: origin.x + (n.outX - origin.x) * sx,
        outY: origin.y + (n.outY - origin.y) * sy,
      })),
    })),
  }
}
