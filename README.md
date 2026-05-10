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

> **Status.** Pre-1.0; the API is shaped after TanStack's `Virtualizer`
> but only the slice we currently need is exposed. PRs to fill the gaps
> (e.g. `scrollToIndex`, smooth-scroll reconciliation) welcome.

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

The shape mirrors TanStack, but a few things are simpler — partly Gleam
ergonomics, partly because we haven't needed them yet:

- **No imperative methods.** The TanStack class exposes `scrollToIndex`,
  `scrollToOffset`, `measure()`, etc. Here, you drive the virtualizer
  with pure setters and dispatch messages from your update loop.
- **No smooth-scroll reconciliation.** TanStack runs a rAF loop to
  re-target `scrollToIndex` as item sizes settle; this port doesn't yet.
- **`getItemKey` defaults to the index.** Override it (via
  `Options.get_item_key`) when you need keys to survive sort/filter
  changes.
- **Single-pass measurement rebuild.** TanStack tracks
  `pendingMeasuredCacheIndexes` to incrementally update from the first
  changed index; this port rebuilds the measurements list when an item
  size changes. For lists in the low thousands this is fine.

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
