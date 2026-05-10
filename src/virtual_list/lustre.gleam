import gleam/dynamic/decode
import gleam/int
import gleam/list
import lustre/attribute.{type Attribute}
import lustre/element.{type Element}
import lustre/element/html
import lustre/element/keyed
import lustre/event
import virtual_list

@external(javascript, "./lustre_ffi.mjs", "get_container_height")
fn get_container_height(id: String) -> Int

/// Render a fixed-height virtual list inside a scrollable container.
///
/// Only the visible items (plus `overscan` extras above and below) are mounted
/// in the DOM. Each item is absolutely positioned by index so the total scroll
/// height is preserved.
///
/// The container height is measured from the live DOM element so the virtual
/// window always reflects the real viewport — no need to pass a hard-coded
/// pixel value.
///
/// Parameters:
/// - `id`               — DOM id of the scroll container
/// - `items`            — the full item list (all pages accumulated)
/// - `item_height`      — fixed pixel height of each row
/// - `scroll_top`       — current scroll offset held in your model
/// - `overscan`         — extra rows to keep mounted above/below the viewport
/// - `key`              — unique key for each item (for Lustre's keyed diffing)
/// - `render`           — `fn(index, item) -> Element(msg)` for each visible row
/// - `on_scroll`        — `fn(scroll_top) -> msg` fired on every scroll event
/// - `attributes`       — additional attributes on the scroll container
///                        (use this to set CSS `height` via `attribute.style`)
pub fn view(
  id container_id: String,
  items items: List(a),
  item_height item_height: Int,
  scroll_top scroll_top: Int,
  overscan overscan: Int,
  key key: fn(a) -> String,
  render render: fn(Int, a) -> Element(msg),
  on_scroll on_scroll: fn(Int) -> msg,
  attributes attributes: List(Attribute(msg)),
) -> Element(msg) {
  let total = list.length(items)
  let container_height = get_container_height(container_id)
  let window =
    virtual_list.compute(
      total_count: total,
      item_height: item_height,
      container_height: container_height,
      scroll_top: scroll_top,
      overscan: overscan,
    )
  let visible = virtual_list.slice(items, window)

  html.div(
    list.flatten([
      [
        attribute.id(container_id),
        attribute.class("relative overflow-y-auto"),
        on_scroll_event(on_scroll),
      ],
      attributes,
    ]),
    [view_inner(visible, total, item_height, key, render)],
  )
}

fn view_inner(
  visible: List(#(Int, a)),
  total: Int,
  item_height: Int,
  key: fn(a) -> String,
  render: fn(Int, a) -> Element(msg),
) -> Element(msg) {
  html.div(
    [
      attribute.style("height", int.to_string(total * item_height) <> "px"),
      attribute.class("relative"),
    ],
    [
      keyed.div(
        [attribute.class("absolute inset-x-0 top-0")],
        list.map(visible, fn(pair) {
          let #(index, item) = pair
          #(
            key(item),
            html.div(
              [
                attribute.class("absolute inset-x-0"),
                attribute.style(
                  "height",
                  int.to_string(item_height) <> "px",
                ),
                attribute.style(
                  "top",
                  int.to_string(index * item_height) <> "px",
                ),
              ],
              [render(index, item)],
            ),
          )
        }),
      ),
    ],
  )
}

// Reads event.target.scrollTop from the scroll event at dispatch time.
// The nested decode.field calls are lazy — they run when the event fires,
// not when the attribute is constructed.
fn on_scroll_event(msg_fn: fn(Int) -> msg) -> Attribute(msg) {
  let decoder = {
    use scroll_top <- decode.field("target", {
      use top <- decode.field("scrollTop", decode.int)
      decode.success(top)
    })
    decode.success(msg_fn(scroll_top))
  }
  event.on("scroll", decoder)
}
