# virtual_list

A virtual list for [Gleam](https://gleam.run/) on the JavaScript target,
ported from [TanStack Virtual](https://tanstack.com/virtual)'s
`@tanstack/virtual-core` package. Ships with a [Lustre](https://lustre.build/)
adapter for both container-scroll and window-scroll layouts.

> **Credit.** The measurements model, range-extraction algorithm, and
> observer architecture are a faithful re-implementation of TanStack
> Virtual. Huge thanks to **[Tanner Linsley](https://github.com/tannerlinsley)**
> and the TanStack maintainers — this package is just a translation; the
> design is theirs. See `react-virtual-core/index.ts` upstream for the
> original.

## Why

Rendering 10,000 rows isn't slow because of the data — it's slow because of
the DOM. A virtual list keeps the **scroll surface** at full virtual size
(so the scrollbar reflects the entire list) but only mounts the rows that
are actually visible, plus a configurable overscan margin.

This package gives you:

- A pure-Gleam `Virtualizer` you can stash in your model and tick with
  pure setters (`set_scroll_offset`, `set_container_size`, `measure_item`).
- A Lustre adapter that wires up the DOM observers and emits messages
  back into your update loop.
- Support for **dynamic row heights** via a `ResizeObserver` on every
  visible row, with an `estimate_size` fallback for unmeasured rows.
- **Container scroll** (the list element scrolls internally) **and
  window scroll** (the page scrolls; the list is just a tall spacer in
  flow). Same virtualizer math; only the source of scroll/resize events
  differs.
- Padding, gaps, lanes (multi-column), and overscan — same options as
  TanStack.

## Install

```sh
gleam add virtual_list
```

## Quickstart (Lustre, container scroll)

```gleam
import gleam/int
import lustre/attribute
import lustre/element/html
import virtual_list.{type VirtualItem, type Virtualizer}
import virtual_list/lustre as vlist

pub type Msg {
  Scrolled(Int)
  Resized(Int)
  Measured(Int, Int)
  // ...your other messages
}

pub type Model {
  Model(items: List(Item), virtualizer: Virtualizer)
}

fn make_virtualizer(count: Int) -> Virtualizer {
  let opts =
    virtual_list.Options(
      ..virtual_list.default_options(count, fn(_) { 56 }),
      overscan: 5,
    )
  virtual_list.new(opts)
}

pub fn update(model: Model, msg: Msg) -> Model {
  case msg {
    Scrolled(top)   -> Model(..model, virtualizer: virtual_list.set_scroll_offset(model.virtualizer, top))
    Resized(h)      -> Model(..model, virtualizer: virtual_list.set_container_size(model.virtualizer, h))
    Measured(i, sz) -> Model(..model, virtualizer: virtual_list.measure_item_at(model.virtualizer, i, sz))
  }
}

pub fn view(model: Model) {
  vlist.view(
    id: "my-list",
    virtualizer: model.virtualizer,
    render: fn(item: VirtualItem) { render_row(model.items, item) },
    on_scroll: Scrolled,
    attributes: [
      attribute.style("height", "calc(100vh - 100px)"),
      attribute.style("overflow-y", "auto"),
    ],
  )
}
```

You also need to install the DOM observers once the element is mounted —
typically via a one-shot effect after first render:

```gleam
import lustre/effect.{type Effect}

pub fn observe() -> Effect(Msg) {
  vlist.observe(
    id: "my-list",
    on_scroll: Scrolled,
    on_resize: Resized,
    on_measure_item: Measured,
  )
}
```

The observers are idempotent: calling `observe` again (e.g. on
re-navigation) tears down the previous set and re-installs.

## Window-scroll mode

If you want the **page** to scroll instead of an inner container, swap
`vlist.observe` for `vlist.observe_window` and remove the `height` /
`overflow-y` attributes:

```gleam
vlist.view(
  id: "my-list",
  virtualizer: model.virtualizer,
  render: …,
  on_scroll: Scrolled,
  attributes: [],   // no height, no overflow
)

// at mount-time
vlist.observe_window(
  id: "my-list",
  on_scroll: Scrolled,
  on_resize: Resized,
  on_measure_item: Measured,
)
```

In window mode the spacer sits in document flow, the page scrolls
naturally, and `scroll_offset` is reported relative to the spacer's top
(via `getBoundingClientRect`). The pure virtualizer math doesn't change.

## How it works

**Pure core (`virtual_list`).** Holds an opaque `Virtualizer` with the
current scroll offset, container size, item-size cache, and the
precomputed `measurements` array (one `VirtualItem` per index, with
`start` / `end` / `size`). `virtual_items(v)` returns the slice that
should render given the current scroll state.

**Adapter (`virtual_list/lustre`).** Renders a spacer of the full
virtual height and absolutely-positions the visible rows by their
measured `start` (using `transform: translateY(...)` so scroll updates
don't trigger layout). Each row is tagged with a `data-index` attribute.

**Observers (FFI).** `setup_observers` (or `setup_window_observers`)
installs:

- A scroll listener on the chosen scroll surface.
- A `ResizeObserver` on the scroll surface to track container size.
- A single `ResizeObserver` watching every `[data-index]` row; a
  `MutationObserver` keeps that observer's target set in sync as Lustre
  swaps rows in/out of the DOM.

Each observer dispatches a Gleam message; the runtime applies it to the
virtualizer with one of the pure setters, and the next render shows the
new visible window.

## Differences vs. TanStack Virtual

The shape mirrors TanStack, but several things are absent or simpler —
partly Gleam ergonomics, partly because they haven't been needed yet.

### Absent features

**No imperative scroll methods.** TanStack exposes `scrollToIndex`,
`scrollToOffset`, and `scrollBy`, each accepting an alignment
(`start | center | end | auto`) and a `behavior` (`auto | smooth |
instant`). This port has no equivalent; scroll position is entirely
driven by the host app.

**No smooth-scroll reconciliation.** When `scrollToIndex` is called with
`behavior: 'smooth'`, TanStack runs a rAF loop that re-targets the
destination as item sizes settle, suppresses measurements of far-away
items during the animation, and bails out after 5 s. None of that loop
exists here.

**Vertical only.** TanStack has a `horizontal` flag that switches every
axis — `scrollLeft`, `offsetWidth`, `inlineSize`. This port is
vertical-only.

**No `scrollMargin`.** TanStack adds `scrollMargin` to each item's start
offset (`start = prevItem.end + gap : paddingStart + scrollMargin`). This
corrects item positions when the virtual list does not begin at the top of
its scroll container — for example when a sticky header sits above it in
the same scrollable element. Without it, measurements are off by the
header height.

**No scroll-position correction on resize.** TanStack's `resizeItem`
checks whether the resizing item is above the current scroll offset and,
if so, immediately adjusts the scroll position by the size delta to
prevent visible content from jumping. This port does not do that; rows
that grow or shrink above the fold will shift the visible content.

**`rangeExtractor` is not configurable.** TanStack exposes the range
extractor as a user-supplied function so consumers can inject fixed
indices (e.g. sticky section headers that must always be mounted). This
port hardcodes the default extractor.

**No `enabled` flag.** TanStack can disable virtualisation entirely —
useful for falling back to normal flow on small lists or during SSR.

### Simpler implementations

**`getItemKey` defaults to the string index.** Override via
`Options.get_item_key` when keys need to survive sort or filter changes.
TanStack's default key extractor returns the numeric index; this port
returns a string.

**Single-pass measurement rebuild.** TanStack tracks
`pendingMeasuredCacheIndexes` and rebuilds measurements only from the
first changed index (`min(pendingIndexes)`), so items above the change
are untouched. This port rebuilds the full measurements list on every
size change. For lists in the low thousands the difference is not
noticeable, but it grows linearly with count.

**Simpler multi-lane range calculation.** TanStack's multi-lane
`calculateRange` expands the visible window forward and backward
per-lane, correctly handling lanes whose tallest item extends beyond the
others. This port uses the same single-index start/end approach as the
single-lane path, which can clip items or over-include them when lane
heights diverge significantly.

## TODO

Contributions welcome. Items are roughly ordered by impact.

- [ ] **`scrollToIndex` / `scrollToOffset` / `scrollBy`** — imperative
  scroll methods with alignment (`start | center | end | auto`) and
  behavior (`auto | smooth | instant`) options. The Lustre adapter would
  expose these as `Effect(msg)` values.
- [ ] **Smooth-scroll reconciliation** — rAF loop that re-targets scroll
  destination as measured sizes settle; measurement suppression for
  out-of-range items during animation; safety-valve timeout.
- [ ] **Scroll-position correction on resize** — when an item above the
  fold changes size, adjust the scroll offset by the delta so visible
  content does not jump. Requires the adapter to be able to imperatively
  set `scrollTop` / `scrollY`.
- [ ] **`scrollMargin`** — offset added to all item start positions,
  needed when the list does not start at the top of its scroll container.
- [ ] **Configurable `rangeExtractor`** — expose the extractor as an
  `Options` field so consumers can inject always-mounted indices (sticky
  headers, pinned rows).
- [ ] **Horizontal mode** — `horizontal: Bool` option that switches the
  axis for scroll offset, container size, item size, and positioning
  style (`translateX` instead of `translateY`).
- [ ] **Incremental measurement rebuild** — track which indices changed
  and rebuild only from `min(changedIndexes)`, matching TanStack's
  `pendingMeasuredCacheIndexes` optimisation.
- [ ] **Multi-lane range fix** — expand the visible range per-lane
  (forward and backward) so all lanes are correctly covered when item
  heights differ across lanes.
- [ ] **`enabled` flag** — skip virtualisation entirely when `False`;
  return all items and clear caches.

## Acknowledgements

- [TanStack Virtual](https://tanstack.com/virtual) by
  [@tannerlinsley](https://github.com/tannerlinsley) and contributors —
  the algorithm and architecture this package ports. The original is
  MIT-licensed; so is this port.
- [Lustre](https://lustre.build/) by
  [@hayleigh-dot-dev](https://github.com/hayleigh-dot-dev) — the
  framework that makes the adapter pleasant to write.

## Licence

[MIT](./LICENCE.md).
