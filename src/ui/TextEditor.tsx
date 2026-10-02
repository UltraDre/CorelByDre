/**
 * In-place text editor overlay. Renders a textarea positioned over the text
 * object with matching metrics; edits are committed as a single undo step on
 * blur, Enter-with-modifier or Escape.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useStore } from '../store/store'
import { updateObjects } from '../store/mutations'
import { css } from '../lib/color'
import type { Page, TextObject, ViewState } from '../types'

export function TextEditor({ object }: { object: TextObject }) {
  const view = useStore((s) => s.view)
  const doc = useStore((s) => s.doc)
  const commit = useStore((s) => s.commit)
  const setEditingText = useStore((s) => s.setEditingText)
  const [value, setValue] = useState(object.content)
  const ref = useRef<HTMLTextAreaElement>(null)
  const cancelRef = useRef(false)

  const page: Page | undefined = useMemo(() => doc.pages.find((p) => p.id === doc.activePageId), [doc])
  const style = object.style

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.focus()
    element.select()
  }, [object.id])

  const commitValue = () => {
    if (cancelRef.current) { setEditingText(null); return }
    if (value !== object.content) {
      const next = value
      commit('Edit text', (d) => updateObjects(d, [object.id], (o) => (o.kind === 'text' ? { ...o, content: next } : o)))
    }
    setEditingText(null)
  }

  // Keep the overlay anchored while the view pans/zooms.
  const zoom = view.zoom
  const rulerOffset = view.showRulers ? 20 : 0
  const frame = object.mode === 'paragraph'
    ? object.frame
    : {
        x: object.frame.x,
        y: object.frame.y,
        w: Math.max(object.frame.w || 60, value.length * style.fontSize * 0.55),
        h: style.fontSize * style.lineHeight * Math.max(1, value.split('\n').length),
      }
  const originX = frame.x + object.transform.e
  const originY = frame.y + object.transform.f

  const box: CSSProperties = {
    position: 'absolute',
    left: rulerOffset + originX * zoom + view.panX,
    top: rulerOffset + originY * zoom + view.panY,
    width: Math.max(80, frame.w * zoom),
    minHeight: Math.max(22, frame.h * zoom),
    fontFamily: `'${style.fontFamily}', var(--ui-font)`,
    fontSize: Math.max(6, style.fontSize * zoom),
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing * zoom,
    color: css(style.color),
    textAlign: style.align === 'justify' || style.align === 'force' ? 'justify' : style.align,
    textTransform: style.caps === 'all' ? 'uppercase' : 'none',
    background: 'rgba(18,161,154,0.08)',
    border: '1px solid var(--accent)',
    outline: 'none',
    resize: 'none',
    padding: 0,
    overflow: 'hidden',
    caretColor: 'var(--accent)',
    whiteSpace: object.mode === 'paragraph' ? 'pre-wrap' : 'pre',
  }

  return (
    <>
      <textarea
        ref={ref}
        className="text-editor"
        style={box}
        value={value}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commitValue}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            cancelRef.current = true
            cancelRef.current = false
            setEditingText(null)
            return
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
      <div className="text-editor-hint">
        Esc to finish · {page ? page.name : ''} · {object.mode === 'artistic' ? 'Artistic text' : 'Paragraph text'}
      </div>
    </>
  )
}
