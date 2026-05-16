import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Setup ────────────────────────────────────────────────────────────────────
// The FFI patches `window.requestAnimationFrame` at module load. Each test
// gets a fresh module via `vi.resetModules` AND restores the original rAF
// first so the new patch wraps the real implementation rather than a stale
// patch from a previous run.

const _originalRAF = window.requestAnimationFrame

let install, uninstall, register, navigate_forward, navigate_back

beforeEach(async () => {
  window.requestAnimationFrame = _originalRAF
  document.documentElement.className = ''
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')

  // jsdom doesn't ship the View Transitions API. Most code paths under
  // test bail out via `typeof document.startViewTransition !== "function"`
  // unless we stub it. The stub schedules the callback as a microtask —
  // matching the spec, which queues the update callback during the next
  // "update the rendering" cycle rather than synchronously. Synchronous
  // execution would make `vt_back`'s inner synthetic popstate fire while
  // the real popstate is still in flight, leaking bubble listeners.
  document.startViewTransition = vi.fn((cb) => {
    const inner = Promise.resolve().then(() => (cb ? cb() : undefined))
    return { finished: inner.catch(() => {}) }
  })

  vi.resetModules()
  ;({ install, uninstall, register, navigate_forward, navigate_back } =
    await import('../src/virtual_list/page_transition_ffi.mjs'))
})

afterEach(() => {
  try {
    uninstall()
  } catch {}
  delete document.startViewTransition
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Count window listeners added between `start()` and `stop()` for the given event types. */
function listenerCounter(types) {
  const matched = new Set(types)
  let count = 0
  let origAdd
  return {
    start() {
      origAdd = window.addEventListener
      window.addEventListener = function (t, fn, opts) {
        if (matched.has(t)) count++
        return origAdd.call(window, t, fn, opts)
      }
    },
    stop() {
      window.addEventListener = origAdd
    },
    get count() {
      return count
    },
  }
}

/** Attach a bubble-phase popstate listener that records whether it fired. */
function bubbleProbe() {
  const fn = vi.fn()
  window.addEventListener('popstate', fn)
  return {
    fn,
    remove: () => window.removeEventListener('popstate', fn),
  }
}

const PAIR = { list: '^/contacts$', detail: '^/contacts/(\\d+)$' }

// ─── install / uninstall ──────────────────────────────────────────────────────

describe('install', () => {
  it('registers the four window listeners (3 scroll-lock + 1 transition)', () => {
    const probe = listenerCounter(['popstate', 'modem-push', 'modem-replace'])
    probe.start()
    install()
    probe.stop()
    expect(probe.count).toBe(4)
  })

  it('is idempotent — second call adds no listeners', () => {
    install()
    const probe = listenerCounter(['popstate', 'modem-push', 'modem-replace'])
    probe.start()
    install()
    probe.stop()
    expect(probe.count).toBe(0)
  })

  it('also installs a capture-phase document click listener', () => {
    let added = false
    const orig = document.addEventListener
    document.addEventListener = function (t, fn, opts) {
      if (t === 'click' && opts === true) added = true
      return orig.call(document, t, fn, opts)
    }
    install()
    document.addEventListener = orig
    expect(added).toBe(true)
  })
})

describe('uninstall', () => {
  it('removes the popstate handler so navigation no longer toggles scroll-lock', () => {
    install()
    register(PAIR)

    // Confirm the handler is wired up: navigate to a detail URL.
    window.history.replaceState(null, '', '/contacts/5')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(document.documentElement.classList.contains('scroll-locked')).toBe(true)

    uninstall()

    // After uninstall: scroll-lock class doesn't toggle on popstate any more.
    document.documentElement.classList.remove('scroll-locked')
    window.history.replaceState(null, '', '/contacts/9')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(document.documentElement.classList.contains('scroll-locked')).toBe(false)
  })

  it('clears the scroll-lock class on uninstall', () => {
    install()
    register(PAIR)
    window.history.replaceState(null, '', '/contacts/5')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(document.documentElement.classList.contains('scroll-locked')).toBe(true)

    uninstall()
    expect(document.documentElement.classList.contains('scroll-locked')).toBe(false)
  })

  it('is idempotent', () => {
    install()
    uninstall()
    expect(() => uninstall()).not.toThrow()
  })

  it('is a no-op when called before install', () => {
    expect(() => uninstall()).not.toThrow()
  })
})

// ─── register ─────────────────────────────────────────────────────────────────
// The FFI `register` takes a single Pair. The Gleam wrapper accepts a
// `List(Pair)` and fans out to this FFI function once per entry.

describe('register', () => {
  it('adds a pair so list ↔ detail popstates are routed', () => {
    // _prevUrl is captured at install time. Install at the detail URL so
    // the next popstate sees it as the "from" path.
    window.history.replaceState(null, '', '/contacts/5')
    install()
    register(PAIR)

    const probe = bubbleProbe()
    window.history.replaceState(null, '', '/contacts')
    window.dispatchEvent(new PopStateEvent('popstate'))
    // Remove probe synchronously — the synthetic popstate that
    // vt_back/vt_forward fire from inside the (microtask-scheduled) VT
    // callback would otherwise hit our bubble listener.
    probe.remove()
    // capture handler called stopImmediatePropagation → bubble didn't fire
    expect(probe.fn).not.toHaveBeenCalled()
  })

  it('is idempotent by regex source — re-registering the same Pair is a no-op', () => {
    window.history.replaceState(null, '', '/contacts/5')
    install()
    register(PAIR)
    expect(() => register(PAIR)).not.toThrow()
    expect(() => register(PAIR)).not.toThrow()
    // Behaviour is unchanged: still routes detail → list.
    const probe = bubbleProbe()
    window.history.replaceState(null, '', '/contacts')
    window.dispatchEvent(new PopStateEvent('popstate'))
    probe.remove()
    expect(probe.fn).not.toHaveBeenCalled()
  })

  it('applies the scroll-lock class on register if the current URL matches a detail regex', () => {
    install()
    window.history.replaceState(null, '', '/contacts/42')
    expect(document.documentElement.classList.contains('scroll-locked')).toBe(false)
    register(PAIR)
    expect(document.documentElement.classList.contains('scroll-locked')).toBe(true)
  })

  it('does NOT apply scroll-lock on register when current URL is a list path', () => {
    install()
    window.history.replaceState(null, '', '/contacts')
    register(PAIR)
    expect(document.documentElement.classList.contains('scroll-locked')).toBe(false)
  })
})

// ─── Popstate routing ─────────────────────────────────────────────────────────

describe('popstate routing', () => {
  it('detail → list popstate calls stopImmediatePropagation', () => {
    window.history.replaceState(null, '', '/contacts/5')
    install()
    register(PAIR)

    const probe = bubbleProbe()
    window.history.replaceState(null, '', '/contacts')
    window.dispatchEvent(new PopStateEvent('popstate'))
    // Remove probe synchronously — the synthetic popstate that
    // vt_back/vt_forward fire from inside the (microtask-scheduled) VT
    // callback would otherwise hit our bubble listener.
    probe.remove()

    expect(probe.fn).not.toHaveBeenCalled()
  })

  it('list → detail popstate calls stopImmediatePropagation', () => {
    window.history.replaceState(null, '', '/contacts')
    install()
    register(PAIR)

    const probe = bubbleProbe()
    window.history.replaceState(null, '', '/contacts/9')
    window.dispatchEvent(new PopStateEvent('popstate'))
    // Remove probe synchronously — the synthetic popstate that
    // vt_back/vt_forward fire from inside the (microtask-scheduled) VT
    // callback would otherwise hit our bubble listener.
    probe.remove()

    expect(probe.fn).not.toHaveBeenCalled()
  })

  it('popstate between two unregistered paths does NOT stop propagation', () => {
    window.history.replaceState(null, '', '/foo')
    install()
    register(PAIR)

    const probe = bubbleProbe()
    window.history.replaceState(null, '', '/bar')
    window.dispatchEvent(new PopStateEvent('popstate'))
    // Remove probe synchronously — the synthetic popstate that
    // vt_back/vt_forward fire from inside the (microtask-scheduled) VT
    // callback would otherwise hit our bubble listener.
    probe.remove()

    expect(probe.fn).toHaveBeenCalled()
  })

  it('iterates multiple registered pairs', () => {
    window.history.replaceState(null, '', '/users/12')
    install()
    register(PAIR)
    register({ list: '^/users$', detail: '^/users/(\\d+)$' })

    const probe = bubbleProbe()
    window.history.replaceState(null, '', '/users')
    window.dispatchEvent(new PopStateEvent('popstate'))
    // Remove probe synchronously — the synthetic popstate that
    // vt_back/vt_forward fire from inside the (microtask-scheduled) VT
    // callback would otherwise hit our bubble listener.
    probe.remove()

    expect(probe.fn).not.toHaveBeenCalled() // second pair matched
  })

  it('bails out when document.startViewTransition is unavailable', () => {
    delete document.startViewTransition
    window.history.replaceState(null, '', '/contacts/5')
    install()
    register(PAIR)

    const probe = bubbleProbe()
    window.history.replaceState(null, '', '/contacts')
    window.dispatchEvent(new PopStateEvent('popstate'))
    // Remove probe synchronously — the synthetic popstate that
    // vt_back/vt_forward fire from inside the (microtask-scheduled) VT
    // callback would otherwise hit our bubble listener.
    probe.remove()

    // No VT support → handler returns before stopping propagation.
    expect(probe.fn).toHaveBeenCalled()
  })
})

// ─── navigate_forward ─────────────────────────────────────────────────────────

describe('navigate_forward', () => {
  function setupRow(id) {
    const row = document.createElement('div')
    row.setAttribute('data-list-item-id', String(id))
    const name = document.createElement('span')
    name.setAttribute('data-vt-field', 'contact-name')
    row.appendChild(name)
    document.body.appendChild(row)
    return { row, name }
  }

  it('pushes the target path onto history', async () => {
    install()
    register(PAIR)
    setupRow(5)

    navigate_forward(5, '/contacts/5', () => {})
    // doNavigate runs inside the VT update callback, which the test
    // harness schedules as a microtask.
    await Promise.resolve()
    expect(window.location.pathname).toBe('/contacts/5')
  })

  it('invokes then_fn after the history push', async () => {
    install()
    register(PAIR)
    setupRow(5)

    const then_fn = vi.fn()
    navigate_forward(5, '/contacts/5', then_fn)
    await Promise.resolve()
    expect(then_fn).toHaveBeenCalledOnce()
  })

  it('tags the row before kicking off the transition', () => {
    install()
    register(PAIR)
    const { name } = setupRow(7)

    // Capture the row state at the moment startViewTransition is called.
    let nameAtVtStart = null
    document.startViewTransition = vi.fn((cb) => {
      nameAtVtStart = name.style.viewTransitionName
      const inner = cb && cb()
      return { finished: Promise.resolve(inner).catch(() => {}) }
    })

    navigate_forward(7, '/contacts/7', () => {})

    // Synchronously before startViewTransition's update callback runs,
    // tag_item should have stamped the row's vt fields.
    expect(nameAtVtStart).toBe('contact-name')
  })

  it('falls back to a plain pushState when startViewTransition is unavailable', () => {
    delete document.startViewTransition
    install()
    register(PAIR)
    setupRow(5)

    const then_fn = vi.fn()
    navigate_forward(5, '/contacts/5', then_fn)
    expect(window.location.pathname).toBe('/contacts/5')
    expect(then_fn).toHaveBeenCalledOnce()
  })
})

// ─── navigate_back ────────────────────────────────────────────────────────────

describe('navigate_back', () => {
  it('falls back to history.back() when startViewTransition is unavailable', () => {
    delete document.startViewTransition
    install()
    const spy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    navigate_back(5)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('drives history.back() inside the view transition callback', async () => {
    install()
    const spy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    navigate_back(5)
    // history.back() is called from the VT update callback (microtask).
    await Promise.resolve()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
