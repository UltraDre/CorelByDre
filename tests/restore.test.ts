/**
 * Session restore.
 *
 * `restoreLastSession` gained a `shouldApply` guard so a restore that arrives
 * after the boot deadline cannot clobber work the user already started. These
 * pin down both halves: a normal restore still works, and a late one yields.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocument } from '../src/store/mutations'
import type { Document } from '../src/types'

const saved = createDocument('Saved work')
let storedPayload: string | null = JSON.stringify(saved)

vi.mock('../src/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    loadMeta: async (key: string) => (key === 'lastDocument' && storedPayload ? 'doc-1' : undefined),
    loadDocumentLocal: async (id: string) =>
      storedPayload && id === 'doc-1'
        ? { id, name: 'Saved work', modifiedAt: Date.now(), size: storedPayload.length, pageCount: 1, payload: storedPayload }
        : undefined,
  }
})

const { restoreLastSession } = await import('../src/ui/fileOps')
const { useStore } = await import('../src/store/store')

beforeEach(() => {
  storedPayload = JSON.stringify(saved)
  const s = useStore.getState()
  s.replaceDocument(createDocument('Untitled-1'), { markClean: true })
  s.setHome(true)
})

describe('restoreLastSession', () => {
  it('reopens the saved document on a fresh boot', async () => {
    const before = useStore.getState().doc.id
    const restored = await restoreLastSession()

    expect(restored).toBe(true)
    const s = useStore.getState()
    expect(s.doc.name).toBe('Saved work')
    expect(s.doc.id).not.toBe(before)
    expect(s.homeVisible).toBe(false)
    expect(s.dirty).toBe(false)
  })

  it('returns false when nothing was autosaved', async () => {
    storedPayload = null
    await expect(restoreLastSession()).resolves.toBe(false)
  })

  it('does not clobber work the user started while storage was slow', async () => {
    // The user clicked "New document" during the boot deadline.
    const userDoc = createDocument('User started this')
    useStore.getState().replaceDocument(userDoc, { markClean: true })
    useStore.getState().setHome(false)

    const restored = await restoreLastSession(() => useStore.getState().homeVisible)

    expect(restored).toBe(false)
    expect(useStore.getState().doc.name).toBe('User started this')
  })

  it('honours a shouldApply predicate that turns false mid-flight', async () => {
    let allow = true
    const promise = restoreLastSession(() => allow)
    allow = false // the user acted before storage answered
    await expect(promise).resolves.toBe(false)
    expect(useStore.getState().doc.name).toBe('Untitled-1')
  })

  it('yields a document the editor can open', async () => {
    await restoreLastSession()
    const doc: Document = useStore.getState().doc
    expect(doc.pages.length).toBeGreaterThan(0)
    const page = doc.pages.find((p) => p.id === doc.activePageId) ?? doc.pages[0]
    expect(page).toBeTruthy()
    expect(page.layers.length).toBeGreaterThan(0)
  })
})
