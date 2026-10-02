#!/usr/bin/env node
/**
 * Compiles the AssemblyScript kernels to public/wasm/kernels.wasm.
 * If the toolchain is unavailable or the compile fails, we keep any previously
 * built artifact and emit a clear warning — the app degrades to its pure-JS
 * fallback rather than breaking the build.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public/wasm')
const outFile = resolve(outDir, 'kernels.wasm')
mkdirSync(outDir, { recursive: true })

const target = resolve(root, 'node_modules/assemblyscript/bin/asc.js')
if (!existsSync(target)) {
  console.warn('[wasm] assemblyscript not installed — skipping kernel build (JS fallback active).')
  process.exit(0)
}

const args = [
  target,
  resolve(root, 'wasm/kernels.ts'),
  '--outFile', outFile,
  '--optimizeLevel', '3',
  '--shrinkLevel', '1',
  '--runtime', 'stub',
  '--exportRuntime',
  '--initialMemory', '64',
  '--maximumMemory', '2048',
  '--noAssert',
  '--enable', 'bulk-memory',
]

try {
  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: root })
  const size = statSync(outFile).size
  console.log(`[wasm] kernels.wasm built — ${(size / 1024).toFixed(1)} KiB`)
} catch (error) {
  console.warn('[wasm] Build failed; keeping the JS fallback path.', error?.message ?? error)
}
