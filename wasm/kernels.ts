/**
 * CorelByDre WASM kernels — bitmap work that must not block the UI thread.
 *
 * Every routine here is a deterministic, closed-form pixel transform: histograms,
 * convolutions, resampling, blend modes, masks, warps and contour extraction.
 * There is deliberately no learning, inference, classification or generative code
 * anywhere in this module (see docs/NO-AI.md).
 *
 * Written for AssemblyScript F32_0_27 (no `if` expressions — ternaries only) and
 * compiled to `public/wasm/kernels.wasm` by `npm run build:wasm`.
 *
 * Memory: the stub runtime never frees, so hot paths reuse module-level scratch
 * buffers that grow on demand instead of allocating per call.
 */

// ------------------------------------------------------------ shared ABI ----
/* JS never passes arrays across the boundary (AssemblyScript arrays are managed
 * objects, not native typed arrays). Instead both sides agree on a fixed set of
 * module-level buffers: JS calls `ensureBuffers` once per job, reads the raw
 * pointers, and memcpy's pixels straight into wasm memory.
 *
 *   imgA / imgB  RGBA image data (Uint8ClampedArray) — primary / secondary
 *   maskA/maskB  8-bit masks and temporary scratch
 *   fA / fB      float scratch: displacement maps, LUT-free colour work, kernels
 *   iA / iB      int scratch: histograms, contour rings, packed paths
 *   small        LUTs (4x256) and small scalar results
 */

let imgA: Uint8ClampedArray = new Uint8ClampedArray(0)
let imgB: Uint8ClampedArray = new Uint8ClampedArray(0)
let maskA: Uint8Array = new Uint8Array(0)
let maskB: Uint8Array = new Uint8Array(0)
let fA: Float32Array = new Float32Array(0)
let fB: Float32Array = new Float32Array(0)
let iA: Int32Array = new Int32Array(0)
let iB: Int32Array = new Int32Array(0)
let small: Uint8Array = new Uint8Array(4096)

export function ensureBuffers(imgBytes: i32, maskBytes: i32, floatCount: i32, intCount: i32): void {
  if (imgA.length < imgBytes) {
    imgA = new Uint8ClampedArray(imgBytes)
    imgB = new Uint8ClampedArray(imgBytes)
  }
  if (maskA.length < maskBytes) {
    maskA = new Uint8Array(maskBytes)
    maskB = new Uint8Array(maskBytes)
  }
  if (fA.length < floatCount) fA = new Float32Array(floatCount)
  if (fB.length < floatCount) fB = new Float32Array(floatCount)
  if (iA.length < intCount) iA = new Int32Array(intCount)
  if (iB.length < intCount) iB = new Int32Array(intCount)
}

export function ptrImgA(): usize { return imgA.dataStart }
export function ptrImgB(): usize { return imgB.dataStart }
export function ptrMaskA(): usize { return maskA.dataStart }
export function ptrMaskB(): usize { return maskB.dataStart }
export function ptrFA(): usize { return fA.dataStart }
export function ptrFB(): usize { return fB.dataStart }
export function ptrIA(): usize { return iA.dataStart }
export function ptrIB(): usize { return iB.dataStart }
export function ptrSmall(): usize { return small.dataStart }
export function capacityImg(): i32 { return imgA.length }
export function capacityMask(): i32 { return maskA.length }
export function capacityF(): i32 { return fA.length }
export function capacityI(): i32 { return iA.length }

// Explicitly typed float constants: AssemblyScript infers bare float literals as f64,
// which would force a cast at every use site.
const F32_0_0: f32 = 0.0
const F32_0_0000001: f32 = 0.0000001
const F32_0_017453292519943295: f32 = 0.017453292519943295
const F32_0_05: f32 = 0.05
const F32_0_072: f32 = 0.072
const F32_0_0722: f32 = 0.0722
const F32_0_140: f32 = 0.140
const F32_0_143: f32 = 0.143
const F32_0_2126: f32 = 0.2126
const F32_0_213: f32 = 0.213
const F32_0_25: f32 = 0.25
const F32_0_27: f32 = 0.27
const F32_0_283: f32 = 0.283
const F32_0_285: f32 = 0.285
const F32_0_3333333333: f32 = 0.3333333333
const F32_0_5: f32 = 0.5
const F32_0_715: f32 = 0.715
const F32_0_7152: f32 = 0.7152
const F32_0_787: f32 = 0.787
const F32_0_928: f32 = 0.928
const F32_0_95: f32 = 0.95
const F32_1_0: f32 = 1.0
const F32_1_2: f32 = 1.2
const F32_10_0: f32 = 10.0
const F32_11_3: f32 = 11.3
const F32_12_0: f32 = 12.0
const F32_16_0: f32 = 16.0
const F32_18_0: f32 = 18.0
const F32_2_0: f32 = 2.0
const F32_24_0: f32 = 24.0
const F32_255_0: f32 = 255.0
const F32_3_0: f32 = 3.0
const F32_30_0: f32 = 30.0
const F32_4_0: f32 = 4.0
const F32_48_0: f32 = 48.0
const F32_6_0: f32 = 6.0
const F32_8_0: f32 = 8.0
const F32_9_0: f32 = 9.0

@inline function iabs(v: i32): i32 {
  return v < 0 ? -v : v
}

@inline function clamp255(v: f32): i32 {
  if (v < F32_0_0) return 0
  if (v > F32_255_0) return 255
  return <i32>(v + F32_0_5)
}

@inline function clampf(v: f32, lo: f32, hi: f32): f32 {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

@inline function idx(x: i32, y: i32, w: i32): i32 {
  return (y * w + x) << 2
}

@inline function lumf(r: f32, g: f32, b: f32): f32 {
  return F32_0_2126 * r + F32_0_7152 * g + F32_0_0722 * b
}

@inline function sampleLum(data: Uint8ClampedArray, o: i32): f32 {
  return F32_0_2126 * <f32>imgA[o] + F32_0_7152 * <f32>imgA[o + 1] + F32_0_0722 * <f32>imgA[o + 2]
}

@inline function bilerp(a: f32, b: f32, c: f32, d: f32, tx: f32, ty: f32): f32 {
  const top = a + (b - a) * tx
  const bot = c + (d - c) * tx
  return top + (bot - top) * ty
}

// -------------------------------------------------- colour adjustment -------

/**
 * applyCurves — per-channel lookup tables (RGBA x 256). This single kernel powers
 * Tone Curve, Hue Curve, Levels, threshold and the manual adjustment presets.
 * The caller keeps the pristine bytes, so the effect stays non-destructive.
 */
export function applyCurves(length: i32): void {
  // small[0..255]=R, [256..511]=G, [512..767]=B, [768..1023]=A
  for (let i = 0; i < length; i += 4) {
    imgA[i] = small[imgA[i]]
    imgA[i + 1] = small[256 + imgA[i + 1]]
    imgA[i + 2] = small[512 + imgA[i + 2]]
    imgA[i + 3] = small[768 + imgA[i + 3]]
  }
}

/** Brightness (-1..1), contrast (-1..1), gamma (F32_0_05..10), saturation (0..4) in one pass. */
export function adjustBasic(length: i32, brightness: f32, contrast: f32, gamma: f32, sat: f32): void {
  const invGamma = F32_1_0 / clampf(gamma, F32_0_05, F32_10_0)
  const c = clampf(contrast, -F32_1_0, F32_1_0)
  const cf = c < F32_0_0 ? F32_1_0 + c : F32_1_0 / (F32_1_0 - c * F32_0_95)
  const doSat = sat != F32_1_0
  for (let i = 0; i < length; i += 4) {
    for (let k = 0; k < 3; k++) {
      let v = <f32>imgA[i + k] / F32_255_0
      v = v + brightness
      v = (v - F32_0_5) * cf + F32_0_5
      v = clampf(v, F32_0_0, F32_1_0)
      if (gamma != F32_1_0) v = Mathf.pow(v, invGamma)
      imgA[i + k] = <u8>clamp255(v * F32_255_0)
    }
    if (doSat) {
      const r = <f32>imgA[i]
      const g = <f32>imgA[i + 1]
      const b = <f32>imgA[i + 2]
      const l = lumf(r, g, b)
      imgA[i] = <u8>clamp255(l + (r - l) * sat)
      imgA[i + 1] = <u8>clamp255(l + (g - l) * sat)
      imgA[i + 2] = <u8>clamp255(l + (b - l) * sat)
    }
  }
}

/** Hue rotation (degrees) + saturation scale + lightness offset — the "Hue Curve" adjuster. */
export function adjustHSL(length: i32, deg: f32, sat: f32, light: f32): void {
  const rad = deg * F32_0_017453292519943295
  const cosA = Mathf.cos(rad)
  const sinA = Mathf.sin(rad)
  const m00 = F32_0_213 + cosA * F32_0_787 - sinA * F32_0_213
  const m01 = F32_0_715 - cosA * F32_0_715 - sinA * F32_0_715
  const m02 = F32_0_072 - cosA * F32_0_072 + sinA * F32_0_928
  const m10 = F32_0_213 - cosA * F32_0_213 + sinA * F32_0_143
  const m11 = F32_0_715 + cosA * F32_0_285 + sinA * F32_0_140
  const m12 = F32_0_072 - cosA * F32_0_072 - sinA * F32_0_283
  const m20 = F32_0_213 - cosA * F32_0_213 - sinA * F32_0_787
  const m21 = F32_0_715 - cosA * F32_0_715 + sinA * F32_0_715
  const m22 = F32_0_072 + cosA * F32_0_928 + sinA * F32_0_072
  const lo = light * F32_255_0
  const doSat = sat != F32_1_0
  for (let i = 0; i < length; i += 4) {
    const r = <f32>imgA[i]
    const g = <f32>imgA[i + 1]
    const b = <f32>imgA[i + 2]
    let nr = r * m00 + g * m01 + b * m02
    let ng = r * m10 + g * m11 + b * m12
    let nb = r * m20 + g * m21 + b * m22
    if (doSat) {
      const l = lumf(nr, ng, nb)
      nr = l + (nr - l) * sat
      ng = l + (ng - l) * sat
      nb = l + (nb - l) * sat
    }
    imgA[i] = <u8>clamp255(nr + lo)
    imgA[i + 1] = <u8>clamp255(ng + lo)
    imgA[i + 2] = <u8>clamp255(nb + lo)
  }
}

/** 256-bin luminance histogram over pixels with alpha > 0. */
export function histogram(length: i32): void {
  const out = iA
  for (let i = 0; i < 256; i++) out[i] = 0
  for (let i = 0; i < length; i += 4) {
    if (imgA[i + 3] == 0) continue
    const l = <i32>(sampleLum(imgA, i) + F32_0_5)
    if (l < 0) continue
    if (l > 255) continue
    out[l] += 1
  }
}

/** Per-channel histogram: r in 0..255, g in 256..511, b in 512..767. */
export function histogramRGB(length: i32): void {
  const out = iA
  for (let i = 0; i < 768; i++) out[i] = 0
  for (let i = 0; i < length; i += 4) {
    if (imgA[i + 3] == 0) continue
    out[imgA[i]] += 1
    out[256 + imgA[i + 1]] += 1
    out[512 + imgA[i + 2]] += 1
  }
}

// ---------------------------------------------------------- convolution -----

/** Builds a normalised 1-D Gaussian kernel of `radius` taps into `out`. */
function buildGaussian(radius: i32, out: Float32Array): void {
  const sigma = <f32>radius / F32_3_0
  const twoSigma2 = F32_2_0 * sigma * sigma
  let sum: f32 = F32_0_0
  for (let i = 0; i <= radius; i++) {
    const v = Mathf.exp(-(<f32>(i * i)) / twoSigma2)
    out[i] = v
    sum += i == 0 ? v : v * F32_2_0
  }
  for (let i = 0; i <= radius; i++) out[i] /= sum
}

/** Separable Gaussian blur. `blurAlpha != 0` also blurs the alpha channel. */
export function gaussianBlur(w: i32, h: i32, radius: i32, blurAlpha: i32): void {
  if (radius < 1) return
  if (radius > 250) radius = 250
  const kernel = fA
  buildGaussian(radius, kernel)
  const tmp = fB
  const doAlpha = blurAlpha != 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr: f32 = F32_0_0
      let sg: f32 = F32_0_0
      let sb: f32 = F32_0_0
      let sa: f32 = F32_0_0
      for (let k = -radius; k <= radius; k++) {
        let sx = x + k
        if (sx < 0) sx = 0
        if (sx > w - 1) sx = w - 1
        const o = idx(sx, y, w)
        const wt = kernel[iabs(k)]
        sr += <f32>imgA[o] * wt
        sg += <f32>imgA[o + 1] * wt
        sb += <f32>imgA[o + 2] * wt
        sa += <f32>imgA[o + 3] * wt
      }
      const t = idx(x, y, w)
      tmp[t] = sr
      tmp[t + 1] = sg
      tmp[t + 2] = sb
      tmp[t + 3] = sa
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr: f32 = F32_0_0
      let sg: f32 = F32_0_0
      let sb: f32 = F32_0_0
      let sa: f32 = F32_0_0
      for (let k = -radius; k <= radius; k++) {
        let sy = y + k
        if (sy < 0) sy = 0
        if (sy > h - 1) sy = h - 1
        const o = idx(x, sy, w)
        const wt = kernel[iabs(k)]
        sr += tmp[o] * wt
        sg += tmp[o + 1] * wt
        sb += tmp[o + 2] * wt
        sa += tmp[o + 3] * wt
      }
      const t = idx(x, y, w)
      imgA[t] = <u8>clamp255(sr)
      imgA[t + 1] = <u8>clamp255(sg)
      imgA[t + 2] = <u8>clamp255(sb)
      if (doAlpha) imgA[t + 3] = <u8>clamp255(sa)
    }
  }
}

/** Unsharp-mask sharpening. amount 0..4. */
export function sharpen(w: i32, h: i32, amount: f32): void {
  const n = w * h * 4
  const kernel = fA            // 8 taps
  const horiz = fB             // separable horizontal pass, floats
  const radius = 2
  buildGaussian(radius, kernel)
  // horizontal pass straight off the image bytes
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr: f32 = F32_0_0
      let sg: f32 = F32_0_0
      let sb: f32 = F32_0_0
      for (let k = -radius; k <= radius; k++) {
        let sx = x + k
        if (sx < 0) sx = 0
        if (sx > w - 1) sx = w - 1
        const o = idx(sx, y, w)
        const wt = kernel[iabs(k)]
        sr += <f32>imgA[o] * wt
        sg += <f32>imgA[o + 1] * wt
        sb += <f32>imgA[o + 2] * wt
      }
      const t = idx(x, y, w)
      horiz[t] = sr
      horiz[t + 1] = sg
      horiz[t + 2] = sb
    }
  }
  // vertical pass, applying the unsharp mask immediately (no third buffer)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr: f32 = F32_0_0
      let sg: f32 = F32_0_0
      let sb: f32 = F32_0_0
      for (let k = -radius; k <= radius; k++) {
        let sy = y + k
        if (sy < 0) sy = 0
        if (sy > h - 1) sy = h - 1
        const o = idx(x, sy, w)
        const wt = kernel[iabs(k)]
        sr += horiz[o] * wt
        sg += horiz[o + 1] * wt
        sb += horiz[o + 2] * wt
      }
      const t = idx(x, y, w)
      imgA[t] = <u8>clamp255(<f32>imgA[t] + (<f32>imgA[t] - sr) * amount)
      imgA[t + 1] = <u8>clamp255(<f32>imgA[t + 1] + (<f32>imgA[t + 1] - sg) * amount)
      imgA[t + 2] = <u8>clamp255(<f32>imgA[t + 2] + (<f32>imgA[t + 2] - sb) * amount)
    }
  }
}

/**
 * JPEG artifact removal (manual, deterministic, no inference):
 *  1. edge-preserving bilateral smoothing kills ringing around high-contrast edges,
 *  2. a gradient-weighted deblocking pass blends the 8x8 macroblock seams.
 * strength 0..1.
 */
export function jpegDeartifact(w: i32, h: i32, strength: f32): void {
  if (strength <= F32_0_0) return
  const n = w * h * 4
  const src = imgB
  for (let i = 0; i < n; i++) src[i] = imgA[i]
  const radius = 2
  const sigmaS2 = F32_2_0 * F32_2_0
  const sigmaR = F32_24_0 * (F32_1_0 - strength) + F32_8_0
  const invR = F32_1_0 / (F32_2_0 * sigmaR * sigmaR)
  const weights = fA  // (2r+1)^2 weights, r = 2
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = <f32>(dx * dx + dy * dy)
      weights[(dy + radius) * (radius * 2 + 1) + (dx + radius)] = Mathf.exp(-d2 / (F32_2_0 * sigmaS2))
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = idx(x, y, w)
      const cr = <f32>src[o]
      const cg = <f32>src[o + 1]
      const cb = <f32>src[o + 2]
      let sr: f32 = F32_0_0
      let sg: f32 = F32_0_0
      let sb: f32 = F32_0_0
      let sw: f32 = F32_0_0
      for (let dy = -radius; dy <= radius; dy++) {
        let sy = y + dy
        if (sy < 0) sy = 0
        if (sy > h - 1) sy = h - 1
        for (let dx = -radius; dx <= radius; dx++) {
          let sx = x + dx
          if (sx < 0) sx = 0
          if (sx > w - 1) sx = w - 1
          const p = idx(sx, sy, w)
          const dr = <f32>src[p] - cr
          const dg = <f32>src[p + 1] - cg
          const db = <f32>src[p + 2] - cb
          const wr = Mathf.exp(-(dr * dr + dg * dg + db * db) * invR)
          const wt = weights[(dy + radius) * (radius * 2 + 1) + (dx + radius)] * wr
          sr += <f32>src[p] * wt
          sg += <f32>src[p + 1] * wt
          sb += <f32>src[p + 2] * wt
          sw += wt
        }
      }
      if (sw <= F32_0_0) sw = F32_1_0
      imgA[o] = <u8>clamp255(sr / sw)
      imgA[o + 1] = <u8>clamp255(sg / sw)
      imgA[o + 2] = <u8>clamp255(sb / sw)
    }
  }
  // Deblocking across the 8-pixel grid.
  const deblock = clampf(strength, F32_0_0, F32_1_0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mx = x % 8
      const my = y % 8
      if (mx != 0 && mx != 7 && my != 0 && my != 7) continue
      const o = idx(x, y, w)
      let sr: f32 = F32_0_0
      let sg: f32 = F32_0_0
      let sb: f32 = F32_0_0
      let sw: f32 = F32_0_0
      for (let dy = -1; dy <= 1; dy++) {
        let sy = y + dy
        if (sy < 0) sy = 0
        if (sy > h - 1) sy = h - 1
        for (let dx = -1; dx <= 1; dx++) {
          let sx = x + dx
          if (sx < 0) sx = 0
          if (sx > w - 1) sx = w - 1
          const p = idx(sx, sy, w)
          const md: i32 = iabs(dx) + iabs(dy) + 1
          const wt = F32_1_0 / <f32>md
          sr += <f32>imgA[p] * wt
          sg += <f32>imgA[p + 1] * wt
          sb += <f32>imgA[p + 2] * wt
          sw += wt
        }
      }
      if (sw <= F32_0_0) sw = F32_1_0
      imgA[o] = <u8>clamp255(<f32>imgA[o] * (F32_1_0 - deblock) + (sr / sw) * deblock)
      imgA[o + 1] = <u8>clamp255(<f32>imgA[o + 1] * (F32_1_0 - deblock) + (sg / sw) * deblock)
      imgA[o + 2] = <u8>clamp255(<f32>imgA[o + 2] * (F32_1_0 - deblock) + (sb / sw) * deblock)
    }
  }
}

// ----------------------------------------------------------- resampling -----

@inline function cubicWeight(x: f32, B: f32, C: f32): f32 {
  const ax = Mathf.abs(x)
  if (ax < F32_1_0) {
    return ((F32_12_0 - F32_9_0 * B - F32_6_0 * C) * ax * ax * ax + (-F32_18_0 + F32_12_0 * B + F32_6_0 * C) * ax * ax + (F32_6_0 - F32_2_0 * B)) / F32_6_0
  }
  if (ax < F32_2_0) {
    return ((-B - F32_6_0 * C) * ax * ax * ax + (F32_6_0 * B + F32_30_0 * C) * ax * ax + (-F32_12_0 * B - F32_48_0 * C) * ax + (F32_8_0 * B + F32_24_0 * C)) / F32_6_0
  }
  return F32_0_0
}

/**
 * High quality resampling for the Upsample / "Resample" command.
 * mode: 0 = bilinear, 1 = bicubic (Catmull-Rom), 2 = Mitchell (upsampling),
 *       3 = box average (clean downsampling).
 */
export function resample(sw: i32, sh: i32, dw: i32, dh: i32, mode: i32): void {
  const src = imgA
  const dst = imgB
  const invW: f32 = <f32>sw / <f32>dw
  const invH: f32 = <f32>sh / <f32>dh
  const down = dw < sw || dh < sh
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) << 2
      if (mode == 3 && down) {
        let x0 = <i32>(<f32>x * invW)
        let y0 = <i32>(<f32>y * invH)
        let x1 = <i32>(<f32>(x + 1) * invW) + 1
        let y1 = <i32>(<f32>(y + 1) * invH) + 1
        if (x1 > sw) x1 = sw
        if (y1 > sh) y1 = sh
        let sr: f32 = F32_0_0
        let sg: f32 = F32_0_0
        let sb: f32 = F32_0_0
        let sa: f32 = F32_0_0
        let n: f32 = F32_0_0
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const p = idx(xx, yy, sw)
            sr += <f32>src[p]
            sg += <f32>src[p + 1]
            sb += <f32>src[p + 2]
            sa += <f32>src[p + 3]
            n += F32_1_0
          }
        }
        if (n < F32_1_0) n = F32_1_0
        dst[o] = <u8>clamp255(sr / n)
        dst[o + 1] = <u8>clamp255(sg / n)
        dst[o + 2] = <u8>clamp255(sb / n)
        dst[o + 3] = <u8>clamp255(sa / n)
        continue
      }
      const fx = (<f32>x + F32_0_5) * invW - F32_0_5
      const fy = (<f32>y + F32_0_5) * invH - F32_0_5
      const x0 = <i32>Mathf.floor(fx)
      const y0 = <i32>Mathf.floor(fy)
      const tx = fx - <f32>x0
      const ty = fy - <f32>y0
      if (mode == 0) {
        let xa = x0
        let xb = x0 + 1
        let ya = y0
        let yb = y0 + 1
        if (xa < 0) xa = 0
        if (xa > sw - 1) xa = sw - 1
        if (xb < 0) xb = 0
        if (xb > sw - 1) xb = sw - 1
        if (ya < 0) ya = 0
        if (ya > sh - 1) ya = sh - 1
        if (yb < 0) yb = 0
        if (yb > sh - 1) yb = sh - 1
        const p00 = idx(xa, ya, sw)
        const p10 = idx(xb, ya, sw)
        const p01 = idx(xa, yb, sw)
        const p11 = idx(xb, yb, sw)
        for (let k = 0; k < 4; k++) {
          dst[o + k] = <u8>clamp255(bilerp(<f32>src[p00 + k], <f32>src[p10 + k], <f32>src[p01 + k], <f32>src[p11 + k], tx, ty))
        }
        continue
      }
      const B: f32 = mode == 2 ? F32_0_3333333333 : F32_0_0
      const C: f32 = mode == 2 ? F32_0_3333333333 : F32_0_5
      let acc0: f32 = F32_0_0
      let acc1: f32 = F32_0_0
      let acc2: f32 = F32_0_0
      let acc3: f32 = F32_0_0
      let wsum: f32 = F32_0_0
      for (let j = -1; j <= 2; j++) {
        const wy = cubicWeight(<f32>j - ty, B, C)
        if (wy == F32_0_0) continue
        let sy = y0 + j
        if (sy < 0) sy = 0
        if (sy > sh - 1) sy = sh - 1
        for (let i = -1; i <= 2; i++) {
          const wx = cubicWeight(<f32>i - tx, B, C)
          if (wx == F32_0_0) continue
          let sx = x0 + i
          if (sx < 0) sx = 0
          if (sx > sw - 1) sx = sw - 1
          const wt = wx * wy
          const p = idx(sx, sy, sw)
          acc0 += <f32>src[p] * wt
          acc1 += <f32>src[p + 1] * wt
          acc2 += <f32>src[p + 2] * wt
          acc3 += <f32>src[p + 3] * wt
          wsum += wt
        }
      }
      if (wsum == F32_0_0) wsum = F32_1_0
      dst[o] = <u8>clamp255(acc0 / wsum)
      dst[o + 1] = <u8>clamp255(acc1 / wsum)
      dst[o + 2] = <u8>clamp255(acc2 / wsum)
      dst[o + 3] = <u8>clamp255(acc3 / wsum)
    }
  }
}

// ----------------------------------------------------------- selection ------

/**
 * Magic-wand / flood select. `tolerance` 0..255 per channel; `contiguous` 0 matches
 * the whole image. Writes a 0/1 mask into `out` and returns the number of pixels hit.
 */
export function floodSelect(w: i32, h: i32, sx: i32, sy: i32, tolerance: f32, contiguous: i32): i32 {
  const data = imgA
  const out = maskA
  const count = w * h
  let cx = sx
  let cy = sy
  if (cx < 0) cx = 0
  if (cy < 0) cy = 0
  if (cx > w - 1) cx = w - 1
  if (cy > h - 1) cy = h - 1
  const start = idx(cx, cy, w)
  const tr = <f32>imgA[start]
  const tg = <f32>imgA[start + 1]
  const tb = <f32>imgA[start + 2]
  const ta = <f32>imgA[start + 3]
  for (let i = 0; i < count; i++) out[i] = 0
  let hits = 0
  if (contiguous == 0) {
    for (let p = 0; p < count; p++) {
      const o = p << 2
      if (Mathf.abs(<f32>imgA[o] - tr) <= tolerance && Mathf.abs(<f32>imgA[o + 1] - tg) <= tolerance
        && Mathf.abs(<f32>imgA[o + 2] - tb) <= tolerance && Mathf.abs(<f32>imgA[o + 3] - ta) <= tolerance) {
        out[p] = 1
        hits++
      }
    }
    return hits
  }
  const stack = iB  // scratch stack, same capacity as iA
  const mark = maskB
  for (let i = 0; i < count; i++) mark[i] = 0
  let sp = 0
  stack[sp++] = cy * w + cx
  while (sp > 0) {
    const p = stack[--sp]
    if (mark[p] != 0) continue
    mark[p] = 1
    const o = p << 2
    if (Mathf.abs(<f32>imgA[o] - tr) > tolerance) continue
    if (Mathf.abs(<f32>imgA[o + 1] - tg) > tolerance) continue
    if (Mathf.abs(<f32>imgA[o + 2] - tb) > tolerance) continue
    if (Mathf.abs(<f32>imgA[o + 3] - ta) > tolerance) continue
    out[p] = 1
    hits++
    const x = p % w
    if (x > 0) stack[sp++] = p - 1
    if (x < w - 1) stack[sp++] = p + 1
    if (p >= w) stack[sp++] = p - w
    if (p < count - w) stack[sp++] = p + w
  }
  return hits
}

/** Morphological dilate (1) / erode (0) with a square kernel. */
export function maskMorph(w: i32, h: i32, radius: i32, dilate: i32): void {
  if (radius < 1) return
  const mask = maskA
  const n = w * h
  const src = maskB
  for (let i = 0; i < n; i++) src[i] = mask[i]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best: i32 = dilate != 0 ? 0 : 255
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy
        if (sy < 0 || sy >= h) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx
          if (sx < 0 || sx >= w) continue
          const v = <i32>src[sy * w + sx]
          if (dilate != 0) {
            if (v > best) best = v
          } else {
            if (v < best) best = v
          }
        }
      }
      mask[y * w + x] = <u8>best
    }
  }
}

/** Feather / refine a mask edge with a separable box blur. */
export function maskFeather(w: i32, h: i32, radius: i32): void {
  if (radius < 1) return
  const mask = maskA
  const tmp = fA
  const n = <f32>(radius * 2 + 1)
  for (let y = 0; y < h; y++) {
    let acc: f32 = F32_0_0
    for (let k = -radius; k <= radius; k++) {
      let sx = k
      if (sx < 0) sx = 0
      if (sx > w - 1) sx = w - 1
      acc += <f32>mask[y * w + sx]
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n
      let outX = x - radius
      if (outX < 0) outX = 0
      let inX = x + radius + 1
      if (inX > w - 1) inX = w - 1
      acc += <f32>mask[y * w + inX] - <f32>mask[y * w + outX]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc: f32 = F32_0_0
    for (let k = -radius; k <= radius; k++) {
      let sy = k
      if (sy < 0) sy = 0
      if (sy > h - 1) sy = h - 1
      acc += tmp[sy * w + x]
    }
    for (let y = 0; y < h; y++) {
      mask[y * w + x] = <u8>clamp255(acc / n)
      let outY = y - radius
      if (outY < 0) outY = 0
      let inY = y + radius + 1
      if (inY > h - 1) inY = h - 1
      acc += tmp[inY * w + x] - tmp[outY * w + x]
    }
  }
}

/** Multiply the alpha by the mask (keepAlpha) or erase where the mask is 0. */
export function applyMask(count: i32, invert: i32, keepAlpha: i32): void {
  const data = imgA
  const mask = maskA
  for (let p = 0; p < count; p++) {
    const raw = mask[p] as i32
    const m = invert != 0 ? 255 - raw : raw
    const o = p << 2
    if (keepAlpha != 0) {
      imgA[o + 3] = <u8>clamp255(<f32>imgA[o + 3] * (<f32>m / F32_255_0))
    } else if (m == 0) {
      imgA[o] = 0
      imgA[o + 1] = 0
      imgA[o + 2] = 0
      imgA[o + 3] = 0
    }
  }
}

// -------------------------------------------------------------- liquify -----

/**
 * Accumulate one liquify "dab" into a displacement map.
 * mode: 0 push (vx,vy), 1 twirl, 2 pinch/bloat, 3 restore (erases the map).
 */
export function buildLiquifyMap(w: i32, h: i32, cx: f32, cy: f32, radius: f32, strength: f32, mode: i32, vx: f32, vy: f32): void {
  const mapDx = fA
  const mapDy = fB
  const r2 = radius * radius
  let x0 = <i32>(cx - radius)
  let x1 = <i32>(cx + radius)
  let y0 = <i32>(cy - radius)
  let y1 = <i32>(cy + radius)
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x1 > w - 1) x1 = w - 1
  if (y1 > h - 1) y1 = h - 1
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = <f32>x - cx
      const dy = <f32>y - cy
      const d2 = dx * dx + dy * dy
      if (d2 > r2) continue
      const dist = Mathf.sqrt(d2)
      const falloff = F32_1_0 - dist / radius
      const wgt = falloff * falloff * strength
      const p = y * w + x
      if (mode == 0) {
        mapDx[p] += vx * wgt
        mapDy[p] += vy * wgt
      } else if (mode == 1) {
        const ang = wgt * F32_3_0
        const ca = Mathf.cos(ang)
        const sa = Mathf.sin(ang)
        mapDx[p] += dx * ca - dy * sa - dx
        mapDy[p] += dx * sa + dy * ca - dy
      } else if (mode == 2) {
        mapDx[p] += dx * wgt * F32_1_2
        mapDy[p] += dy * wgt * F32_1_2
      } else {
        let keep = F32_1_0 - wgt * F32_2_0
        if (keep < F32_0_0) keep = F32_0_0
        mapDx[p] *= keep
        mapDy[p] *= keep
      }
    }
  }
}

/** Apply a displacement map with bilinear sampling (liquify, distortion, turbulence). */
export function applyDisplacementMap(w: i32, h: i32): void {
  const src = imgA
  const dst = imgB
  const mapDx = fA
  const mapDy = fB
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      let sx = <f32>x + mapDx[p]
      let sy = <f32>y + mapDy[p]
      if (sx < F32_0_0) sx = F32_0_0
      if (sy < F32_0_0) sy = F32_0_0
      if (sx > <f32>(w - 1)) sx = <f32>(w - 1)
      if (sy > <f32>(h - 1)) sy = <f32>(h - 1)
      const ix = <i32>sx
      const iy = <i32>sy
      const tx = sx - <f32>ix
      const ty = sy - <f32>iy
      let ix1 = ix + 1
      let iy1 = iy + 1
      if (ix1 > w - 1) ix1 = w - 1
      if (iy1 > h - 1) iy1 = h - 1
      const p00 = idx(ix, iy, w)
      const p10 = idx(ix1, iy, w)
      const p01 = idx(ix, iy1, w)
      const p11 = idx(ix1, iy1, w)
      const o = p << 2
      for (let k = 0; k < 4; k++) {
        dst[o + k] = <u8>clamp255(bilerp(<f32>src[p00 + k], <f32>src[p10 + k], <f32>src[p01 + k], <f32>src[p11 + k], tx, ty))
      }
    }
  }
}

// ---------------------------------------------------------- compositing -----

/** Porter-Duff source-over of straight-alpha RGBA `src` onto `dst`. */
export function alphaCompositeOver(opacity: f32, pixelCount: i32): void {
  const dst = imgA
  const src = imgB
  const n = pixelCount << 2
  for (let i = 0; i < n; i += 4) {
    const sa = (<f32>src[i + 3] / F32_255_0) * opacity
    if (sa <= F32_0_0) continue
    const da = <f32>dst[i + 3] / F32_255_0
    const outA = sa + da * (F32_1_0 - sa)
    if (outA <= F32_0_0) {
      dst[i] = 0
      dst[i + 1] = 0
      dst[i + 2] = 0
      dst[i + 3] = 0
      continue
    }
    for (let k = 0; k < 3; k++) {
      const sc = <f32>src[i + k] / F32_255_0
      const dc = <f32>dst[i + k] / F32_255_0
      dst[i + k] = <u8>clamp255(((sc * sa + dc * da * (F32_1_0 - sa)) / outA) * F32_255_0)
    }
    dst[i + 3] = <u8>clamp255(outA * F32_255_0)
  }
}

/**
 * Blend a layer with the standard separable/non-separable blend set (PDF 32000-1 §F32_11_3.5).
 * mode: 0 normal, 1 multiply, 2 screen, 3 overlay, 4 darken, 5 lighten, 6 color-dodge,
 *       7 color-burn, 8 hard-light, 9 soft-light, 10 difference, 11 exclusion,
 *       12 hue, 13 saturation, 14 color, 15 luminosity.
 */
export function blendLayer(mode: i32, opacity: f32, pixelCount: i32): void {
  const dst = imgA
  const src = imgB
  const n = pixelCount << 2
  const tri = new Float32Array(3)
  const outTri = new Float32Array(6)
  for (let i = 0; i < n; i += 4) {
    const sr = <f32>src[i] / F32_255_0
    const sg = <f32>src[i + 1] / F32_255_0
    const sb = <f32>src[i + 2] / F32_255_0
    const sa = (<f32>src[i + 3] / F32_255_0) * opacity
    if (sa <= F32_0_0) continue
    const dr = <f32>dst[i] / F32_255_0
    const dg = <f32>dst[i + 1] / F32_255_0
    const db = <f32>dst[i + 2] / F32_255_0
    const da = <f32>dst[i + 3] / F32_255_0
    let br = sr
    let bg = sg
    let bb = sb
    if (mode == 1) {
      br = sr * dr
      bg = sg * dg
      bb = sb * db
    } else if (mode == 2) {
      br = F32_1_0 - (F32_1_0 - sr) * (F32_1_0 - dr)
      bg = F32_1_0 - (F32_1_0 - sg) * (F32_1_0 - dg)
      bb = F32_1_0 - (F32_1_0 - sb) * (F32_1_0 - db)
    } else if (mode == 3) {
      br = dr <= F32_0_5 ? F32_2_0 * sr * dr : F32_1_0 - F32_2_0 * (F32_1_0 - sr) * (F32_1_0 - dr)
      bg = dg <= F32_0_5 ? F32_2_0 * sg * dg : F32_1_0 - F32_2_0 * (F32_1_0 - sg) * (F32_1_0 - dg)
      bb = db <= F32_0_5 ? F32_2_0 * sb * db : F32_1_0 - F32_2_0 * (F32_1_0 - sb) * (F32_1_0 - db)
    } else if (mode == 4) {
      br = Mathf.min(sr, dr)
      bg = Mathf.min(sg, dg)
      bb = Mathf.min(sb, db)
    } else if (mode == 5) {
      br = Mathf.max(sr, dr)
      bg = Mathf.max(sg, dg)
      bb = Mathf.max(sb, db)
    } else if (mode == 6) {
      br = dodge(sr, dr)
      bg = dodge(sg, dg)
      bb = dodge(sb, db)
    } else if (mode == 7) {
      br = burn(sr, dr)
      bg = burn(sg, dg)
      bb = burn(sb, db)
    } else if (mode == 8) {
      br = hardLight(sr, dr)
      bg = hardLight(sg, dg)
      bb = hardLight(sb, db)
    } else if (mode == 9) {
      br = softLight(sr, dr)
      bg = softLight(sg, dg)
      bb = softLight(sb, db)
    } else if (mode == 10) {
      br = Mathf.abs(sr - dr)
      bg = Mathf.abs(sg - dg)
      bb = Mathf.abs(sb - db)
    } else if (mode == 11) {
      br = sr + dr - F32_2_0 * sr * dr
      bg = sg + dg - F32_2_0 * sg * dg
      bb = sb + db - F32_2_0 * sb * db
    } else if (mode == 12) {
      // hue: source hue+saturation, backdrop luminance
      tri[0] = sr
      tri[1] = sg
      tri[2] = sb
      setSaturation(tri, satOf(dr, dg, db))
      setLuminance(tri, lumf(dr, dg, db), outTri)
      br = outTri[0]
      bg = outTri[1]
      bb = outTri[2]
    } else if (mode == 13) {
      // saturation: source saturation, backdrop hue+luminance
      tri[0] = dr
      tri[1] = dg
      tri[2] = db
      setSaturation(tri, satOf(sr, sg, sb))
      setLuminance(tri, lumf(dr, dg, db), outTri)
      br = outTri[0]
      bg = outTri[1]
      bb = outTri[2]
    } else if (mode == 14) {
      // color: source hue+saturation, backdrop luminance
      tri[0] = sr
      tri[1] = sg
      tri[2] = sb
      setLuminance(tri, lumf(dr, dg, db), outTri)
      br = outTri[0]
      bg = outTri[1]
      bb = outTri[2]
    } else if (mode == 15) {
      // luminosity: source luminance, backdrop hue+saturation
      tri[0] = dr
      tri[1] = dg
      tri[2] = db
      setLuminance(tri, lumf(sr, sg, sb), outTri)
      br = outTri[0]
      bg = outTri[1]
      bb = outTri[2]
    }
    const outR = br * sa + dr * da * (F32_1_0 - sa)
    const outG = bg * sa + dg * da * (F32_1_0 - sa)
    const outB = bb * sa + db * da * (F32_1_0 - sa)
    const outA = sa + da * (F32_1_0 - sa)
    if (outA <= F32_0_0) {
      dst[i] = 0
      dst[i + 1] = 0
      dst[i + 2] = 0
      dst[i + 3] = 0
      continue
    }
    dst[i] = <u8>clamp255((outR / outA) * F32_255_0)
    dst[i + 1] = <u8>clamp255((outG / outA) * F32_255_0)
    dst[i + 2] = <u8>clamp255((outB / outA) * F32_255_0)
    dst[i + 3] = <u8>clamp255(outA * F32_255_0)
  }
}

@inline function hardLight(s: f32, d: f32): f32 {
  return s <= F32_0_5 ? F32_2_0 * s * d : F32_1_0 - F32_2_0 * (F32_1_0 - s) * (F32_1_0 - d)
}

@inline function dodge(s: f32, d: f32): f32 {
  if (s >= F32_1_0) return F32_1_0
  return Mathf.min(F32_1_0, d / (F32_1_0 - s))
}

@inline function burn(s: f32, d: f32): f32 {
  if (s <= F32_0_0) return F32_0_0
  return F32_1_0 - Mathf.min(F32_1_0, (F32_1_0 - d) / s)
}

@inline function softLight(s: f32, d: f32): f32 {
  if (s <= F32_0_5) return d - (F32_1_0 - F32_2_0 * s) * d * (F32_1_0 - d)
  const dd = d <= F32_0_25 ? ((F32_16_0 * d - F32_12_0) * d + F32_4_0) * d : Mathf.sqrt(d)
  return d + (F32_2_0 * s - F32_1_0) * (dd - d)
}

@inline function satOf(r: f32, g: f32, b: f32): f32 {
  return Mathf.max(r, Mathf.max(g, b)) - Mathf.min(r, Mathf.min(g, b))
}

/** SetSaturation from the PDF blend spec, in place on a 3-float triple. */
function setSaturation(t: Float32Array, s: f32): void {
  const r = t[0]
  const g = t[1]
  const b = t[2]
  const mn = Mathf.min(r, Mathf.min(g, b))
  const mx = Mathf.max(r, Mathf.max(g, b))
  if (mx <= mn) {
    t[0] = F32_0_0
    t[1] = F32_0_0
    t[2] = F32_0_0
    return
  }
  const mid = r > mn && r < mx ? r : (g > mn && g < mx ? g : b)
  const scaled = ((mid - mn) * s) / (mx - mn)
  t[0] = r == mn ? F32_0_0 : (r == mx ? s : scaled)
  t[1] = g == mn ? F32_0_0 : (g == mx ? s : scaled)
  t[2] = b == mn ? F32_0_0 : (b == mx ? s : scaled)
}

/** SetLuminance with the spec's clipping step; writes into `out` (offset 3). */
function setLuminance(t: Float32Array, l: f32, out: Float32Array): void {
  const d = l - lumf(t[0], t[1], t[2])
  let r = t[0] + d
  let g = t[1] + d
  let b = t[2] + d
  const l2 = lumf(r, g, b)
  const n = Mathf.min(r, Mathf.min(g, b))
  const x = Mathf.max(r, Mathf.max(g, b))
  if (n < F32_0_0) {
    const f = l2 / (l2 - n + F32_0_0000001)
    r = l2 + (r - l2) * f
    g = l2 + (g - l2) * f
    b = l2 + (b - l2) * f
  }
  if (x > F32_1_0) {
    const f = (F32_1_0 - l2) / (x - l2 + F32_0_0000001)
    r = l2 + (r - l2) * f
    g = l2 + (g - l2) * f
    b = l2 + (b - l2) * f
  }
  out[0] = r
  out[1] = g
  out[2] = b
}

// ------------------------------------------------------------ analyzing -----

/**
 * Bounding box of everything that differs from the corner-sampled background by
 * more than `tolerance`. out = [minX, minY, maxX, maxY, pixelCount].
 */
export function subjectBounds(w: i32, h: i32, tolerance: f32): void {
  const data = imgA
  const out = iA
  const corners = iB
  corners[0] = 0
  corners[1] = (w - 1) << 2
  corners[2] = ((h - 1) * w) << 2
  corners[3] = (((h - 1) * w) + w - 1) << 2
  let br: f32 = F32_0_0
  let bg: f32 = F32_0_0
  let bb: f32 = F32_0_0
  for (let c = 0; c < 4; c++) {
    br += <f32>imgA[corners[c]]
    bg += <f32>imgA[corners[c] + 1]
    bb += <f32>imgA[corners[c] + 2]
  }
  br /= F32_4_0
  bg /= F32_4_0
  bb /= F32_4_0
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = idx(x, y, w)
      if (imgA[o + 3] < 8) continue
      const d = Mathf.abs(<f32>imgA[o] - br) + Mathf.abs(<f32>imgA[o + 1] - bg) + Mathf.abs(<f32>imgA[o + 2] - bb)
      if (d <= tolerance) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      count++
    }
  }
  const found = maxX >= 0
  out[0] = found ? minX : 0
  out[1] = found ? minY : 0
  out[2] = found ? maxX : w - 1
  out[3] = found ? maxY : h - 1
  out[4] = count
}

/** Mean colour of the opaque pixels — used by the eyedropper average and palette tools. */
export function averageColor(length: i32): void {
  const data = imgA
  const out = fA
  let r: f64 = F32_0_0
  let g: f64 = F32_0_0
  let b: f64 = F32_0_0
  let n: f64 = F32_0_0
  for (let i = 0; i < length; i += 4) {
    if (imgA[i + 3] < 8) continue
    r += <f64>imgA[i]
    g += <f64>imgA[i + 1]
    b += <f64>imgA[i + 2]
    n += F32_1_0
  }
  if (n == F32_0_0) n = F32_1_0
  out[0] = <f32>(r / n)
  out[1] = <f32>(g / n)
  out[2] = <f32>(b / n)
}

/**
 * Deterministic median-cut style palette extraction over a 5-bit-per-channel
 * histogram (32768 buckets). No random seeding, so results are reproducible.
 */
export function extractPalette(length: i32, count: i32): void {
  const data = imgA
  const out = small
  const buckets = iA
  const used = iB
  for (let i = 0; i < 32768; i++) {
    buckets[i] = 0
    used[i] = 0
  }
  for (let i = 0; i < length; i += 4) {
    if (imgA[i + 3] < 8) continue
    const key = (<i32>(imgA[i] >> 3) << 10) | (<i32>(imgA[i + 1] >> 3) << 5) | <i32>(imgA[i + 2] >> 3)
    buckets[key] += 1
  }
  const chosen = fB   // 32 colours x 3 channels
  const maxColors = Math.min(count, 32)
  for (let c = 0; c < maxColors; c++) {
    let bestKey = -1
    let bestScore: f64 = -F32_1_0
    for (let k = 0; k < 32768; k++) {
      const hits = buckets[k]
      if (hits == 0 || used[k] != 0) continue
      const r = <f32>((k >> 10) & 31) * F32_8_0 + F32_4_0
      const g = <f32>((k >> 5) & 31) * F32_8_0 + F32_4_0
      const b = <f32>(k & 31) * F32_8_0 + F32_4_0
      let nearest: f64 = 1.0e18
      for (let j = 0; j < c; j++) {
        const pr = chosen[j * 3]
        const pg = chosen[j * 3 + 1]
        const pb = chosen[j * 3 + 2]
        const dd = <f64>((r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb))
        if (dd < nearest) nearest = dd
      }
      const score = <f64>hits * nearest
      if (score > bestScore) {
        bestScore = score
        bestKey = k
      }
    }
    if (bestKey < 0) {
      out[c * 3] = 0
      out[c * 3 + 1] = 0
      out[c * 3 + 2] = 0
      continue
    }
    used[bestKey] = 1
    const r = <f32>((bestKey >> 10) & 31) * F32_8_0 + F32_4_0
    const g = <f32>((bestKey >> 5) & 31) * F32_8_0 + F32_4_0
    const b = <f32>(bestKey & 31) * F32_8_0 + F32_4_0
    chosen[c * 3] = r
    chosen[c * 3 + 1] = g
    chosen[c * 3 + 2] = b
    out[c * 3] = <u8>clamp255(r)
    out[c * 3 + 1] = <u8>clamp255(g)
    out[c * 3 + 2] = <u8>clamp255(b)
  }
}

/**
 * Vector trace: threshold, then 8-connected contour walking. Emits closed rings as
 * packed (x,y) i32 pairs, each ring terminated by (-1,-1). Returns the number of
 * i32 values written; the JS side simplifies with Douglas-Peucker and fits beziers.
 */
export function traceContours(w: i32, h: i32, threshold: i32, maxOut: i32): i32 {
  const data = imgA
  const out = iA
  const n = w * h
  const mask = maskA
  const visited = maskB
  for (let p = 0; p < n; p++) {
    const o = p << 2
    const a = <f32>imgA[o + 3] / F32_255_0
    mask[p] = sampleLum(data, o) * a >= <f32>threshold ? 1 : 0
    visited[p] = 0
  }
  const dxs = iB   // dxs occupies [0..7], dys [8..15]; rings go to iA
  dxs[0] = 1
  dxs[1] = 1
  dxs[2] = 0
  dxs[3] = -1
  dxs[4] = -1
  dxs[5] = -1
  dxs[6] = 0
  dxs[7] = 1
  dxs[8] = 0
  dxs[9] = 1
  dxs[10] = 1
  dxs[11] = 1
  dxs[12] = 0
  dxs[13] = -1
  dxs[14] = -1
  dxs[15] = -1
  // dys lives at dxs[8..15] to avoid a second buffer

  let written = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const start = y * w + x
      if (mask[start] == 0 || visited[start] != 0) continue
      if (mask[start - 1] != 0 && mask[start + 1] != 0 && mask[start - w] != 0 && mask[start + w] != 0) continue
      let cx = x
      let cy = y
      let dir = 0
      let steps = 0
      let count = 0
      const maxSteps = n * 2
      const startIndex = written
      while (steps < maxSteps) {
        steps++
        visited[cy * w + cx] = 1
        if (written + 2 > maxOut) return written
        out[written++] = cx
        out[written++] = cy
        count++
        let found = false
        for (let k = 0; k < 8; k++) {
          const d = (dir + 6 + k) % 8
          const nx = cx + dxs[d]
          const ny = cy + dxs[8 + d]
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          if (mask[ny * w + nx] == 0) continue
          cx = nx
          cy = ny
          dir = d
          found = true
          break
        }
        if (!found) break
        if (cx == x && cy == y) break
      }
      if (written + 2 > maxOut) return written
      out[written++] = -1
      out[written++] = -1
      if (count < 12) written = startIndex // drop specks
    }
  }
  return written
}

/** Douglas-Peucker simplification over packed (x,y) i32 pairs. Returns retained pairs. */
export function simplifyPath(count: i32, epsilon: f32): i32 {
  const pts = iA
  const out = iB
  if (count < 3) {
    for (let i = 0; i < count; i++) {
      out[i * 2] = pts[i * 2]
      out[i * 2 + 1] = pts[i * 2 + 1]
    }
    return count
  }
  const keep = maskB
  for (let i = 0; i < count; i++) keep[i] = 0
  keep[0] = 1
  keep[count - 1] = 1
  const stack = iB
  let sp = 0
  stack[sp++] = 0
  stack[sp++] = count - 1
  while (sp >= 2) {
    const end = stack[--sp]
    const start = stack[--sp]
    if (end <= start + 1) continue
    const ax = <f32>pts[start * 2]
    const ay = <f32>pts[start * 2 + 1]
    const bx = <f32>pts[end * 2]
    const by = <f32>pts[end * 2 + 1]
    const vx = bx - ax
    const vy = by - ay
    const vlen2 = vx * vx + vy * vy
    let maxD: f32 = -F32_1_0
    let maxI = -1
    for (let i = start + 1; i < end; i++) {
      const px = <f32>pts[i * 2]
      const py = <f32>pts[i * 2 + 1]
      let d: f32
      if (vlen2 == F32_0_0) {
        d = Mathf.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay))
      } else {
        let t = ((px - ax) * vx + (py - ay) * vy) / vlen2
        t = clampf(t, F32_0_0, F32_1_0)
        const ddx = px - (ax + t * vx)
        const ddy = py - (ay + t * vy)
        d = Mathf.sqrt(ddx * ddx + ddy * ddy)
      }
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > epsilon && maxI > 0 && sp < count * 4 - 4) {
      keep[maxI] = 1
      stack[sp++] = start
      stack[sp++] = maxI
      stack[sp++] = maxI
      stack[sp++] = end
    }
  }
  let n2 = 0
  for (let i = 0; i < count; i++) {
    if (keep[i] != 0) {
      out[n2 * 2] = pts[i * 2]
      out[n2 * 2 + 1] = pts[i * 2 + 1]
      n2++
    }
  }
  return n2
}

/** Block-shadow silhouette: replicas of the mask offset by (dx,dy) for `steps` copies. */
export function blockShadowMask(w: i32, h: i32, dx: i32, dy: i32, steps: i32): void {
  const mask = maskA
  const out = maskB
  const n = w * h
  for (let i = 0; i < n; i++) out[i] = mask[i]
  for (let s = 1; s <= steps; s++) {
    const ox = dx * s
    const oy = dy * s
    for (let y = 0; y < h; y++) {
      const sy = y - oy
      if (sy < 0 || sy >= h) continue
      for (let x = 0; x < w; x++) {
        if (mask[sy * w + x] == 0) continue
        const tx = x + ox
        if (tx < 0 || tx >= w) continue
        out[y * w + tx] = 255
      }
    }
  }
}

/** Turn a mask into a premultiplied colour layer (colour = [r,g,b,a] as 0..255 floats). */
export function renderShadow(w: i32, h: i32, cr: f32, cg: f32, cb: f32, ca: f32): void {
  const mask = maskA
  const out = imgB
  const n = w * h
  for (let p = 0; p < n; p++) {
    const o = p << 2
    out[o] = <u8>clamp255(cr)
    out[o + 1] = <u8>clamp255(cg)
    out[o + 2] = <u8>clamp255(cb)
    out[o + 3] = <u8>clamp255(<f32>mask[p] * (ca / F32_255_0))
  }
}

/** Perspective warp through a row-major 3x3 homography (used by Interactive Perspective). */
export function perspectiveWarp(sw: i32, sh: i32, dw: i32, dh: i32): void {
  const src = imgA
  const dst = imgB
  const homography = fA
  const h0 = homography[0]
  const h1 = homography[1]
  const h2 = homography[2]
  const h3 = homography[3]
  const h4 = homography[4]
  const h5 = homography[5]
  const h6 = homography[6]
  const h7 = homography[7]
  const h8 = homography[8]
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const wgt = h6 * <f32>x + h7 * <f32>y + h8
      const o = idx(x, y, dw)
      if (wgt == F32_0_0) {
        dst[o + 3] = 0
        continue
      }
      const sx = (h0 * <f32>x + h1 * <f32>y + h2) / wgt
      const sy = (h3 * <f32>x + h4 * <f32>y + h5) / wgt
      if (sx < F32_0_0 || sy < F32_0_0 || sx >= <f32>(sw - 1) || sy >= <f32>(sh - 1)) {
        dst[o] = 0
        dst[o + 1] = 0
        dst[o + 2] = 0
        dst[o + 3] = 0
        continue
      }
      const ix = <i32>sx
      const iy = <i32>sy
      const tx = sx - <f32>ix
      const ty = sy - <f32>iy
      const p00 = idx(ix, iy, sw)
      const p10 = idx(ix + 1, iy, sw)
      const p01 = idx(ix, iy + 1, sw)
      const p11 = idx(ix + 1, iy + 1, sw)
      for (let k = 0; k < 4; k++) {
        dst[o + k] = <u8>clamp255(bilerp(<f32>src[p00 + k], <f32>src[p10 + k], <f32>src[p01 + k], <f32>src[p11 + k], tx, ty))
      }
    }
  }
}

/** One-euro style adaptive smoothing for LiveSketch / Vector Smoothing / Freehand. */
export function smoothStroke(count: i32, minCutoff: f32, beta: f32): void {
  if (count < 2) return
  const xs = fA
  const ys = fB
  let prevX = xs[0]
  let prevY = ys[0]
  for (let i = 1; i < count; i++) {
    const ddx = xs[i] - prevX
    const ddy = ys[i] - prevY
    const dist = Mathf.sqrt(ddx * ddx + ddy * ddy)
    const cutoff = minCutoff + beta * dist
    const alpha = F32_1_0 / (F32_1_0 + cutoff)
    prevX = prevX + alpha * (xs[i] - prevX)
    prevY = prevY + alpha * (ys[i] - prevY)
    xs[i] = prevX
    ys[i] = prevY
  }
}
