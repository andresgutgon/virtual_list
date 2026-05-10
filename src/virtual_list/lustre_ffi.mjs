// DOM observer setup for the virtual_list Lustre adapter.
//
// Two modes:
//   - setup_observers (container scroll): scroll/resize listened on the spacer
//     element itself; consumer typically gives that element overflow + height.
//   - setup_window_observers (window scroll): the whole page scrolls, the
//     spacer is just a tall element in flow. Scroll/resize listened on window;
//     scroll_offset is computed as max(0, -spacer.getBoundingClientRect().top)
//     so the virtualizer sees a spacer-relative offset.
//
// In both modes the per-item ResizeObserver is the same: every child tagged
// with the index attribute reports its measured size. A MutationObserver
// keeps that observer's target set in sync as Lustre swaps rows in/out.

const observed = new Map() // container_id -> teardown fn (handles HMR re-mount)

function attachItemObserver(rootEl, indexAttribute, onMeasureItem) {
  const measured = new WeakMap() // element -> last reported size
  const trackedItems = new Set()

  let itemRO = null
  if (typeof ResizeObserver !== "undefined") {
    itemRO = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target
        const indexStr = node.getAttribute(indexAttribute)
        if (indexStr == null) continue
        const index = parseInt(indexStr, 10)
        if (Number.isNaN(index)) continue

        const box = entry.borderBoxSize?.[0]
        const size = box ? Math.round(box.blockSize) : node.offsetHeight
        if (measured.get(node) === size) continue
        measured.set(node, size)
        onMeasureItem(index, size)
      }
    })
  }

  const trackItem = (node) => {
    if (trackedItems.has(node) || !itemRO) return
    trackedItems.add(node)
    itemRO.observe(node)
  }
  const untrackItem = (node) => {
    if (!trackedItems.has(node)) return
    trackedItems.delete(node)
    if (itemRO) itemRO.unobserve(node)
    measured.delete(node)
  }

  const syncTracked = () => {
    const current = new Set(
      rootEl.querySelectorAll(`[${CSS.escape(indexAttribute)}]`),
    )
    for (const node of trackedItems) {
      if (!current.has(node)) untrackItem(node)
    }
    for (const node of current) trackItem(node)
  }
  syncTracked()

  const mutationObserver = new MutationObserver(syncTracked)
  mutationObserver.observe(rootEl, { childList: true, subtree: true })

  return () => {
    if (itemRO) itemRO.disconnect()
    mutationObserver.disconnect()
    trackedItems.clear()
  }
}

function teardownPrevious(containerId) {
  const prev = observed.get(containerId)
  if (prev) prev()
}

// Container-scroll mode --------------------------------------------------------

export function setup_observers(
  container_id,
  index_attribute,
  on_scroll,
  on_resize,
  on_measure_item,
) {
  const el = document.getElementById(container_id)
  if (!el) return
  teardownPrevious(container_id)

  on_scroll(el.scrollTop)
  on_resize(el.clientHeight)

  const scrollHandler = () => on_scroll(el.scrollTop)
  el.addEventListener("scroll", scrollHandler, { passive: true })

  let containerRO = null
  if (typeof ResizeObserver !== "undefined") {
    containerRO = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const box = entry.borderBoxSize?.[0]
      const height = box ? Math.round(box.blockSize) : el.clientHeight
      on_resize(height)
    })
    containerRO.observe(el, { box: "border-box" })
  }

  const teardownItems = attachItemObserver(el, index_attribute, on_measure_item)

  observed.set(container_id, () => {
    el.removeEventListener("scroll", scrollHandler)
    if (containerRO) containerRO.disconnect()
    teardownItems()
    observed.delete(container_id)
  })
}

// Window-scroll mode -----------------------------------------------------------

export function setup_window_observers(
  spacer_id,
  index_attribute,
  on_scroll,
  on_resize,
  on_measure_item,
) {
  const el = document.getElementById(spacer_id)
  if (!el) return
  teardownPrevious(spacer_id)

  // Spacer-relative offset: how far the user has scrolled past the spacer's
  // top. Clamped to 0 so the virtualizer never sees a negative offset while
  // the spacer is still below the fold.
  const offsetForScroll = () => Math.max(0, -el.getBoundingClientRect().top)

  on_scroll(offsetForScroll())
  on_resize(window.innerHeight)

  const scrollHandler = () => on_scroll(offsetForScroll())
  const resizeHandler = () => {
    on_resize(window.innerHeight)
    // A resize can also shift layout above the spacer, changing its document
    // offset — re-emit scroll so the virtualizer recomputes its visible range.
    on_scroll(offsetForScroll())
  }
  window.addEventListener("scroll", scrollHandler, { passive: true })
  window.addEventListener("resize", resizeHandler, { passive: true })

  const teardownItems = attachItemObserver(el, index_attribute, on_measure_item)

  observed.set(spacer_id, () => {
    window.removeEventListener("scroll", scrollHandler)
    window.removeEventListener("resize", resizeHandler)
    teardownItems()
    observed.delete(spacer_id)
  })
}
