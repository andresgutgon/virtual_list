//// Core virtual-list math.
////
//// This module is a Gleam port of [TanStack Virtual]'s `@tanstack/virtual-core`
//// — the measurements model, the range-extraction algorithm, and the
//// observer architecture are all faithfully translated from the original
//// TypeScript. Many thanks to **Tanner Linsley** and the TanStack
//// maintainers; the design is theirs, this is just the translation.
////
//// [TanStack Virtual]: https://tanstack.com/virtual
////
//// The module itself is pure (no FFI, no DOM): it produces a list of
//// `VirtualItem`s to render given a scroll offset, container size, and
//// item size cache. Adapters (e.g. `virtual_list/lustre`) wire this up to
//// the runtime, observing scroll and resize events and dispatching them
//// back into the consumer's model.

import gleam/dict.{type Dict}
import gleam/int
import gleam/list

// CONFIG ---------------------------------------------------------------------

pub type Options {
  Options(
    /// Total number of items in the list.
    count: Int,
    /// Estimated size in pixels for an item that hasn't been measured yet.
    estimate_size: fn(Int) -> Int,
    /// Extra rows kept mounted above and below the visible window.
    overscan: Int,
    /// Padding before the first item, in pixels.
    padding_start: Int,
    /// Padding after the last item, in pixels.
    padding_end: Int,
    /// Gap between items, in pixels.
    gap: Int,
    /// Number of lanes (columns for a vertical list, rows for a horizontal one).
    /// `1` is the standard single-column case.
    lanes: Int,
    /// Stable key per item index (used as the DOM diffing key).
    get_item_key: fn(Int) -> String,
  )
}

/// Sensible defaults: single lane, 1-row overscan, no padding/gap, integer-key
/// extractor. The caller must supply `count` and `estimate_size`.
pub fn default_options(
  count count: Int,
  estimate_size estimate_size: fn(Int) -> Int,
) -> Options {
  Options(
    count: count,
    estimate_size: estimate_size,
    overscan: 1,
    padding_start: 0,
    padding_end: 0,
    gap: 0,
    lanes: 1,
    get_item_key: fn(i) { int.to_string(i) },
  )
}

// MEASUREMENTS ---------------------------------------------------------------

pub type VirtualItem {
  VirtualItem(
    key: String,
    index: Int,
    start: Int,
    size: Int,
    end: Int,
    lane: Int,
  )
}

pub type Range {
  Range(start_index: Int, end_index: Int)
}

// STATE ----------------------------------------------------------------------

/// Snapshot of the virtualizer at a point in time. Pure; pass it through the
/// model and rebuild on each tick.
pub opaque type Virtualizer {
  Virtualizer(
    options: Options,
    scroll_offset: Int,
    container_size: Int,
    item_sizes: Dict(String, Int),
    measurements: List(VirtualItem),
  )
}

pub fn new(options: Options) -> Virtualizer {
  Virtualizer(
    options: options,
    scroll_offset: 0,
    container_size: 0,
    item_sizes: dict.new(),
    measurements: build_measurements(options, dict.new()),
  )
}

pub fn options(v: Virtualizer) -> Options {
  v.options
}

pub fn scroll_offset(v: Virtualizer) -> Int {
  v.scroll_offset
}

pub fn container_size(v: Virtualizer) -> Int {
  v.container_size
}

/// Replace the configuration. Recomputes measurements from cached sizes.
pub fn set_options(v: Virtualizer, options: Options) -> Virtualizer {
  Virtualizer(
    ..v,
    options: options,
    measurements: build_measurements(options, v.item_sizes),
  )
}

pub fn set_scroll_offset(v: Virtualizer, offset: Int) -> Virtualizer {
  Virtualizer(..v, scroll_offset: int.max(0, offset))
}

pub fn set_container_size(v: Virtualizer, size: Int) -> Virtualizer {
  Virtualizer(..v, container_size: int.max(0, size))
}

/// Record a measured size for one item. If the size is unchanged, returns the
/// virtualizer untouched (no rebuild). Otherwise rebuilds the measurements
/// list — this is O(count) but happens only when an item actually resizes.
///
/// Sizes `<= 0` are ignored. ResizeObserver can briefly report `0` while
/// an element is detaching, mid-transition, or in a `display: none` ancestor;
/// caching a `0` would collapse subsequent items onto the same start offset
/// and stack them visually.
pub fn measure_item(
  v: Virtualizer,
  key: String,
  size: Int,
) -> Virtualizer {
  case size <= 0 {
    True -> v
    False ->
      case dict.get(v.item_sizes, key) {
        Ok(prev) if prev == size -> v
        _ -> {
          let new_sizes = dict.insert(v.item_sizes, key, size)
          Virtualizer(
            ..v,
            item_sizes: new_sizes,
            measurements: build_measurements(v.options, new_sizes),
          )
        }
      }
  }
}

/// Same as `measure_item` but takes an item index. Resolves the key via
/// `options.get_item_key`.
pub fn measure_item_at(v: Virtualizer, index: Int, size: Int) -> Virtualizer {
  measure_item(v, v.options.get_item_key(index), size)
}

/// Drop all cached sizes — useful when the item template changes (e.g. font
/// load, density toggle). The next render falls back to `estimate_size`.
pub fn invalidate_measurements(v: Virtualizer) -> Virtualizer {
  Virtualizer(
    ..v,
    item_sizes: dict.new(),
    measurements: build_measurements(v.options, dict.new()),
  )
}

// PUBLIC OUTPUTS -------------------------------------------------------------

/// Total scrollable size in pixels. Use this to size the spacer element.
pub fn total_size(v: Virtualizer) -> Int {
  let end = case v.options.lanes == 1 {
    True -> result_map_to_zero(list.last(v.measurements))
    False -> max_end_per_lane(v.measurements, v.options.lanes)
  }
  int.max(0, end + v.options.padding_end)
}

/// The visible items (plus overscan) given the current scroll offset.
pub fn virtual_items(v: Virtualizer) -> List(VirtualItem) {
  case v.measurements, v.container_size {
    [], _ -> []
    _, 0 -> []
    measurements, outer -> {
      let range = calculate_range(measurements, outer, v.scroll_offset, v.options.lanes)
      let extracted =
        default_range_extractor(
          range,
          v.options.overscan,
          v.options.count,
        )
      take_at_indices(measurements, extracted)
    }
  }
}

// INTERNALS ------------------------------------------------------------------

fn build_measurements(
  opts: Options,
  item_sizes: Dict(String, Int),
) -> List(VirtualItem) {
  case opts.lanes <= 1 {
    True -> build_single_lane(opts, item_sizes)
    False -> build_multi_lane(opts, item_sizes)
  }
}

fn build_single_lane(
  opts: Options,
  item_sizes: Dict(String, Int),
) -> List(VirtualItem) {
  build_single_lane_loop(0, opts.count, opts.padding_start, opts, item_sizes, [])
  |> list.reverse
}

fn build_single_lane_loop(
  i: Int,
  count: Int,
  cursor: Int,
  opts: Options,
  item_sizes: Dict(String, Int),
  acc: List(VirtualItem),
) -> List(VirtualItem) {
  case i >= count {
    True -> acc
    False -> {
      let key = opts.get_item_key(i)
      let size = case dict.get(item_sizes, key) {
        Ok(s) if s > 0 -> s
        _ -> opts.estimate_size(i)
      }
      let start = case i == 0 {
        True -> cursor
        False -> cursor + opts.gap
      }
      let end = start + size
      let item =
        VirtualItem(
          key: key,
          index: i,
          start: start,
          size: size,
          end: end,
          lane: 0,
        )
      build_single_lane_loop(i + 1, count, end, opts, item_sizes, [item, ..acc])
    }
  }
}

// Multi-lane layout: each item is placed into the lane whose furthest end is
// smallest, mirroring TanStack's behaviour. `lane_ends` tracks the running
// `end` per lane.
fn build_multi_lane(
  opts: Options,
  item_sizes: Dict(String, Int),
) -> List(VirtualItem) {
  let lane_ends = list.repeat(opts.padding_start, opts.lanes)
  build_multi_lane_loop(0, opts.count, lane_ends, opts, item_sizes, [])
  |> list.reverse
}

fn build_multi_lane_loop(
  i: Int,
  count: Int,
  lane_ends: List(Int),
  opts: Options,
  item_sizes: Dict(String, Int),
  acc: List(VirtualItem),
) -> List(VirtualItem) {
  case i >= count {
    True -> acc
    False -> {
      let key = opts.get_item_key(i)
      let size = case dict.get(item_sizes, key) {
        Ok(s) if s > 0 -> s
        _ -> opts.estimate_size(i)
      }
      let #(lane, lane_end) = shortest_lane(lane_ends)
      let start = case lane_end == opts.padding_start {
        True -> opts.padding_start
        False -> lane_end + opts.gap
      }
      let end = start + size
      let new_lane_ends = update_at(lane_ends, lane, end)
      let item =
        VirtualItem(
          key: key,
          index: i,
          start: start,
          size: size,
          end: end,
          lane: lane,
        )
      build_multi_lane_loop(
        i + 1,
        count,
        new_lane_ends,
        opts,
        item_sizes,
        [item, ..acc],
      )
    }
  }
}

fn shortest_lane(lane_ends: List(Int)) -> #(Int, Int) {
  let #(lane, end, _) =
    list.fold(lane_ends, #(0, 0, 0), fn(state, current) {
      let #(best_lane, best_end, idx) = state
      case idx == 0 || current < best_end {
        True -> #(idx, current, idx + 1)
        False -> #(best_lane, best_end, idx + 1)
      }
    })
  #(lane, end)
}

fn update_at(items: List(Int), idx: Int, value: Int) -> List(Int) {
  list.index_map(items, fn(item, i) {
    case i == idx {
      True -> value
      False -> item
    }
  })
}

fn max_end_per_lane(items: List(VirtualItem), _lanes: Int) -> Int {
  list.fold(items, 0, fn(acc, item) { int.max(acc, item.end) })
}

// RANGE COMPUTATION ----------------------------------------------------------

fn calculate_range(
  measurements: List(VirtualItem),
  outer_size: Int,
  scroll_offset: Int,
  lanes: Int,
) -> Range {
  let last_index = list.length(measurements) - 1
  case last_index < 0 {
    True -> Range(start_index: 0, end_index: -1)
    False ->
      case list.length(measurements) <= lanes {
        True -> Range(start_index: 0, end_index: last_index)
        False -> compute_range(measurements, outer_size, scroll_offset, lanes)
      }
  }
}

fn compute_range(
  measurements: List(VirtualItem),
  outer_size: Int,
  scroll_offset: Int,
  _lanes: Int,
) -> Range {
  let viewport_end = scroll_offset + outer_size
  let last_index = list.length(measurements) - 1

  // Find the last item whose start <= scroll_offset (binary-search-ish via
  // linear walk; lists are linked, so linear is the natural shape and 300
  // items only costs us one cache line). Falls back to 0 if every item is
  // already past the scroll offset.
  let start_index =
    list.fold(measurements, #(0, 0, False), fn(state, item) {
      let #(best, idx, locked) = state
      case locked {
        True -> #(best, idx + 1, True)
        False ->
          case item.start > scroll_offset {
            True -> #(best, idx + 1, True)
            False -> #(idx, idx + 1, False)
          }
      }
    }).0

  // Walk forward from start_index until item.end >= viewport_end. The end
  // index is inclusive.
  let end_index =
    advance_end_index(measurements, start_index, viewport_end, last_index)

  Range(start_index: start_index, end_index: end_index)
}

fn advance_end_index(
  measurements: List(VirtualItem),
  start_index: Int,
  viewport_end: Int,
  last_index: Int,
) -> Int {
  let after_start = list.drop(measurements, start_index)
  do_advance_end(after_start, start_index, viewport_end, last_index)
}

fn do_advance_end(
  rest: List(VirtualItem),
  current: Int,
  viewport_end: Int,
  last_index: Int,
) -> Int {
  case rest {
    [] -> last_index
    [item, ..tail] ->
      case item.end >= viewport_end || current >= last_index {
        True -> current
        False -> do_advance_end(tail, current + 1, viewport_end, last_index)
      }
  }
}

fn default_range_extractor(
  range: Range,
  overscan: Int,
  count: Int,
) -> List(Int) {
  let start = int.max(range.start_index - overscan, 0)
  let end = int.min(range.end_index + overscan, count - 1)
  case end < start {
    True -> []
    False -> int_range(start, end)
  }
}

fn take_at_indices(
  measurements: List(VirtualItem),
  indices: List(Int),
) -> List(VirtualItem) {
  // Indices are sorted ascending and dense, so a single forward pass is enough.
  case indices {
    [] -> []
    [first, ..] -> {
      let dropped = list.drop(measurements, first)
      take_dense(dropped, indices, first, [])
      |> list.reverse
    }
  }
}

fn take_dense(
  items: List(VirtualItem),
  indices: List(Int),
  cursor: Int,
  acc: List(VirtualItem),
) -> List(VirtualItem) {
  case indices, items {
    [], _ -> acc
    _, [] -> acc
    [target, ..rest_idx], [item, ..rest_items] ->
      case cursor == target {
        True -> take_dense(rest_items, rest_idx, cursor + 1, [item, ..acc])
        False -> take_dense(rest_items, indices, cursor + 1, acc)
      }
  }
}

// HELPERS --------------------------------------------------------------------

fn result_map_to_zero(r: Result(VirtualItem, Nil)) -> Int {
  case r {
    Ok(item) -> item.end
    Error(_) -> 0
  }
}

fn int_range(from: Int, to: Int) -> List(Int) {
  do_int_range(to, from, [])
}

fn do_int_range(from: Int, to: Int, acc: List(Int)) -> List(Int) {
  case from < to {
    True -> acc
    False -> do_int_range(from - 1, to, [from, ..acc])
  }
}
