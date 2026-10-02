/**
 * Entry point. Registers the service worker, loads the WASM kernels, wires the
 * font catalogue and mounts the editor.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { loadKernels } from './lib/wasm'
import { registerGlyphParser } from './engine/render'
import { fonts } from './lib/text'
import { parseSvgPath } from './lib/text'

/* Glyph outlines come from the font module; the renderer only needs the parser. */
registerGlyphParser((d: string) => parseSvgPath(d))

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/* Kernels load in the background so first paint is never blocked. */
void loadKernels().then((status) => {
  if (status !== 'ready') {
    // The JS fallbacks are complete, so this is informational only.
    console.info('[CorelByDre] WASM kernels unavailable — using the JavaScript fallbacks.')
  }
})

/* Warm the font catalogue: bundled families first, the full Google library only
   when we are online (offline editing never depends on this call). */
if (navigator.onLine) void fonts.fetchGoogleCatalog().catch(() => 0)
console.info(`[CorelByDre] ${fonts.list().length} font families available offline`)

/* Service worker: offline shell + background sync for export jobs. */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[CorelByDre] Service worker registration failed', error)
    })
  })
}

export {}
