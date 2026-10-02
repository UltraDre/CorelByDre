/**
 * The left toolbox: one button per tool group, with CorelDRAW-style flyouts for
 * every tool in the group. Long-press, right-click or the corner marker opens
 * the flyout; picking a tool makes it that group's primary button.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/store'
import { TOOLS, TOOL_GROUPS, TOOLBOX_ORDER, toolDef, type ToolID } from '../tools/registry'

function ToolIcon({ id }: { id: ToolID }) {
  return <span dangerouslySetInnerHTML={{ __html: TOOLS[id].icon }} style={{ display: 'inline-flex', width: 20, height: 20 }} />
}

export function Toolbox() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [primary, setPrimary] = useState<Record<string, ToolID>>(() =>
    Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g.tools[0]])),
  )
  const holdTimer = useRef<number | null>(null)
  const toolboxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (toolboxRef.current && !toolboxRef.current.contains(e.target as Node)) setOpenGroup(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <div className="toolbox" ref={toolboxRef}>
      {TOOLBOX_ORDER.map((groupId, index) => {
        const group = TOOL_GROUPS.find((g) => g.id === groupId)!
        const primaryId = group.tools.includes(primary[groupId]) ? primary[groupId] : group.tools[0]
        const def = toolDef(primaryId)
        const isOpen = openGroup === groupId
        return (
          <div key={groupId} style={{ position: 'relative' }}>
            {index === 4 || index === 7 || index === 11 ? <div className="group-sep" /> : null}
            <button
              type="button"
              className={`tool ${tool === def.id ? 'active' : ''}`}
              title={`${def.label}${def.shortcut ? ` (${def.shortcut})` : ''} — ${def.hint}`}
              onClick={() => setTool(def.id)}
              onContextMenu={(e) => { e.preventDefault(); setOpenGroup(isOpen ? null : groupId) }}
              onPointerDown={() => {
                holdTimer.current = window.setTimeout(() => setOpenGroup(groupId), 320)
              }}
              onPointerUp={() => { if (holdTimer.current) window.clearTimeout(holdTimer.current) }}
              onPointerLeave={() => { if (holdTimer.current) window.clearTimeout(holdTimer.current) }}
            >
              <ToolIcon id={def.id} />
              {group.tools.length > 1 ? <span className="flyout-mark" /> : null}
            </button>
            {group.tools.length > 1 ? (
              <button
                type="button"
                aria-label={`${group.label} flyout`}
                title={`${group.label} — ${group.tools.length} tools`}
                onClick={() => setOpenGroup(isOpen ? null : groupId)}
                style={{
                  position: 'absolute', right: 0, bottom: 0, width: 12, height: 12,
                  background: 'transparent', border: 0, padding: 0,
                }}
              />
            ) : null}
            {isOpen ? (
              <div className="tool-flyout" style={{ top: 0 }}>
                {group.tools.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`tool ${tool === id ? 'active' : ''}`}
                    title={`${TOOLS[id].label}${TOOLS[id].shortcut ? ` (${TOOLS[id].shortcut})` : ''} — ${TOOLS[id].hint}`}
                    onClick={() => {
                      setPrimary((p) => ({ ...p, [groupId]: id }))
                      setTool(id)
                      setOpenGroup(null)
                    }}
                  >
                    <ToolIcon id={id} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
