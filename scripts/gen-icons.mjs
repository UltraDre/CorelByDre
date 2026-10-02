#!/usr/bin/env node
/**
 * Generates the CorelByDre app-icon family as real PNGs (no image deps — zlib only).
 * The mark: a bezier brush stroke with visible anchor nodes, over a rounded gradient tile.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public/icons')
const shotDir = resolve(root, 'public/screenshots')
mkdirSync(outDir, { recursive: true })
mkdirSync(shotDir, { recursive: true })

/* ------------------------------------------------------------------ png ---- */

function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* -------------------------------------------------------------- drawing ---- */

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const mix = (a, b, t) => a + (b - a) * t
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function roundedRectSDF(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r)
  const qy = Math.abs(py - cy) - (halfH - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function cubic(p0, p1, p2, p3, t) {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]
}

function flatten(segs, steps = 48) {
  const pts = []
  for (const s of segs) {
    for (let i = 0; i <= steps; i++) pts.push(cubic(s[0], s[1], s[2], s[3], i / steps))
  }
  return pts
}

function distToPolyline(px, py, pts) {
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[i + 1]
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = dx * dx + dy * dy || 1
    let t = ((px - x1) * dx + (py - y1) * dy) / len2
    t = clamp(t)
    const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
    if (d < best) best = d
  }
  return best
}

/** Renders the mark at an arbitrary resolution. `mono` draws white-on-transparent. */
function renderIcon(size, { maskable = false, mono = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4)
  const S = size
  // Mark geometry in a 0..1 space.
  const stroke = 0.072 * S
  const segs = [
    [
      [0.24 * S, 0.68 * S],
      [0.33 * S, 0.30 * S],
      [0.63 * S, 0.24 * S],
      [0.66 * S, 0.46 * S],
    ],
    [
      [0.66 * S, 0.46 * S],
      [0.69 * S, 0.70 * S],
      [0.38 * S, 0.78 * S],
      [0.52 * S, 0.86 * S],
    ],
  ]
  const pts = flatten(segs, 64)
  const anchors = [
    [0.24 * S, 0.68 * S],
    [0.66 * S, 0.46 * S],
    [0.52 * S, 0.86 * S],
  ]
  const inner = maskable ? 0.78 : 0.92 // maskable keeps the mark inside the safe zone
  const scale = inner

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      if (!mono) {
        const d = roundedRectSDF(px, py, S / 2, S / 2, S / 2, S / 2, S * (maskable ? 0.5 : 0.22))
        const cov = 1 - smooth(-0.75, 0.75, d)
        if (cov > 0) {
          const t = clamp((px + py) / (2 * S) + 0.35 * (py / S - 0.5))
          r = mix(0x0f, 0x1b, t)
          g = mix(0xa6, 0x6c, t)
          b = mix(0x9a, 0xd6, t)
          a = cov
        }
      }

      // Mark, scaled about the centre to respect the maskable safe zone.
      const mx = (px - S / 2) / scale + S / 2
      const my = (py - S / 2) / scale + S / 2
      const ds = distToPolyline(mx, my, pts) - stroke / (2 * scale)
      const strokeCov = 1 - smooth(-0.8, 0.8, ds)
      let markCov = strokeCov
      for (const [ax, ay] of anchors) {
        const da = Math.hypot(mx - ax, my - ay) - stroke * 0.62 / scale
        markCov = Math.max(markCov, 1 - smooth(-0.8, 0.8, da))
      }
      if (markCov > 0) {
        if (mono) {
          r = 255
          g = 255
          b = 255
        } else {
          r = mix(r, 255, markCov)
          g = mix(g, 255, markCov)
          b = mix(b, 255, markCov)
        }
        a = Math.max(a, markCov)
      }
      const o = (y * S + x) * 4
      rgba[o] = Math.round(r)
      rgba[o + 1] = Math.round(g)
      rgba[o + 2] = Math.round(b)
      rgba[o + 3] = Math.round(a * 255)
    }
  }
  return encodePNG(S, S, rgba)
}

/* A wide branded screenshot placeholder (real captures are written by the app's "Capture UI" action). */
function renderScreenshot(w, h) {
  const rgba = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const t = clamp(y / h)
      const ui = y > h * 0.14 && x > w * 0.06 && x < w * 0.94
      const dark = ui ? 0.0 : 0.12
      rgba[o] = Math.round(mix(16, 26, t) * (1 - dark) + 12)
      rgba[o + 1] = Math.round(mix(24, 36, t) * (1 - dark) + 20)
      rgba[o + 2] = Math.round(mix(32, 48, t) * (1 - dark) + 28)
      rgba[o + 3] = 255
      if (ui && (y < h * 0.16 || x < w * 0.055 || x > w * 0.87)) {
        rgba[o] = 32
        rgba[o + 1] = 42
        rgba[o + 2] = 52
      }
    }
  }
  const mark = renderIcon(Math.min(w, h) * 0.4, { mono: false })
  return encodePNG(w, h, rgba)
}

/* ------------------------------------------------------------------ out ---- */

const sizes = [96, 128, 180, 192, 256, 384, 512, 1024]
for (const s of sizes) {
  const name = s === 96 ? 'badge-96.png' : `icon-${s}.png`
  writeFileSync(resolve(outDir, name), renderIcon(s))
}
writeFileSync(resolve(outDir, 'maskable-512.png'), renderIcon(512, { maskable: true }))
writeFileSync(resolve(outDir, 'maskable-1024.png'), renderIcon(1024, { maskable: true }))
writeFileSync(resolve(outDir, 'monochrome-512.png'), renderIcon(512, { mono: true }))
writeFileSync(resolve(shotDir, 'editor-wide.png'), renderScreenshot(1280, 720))
writeFileSync(resolve(shotDir, 'editor-narrow.png'), renderScreenshot(720, 1280))

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="CorelByDre">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0fa69a"/><stop offset="1" stop-color="#1b6cd6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <path d="M123 348C169 154 322 123 338 236c9 65-25 116-72 137 40-52 47-119 47-119" fill="none" stroke="#fff" stroke-width="37" stroke-linecap="round" stroke-linejoin="round"/>
  <g fill="#fff"><circle cx="123" cy="348" r="25"/><circle cx="338" cy="236" r="25"/><circle cx="266" cy="440" r="25"/></g>
</svg>`
writeFileSync(resolve(outDir, 'icon.svg'), svg)
console.log(`Wrote ${sizes.length + 4} icons and 2 screenshots to public/`)
