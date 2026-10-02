/**
 * Storage resilience.
 *
 * The editor must never hang on local persistence. These cover the three ways
 * IndexedDB fails in the wild: absent, throwing on access, and — the one that
 * produced a permanently blank app — present but never settling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** A request whose callbacks are never invoked: the real-world hang. */
function hangingIndexedDB() {
  const req = {
    result: undefined, error: null,
    onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  }
  return { open: () => req, deleteDatabase: () => req, databases: async () => [], cmp: () => 0 }
}

function throwingIndexedDB() {
  return {
    open: () => { throw new DOMException('The operation is insecure.', 'SecurityError') },
    deleteDatabase: () => { throw new DOMException('nope', 'SecurityError') },
  }
}

/** Fresh module instance per case: the bridge memoises its failure state. */
async function loadStorage() {
  vi.resetModules()
  return import('../src/lib/storage')
}

function setIDB(value: unknown) {
  Object.defineProperty(globalThis, 'indexedDB', { value, configurable: true, writable: true })
  Object.defineProperty(window, 'indexedDB', { value, configurable: true, writable: true })
}

afterEach(() => {
  vi.useRealTimers()
  setIDB(undefined)
})

describe('withTimeout', () => {
  it('passes through a value that arrives in time', async () => {
    const { withTimeout } = await loadStorage()
    await expect(withTimeout(Promise.resolve(42), 1000, 'x')).resolves.toBe(42)
  })

  it('rejects a promise that never settles', async () => {
    const { withTimeout } = await loadStorage()
    const never = new Promise<number>(() => undefined)
    await expect(withTimeout(never, 20, 'slow op')).rejects.toThrow(/slow op timed out after 20ms/)
  })

  it('propagates the original rejection', async () => {
    const { withTimeout } = await loadStorage()
    await expect(withTimeout(Promise.reject(new Error('real')), 1000, 'x')).rejects.toThrow('real')
  })
})

describe('storageAvailable', () => {
  it('is false when IndexedDB is missing', async () => {
    setIDB(undefined)
    const { storageAvailable } = await loadStorage()
    expect(storageAvailable()).toBe(false)
  })

  it('is false when merely reading indexedDB throws', async () => {
    const { storageAvailable } = await loadStorage()
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError') },
    })
    expect(storageAvailable()).toBe(false)
  })

  it('is true when IndexedDB is present', async () => {
    setIDB(hangingIndexedDB())
    const { storageAvailable } = await loadStorage()
    expect(storageAvailable()).toBe(true)
  })
})

describe('reads never hang', () => {
  it('rejects quickly when indexedDB.open() throws a SecurityError', async () => {
    setIDB(throwingIndexedDB())
    const storage = await loadStorage()
    await expect(storage.loadMeta('lastDocument')).rejects.toThrow(/Local storage unavailable/)
    // The denial is remembered, so later calls short-circuit instead of retrying.
    expect(storage.storageAvailable()).toBe(false)
  })

  it('rejects when open() never fires a callback', async () => {
    vi.useFakeTimers()
    setIDB(hangingIndexedDB())
    const storage = await loadStorage()
    const pending = storage.loadMeta<string>('lastDocument')
    const assertion = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  }, 20000)

  it('does not blacklist storage after a transient timeout', async () => {
    vi.useFakeTimers()
    setIDB(hangingIndexedDB())
    const storage = await loadStorage()
    const pending = storage.listDocuments()
    const assertion = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    // Retryable: a slow first open must not disable autosave for the session.
    expect(storage.storageAvailable()).toBe(true)
  }, 20000)

  it('reports zero usage when the storage estimate is unavailable', async () => {
    setIDB(undefined)
    const { estimateStorage, persistStorage } = await loadStorage()
    await expect(estimateStorage()).resolves.toEqual({ usage: 0, quota: 0 })
    await expect(persistStorage()).resolves.toBe(false)
  })
})
