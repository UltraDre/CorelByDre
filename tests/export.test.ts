import { describe, expect, it } from 'vitest'
import { createDocument, createTextObject, createVector, rectPathData } from '../src/store/mutations'
import { exportCDR, exportDXF, exportEPS, exportSVG, DEFAULT_EXPORT } from '../src/lib/export'
import { importCDR, importDXF, importFile, importSVG, inspectCDR } from '../src/lib/import'
import { rgb } from '../src/lib/color'
import type { Document } from '../src/types'

function docWithArt(): Document {
  const doc = createDocument('Export test')
  const page = doc.pages[0]
  const layer = page.layers[0]
  layer.objects.push(createVector({
    path: rectPathData(20, 30, 120, 80),
    primitive: { type: 'rect', w: 120, h: 80, r: 0, corners: [1, 1, 1, 1] },
    fill: { type: 'uniform', color: rgb(200, 16, 46) },
  }))
  const text = createTextObject('artistic', 'CorelByDre', { x: 40, y: 200, w: 200, h: 40 })
  text.transform = { a: 1, b: 0, c: 0, d: 1, e: 40, f: 200 }
  layer.objects.push(text)
  return doc
}

describe('vector export', () => {
  it('writes a valid SVG with the document geometry', () => {
    const doc = docWithArt()
    const svg = exportSVG(doc, doc.pages[0], DEFAULT_EXPORT)
    expect(svg.startsWith('<?xml')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('#c8102e')
    expect(svg).toMatch(/<path d="M/)
    expect(svg).toContain('CorelByDre')
    expect(svg).toContain('</svg>')
  })

  it('adds crop marks and colour bars when asked', () => {
    const doc = docWithArt()
    const svg = exportSVG(doc, doc.pages[0], { ...DEFAULT_EXPORT, marks: { crop: true, registration: true, colourBars: true, pageInfo: true } })
    expect(svg).toContain('#000000')
    expect(svg.split('<rect').length).toBeGreaterThan(3)
  })

  it('emits EPS with a bounding box and PostScript operators', () => {
    const doc = docWithArt()
    const eps = exportEPS(doc, doc.pages[0], DEFAULT_EXPORT)
    expect(eps).toContain('%!PS-Adobe-3.0 EPSF-3.0')
    expect(eps).toMatch(/%%BoundingBox: -?\d+ -?\d+ -?\d+ -?\d+/)
    expect(eps).toContain('curveto')
    expect(eps).toContain('showpage')
  })

  it('emits DXF polylines that close and terminate properly', () => {
    const doc = docWithArt()
    const dxf = exportDXF(doc, doc.pages[0])
    expect(dxf).toContain('SECTION')
    expect(dxf).toContain('LWPOLYLINE')
    expect(dxf.trim().endsWith('EOF')).toBe(true)
  })
})

describe('import', () => {
  it('reads SVG shapes, transforms and text', async () => {
    const svg = `<?xml version="1.0"?>
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
        <g transform="translate(10 10)">
          <rect x="0" y="0" width="50" height="30" fill="#ff0000"/>
          <circle cx="100" cy="60" r="20" fill="none" stroke="#00ff00" stroke-width="2"/>
          <path d="M10 100 C 40 60, 90 60, 120 100" fill="none" stroke="#000000"/>
          <polygon points="150,10 180,10 165,40" fill="#0000ff"/>
        </g>
        <text x="20" y="110" font-size="14" font-family="Arial" fill="#333333">Hello</text>
      </svg>`
    const result = await importSVG(svg, 'fixture')
    expect(result.warnings).toHaveLength(0)
    expect(result.stats.objects).toBe(5)
    expect(result.stats.text).toBe(1)
    expect(result.document.pages[0].size.w).toBeCloseTo(200, 1)
    const objects = result.document.pages[0].layers[0].objects
    const rect = objects[0]
    expect(rect.kind).toBe('vector')
    if (rect.kind === 'vector') {
      expect(rect.fill).toEqual({ type: 'uniform', color: { r: 255, g: 0, b: 0, a: 1 } })
    }
    // The group transform is carried onto the imported object.
    expect(rect.transform.e).toBe(10)
  })

  it('imports DXF lines into page space with Y flipped', async () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '0', '70', '1', '10', '0', '20', '0', '10', '100', '20', '0', '10', '100', '20', '60', '0', 'ENDSEC', '0', 'EOF'].join('\n')
    const result = await importDXF(dxf, 'fixture')
    expect(result.stats.objects).toBe(1)
    const obj = result.document.pages[0].layers[0].objects[0]
    expect(obj.kind).toBe('vector')
    if (obj.kind === 'vector') {
      expect(obj.path.subpaths[0].closed).toBe(true)
      expect(obj.path.subpaths[0].nodes).toHaveLength(3)
    }
  })

  it('reports unsupported SVG content instead of silently dropping it', async () => {
    const result = await importSVG('<svg xmlns="http://www.w3.org/2000/svg"><image href="photo.png" width="10" height="10"/></svg>', 'images')
    expect(result.warnings.join(' ')).toMatch(/external image/i)
  })

  it('saves, inspects, opens and imports CorelDRAW (.cdr) files with full fidelity', async () => {
    const doc = docWithArt()
    const cdrBytes = exportCDR(doc)
    expect(String.fromCharCode(cdrBytes[0], cdrBytes[1], cdrBytes[2], cdrBytes[3])).toBe('RIFF')
    expect(String.fromCharCode(cdrBytes[8], cdrBytes[9], cdrBytes[10], cdrBytes[11])).toBe('CDR ')

    const inspected = await inspectCDR(cdrBytes)
    expect(inspected.info.format).toBe('riff')
    expect(inspected.info.chunks.some((c) => c.id === 'vrsn')).toBe(true)
    expect(inspected.info.chunks.some((c) => c.id === 'CBD ')).toBe(true)
    expect(inspected.info.chunks.some((c) => c.id === 'SVG ')).toBe(true)

    const imported = await importCDR(cdrBytes, 'RoundtripCDR')
    expect(imported.warnings).toHaveLength(0)
    expect(imported.stats.objects).toBe(2)
    expect(imported.stats.text).toBe(1)
    expect(imported.document.pages[0].layers[0].objects).toHaveLength(2)

    const cdrFile = new File([cdrBytes as unknown as BlobPart], 'poster.cdr', { type: 'application/vnd.corel-draw' })
    const fileImported = await importFile(cdrFile)
    expect(fileImported.warnings).toHaveLength(0)
    expect(fileImported.stats.objects).toBe(2)
    expect(fileImported.document.pages[0].layers[0].objects[0].kind).toBe('vector')
  })

  it('imports legacy RIFF CDR containers with raw vrsn/loda chunks into editable objects', async () => {
    // Minimal RIFF 'CDR ' container with a 'vrsn' chunk and a 'loda' object chunk
    const buf = new Uint8Array(32)
    const view = new DataView(buf.buffer)
    buf.set([0x52, 0x49, 0x46, 0x46], 0) // 'RIFF'
    view.setUint32(4, 24, true)
    buf.set([0x43, 0x44, 0x52, 0x20], 8) // 'CDR '
    buf.set([0x76, 0x72, 0x73, 0x6e], 12) // 'vrsn'
    view.setUint32(16, 2, true)
    view.setUint16(20, 1500, true)
    buf.set([0x6c, 0x6f, 0x64, 0x61], 22) // 'loda'
    view.setUint32(26, 2, true)
    view.setUint16(30, 1, true)

    const result = await importCDR(buf, 'LegacyFile')
    expect(result.warnings).toHaveLength(0)
    expect(result.stats.objects).toBeGreaterThanOrEqual(1)
    expect(result.document.pages[0].layers[0].objects.length).toBeGreaterThanOrEqual(1)
  })
})

