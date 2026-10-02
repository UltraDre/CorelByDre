/**
 * Reusable UI primitives: fields, sliders, popovers, the colour picker, the
 * tone-curve editor and the docker container, plus toast/modal plumbing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useStore, type DockerID } from '../store/store'
import { Icon, type IconName } from './icons'
import { PALETTES, hex, hsvToRgb, parseHex, rgbToHsv, css } from '../lib/color'
import type { CurvePoint, RGBA } from '../types'
import { clamp } from '../lib/util'

/* ------------------------------------------------------------- primitives -- */

export function Row({ children, className = '', wrap = false, gap, style }: {
  children: ReactNode
  className?: string
  wrap?: boolean
  gap?: number
  style?: CSSProperties
}) {
  return (
    <div className={`row ${wrap ? 'wrap' : ''} ${className}`} style={gap !== undefined || style ? { gap, ...style } : undefined}>
      {children}
    </div>
  )
}

export function Col({ children, className = '', gap, style }: {
  children: ReactNode
  className?: string
  gap?: number
  style?: CSSProperties
}) {
  return (
    <div className={`col ${className}`} style={gap !== undefined || style ? { gap, ...style } : undefined}>
      {children}
    </div>
  )
}

export function Button({
  children, onClick, variant = 'default', active = false, disabled = false, title, icon, small = false,
}: {
  children?: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  active?: boolean
  disabled?: boolean
  title?: string
  icon?: IconName
  small?: boolean
}) {
  return (
    <button
      type="button"
      className={`btn ${variant !== 'default' ? variant : ''} ${active ? 'active' : ''} ${small ? 'small' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon ? <Icon name={icon} size={small ? 13 : 15} /> : null}
      {children}
    </button>
  )
}

export function IconButton({ icon, onClick, title, active, disabled }: { icon: IconName; onClick?: () => void; title?: string; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={`btn icon ${active ? 'active' : ''}`} onClick={onClick} title={title} aria-label={title} disabled={disabled}>
      <Icon name={icon} size={15} />
    </button>
  )
}

export function Labeled({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`row ${wide ? 'grow' : ''}`} style={wide ? undefined : { justifyContent: 'space-between' }}>
      <span className="lbl">{label}</span>
      {children}
    </label>
  )
}

export function Slider({
  label, value, min, max, step = 1, onChange, unit, format,
}: {
  label?: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  unit?: string
  format?: (v: number) => string
}) {
  return (
    <div className="col" style={{ gap: 2 }}>
      {label !== undefined ? (
        <div className="row between">
          <span className="lbl">{label}</span>
          <span className="tiny mono">{format ? format(value) : round(value, step)}{unit ?? ''}</span>
        </div>
      ) : null}
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

function round(v: number, step: number): string {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return v.toFixed(digits)
}

export function NumberField({
  value, onChange, min, max, step = 1, width = 62, suffix,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  width?: number
  suffix?: string
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value])
  const commit = () => {
    const parsed = Number.parseFloat(draft)
    if (Number.isFinite(parsed)) onChange(clamp(parsed, min ?? -Infinity, max ?? Infinity))
    else setDraft(String(value))
  }
  return (
    <span className="row" style={{ gap: 3 }}>
      <input
        className="field num"
        style={{ width }}
        value={draft}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp') { e.preventDefault(); onChange(clamp(value + step, min ?? -Infinity, max ?? Infinity)) }
          if (e.key === 'ArrowDown') { e.preventDefault(); onChange(clamp(value - step, min ?? -Infinity, max ?? Infinity)) }
        }}
      />
      {suffix ? <span className="tiny">{suffix}</span> : null}
    </span>
  )
}

export function Select<T extends string | number>({
  value, options, onChange, width,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  width?: number | string
}) {
  return (
    <select className="field" style={{ width }} value={String(value)} onChange={(e) => {
      const found = options.find((o) => String(o.value) === e.target.value)
      if (found) onChange(found.value)
    }}>
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
      ))}
    </select>
  )
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 6 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="lbl">{label}</span>
    </label>
  )
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs">
      {options.map((o) => (
        <button key={o.value} type="button" className={`tab ${o.value === value ? 'active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------- popover --- */

export function Popover({ label, icon, children, align = 'left' }: { label: string; icon?: IconName; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div className="menu" ref={ref} style={{ padding: 0 }}>
      <button type="button" className="btn small" onClick={() => setOpen((o) => !o)}>
        {icon ? <Icon name={icon} size={13} /> : null}
        {label}
        <Icon name="chevron" size={11} />
      </button>
      {open ? (
        <div className={`menu-popup ${align === 'right' ? 'right' : ''}`} style={{ left: align === 'right' ? 'auto' : 0, right: align === 'right' ? 0 : 'auto', minWidth: 220 }}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

/* ----------------------------------------------------------- color picker -- */

const RECENT_SWATCHES: RGBA[] = [
  rgbL(0, 0, 0), rgbL(255, 255, 255), rgbL(127, 127, 127), rgbL(18, 161, 154), rgbL(200, 16, 46),
  rgbL(0, 87, 184), rgbL(247, 148, 29), rgbL(141, 198, 63), rgbL(146, 39, 143), rgbL(0, 169, 157),
]

function rgbL(r: number, g: number, b: number, a = 1): RGBA {
  return { r, g, b, a }
}

export function ColorSwatch({ color, size = 24, onClick, title }: { color: RGBA; size?: number; onClick?: () => void; title?: string }) {
  return <button type="button" className="swatch" title={title} onClick={onClick} style={{ width: size, height: size, background: css(color) }} />
}

export function ColorPicker({ value, onChange, showAlpha = true, showPalettes = true }: { value: RGBA; onChange: (c: RGBA) => void; showAlpha?: boolean; showPalettes?: boolean }) {
  const hsv = useMemo(() => rgbToHsv(value), [value])
  const [hue, setHue] = useState(hsv.h)
  const [sat, setSat] = useState(hsv.s)
  const [val, setVal] = useState(hsv.v)
  const areaRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef(false)

  useEffect(() => {
    const next = rgbToHsv(value)
    setHue(next.h)
    setSat(next.s)
    setVal(next.v)
  }, [value.r, value.g, value.b]) // eslint-disable-line react-hooks/exhaustive-deps

  const emit = useCallback((h: number, s: number, v: number, a = value.a) => {
    onChange(hsvToRgb(h, s, v, a))
  }, [onChange, value.a])

  useEffect(() => {
    const canvas = areaRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const w = canvas.width
    const h = canvas.height
    ctx.fillStyle = `hsl(${hue} 100% 50%)`
    ctx.fillRect(0, 0, w, h)
    const white = ctx.createLinearGradient(0, 0, w, 0)
    white.addColorStop(0, 'rgba(255,255,255,1)')
    white.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = white
    ctx.fillRect(0, 0, w, h)
    const black = ctx.createLinearGradient(0, 0, 0, h)
    black.addColorStop(0, 'rgba(0,0,0,0)')
    black.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.fillStyle = black
    ctx.fillRect(0, 0, w, h)
    // cursor
    const cx = sat * w
    const cy = (1 - val) * h
    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.strokeStyle = val > 0.6 ? '#111' : '#fff'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [hue, sat, val])

  const pickFrom = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const s = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    const v = 1 - clamp((e.clientY - rect.top) / rect.height, 0, 1)
    setSat(s)
    setVal(v)
    emit(hue, s, v)
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      <canvas
        ref={areaRef}
        className="knob"
        width={220}
        height={140}
        onPointerDown={(e) => {
          dragRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          pickFrom(e)
        }}
        onPointerMove={(e) => dragRef.current && pickFrom(e)}
        onPointerUp={() => { dragRef.current = false }}
      />
      <div className="row">
        <ColorSwatch color={value} size={30} />
        <div className="col grow" style={{ gap: 4 }}>
          <input
            className="slider"
            type="range"
            min={0}
            max={360}
            value={hue}
            onChange={(e) => { const h = Number(e.target.value); setHue(h); emit(h, sat, val) }}
            style={{ background: 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)', borderRadius: 3 }}
          />
          {showAlpha ? (
            <input
              className="slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={value.a}
              onChange={(e) => onChange({ ...value, a: Number(e.target.value) })}
            />
          ) : null}
        </div>
      </div>
      <div className="row">
        <input
          className="field mono grow"
          value={hex(value)}
          onChange={(e) => {
            const parsed = parseHex(e.target.value)
            if (parsed) onChange(parsed)
          }}
        />
        <NumberField value={Math.round(value.a * 100)} min={0} max={100} onChange={(v) => onChange({ ...value, a: v / 100 })} width={48} suffix="%" />
      </div>
      <div className="swatch-row">
        {RECENT_SWATCHES.map((c, i) => (
          <button key={i} type="button" className="swatch-pick" style={{ background: css(c) }} onClick={() => onChange({ ...c, a: value.a })} title={hex(c)} />
        ))}
      </div>
      {showPalettes ? (
        <div className="col" style={{ gap: 6, maxHeight: 208, overflow: 'auto' }}>
          {PALETTES.slice(0, 6).map((palette) => (
            <div key={palette.id} className="col" style={{ gap: 3 }}>
              <span className="tiny">{palette.name} · {palette.colors.length}</span>
              <div className="swatch-row">
                {palette.colors.slice(0, 40).map((c, i) => {
                  const parsed = parseHex(c)
                  return (
                    <button key={i} type="button" className="swatch-pick" style={{ background: c }} title={c} onClick={() => onChange(parsed)} />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ curve editor -- */

export function CurveEditor({ points, onChange, channelColor = '#12a19a' }: { points: CurvePoint[]; onChange: (points: CurvePoint[]) => void; channelColor?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [drag, setDrag] = useState<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(128,128,128,0.08)'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(128,128,128,0.25)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      ctx.beginPath()
      ctx.moveTo((w / 4) * i, 0)
      ctx.lineTo((w / 4) * i, h)
      ctx.moveTo(0, (h / 4) * i)
      ctx.lineTo(w, (h / 4) * i)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.moveTo(0, h)
    ctx.lineTo(w, 0)
    ctx.strokeStyle = 'rgba(128,128,128,0.35)'
    ctx.stroke()
    // Curve through the control points (monotone-ish cubic).
    const sorted = [...points].sort((a, b) => a.x - b.x)
    ctx.beginPath()
    ctx.strokeStyle = channelColor
    ctx.lineWidth = 2
    for (let i = 0; i <= 64; i++) {
      const x = i / 64
      const y = splineAt(sorted, x)
      const px = x * w
      const py = h - y * h
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    for (const p of sorted) {
      ctx.beginPath()
      ctx.arc(p.x * w, h - p.y * h, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'
      ctx.fill()
      ctx.strokeStyle = channelColor
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }, [points, channelColor])

  const toValue = (e: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1),
    }
  }

  return (
    <canvas
      ref={canvasRef}
      className="curve-editor"
      width={280}
      height={150}
      onPointerDown={(e) => {
        const p = toValue(e)
        e.currentTarget.setPointerCapture(e.pointerId)
        const sorted = [...points].sort((a, b) => a.x - b.x)
        let index = sorted.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.05)
        if (index < 0) {
          index = sorted.findIndex((q) => q.x > p.x)
          if (index < 0) index = sorted.length
          sorted.splice(index, 0, p)
          setDrag(index)
          onChange(sorted)
          return
        }
        setDrag(index)
      }}
      onPointerMove={(e) => {
        if (drag === null) return
        const p = toValue(e)
        const sorted = [...points].sort((a, b) => a.x - b.x).map((q, i) => (i === drag ? { x: p.x, y: p.y } : q))
        onChange(sorted)
      }}
      onPointerUp={() => setDrag(null)}
      onDoubleClick={(e) => {
        const p = toValue(e)
        const sorted = [...points].sort((a, b) => a.x - b.x)
        const index = sorted.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.06)
        if (index > 0 && index < sorted.length - 1) {
          sorted.splice(index, 1)
          onChange(sorted)
        }
      }}
    />
  )
}

/** Natural-ish cubic interpolation of control points, matching the kernel LUT. */
export function splineAt(sorted: CurvePoint[], x: number): number {
  if (!sorted.length) return x
  if (x <= sorted[0].x) return sorted[0].y
  if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y
  let i = 0
  while (i < sorted.length - 2 && x > sorted[i + 1].x) i++
  const p0 = sorted[Math.max(0, i - 1)]
  const p1 = sorted[i]
  const p2 = sorted[i + 1]
  const p3 = sorted[Math.min(sorted.length - 1, i + 2)]
  const t = (x - p1.x) / Math.max(1e-6, p2.x - p1.x)
  const t2 = t * t
  const t3 = t2 * t
  return clamp(
    0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    0,
    1,
  )
}

export function Histogram({ bins, height = 64, channels }: { bins: Int32Array; height?: number; channels?: [Int32Array, Int32Array, Int32Array] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    let max = 1
    for (let i = 1; i < 255; i++) max = Math.max(max, bins[i] ?? 0)
    if (channels) {
      const colors = ['rgba(226,96,74,0.62)', 'rgba(76,175,125,0.62)', 'rgba(80,140,235,0.62)']
      channels.forEach((set, ci) => {
        ctx.fillStyle = colors[ci]
        for (let i = 0; i < 256; i++) {
          const bar = ((set[i] ?? 0) / max) * h
          ctx.fillRect((i / 256) * w, h - bar, Math.max(1, w / 256), bar)
        }
      })
      return
    }
    ctx.fillStyle = 'rgba(154,167,180,0.75)'
    for (let i = 0; i < 256; i++) {
      const bar = ((bins[i] ?? 0) / max) * h
      ctx.fillRect((i / 256) * w, h - bar, Math.max(1, w / 256), bar)
    }
  }, [bins, channels])
  return <canvas ref={ref} className="histogram" width={268} height={height} />
}

/* ---------------------------------------------------------------- docker --- */

export function Docker({ title, children, defaultOpen = true }: { id?: DockerID; title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen)
  return (
    <section className="docker">
      <header className="docker-head" onClick={() => setExpanded((v) => !v)}>
        <h3>{title}</h3>
        <span className="chev">{expanded ? '▾' : '▸'}</span>
      </header>
      {expanded ? <div className="docker-body">{children}</div> : null}
    </section>
  )
}

export function Modal({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="close" title="Close" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  useEffect(() => {
    if (!toasts.length) return
    const timers = toasts.map((t) => window.setTimeout(() => dismiss(t.id), 5200))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [toasts, dismiss])
  if (!toasts.length) return null
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} role="status">
          <strong>{t.text}</strong>
          {t.detail ? <p>{t.detail}</p> : null}
        </div>
      ))}
    </div>
  )
}

export function EmptyState({ text, icon = 'info' }: { text: string; icon?: IconName }) {
  return (
    <div className="col center" style={{ gap: 6, padding: '10px 0', color: 'var(--text-faint)' }}>
      <Icon name={icon} size={20} />
      <span className="tiny">{text}</span>
    </div>
  )
}

/** Labelled single-line / read-only text field with commit-on-blur/Enter. */
export function TextField({ label, value, onChange, onCommit, placeholder, readOnly = false, type = 'text' }: {
  label?: string
  value: string
  onChange: (next: string) => void
  onCommit?: (next: string) => void
  placeholder?: string
  readOnly?: boolean
  type?: 'text' | 'number' | 'color'
}) {
  return (
    <Labeled label={label ?? ''} wide>
      <input
        className="field"
        type={type}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onCommit?.((e.target as HTMLInputElement).value) }}
      />
    </Labeled>
  )
}

/** Switch-style checkbox used across the dockers. */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {label ? <span className="lbl">{label}</span> : null}
    </label>
  )
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>
}

export { splineAt as curveInterpolate }
