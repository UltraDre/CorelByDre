/**
 * Application root.
 *
 * Mounts the shell and wires the things that must exist before the first paint:
 * the theme, the service-worker update prompt and the "restore last session"
 * check for people who close the tab mid-document.
 *
 * Liveness rule: nothing here may block the editor from painting. Session
 * restore is a nicety, so it is raced against a short deadline — if local
 * storage is blocked, partitioned or simply slow (sandboxed embeds, private
 * browsing, a cold IndexedDB upgrade), the workspace opens anyway instead of
 * leaving the user staring at a splash screen forever.
 */
import { useEffect, useState } from 'react'
import { AppShell } from './ui/AppShell'
import { useCollab } from './store/collab'
import { useStore } from './store/store'
import { restoreLastSession } from './ui/fileOps'
import { DB_TIMEOUT, storageAvailable } from './lib/storage'

/** Long enough for a warm IndexedDB read, short enough that nobody waits on it. */
const RESTORE_BUDGET_MS = 1_500

export default function App() {
  const theme = useStore((s) => s.theme)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Collaboration is optional and offline-first; a failure here must never
    // surface as an unhandled rejection or a stalled boot.
    void useCollab.getState().init().catch((error) => {
      console.warn('[CorelByDre] collaboration unavailable', error)
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    let cancelled = false
    let painted = false
    let warned = false

    // Only take over the session while the user is still on the untouched home
    // screen. Once they have created or opened a document, a late restore from
    // slow storage must not clobber what they are doing.
    const initialDocId = useStore.getState().doc.id
    const shouldApply = () => {
      const s = useStore.getState()
      return s.homeVisible && s.doc.id === initialDocId && !s.dirty
    }

    const paint = () => {
      if (cancelled || painted) return
      painted = true
      setReady(true)
    }

    // Autosave, recents and the offline history all need local storage, so say
    // so once — but only after the capability probe has actually concluded.
    const warnIfBlocked = () => {
      if (cancelled || warned || storageAvailable()) return
      warned = true
      useStore.getState().toast(
        'warn',
        'Local storage is blocked',
        'Editing works normally, but autosave and recent files are unavailable in this context. Use Save or Export to keep your work.',
      )
    }

    // Hard deadline: paint the editor even if the restore never settles.
    const deadline = setTimeout(paint, RESTORE_BUDGET_MS)
    // If the deadline wins, storage is still being probed — re-check once the
    // IndexedDB guard has had time to reach a verdict.
    const probe = setTimeout(warnIfBlocked, RESTORE_BUDGET_MS + DB_TIMEOUT + 500)

    void restoreLastSession(shouldApply)
      .then((restored) => {
        clearTimeout(deadline)
        paint()
        warnIfBlocked()
        if (restored && !cancelled) {
          useStore.getState().toast('info', 'Restored your last document', 'Autosaved locally a few seconds ago.')
        }
      })
      .catch((error) => {
        clearTimeout(deadline)
        console.warn('[CorelByDre] could not restore the last session', error)
        paint()
        warnIfBlocked()
      })

    return () => { cancelled = true; clearTimeout(deadline); clearTimeout(probe) }
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
      <div className="boot" role="status" aria-live="polite">
        <span className="boot-mark" aria-hidden="true" />
        <span>Starting CorelByDre…</span>
      </div>
    )
  }
  return <AppShell />
}
