import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── ResizeObserver fake ──────────────────────────────────────────────────────
// jsdom does not provide ResizeObserver; we stub a minimal synchronous
// implementation so tests can manually fire resize entries.
class FakeResizeObserver {
  static instances = []

  constructor(cb) {
    this.cb = cb
    this.targets = new Set()
    FakeResizeObserver.instances.push(this)
  }
  observe(el) {
    this.targets.add(el)
  }
  unobserve(el) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
  /** Synchronously trigger a border-box resize entry for `el`. */
  fire(el, blockSize) {
    this.cb([{ target: el, borderBoxSize: [{ blockSize }] }])
  }
}

vi.stubGlobal('ResizeObserver', FakeResizeObserver)
// jsdom 26 does not ship CSS.escape; provide a minimal polyfill.
vi.stubGlobal('CSS', { escape: (s) => s.replace(/([^\w-])/g, '\\$1') })

// ─── Module isolation ─────────────────────────────────────────────────────────
// Each test gets a fresh copy of lustre_ffi.mjs so the module-level
// `observed` Map starts empty and previous window listeners can't leak in.
let setup_observers, setup_window_observers

beforeEach(async () => {
  FakeResizeObserver.instances = []
  vi.resetModules()
  ;({ setup_observers, setup_window_observers } = await import(
    '../src/virtual_list/lustre_ffi.mjs'
  ))
})

afterEach(() => {
  document.body.innerHTML = ''
})

// ─── DOM helpers ──────────────────────────────────────────────────────────────
let seq = 0

function mkEl() {
  const div = document.createElement('div')
  div.id = `vl-test-${++seq}`
  document.body.appendChild(div)
  return div
}

function mkItem(parent, index) {
  const div = document.createElement('div')
  div.setAttribute('data-index', String(index))
  parent.appendChild(div)
  return div
}

// ─── setup_observers ──────────────────────────────────────────────────────────

describe('setup_observers', () => {
  describe('guard: element not found', () => {
    it('does not call any callback when the id is missing', () => {
      const onScroll = vi.fn()
      setup_observers('no-such-el', 'data-index', onScroll, vi.fn(), vi.fn())
      expect(onScroll).not.toHaveBeenCalled()
    })
  })

  describe('initial synchronous calls', () => {
    it("calls on_scroll with the element's scrollTop", () => {
      const el = mkEl()
      Object.defineProperty(el, 'scrollTop', { value: 120, configurable: true })
      const onScroll = vi.fn()
      setup_observers(el.id, 'data-index', onScroll, vi.fn(), vi.fn())
      expect(onScroll).toHaveBeenCalledWith(120)
    })

    it("calls on_resize with the element's clientHeight", () => {
      const el = mkEl()
      Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
      const onResize = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), onResize, vi.fn())
      expect(onResize).toHaveBeenCalledWith(400)
    })
  })

  describe('scroll listener', () => {
    it('calls on_scroll when a scroll event fires', () => {
      const el = mkEl()
      Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true })
      const onScroll = vi.fn()
      setup_observers(el.id, 'data-index', onScroll, vi.fn(), vi.fn())
      onScroll.mockClear()

      Object.defineProperty(el, 'scrollTop', { value: 250, configurable: true })
      el.dispatchEvent(new Event('scroll'))

      expect(onScroll).toHaveBeenCalledOnce()
      expect(onScroll).toHaveBeenCalledWith(250)
    })
  })

  describe('teardown on re-mount', () => {
    it('removes the old scroll listener when setup is called again with the same id', () => {
      const el = mkEl()
      const onScroll1 = vi.fn()
      const onScroll2 = vi.fn()

      setup_observers(el.id, 'data-index', onScroll1, vi.fn(), vi.fn())
      setup_observers(el.id, 'data-index', onScroll2, vi.fn(), vi.fn())

      const before1 = onScroll1.mock.calls.length // 1 from initial call
      const before2 = onScroll2.mock.calls.length // 1 from initial call

      el.dispatchEvent(new Event('scroll'))

      expect(onScroll1.mock.calls.length).toBe(before1) // unchanged — listener gone
      expect(onScroll2.mock.calls.length).toBe(before2 + 1) // fired once
    })

    it('disconnects the old container ResizeObserver', () => {
      const el = mkEl()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), vi.fn())
      const oldContainerRO = FakeResizeObserver.instances[0]
      expect(oldContainerRO.targets.size).toBe(1)

      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), vi.fn())
      // The old RO is disconnected; its target set is cleared.
      expect(oldContainerRO.targets.size).toBe(0)
    })
  })

  describe('container ResizeObserver', () => {
    it('calls on_resize when the container resizes', () => {
      const el = mkEl()
      const onResize = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), onResize, vi.fn())
      onResize.mockClear()

      // instances[0] = containerRO
      FakeResizeObserver.instances[0].fire(el, 600)

      expect(onResize).toHaveBeenCalledOnce()
      expect(onResize).toHaveBeenCalledWith(600)
    })
  })

  describe('item ResizeObserver — measurement', () => {
    it('measures pre-existing items tagged with data-index', () => {
      const el = mkEl()
      const itemEl = mkItem(el, 3)
      const onMeasure = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      // instances[1] = itemRO
      FakeResizeObserver.instances[1].fire(itemEl, 48)

      expect(onMeasure).toHaveBeenCalledWith(3, 48)
    })

    it('ignores elements without data-index', () => {
      const el = mkEl()
      const plain = document.createElement('div')
      el.appendChild(plain)
      const onMeasure = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      FakeResizeObserver.instances[1].fire(plain, 50)

      expect(onMeasure).not.toHaveBeenCalled()
    })

    it('ignores elements with a non-numeric data-index', () => {
      const el = mkEl()
      const bad = document.createElement('div')
      bad.setAttribute('data-index', 'not-a-number')
      el.appendChild(bad)
      const onMeasure = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      FakeResizeObserver.instances[1].fire(bad, 50)

      expect(onMeasure).not.toHaveBeenCalled()
    })

    it('ignores zero block size', () => {
      const el = mkEl()
      const itemEl = mkItem(el, 0)
      const onMeasure = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      FakeResizeObserver.instances[1].fire(itemEl, 0)

      expect(onMeasure).not.toHaveBeenCalled()
    })

    it('ignores negative block size', () => {
      const el = mkEl()
      const itemEl = mkItem(el, 0)
      const onMeasure = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      FakeResizeObserver.instances[1].fire(itemEl, -10)

      expect(onMeasure).not.toHaveBeenCalled()
    })

    it('does not re-report the same size for the same element', () => {
      const el = mkEl()
      const itemEl = mkItem(el, 0)
      const onMeasure = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      FakeResizeObserver.instances[1].fire(itemEl, 48)
      FakeResizeObserver.instances[1].fire(itemEl, 48) // duplicate

      expect(onMeasure).toHaveBeenCalledOnce()
      expect(onMeasure).toHaveBeenCalledWith(0, 48)
    })

    it('reports a different size after the first measurement', () => {
      const el = mkEl()
      const itemEl = mkItem(el, 0)
      const onMeasure = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      FakeResizeObserver.instances[1].fire(itemEl, 48)
      FakeResizeObserver.instances[1].fire(itemEl, 96) // changed

      expect(onMeasure).toHaveBeenCalledTimes(2)
      expect(onMeasure).toHaveBeenLastCalledWith(0, 96)
    })
  })

  describe('MutationObserver — item tracking', () => {
    it('starts observing items added after setup', async () => {
      const el = mkEl()
      const onMeasure = vi.fn()
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      const newItem = mkItem(el, 7)
      await Promise.resolve() // let MutationObserver deliver

      FakeResizeObserver.instances[1].fire(newItem, 60)
      expect(onMeasure).toHaveBeenCalledWith(7, 60)
    })

    it('stops observing items removed after setup', async () => {
      const el = mkEl()
      const itemEl = mkItem(el, 2)
      setup_observers(el.id, 'data-index', vi.fn(), vi.fn(), vi.fn())

      const itemRO = FakeResizeObserver.instances[1]
      expect(itemRO.targets.has(itemEl)).toBe(true)

      el.removeChild(itemEl)
      await Promise.resolve()

      expect(itemRO.targets.has(itemEl)).toBe(false)
    })
  })
})

// ─── setup_window_observers ───────────────────────────────────────────────────

describe('setup_window_observers', () => {
  describe('guard: element not found', () => {
    it('does not call any callback when the id is missing', () => {
      const onScroll = vi.fn()
      setup_window_observers('missing', 'data-index', onScroll, vi.fn(), vi.fn())
      expect(onScroll).not.toHaveBeenCalled()
    })
  })

  describe('initial synchronous calls', () => {
    it('calls on_scroll with the spacer-relative offset', () => {
      const el = mkEl()
      el.getBoundingClientRect = () => ({ top: -200 }) // 200px past top
      const onScroll = vi.fn()
      setup_window_observers(el.id, 'data-index', onScroll, vi.fn(), vi.fn())
      expect(onScroll).toHaveBeenCalledWith(200)
    })

    it('clamps on_scroll to 0 when the spacer is still below the fold', () => {
      const el = mkEl()
      el.getBoundingClientRect = () => ({ top: 300 })
      const onScroll = vi.fn()
      setup_window_observers(el.id, 'data-index', onScroll, vi.fn(), vi.fn())
      expect(onScroll).toHaveBeenCalledWith(0)
    })

    it('calls on_resize with window.innerHeight', () => {
      const el = mkEl()
      el.getBoundingClientRect = () => ({ top: 0 })
      Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true })
      const onResize = vi.fn()
      setup_window_observers(el.id, 'data-index', vi.fn(), onResize, vi.fn())
      expect(onResize).toHaveBeenCalledWith(812)
    })
  })

  describe('window scroll listener', () => {
    it('calls on_scroll when the window scrolls', () => {
      const el = mkEl()
      let top = 0
      el.getBoundingClientRect = () => ({ top: -top })
      const onScroll = vi.fn()
      setup_window_observers(el.id, 'data-index', onScroll, vi.fn(), vi.fn())
      onScroll.mockClear()

      top = 350
      window.dispatchEvent(new Event('scroll'))

      expect(onScroll).toHaveBeenCalledOnce()
      expect(onScroll).toHaveBeenCalledWith(350)
    })
  })

  describe('window resize listener', () => {
    it('calls on_resize with the updated window.innerHeight', () => {
      const el = mkEl()
      el.getBoundingClientRect = () => ({ top: 0 })
      const onResize = vi.fn()
      setup_window_observers(el.id, 'data-index', vi.fn(), onResize, vi.fn())
      onResize.mockClear()

      Object.defineProperty(window, 'innerHeight', { value: 1024, configurable: true })
      window.dispatchEvent(new Event('resize'))

      expect(onResize).toHaveBeenCalledWith(1024)
    })

    it('also re-emits on_scroll on resize to reflect layout shifts', () => {
      const el = mkEl()
      let top = 0
      el.getBoundingClientRect = () => ({ top: -top })
      const onScroll = vi.fn()
      setup_window_observers(el.id, 'data-index', onScroll, vi.fn(), vi.fn())
      onScroll.mockClear()

      top = 100
      window.dispatchEvent(new Event('resize'))

      expect(onScroll).toHaveBeenCalledWith(100)
    })
  })

  describe('teardown on re-mount', () => {
    it('removes the old window scroll listener when re-mounted with the same id', () => {
      const el = mkEl()
      el.getBoundingClientRect = () => ({ top: 0 })
      const onScroll1 = vi.fn()
      const onScroll2 = vi.fn()

      setup_window_observers(el.id, 'data-index', onScroll1, vi.fn(), vi.fn())
      setup_window_observers(el.id, 'data-index', onScroll2, vi.fn(), vi.fn())

      const before1 = onScroll1.mock.calls.length
      const before2 = onScroll2.mock.calls.length

      window.dispatchEvent(new Event('scroll'))

      expect(onScroll1.mock.calls.length).toBe(before1)
      expect(onScroll2.mock.calls.length).toBe(before2 + 1)
    })

    it('removes the old window resize listener when re-mounted with the same id', () => {
      const el = mkEl()
      el.getBoundingClientRect = () => ({ top: 0 })
      const onResize1 = vi.fn()
      const onResize2 = vi.fn()

      setup_window_observers(el.id, 'data-index', vi.fn(), onResize1, vi.fn())
      setup_window_observers(el.id, 'data-index', vi.fn(), onResize2, vi.fn())

      const before1 = onResize1.mock.calls.length

      window.dispatchEvent(new Event('resize'))

      expect(onResize1.mock.calls.length).toBe(before1)
      expect(onResize2).toHaveBeenCalled()
    })
  })

  describe('item ResizeObserver — measurement', () => {
    it('measures pre-existing items tagged with data-index', () => {
      const el = mkEl()
      const itemEl = mkItem(el, 5)
      el.getBoundingClientRect = () => ({ top: 0 })
      const onMeasure = vi.fn()
      setup_window_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      // Window mode creates no containerRO; instances[0] is the item observer.
      FakeResizeObserver.instances[0].fire(itemEl, 72)

      expect(onMeasure).toHaveBeenCalledWith(5, 72)
    })

    it('ignores zero block size', () => {
      const el = mkEl()
      const itemEl = mkItem(el, 0)
      el.getBoundingClientRect = () => ({ top: 0 })
      const onMeasure = vi.fn()
      setup_window_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      FakeResizeObserver.instances[0].fire(itemEl, 0)

      expect(onMeasure).not.toHaveBeenCalled()
    })

    it('tracks items added after setup via MutationObserver', async () => {
      const el = mkEl()
      el.getBoundingClientRect = () => ({ top: 0 })
      const onMeasure = vi.fn()
      setup_window_observers(el.id, 'data-index', vi.fn(), vi.fn(), onMeasure)

      const newItem = mkItem(el, 9)
      await Promise.resolve()

      FakeResizeObserver.instances[0].fire(newItem, 80)
      expect(onMeasure).toHaveBeenCalledWith(9, 80)
    })
  })
})
