/**
 * Bridge to the WebAssembly image kernels (wasm/kernels.ts).
 *
 * AssemblyScript arrays are managed objects, so instead of marshalling arrays we
 * agree on a fixed set of shared module-level buffers. `ensure()` sizes them,
 * `views` re-wrap the wasm memory, and each op memcpy's the pixels in and out.
 * Everything degrades to a pure-JS implementation when WASM is unavailable
 * (older browsers, CSP restrictions, or a failed fetch) — the editor never
 * depends on acceleration to function.
 */

/**
 * TypeScript 5.7 parameterises typed arrays by their backing buffer; kernel
 * buffers may legitimately come from ArrayBuffer, SharedArrayBuffer or a
 * slice of wasm memory, so the bridge accepts the widest form.
 */
export type Bytes = Uint8ClampedArray<ArrayBufferLike>
export type MaskBytes = Uint8Array<ArrayBufferLike>

export type KernelStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'js'

interface KernelExports {
  memory: WebAssembly.Memory
  ensureBuffers(imgBytes: number, maskBytes: number, floatCount: number, intCount: number): void
  ptrImgA(): number; ptrImgB(): number; ptrMaskA(): number; ptrMaskB(): number
  ptrFA(): number; ptrFB(): number; ptrIA(): number; ptrIB(): number; ptrSmall(): number
  capacityImg(): number; capacityMask(): number; capacityF(): number; capacityI(): number
  applyCurves(length: number): void
  adjustBasic(length: number, brightness: number, contrast: number, gamma: number, sat: number): void
  adjustHSL(length: number, deg: number, sat: number, light: number): void
  histogram(length: number): void
  histogramRGB(length: number): void
  gaussianBlur(w: number, h: number, radius: number, blurAlpha: number): void
  sharpen(w: number, h: number, amount: number): void
  jpegDeartifact(w: number, h: number, strength: number): void
  resample(sw: number, sh: number, dw: number, dh: number, mode: number): void
  floodSelect(w: number, h: number, sx: number, sy: number, tolerance: number, contiguous: number): number
  maskMorph(w: number, h: number, radius: number, dilate: number): void
  maskFeather(w: number, h: number, radius: number): void
  applyMask(count: number, invert: number, keepAlpha: number): void
  buildLiquifyMap(w: number, h: number, cx: number, cy: number, radius: number, strength: number, mode: number, vx: number, vy: number): void
  applyDisplacementMap(w: number, h: number): void
  alphaCompositeOver(opacity: number, pixelCount: number): void
  blendLayer(mode: number, opacity: number, pixelCount: number): void
  subjectBounds(w: number, h: number, tolerance: number): void
  averageColor(length: number): void
  extractPalette(length: number, count: number): void
  traceContours(w: number, h: number, threshold: number, maxOut: number): number
  simplifyPath(count: number, epsilon: number): number
  blockShadowMask(w: number, h: number, dx: number, dy: number, steps: number): void
  renderShadow(w: number, h: number, cr: number, cg: number, cb: number, ca: number): void
  perspectiveWarp(sw: number, sh: number, dw: number, dh: number): void
  smoothStroke(count: number, minCutoff: number, beta: number): void
}

let exportsRef: KernelExports | null = null
let status: KernelStatus = 'idle'
let loadPromise: Promise<KernelStatus> | null = null
const listeners = new Set<(s: KernelStatus) => void>()

function setStatus(next: KernelStatus) {
  status = next
  listeners.forEach((fn) => fn(next))
}

export function kernelStatus(): KernelStatus {
  return status
}
export function onKernelStatus(fn: (s: KernelStatus) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Load and instantiate the kernels once. Never rejects — falls back to JS. */
export function loadKernels(): Promise<KernelStatus> {
  if (loadPromise) return loadPromise
  loadPromise = (async (): Promise<KernelStatus> => {
    setStatus('loading')
    try {
      const res = await fetch('/wasm/kernels.wasm')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = await res.arrayBuffer()
      const { instance } = await WebAssembly.instantiate(bytes, {
        env: {
          abort: () => {
            throw new Error('wasm kernel aborted')
          },
        },
      })
      exportsRef = instance.exports as unknown as KernelExports
      // Warm the buffers with a sensible default so the first operation is fast.
      exportsRef.ensureBuffers(2048 * 2048 * 4, 2048 * 2048, 2048 * 2048 * 4 + 8192, 32768 + 65536)
      setStatus('ready')
      return 'ready' as KernelStatus
    } catch (error) {
      console.warn('[wasm] kernels unavailable, using the JavaScript pipeline:', error)
      exportsRef = null
      setStatus('js')
      return 'js' as KernelStatus
    }
  })()
  return loadPromise
}

export function kernelsReady(): boolean {
  return status === 'ready' && exportsRef !== null
}

/* ------------------------------------------------------------- buffers ----- */

function ensureViews(imgBytes: number, maskBytes: number, floats: number, ints: number) {
  const e = exportsRef
  if (!e) throw new Error('wasm kernels not loaded')
  const needed = {
    img: Math.max(imgBytes, 64) + 64,
    mask: Math.max(maskBytes, 64) + 64,
    f: Math.max(floats, 512) + 1024,
    i: Math.max(ints, 32768 + 4096),
  }
  if (needed.img > e.capacityImg() || needed.mask > e.capacityMask() || needed.f > e.capacityF() || needed.i > e.capacityI()) {
    e.ensureBuffers(needed.img, needed.mask, needed.f, needed.i)
    // Memory growth detaches previous views; re-wrap lazily on every access below.
  }
  const buf = e.memory.buffer
  return {
    imgA: new Uint8ClampedArray(buf, e.ptrImgA(), needed.img),
    imgB: new Uint8ClampedArray(buf, e.ptrImgB(), needed.img),
    maskA: new Uint8Array(buf, e.ptrMaskA(), needed.mask),
    maskB: new Uint8Array(buf, e.ptrMaskB(), needed.mask),
    fA: new Float32Array(buf, e.ptrFA(), needed.f),
    fB: new Float32Array(buf, e.ptrFB(), needed.f),
    iA: new Int32Array(buf, e.ptrIA(), needed.i),
    iB: new Int32Array(buf, e.ptrIB(), needed.i),
    small: new Uint8Array(buf, e.ptrSmall(), 4096),
  }
}

/** Plan buffer sizes for an image of w×h. */
function plan(w: number, h: number) {
  const pixels = w * h
  return {
    imgBytes: pixels * 4 + 4096,
    maskBytes: pixels * 2 + 4096,
    floats: pixels * 4 + 8192,
    ints: Math.max(32768 + 8192, pixels * 4 + 8192),
  }
}

/* --------------------------------------------------------------- ops ------- */

const identityOut = (data: Bytes) => data

export const ImageKernels = {
  /** Per-channel curves; luts are 4 arrays of 256 bytes (R, G, B, A). */
  applyCurves(data: Bytes, luts: MaskBytes[]): Bytes {
    if (!kernelsReady()) return jsCurves(data, luts)
    const e = exportsRef!
    const p = plan(data.length / 4, 1)
    const v = ensureViews(data.length, 1024, p.floats, p.ints)
    v.imgA.set(data)
    for (let i = 0; i < 4; i++) v.small.set(luts[i].subarray(0, 256), i * 256)
    e.applyCurves(data.length)
    const out = v.imgA.slice(0, data.length)
    // keep identity so callers can treat it uniformly
    void identityOut
    return out
  },

  adjustBasic(data: Bytes, brightness: number, contrast: number, gamma: number, sat: number): Bytes {
    if (!kernelsReady()) return jsAdjustBasic(data, brightness, contrast, gamma, sat)
    const e = exportsRef!
    const p = plan(data.length / 4, 1)
    const v = ensureViews(data.length, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.adjustBasic(data.length, brightness, contrast, gamma, sat)
    return v.imgA.slice(0, data.length)
  },

  adjustHSL(data: Bytes, deg: number, sat: number, light: number): Bytes {
    if (!kernelsReady()) return jsAdjustHSL(data, deg, sat, light)
    const e = exportsRef!
    const p = plan(data.length / 4, 1)
    const v = ensureViews(data.length, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.adjustHSL(data.length, deg, sat, light)
    return v.imgA.slice(0, data.length)
  },

  /** 256-bin luminance histogram. */
  histogram(data: Bytes): Int32Array {
    if (!kernelsReady()) return jsHistogram(data)
    const e = exportsRef!
    const p = plan(data.length / 4, 1)
    const v = ensureViews(data.length, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.histogram(data.length)
    return v.iA.slice(0, 256)
  },

  histogramRGB(data: Bytes): Int32Array {
    if (!kernelsReady()) return jsHistogramRGB(data)
    const e = exportsRef!
    const p = plan(data.length / 4, 1)
    const v = ensureViews(data.length, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.histogramRGB(data.length)
    return v.iA.slice(0, 768)
  },

  gaussianBlur(data: Bytes, w: number, h: number, radius: number, blurAlpha = 0): Bytes {
    if (radius < 1) return data
    if (!kernelsReady()) return jsBoxBlur(data, w, h, radius, blurAlpha)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(w * h * 4, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.gaussianBlur(w, h, radius, blurAlpha)
    return v.imgA.slice(0, w * h * 4)
  },

  sharpen(data: Bytes, w: number, h: number, amount: number): Bytes {
    if (!kernelsReady()) return jsSharpen(data, w, h, amount)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(w * h * 4, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.sharpen(w, h, amount)
    return v.imgA.slice(0, w * h * 4)
  },

  jpegRestore(data: Bytes, w: number, h: number, strength: number): Bytes {
    if (!kernelsReady()) return jsBoxBlur(data, w, h, 1, 1)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(Math.max(w * h * 4, w * h), w * h * 2, p.floats, p.ints)
    v.imgA.set(data)
    e.jpegDeartifact(w, h, strength)
    return v.imgA.slice(0, w * h * 4)
  },

  /** mode: 0 bilinear, 1 bicubic, 2 Mitchell, 3 box. */
  resample(data: Bytes, sw: number, sh: number, dw: number, dh: number, mode: number): Bytes {
    if (!kernelsReady()) return jsResample(data, sw, sh, dw, dh)
    const e = exportsRef!
    const p = plan(Math.max(sw * sh, dw * dh), 1)
    const v = ensureViews(Math.max(sw * sh, dw * dh) * 4, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.resample(sw, sh, dw, dh, mode)
    return v.imgB.slice(0, dw * dh * 4)
  },

  /**
   * Flood/colour selection. The kernel emits a binary 0/1 map (cheap to build);
   * it is scaled to the 0..255 mask convention every other mask kernel uses so
   * callers can pass the result straight into `commitSelection`/`applyMask`.
   */
  floodSelect(data: Bytes, w: number, h: number, sx: number, sy: number, tolerance: number, contiguous: boolean): MaskBytes {
    const raw = kernelsReady()
      ? (() => {
        const e = exportsRef!
        const p = plan(w, h)
        const v = ensureViews(w * h * 4, p.maskBytes, p.floats, p.ints)
        v.imgA.set(data)
        e.floodSelect(w, h, sx, sy, tolerance, contiguous ? 1 : 0)
        return v.maskA.slice(0, w * h)
      })()
      : jsFloodSelect(data, w, h, sx, sy, tolerance, contiguous)
    const out: MaskBytes = new Uint8Array(w * h)
    for (let i = 0; i < out.length; i++) out[i] = raw[i] ? 255 : 0
    return out
  },

  maskMorph(mask: MaskBytes, w: number, h: number, radius: number, dilate: boolean): MaskBytes {
    if (!kernelsReady()) return jsMaskMorph(mask, w, h, radius, dilate)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(64, p.maskBytes, p.floats, p.ints)
    v.maskA.set(mask.subarray(0, w * h))
    e.maskMorph(w, h, radius, dilate ? 1 : 0)
    return v.maskA.slice(0, w * h)
  },

  maskFeather(mask: MaskBytes, w: number, h: number, radius: number): MaskBytes {
    if (!kernelsReady()) return jsMaskFeather(mask, w, h, radius)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(64, p.maskBytes, p.floats, p.ints)
    v.maskA.set(mask.subarray(0, w * h))
    e.maskFeather(w, h, radius)
    return v.maskA.slice(0, w * h)
  },

  applyMask(data: Bytes, mask: MaskBytes, w: number, h: number, invert = false, keepAlpha = true): Bytes {
    if (!kernelsReady()) return jsApplyMask(data, mask, w * h, invert, keepAlpha)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(w * h * 4, p.maskBytes, p.floats, p.ints)
    v.imgA.set(data)
    v.maskA.set(mask.subarray(0, w * h))
    e.applyMask(w * h, invert ? 1 : 0, keepAlpha ? 1 : 0)
    return v.imgA.slice(0, w * h * 4)
  },

  /**
   * Liquify: accumulate a displacement map, then warp. `start`/`continue` mirror
   * the interactive brush so a whole drag costs one warp at the end.
   */
  liquifyStart(w: number, h: number) {
    const e = exportsRef
    if (!e || !kernelsReady()) return null
    const p = plan(w, h)
    const v = ensureViews(64, 8, p.floats, p.ints)
    v.fA.fill(0, 0, w * h)
    v.fB.fill(0, 0, w * h)
    return { w, h }
  },

  liquifyDab(w: number, h: number, cx: number, cy: number, radius: number, strength: number, mode: number, vx: number, vy: number) {
    const e = exportsRef
    if (!e || !kernelsReady()) return
    const p = plan(w, h)
    ensureViews(64, 8, p.floats, p.ints)
    e.buildLiquifyMap(w, h, cx, cy, radius, strength, mode, vx, vy)
  },

  liquifyApply(data: Bytes, w: number, h: number): Bytes {
    const e = exportsRef
    if (!e || !kernelsReady()) return data
    const p = plan(w, h)
    const v = ensureViews(w * h * 4, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.applyDisplacementMap(w, h)
    return v.imgB.slice(0, w * h * 4)
  },

  blend(dst: Bytes, src: Bytes, blendIndex: number, opacity: number): Bytes {
    const pixels = Math.min(dst.length, src.length) >> 2
    if (!kernelsReady()) return jsBlend(dst, src, blendIndex, opacity)
    const e = exportsRef!
    const p = plan(pixels, 1)
    const v = ensureViews(Math.max(dst.length, src.length), 8, p.floats, p.ints)
    v.imgA.set(dst.subarray(0, pixels * 4))
    v.imgB.set(src.subarray(0, pixels * 4))
    e.blendLayer(blendIndex, opacity, pixels)
    return v.imgA.slice(0, pixels * 4)
  },

  compositeOver(dst: Bytes, src: Bytes, opacity = 1): Bytes {
    const pixels = Math.min(dst.length, src.length) >> 2
    if (!kernelsReady()) return jsBlend(dst, src, 0, opacity)
    const e = exportsRef!
    const p = plan(pixels, 1)
    const v = ensureViews(Math.max(dst.length, src.length), 8, p.floats, p.ints)
    v.imgA.set(dst.subarray(0, pixels * 4))
    v.imgB.set(src.subarray(0, pixels * 4))
    e.alphaCompositeOver(opacity, pixels)
    return v.imgA.slice(0, pixels * 4)
  },

  subjectBounds(data: Bytes, w: number, h: number, tolerance: number): { x: number; y: number; w: number; h: number; count: number } {
    if (!kernelsReady()) return jsSubjectBounds(data, w, h, tolerance)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(w * h * 4, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.subjectBounds(w, h, tolerance)
    const [minX, minY, maxX, maxY, count] = v.iA
    return { x: minX, y: minY, w: Math.max(0, maxX - minX + 1), h: Math.max(0, maxY - minY + 1), count }
  },

  averageColor(data: Bytes): { r: number; g: number; b: number } {
    if (!kernelsReady()) return jsAverageColor(data)
    const e = exportsRef!
    const p = plan(data.length / 4, 1)
    const v = ensureViews(data.length, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.averageColor(data.length)
    return { r: v.fA[0], g: v.fA[1], b: v.fA[2] }
  },

  extractPalette(data: Bytes, count = 8): { r: number; g: number; b: number }[] {
    if (!kernelsReady()) return jsPalette(data, count)
    const e = exportsRef!
    const p = plan(data.length / 4, 1)
    const v = ensureViews(data.length, 8, p.floats, p.ints)
    v.imgA.set(data)
    e.extractPalette(data.length, count)
    const out: { r: number; g: number; b: number }[] = []
    for (let i = 0; i < count; i++) out.push({ r: v.small[i * 3], g: v.small[i * 3 + 1], b: v.small[i * 3 + 2] })
    return out
  },

  /** Vector trace: returns closed rings in image pixel coordinates. */
  traceContours(data: Bytes, w: number, h: number, threshold: number): { x: number; y: number }[][] {
    if (!kernelsReady()) return jsTrace(data, w, h, threshold)
    const e = exportsRef!
    const p = plan(w, h)
    const maxOut = Math.max(65536, w * h * 8)
    const v = ensureViews(w * h * 4, w * h * 2 + 4096, p.floats, maxOut)
    v.imgA.set(data)
    const written = e.traceContours(w, h, threshold, maxOut)
    const rings: { x: number; y: number }[][] = []
    let current: { x: number; y: number }[] = []
    for (let i = 0; i < written; i += 2) {
      const x = v.iA[i]
      const y = v.iA[i + 1]
      if (x < 0 || y < 0) {
        if (current.length) rings.push(current)
        current = []
      } else {
        current.push({ x, y })
      }
    }
    if (current.length) rings.push(current)
    return rings
  },

  /** Douglas-Peucker over a ring. */
  simplify(ring: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
    if (!kernelsReady() || ring.length < 3) return jsSimplify(ring, epsilon)
    const e = exportsRef!
    const count = ring.length
    const p = plan(count, 1)
    const v = ensureViews(64, 8, p.floats, Math.max(32768, count * 8))
    for (let i = 0; i < count; i++) {
      v.iA[i * 2] = Math.round(ring[i].x)
      v.iA[i * 2 + 1] = Math.round(ring[i].y)
    }
    const kept = e.simplifyPath(count, epsilon)
    const out: { x: number; y: number }[] = []
    for (let i = 0; i < kept; i++) out.push({ x: v.iB[i * 2], y: v.iB[i * 2 + 1] })
    return out
  },

  blockShadowMask(mask: MaskBytes, w: number, h: number, dx: number, dy: number, steps: number): MaskBytes {
    if (!kernelsReady()) return jsBlockShadow(mask, w, h, dx, dy, steps)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(64, p.maskBytes, p.floats, p.ints)
    v.maskA.set(mask.subarray(0, w * h))
    e.blockShadowMask(w, h, Math.round(dx), Math.round(dy), steps)
    return v.maskB.slice(0, w * h)
  },

  renderShadow(mask: MaskBytes, w: number, h: number, color: { r: number; g: number; b: number; a: number }): Bytes {
    if (!kernelsReady()) return jsRenderShadow(mask, w, h, color)
    const e = exportsRef!
    const p = plan(w, h)
    const v = ensureViews(w * h * 4, p.maskBytes, p.floats, p.ints)
    v.maskA.set(mask.subarray(0, w * h))
    e.renderShadow(w, h, color.r, color.g, color.b, color.a * 255)
    return v.imgB.slice(0, w * h * 4)
  },

  perspectiveWarp(
    data: Bytes, sw: number, sh: number, dw: number, dh: number,
    homography: number[],
  ): Bytes {
    if (!kernelsReady()) return data
    const e = exportsRef!
    const p = plan(Math.max(sw * sh, dw * dh), 1)
    const v = ensureViews(Math.max(sw * sh, dw * dh) * 4, 8, p.floats, p.ints)
    v.imgA.set(data)
    for (let i = 0; i < 9; i++) v.fA[i] = homography[i]
    e.perspectiveWarp(sw, sh, dw, dh)
    return v.imgB.slice(0, dw * dh * 4)
  },

  smoothStroke(xs: Float32Array, ys: Float32Array, minCutoff: number, beta: number): void {
    if (!kernelsReady()) {
      jsSmooth(xs, ys, minCutoff, beta)
      return
    }
    const e = exportsRef!
    const count = xs.length
    const p = plan(count, 1)
    const v = ensureViews(64, 8, Math.max(p.floats, count * 2 + 16), p.ints)
    v.fA.set(xs)
    v.fB.set(ys)
    e.smoothStroke(count, minCutoff, beta)
    xs.set(v.fA.subarray(0, count))
    ys.set(v.fB.subarray(0, count))
  },
}

/* =========================================================================
 * Pure-JS fallbacks — same semantics, used when WASM is unavailable.
 * ========================================================================= */

function jsCurves(data: Bytes, luts: MaskBytes[]): Bytes {
  const out = new Uint8ClampedArray(data.length)
  for (let i = 0; i < data.length; i += 4) {
    out[i] = luts[0][data[i]]
    out[i + 1] = luts[1][data[i + 1]]
    out[i + 2] = luts[2][data[i + 2]]
    out[i + 3] = luts[3][data[i + 3]]
  }
  return out
}

function jsAdjustBasic(data: Bytes, brightness: number, contrast: number, gamma: number, sat: number): Bytes {
  const out = new Uint8ClampedArray(data.length)
  const cf = contrast < 0 ? 1 + contrast : 1 / (1 - contrast * 0.95)
  const ig = 1 / Math.min(10, Math.max(0.05, gamma))
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255
    let g = data[i + 1] / 255
    let b = data[i + 2] / 255
    r = Math.min(1, Math.max(0, (r + brightness - 0.5) * cf + 0.5)) ** ig
    g = Math.min(1, Math.max(0, (g + brightness - 0.5) * cf + 0.5)) ** ig
    b = Math.min(1, Math.max(0, (b + brightness - 0.5) * cf + 0.5)) ** ig
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
    out[i] = 255 * (l + (r - l) * sat)
    out[i + 1] = 255 * (l + (g - l) * sat)
    out[i + 2] = 255 * (l + (b - l) * sat)
    out[i + 3] = data[i + 3]
  }
  return out
}

function jsAdjustHSL(data: Bytes, deg: number, sat: number, light: number): Bytes {
  const out = new Uint8ClampedArray(data.length)
  const rad = (deg * Math.PI) / 180
  const cosA = Math.cos(rad)
  const sinA = Math.sin(rad)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    let nr = (0.213 + cosA * 0.787 - sinA * 0.213) * r + (0.715 - cosA * 0.715 - sinA * 0.715) * g + (0.072 - cosA * 0.072 + sinA * 0.928) * b
    let ng = (0.213 - cosA * 0.213 + sinA * 0.143) * r + (0.715 + cosA * 0.285 + sinA * 0.14) * g + (0.072 - cosA * 0.072 - sinA * 0.283) * b
    let nb = (0.213 - cosA * 0.213 - sinA * 0.787) * r + (0.715 - cosA * 0.715 + sinA * 0.715) * g + (0.072 + cosA * 0.928 + sinA * 0.072) * b
    const l = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb
    nr = l + (nr - l) * sat
    ng = l + (ng - l) * sat
    nb = l + (nb - l) * sat
    out[i] = nr + light * 255
    out[i + 1] = ng + light * 255
    out[i + 2] = nb + light * 255
    out[i + 3] = data[i + 3]
  }
  return out
}

function jsHistogram(data: Bytes): Int32Array {
  const h = new Int32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    const l = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])
    h[Math.min(255, Math.max(0, l))]++
  }
  return h
}

function jsHistogramRGB(data: Bytes): Int32Array {
  const h = new Int32Array(768)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    h[data[i]]++
    h[256 + data[i + 1]]++
    h[512 + data[i + 2]]++
  }
  return h
}

function jsBoxBlur(data: Bytes, w: number, h: number, radius: number, blurAlpha: number): Bytes {
  const tmp = new Float32Array(w * h * 4)
  const out = new Uint8ClampedArray(w * h * 4)
  const n = radius * 2 + 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(w - 1, Math.max(0, x + k))
        const o = (y * w + sx) * 4
        r += data[o]; g += data[o + 1]; b += data[o + 2]; a += data[o + 3]
      }
      const t = (y * w + x) * 4
      tmp[t] = r / n; tmp[t + 1] = g / n; tmp[t + 2] = b / n; tmp[t + 3] = a / n
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(h - 1, Math.max(0, y + k))
        const o = (sy * w + x) * 4
        r += tmp[o]; g += tmp[o + 1]; b += tmp[o + 2]; a += tmp[o + 3]
      }
      const t = (y * w + x) * 4
      out[t] = r / n; out[t + 1] = g / n; out[t + 2] = b / n
      out[t + 3] = blurAlpha ? a / n : data[t + 3]
    }
  }
  return out
}

function jsSharpen(data: Bytes, w: number, h: number, amount: number): Bytes {
  const blurred = jsBoxBlur(data, w, h, 2, 0)
  const out = new Uint8ClampedArray(data.length)
  for (let i = 0; i < data.length; i += 4) {
    out[i] = data[i] + (data[i] - blurred[i]) * amount
    out[i + 1] = data[i + 1] + (data[i + 1] - blurred[i + 1]) * amount
    out[i + 2] = data[i + 2] + (data[i + 2] - blurred[i + 2]) * amount
    out[i + 3] = data[i + 3]
  }
  return out
}

function jsResample(data: Bytes, sw: number, sh: number, dw: number, dh: number): Bytes {
  const out = new Uint8ClampedArray(dw * dh * 4)
  const iw = sw / dw
  const ih = sh / dh
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, Math.round((x + 0.5) * iw - 0.5)))
      const sy = Math.min(sh - 1, Math.max(0, Math.round((y + 0.5) * ih - 0.5)))
      const so = (sy * sw + sx) * 4
      const o = (y * dw + x) * 4
      out[o] = data[so]; out[o + 1] = data[so + 1]; out[o + 2] = data[so + 2]; out[o + 3] = data[so + 3]
    }
  }
  return out
}

function jsFloodSelect(data: Bytes, w: number, h: number, sx: number, sy: number, tolerance: number, contiguous: boolean): MaskBytes {
  const mask = new Uint8Array(w * h)
  const o0 = (sy * w + sx) * 4
  const tr = data[o0]; const tg = data[o0 + 1]; const tb = data[o0 + 2]; const ta = data[o0 + 3]
  const match = (p: number) => {
    const o = p * 4
    return Math.abs(data[o] - tr) <= tolerance && Math.abs(data[o + 1] - tg) <= tolerance
      && Math.abs(data[o + 2] - tb) <= tolerance && Math.abs(data[o + 3] - ta) <= tolerance
  }
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) mask[p] = match(p) ? 1 : 0
    return mask
  }
  const stack = [sy * w + sx]
  const seen = new Uint8Array(w * h)
  while (stack.length) {
    const p = stack.pop()!
    if (seen[p]) continue
    seen[p] = 1
    if (!match(p)) continue
    mask[p] = 1
    const x = p % w
    if (x > 0) stack.push(p - 1)
    if (x < w - 1) stack.push(p + 1)
    if (p >= w) stack.push(p - w)
    if (p < w * h - w) stack.push(p + w)
  }
  return mask
}

function jsMaskMorph(mask: MaskBytes, w: number, h: number, radius: number, dilate: boolean): MaskBytes {
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = dilate ? 0 : 255
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy
        if (sy < 0 || sy >= h) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx
          if (sx < 0 || sx >= w) continue
          const v = mask[sy * w + sx]
          best = dilate ? Math.max(best, v) : Math.min(best, v)
        }
      }
      out[y * w + x] = best
    }
  }
  return out
}

function jsMaskFeather(mask: MaskBytes, w: number, h: number, radius: number): MaskBytes {
  if (radius < 1) return mask
  const tmp = new Float32Array(w * h)
  const out = new Uint8Array(w * h)
  const n = radius * 2 + 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) acc += mask[y * w + Math.min(w - 1, Math.max(0, x + k))]
      tmp[y * w + x] = acc / n
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) acc += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
      out[y * w + x] = acc / n
    }
  }
  return out
}

function jsApplyMask(data: Bytes, mask: MaskBytes, count: number, invert: boolean, keepAlpha: boolean): Bytes {
  const out = new Uint8ClampedArray(data)
  for (let p = 0; p < count; p++) {
    const m = invert ? 255 - mask[p] : mask[p]
    const o = p * 4
    if (keepAlpha) out[o + 3] = (out[o + 3] * m) / 255
    else if (m === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0 }
  }
  return out
}

function jsBlend(dst: Bytes, src: Bytes, mode: number, opacity: number): Bytes {
  const out = new Uint8ClampedArray(dst)
  const sep = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  for (let i = 0; i < Math.min(dst.length, src.length); i += 4) {
    const sa = (src[i + 3] / 255) * opacity
    if (sa <= 0) continue
    const da = dst[i + 3] / 255
    for (let k = 0; k < 3; k++) {
      const s = src[i + k] / 255
      const d = dst[i + k] / 255
      let b = s
      if (mode === 1) b = s * d
      else if (mode === 2) b = 1 - (1 - s) * (1 - d)
      else if (mode === 3) b = d <= 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d)
      else if (mode === 4) b = Math.min(s, d)
      else if (mode === 5) b = Math.max(s, d)
      else if (mode === 8) b = s <= 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d)
      else if (mode === 9) b = s <= 0.5 ? d - (1 - 2 * s) * d * (1 - d) : d + (2 * s - 1) * (Math.sqrt(d) - d)
      else if (mode === 10) b = Math.abs(s - d)
      else if (mode === 11) b = s + d - 2 * s * d
      else b = sep[mode] !== undefined ? s : s
      const outA = sa + da * (1 - sa)
      out[i + k] = (((b * sa + d * da * (1 - sa)) / (outA || 1)) * 255)
    }
    out[i + 3] = (sa + da * (1 - sa)) * 255
  }
  return out
}

function jsSubjectBounds(data: Bytes, w: number, h: number, tolerance: number) {
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4]
  let br = 0; let bg = 0; let bb = 0
  for (const c of corners) { br += data[c]; bg += data[c + 1]; bb += data[c + 2] }
  br /= 4; bg /= 4; bb /= 4
  let minX = w; let minY = h; let maxX = -1; let maxY = -1; let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (data[o + 3] < 8) continue
      if (Math.abs(data[o] - br) + Math.abs(data[o + 1] - bg) + Math.abs(data[o + 2] - bb) <= tolerance) continue
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      count++
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h, count: 0 }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count }
}

function jsAverageColor(data: Bytes) {
  let r = 0; let g = 0; let b = 0; let n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
  }
  if (!n) return { r: 0, g: 0, b: 0 }
  return { r: r / n, g: g / n, b: b / n }
}

function jsPalette(data: Bytes, count: number) {
  const buckets = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([k]) => ({ r: ((k >> 10) & 31) * 8 + 4, g: ((k >> 5) & 31) * 8 + 4, b: (k & 31) * 8 + 4 }))
}

function jsTrace(data: Bytes, w: number, h: number, threshold: number) {
  // Simple marching-squares boundary walk on the thresholded mask.
  const mask = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) {
    const o = p * 4
    const l = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]
    mask[p] = (l * (data[o + 3] / 255)) >= threshold ? 1 : 0
  }
  const rings: { x: number; y: number }[][] = []
  const visited = new Uint8Array(w * h)
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const start = y * w + x
      if (!mask[start] || visited[start]) continue
      if (mask[start - 1] && mask[start + 1] && mask[start - w] && mask[start + w]) continue
      let cx = x; let cy = y; let dir = 0
      const ring: { x: number; y: number }[] = []
      for (let step = 0; step < w * h; step++) {
        visited[cy * w + cx] = 1
        ring.push({ x: cx, y: cy })
        let found = false
        for (let k = 0; k < 8; k++) {
          const d = (dir + 6 + k) % 8
          const nx = cx + dirs[d][0]
          const ny = cy + dirs[d][1]
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          if (!mask[ny * w + nx]) continue
          cx = nx; cy = ny; dir = d; found = true
          break
        }
        if (!found || (cx === x && cy === y)) break
      }
      if (ring.length >= 12) rings.push(ring)
    }
  }
  return rings
}

function jsSimplify(ring: { x: number; y: number }[], epsilon: number) {
  if (ring.length < 3) return ring
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1
  const stack: [number, number][] = [[0, ring.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    if (e <= s + 1) continue
    const a = ring[s]
    const b = ring[e]
    const vx = b.x - a.x
    const vy = b.y - a.y
    const len2 = vx * vx + vy * vy
    let maxD = -1
    let maxI = -1
    for (let i = s + 1; i < e; i++) {
      const p = ring[i]
      let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
      t = Math.min(1, Math.max(0, t))
      const d = Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
      if (d > maxD) { maxD = d; maxI = i }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1
      stack.push([s, maxI], [maxI, e])
    }
  }
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i])
  return out
}

function jsBlockShadow(mask: MaskBytes, w: number, h: number, dx: number, dy: number, steps: number): MaskBytes {
  const out = new Uint8Array(mask)
  for (let s = 1; s <= steps; s++) {
    const ox = Math.round(dx * s)
    const oy = Math.round(dy * s)
    for (let y = 0; y < h; y++) {
      const sy = y - oy
      if (sy < 0 || sy >= h) continue
      for (let x = 0; x < w; x++) {
        if (!mask[sy * w + x]) continue
        const tx = x + ox
        if (tx < 0 || tx >= w) continue
        out[y * w + tx] = 255
      }
    }
  }
  return out
}

function jsRenderShadow(mask: MaskBytes, w: number, h: number, color: { r: number; g: number; b: number; a: number }): Bytes {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let p = 0; p < w * h; p++) {
    const o = p * 4
    out[o] = color.r; out[o + 1] = color.g; out[o + 2] = color.b
    out[o + 3] = (mask[p] * color.a / 255) * 255
  }
  return out
}

function jsSmooth(xs: Float32Array, ys: Float32Array, minCutoff: number, beta: number): void {
  let px = xs[0]
  let py = ys[0]
  for (let i = 1; i < xs.length; i++) {
    const d = Math.hypot(xs[i] - px, ys[i] - py)
    const alpha = 1 / (1 + minCutoff + beta * d)
    px += alpha * (xs[i] - px)
    py += alpha * (ys[i] - py)
    xs[i] = px
    ys[i] = py
  }
}

/* ------------------------------------------------------------ helpers ------ */

/** ImageData → kernel-friendly buffer and back. */
export function imageDataToBytes(img: ImageData): Bytes {
  return new Uint8ClampedArray(img.data.buffer.slice(0))
}

export function bytesToImageData(bytes: Bytes, w: number, h: number): ImageData {
  return new ImageData(new Uint8ClampedArray(bytes.subarray(0, w * h * 4)), w, h)
}

/** Monotone cubic interpolation through control points → 256-entry LUT. */
export function curveToLUT(points: { x: number; y: number }[]): MaskBytes {
  const lut = new Uint8Array(256)
  const pts = [...points].sort((a, b) => a.x - b.x)
  if (pts.length < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i
    return lut
  }
  // Natural cubic spline on the control points.
  const n = pts.length
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const h = new Array(n - 1)
  const alpha = new Array(n).fill(0)
  for (let i = 0; i < n - 1; i++) h[i] = xs[i + 1] - xs[i] || 1e-6
  for (let i = 1; i < n - 1; i++) {
    alpha[i] = (3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1])
  }
  const l = new Array(n).fill(1)
  const mu = new Array(n).fill(0)
  const z = new Array(n).fill(0)
  const c = new Array(n).fill(0)
  const b = new Array(n).fill(0)
  const d = new Array(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1]
    mu[i] = h[i] / l[i]
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i]
  }
  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1]
    b[j] = (ys[j + 1] - ys[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3
    d[j] = (c[j + 1] - c[j]) / (3 * h[j])
  }
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    if (x <= xs[0]) { lut[i] = Math.round(Math.min(255, Math.max(0, ys[0] * 255))); continue }
    if (x >= xs[n - 1]) { lut[i] = Math.round(Math.min(255, Math.max(0, ys[n - 1] * 255))); continue }
    let j = 0
    while (j < n - 2 && x > xs[j + 1]) j++
    const dx = x - xs[j]
    const y = ys[j] + b[j] * dx + c[j] * dx * dx + d[j] * dx * dx * dx
    lut[i] = Math.round(Math.min(255, Math.max(0, y * 255)))
  }
  return lut
}

export function identityLUT(): MaskBytes {
  const lut = new Uint8Array(256)
  for (let i = 0; i < 256; i++) lut[i] = i
  return lut
}
