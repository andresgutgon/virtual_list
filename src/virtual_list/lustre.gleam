//// Lustre adapter for `virtual_list`.
////
//// The pure core lives in `virtual_list`. This module owns the runtime side:
//// rendering the spacer + visible items, and wiring up the DOM observers
//// (scroll, container resize, item resize) via FFI. Each observer dispatches
//// a message back into the consumer's update loop, which then mutates the
//// virtualizer state with the corresponding pure setter.
////
//// Two observation modes are exposed:
////
//// - [`observe`](#observe) — scroll/resize on the spacer element itself
////   (the consumer gives it a fixed height + `overflow-y`).
//// - [`observe_window`](#observe_window) — scroll/resize on `window`; the
////   spacer is just a tall element in document flow.
////
//// The observation primitives are ported from TanStack Virtual's
//// `observeElementOffset` / `observeWindowOffset` / `observeElementRect`
//// callbacks. Credit to the TanStack team — see `README.md`.

import gleam/dynamic/decode
import gleam/int
import gleam/list
import lustre/attribute.{type Attribute}
import lustre/effect.{type Effect}
import lustre/element.{type Element}
import lustre/element/html
import lustre/element/keyed
import lustre/event
import virtual_list.{
  type VirtualItem, type Virtualizer, total_size, virtual_items,
}

const index_attribute = "data-index"

// VIEW -----------------------------------------------------------------------

/// Render the virtual list inside a scrollable container.
///
/// - `id`         — DOM id used by the FFI observers
/// - `virtualizer`— the current state from the consumer's model
/// - `render`     — `fn(VirtualItem) -> Element(msg)` for each visible row
/// - `on_scroll`  — fired on every scroll event with the new offset
/// - `attributes` — extra attributes on the scroll container (e.g. CSS height)
pub fn view(
  id container_id: String,
  virtualizer virtualizer: Virtualizer,
  render render: fn(VirtualItem) -> Element(msg),
  on_scroll on_scroll: fn(Int) -> msg,
  attributes attributes: List(Attribute(msg)),
) -> Element(msg) {
  let visible = virtual_items(virtualizer)
  let total = total_size(virtualizer)

  // The package keeps its own positioning styles inline rather than relying on
  // Tailwind utilities — consumers' build pipelines may not scan this source.
  // Only `position: relative` is forced (so the spacer can host absolute items).
  // Overflow / height are caller concerns: pass them via `attributes` for
  // container-scroll, or omit and use `observe_window` for window-scroll.
  html.div(
    list.flatten([
      [
        attribute.id(container_id),
        attribute.style("position", "relative"),
        on_scroll_event(on_scroll),
      ],
      attributes,
    ]),
    [view_inner(visible, total, render)],
  )
}

fn view_inner(
  visible: List(VirtualItem),
  total: Int,
  render: fn(VirtualItem) -> Element(msg),
) -> Element(msg) {
  // Spacer reserves the full virtual height so the scrollbar reflects the
  // entire list. Visible rows are absolutely positioned by their measured
  // start offset.
  keyed.div(
    [
      attribute.style("position", "relative"),
      attribute.style("width", "100%"),
      attribute.style("height", int.to_string(total) <> "px"),
    ],
    list.map(visible, fn(item: VirtualItem) {
      #(
        item.key,
        html.div(
          [
            attribute.attribute(index_attribute, int.to_string(item.index)),
            attribute.style("position", "absolute"),
            attribute.style("left", "0"),
            attribute.style("right", "0"),
            attribute.style(
              "transform",
              "translateY(" <> int.to_string(item.start) <> "px)",
            ),
            attribute.style("height", int.to_string(item.size) <> "px"),
          ],
          [render(item)],
        ),
      )
    }),
  )
}

fn on_scroll_event(msg_fn: fn(Int) -> msg) -> Attribute(msg) {
  let decoder = {
    use offset <- decode.field("target", {
      use top <- decode.field("scrollTop", decode.int)
      decode.success(top)
    })
    decode.success(msg_fn(offset))
  }
  // Throttle scroll events: the model already drives the visible window from
  // `scroll_offset`, and dispatching every scroll tick produces N renders per
  // second of pixel-precision noise that the user can't see.
  event.on("scroll", decoder)
  |> event.throttle(16)
}

// OBSERVER LIFECYCLE ---------------------------------------------------------

/// Set up the DOM observers that drive the virtualizer's measurements.
///
/// Call this once after the scroll container has been mounted (e.g. from the
/// initial route load). The returned effect installs:
/// - a `ResizeObserver` on the scroll container — dispatches `on_resize`
/// - a `ResizeObserver` on each row tagged with `data-index` — dispatches
///   `on_measure_item`
/// - the initial scroll offset — dispatched via `on_scroll`
///
/// These observers persist for the lifetime of the page; Lustre will tear them
/// down with the element when the route changes.
pub fn observe(
  id container_id: String,
  on_scroll on_scroll: fn(Int) -> msg,
  on_resize on_resize: fn(Int) -> msg,
  on_measure_item on_measure_item: fn(Int, Int) -> msg,
) -> Effect(msg) {
  effect.after_paint(fn(dispatch, _root) {
    setup_observers(
      container_id,
      index_attribute,
      fn(top) { dispatch(on_scroll(top)) },
      fn(height) { dispatch(on_resize(height)) },
      fn(index, size) { dispatch(on_measure_item(index, size)) },
    )
  })
}

@external(javascript, "./lustre_ffi.mjs", "setup_observers")
fn setup_observers(
  container_id: String,
  index_attribute: String,
  on_scroll: fn(Int) -> Nil,
  on_resize: fn(Int) -> Nil,
  on_measure_item: fn(Int, Int) -> Nil,
) -> Nil

/// Window-scroll variant of `observe`. The page itself is the scroll surface;
/// the vlist element is just a tall spacer in flow. Scroll offset is reported
/// relative to the spacer's top, so the same virtualizer math works without
/// changes — only the source of scroll/resize events differs.
///
/// Use this when you want the page to scroll instead of an inner container.
/// In that case do NOT set `overflow-y` or a fixed height on the vlist
/// element via `attributes`.
pub fn observe_window(
  id container_id: String,
  on_scroll on_scroll: fn(Int) -> msg,
  on_resize on_resize: fn(Int) -> msg,
  on_measure_item on_measure_item: fn(Int, Int) -> msg,
) -> Effect(msg) {
  effect.after_paint(fn(dispatch, _root) {
    setup_window_observers(
      container_id,
      index_attribute,
      fn(top) { dispatch(on_scroll(top)) },
      fn(height) { dispatch(on_resize(height)) },
      fn(index, size) { dispatch(on_measure_item(index, size)) },
    )
  })
}

@external(javascript, "./lustre_ffi.mjs", "setup_window_observers")
fn setup_window_observers(
  spacer_id: String,
  index_attribute: String,
  on_scroll: fn(Int) -> Nil,
  on_resize: fn(Int) -> Nil,
  on_measure_item: fn(Int, Int) -> Nil,
) -> Nil
