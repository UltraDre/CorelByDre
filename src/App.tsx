/**
 * Application root.
 *
 * Mounts the shell and wires the things that must exist before the first paint:
 * the theme, the service-worker update prompt and the "restore last session"
 * check for people who close the tab mid-document.
 */
import { useEffect, useState } from 'react'
import { AppShell } from './ui/AppShell'
import { useCollab } from './store/collab'
import { useStore } from './store/store'
import { restoreLastSession } from './ui/fileOps'

export default function App() {
  const theme = useStore((s) => s.theme)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void useCollab.getState().init()
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    let cancelled = false
    // Offer to reopen the last document; never block the UI on it.
    void restoreLastSession()
      .then((restored) => {
        if (cancelled) return
        if (restored) {
          useStore.getState().toast('info', 'Restored your last document', 'Autosaved locally a few seconds ago.')
        }
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onController = () => {
      useStore.getState().toast('success', 'Update ready', 'CorelByDre has been updated in the background. Reload to use the newest version.')
    }
    navigator.serviceWorker.addEventListener('controllerchange', onController)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onController)
  }, [])

  if (!ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--text-dim)' }}>
        <span>Starting CorelByDre…</span>
      </div>
    )
  }
  return <AppShell />
}
