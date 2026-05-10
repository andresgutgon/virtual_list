import gleam/int
import gleam/list

/// The computed slice of a virtual list: which items are visible,
/// and how tall the spacers above/below them should be.
pub type VirtualWindow {
  VirtualWindow(
    first_index: Int,
    last_index: Int,
    top_spacer: Int,
    bottom_spacer: Int,
  )
}

/// Compute the visible window given scroll state and item geometry.
///
/// - `total_count`      — total number of items in the list
/// - `item_height`      — fixed height of each item in pixels
/// - `container_height` — visible height of the scroll container in pixels
/// - `scroll_top`       — current scroll offset of the container in pixels
/// - `overscan`         — extra items to render above and below the visible area
pub fn compute(
  total_count total_count: Int,
  item_height item_height: Int,
  container_height container_height: Int,
  scroll_top scroll_top: Int,
  overscan overscan: Int,
) -> VirtualWindow {
  let first_visible = scroll_top / item_height
  let visible_count = container_height / item_height + 1
  let first_rendered = int.max(0, first_visible - overscan)
  let last_rendered =
    int.min(total_count - 1, first_visible + visible_count + overscan)
  let bottom_spacer =
    int.max(0, { total_count - last_rendered - 1 } * item_height)
  VirtualWindow(
    first_index: first_rendered,
    last_index: last_rendered,
    top_spacer: first_rendered * item_height,
    bottom_spacer: bottom_spacer,
  )
}

/// Extract the visible slice from the full item list.
/// Returns `List(#(Int, a))` — each item paired with its absolute index,
/// so the caller can position and key each row correctly.
pub fn slice(items: List(a), window: VirtualWindow) -> List(#(Int, a)) {
  let count = window.last_index - window.first_index + 1
  items
  |> list.drop(window.first_index)
  |> list.take(count)
  |> list.index_map(fn(item, i) { #(window.first_index + i, item) })
}
