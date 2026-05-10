import gleam/int
import gleam/list
import gleeunit
import gleeunit/should
import virtual_list.{
  type Options, Options, container_size, default_options,
  invalidate_measurements, measure_item, measure_item_at, new, scroll_offset,
  set_container_size, set_options, set_scroll_offset, total_size,
  virtual_items,
}

pub fn main() {
  gleeunit.main()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn fixed(count: Int, size: Int) -> Options {
  default_options(count: count, estimate_size: fn(_) { size })
}

fn make(count: Int, size: Int) {
  new(fixed(count, size))
}

// ---------------------------------------------------------------------------
// Constructor / getters
// ---------------------------------------------------------------------------

pub fn new_defaults_test() {
  let v = make(5, 50)
  scroll_offset(v) |> should.equal(0)
  container_size(v) |> should.equal(0)
}

pub fn options_roundtrip_test() {
  let opts = fixed(10, 60)
  let v = new(opts)
  virtual_list.options(v).count |> should.equal(10)
}

// ---------------------------------------------------------------------------
// Setters with clamping
// ---------------------------------------------------------------------------

pub fn set_scroll_offset_positive_test() {
  let v = make(5, 50) |> set_scroll_offset(200)
  scroll_offset(v) |> should.equal(200)
}

pub fn set_scroll_offset_clamps_negative_test() {
  let v = make(5, 50) |> set_scroll_offset(-1)
  scroll_offset(v) |> should.equal(0)
}

pub fn set_container_size_positive_test() {
  let v = make(5, 50) |> set_container_size(300)
  container_size(v) |> should.equal(300)
}

pub fn set_container_size_clamps_negative_test() {
  let v = make(5, 50) |> set_container_size(-100)
  container_size(v) |> should.equal(0)
}

// ---------------------------------------------------------------------------
// total_size
// ---------------------------------------------------------------------------

pub fn total_size_empty_test() {
  total_size(make(0, 50)) |> should.equal(0)
}

pub fn total_size_single_item_test() {
  total_size(make(1, 50)) |> should.equal(50)
}

pub fn total_size_multiple_items_test() {
  total_size(make(3, 50)) |> should.equal(150)
}

pub fn total_size_with_gap_test() {
  // Items: start=0,end=50 | start=60,end=110 | start=120,end=170
  let opts = Options(..fixed(3, 50), gap: 10)
  total_size(new(opts)) |> should.equal(170)
}

pub fn total_size_with_padding_test() {
  // Item 0: start=20,end=70. Item 1: start=70,end=120. +padding_end=10 → 130.
  let opts = Options(..fixed(2, 50), padding_start: 20, padding_end: 10)
  total_size(new(opts)) |> should.equal(130)
}

pub fn total_size_with_gap_and_padding_test() {
  // Item 0: start=4,end=54. Item 1: start=62,end=112. Item 2: start=120,end=170. +4 → 174.
  let opts = Options(..fixed(3, 50), gap: 8, padding_start: 4, padding_end: 4)
  total_size(new(opts)) |> should.equal(174)
}

pub fn total_size_non_uniform_estimates_test() {
  let opts =
    default_options(
      count: 4,
      estimate_size: fn(i) {
        case i % 2 {
          0 -> 100
          _ -> 30
        }
      },
    )
  // 100 + 30 + 100 + 30 = 260
  total_size(new(opts)) |> should.equal(260)
}

// ---------------------------------------------------------------------------
// virtual_items — guard conditions
// ---------------------------------------------------------------------------

pub fn virtual_items_zero_container_returns_empty_test() {
  // container_size defaults to 0
  virtual_items(make(100, 50)) |> should.equal([])
}

pub fn virtual_items_empty_measurements_returns_empty_test() {
  let v = make(0, 50) |> set_container_size(500)
  virtual_items(v) |> should.equal([])
}

// ---------------------------------------------------------------------------
// virtual_items — range and overscan
// ---------------------------------------------------------------------------

pub fn virtual_items_all_fit_in_view_test() {
  // 3×50px items in a 200px container — all visible, overscan capped at bounds
  let v = make(3, 50) |> set_container_size(200)
  virtual_items(v) |> list.length |> should.equal(3)
}

pub fn virtual_items_overscan_extends_range_test() {
  // 10×50px items, container=100px, scroll=0
  // Visible: items 0,1 (range 0–1). Overscan=1 → also item 2.
  let v = make(10, 50) |> set_container_size(100)
  virtual_items(v) |> list.length |> should.equal(3)
}

pub fn virtual_items_overscan_clamped_at_start_test() {
  // At scroll=0 the overscan must not go below index 0.
  // Visible: item 0 (range 0–0). Overscan adds item 1, start stays 0.
  let v = make(10, 50) |> set_container_size(50)
  let items = virtual_items(v)
  list.length(items) |> should.equal(2)
  case items {
    [first, ..] -> first.index |> should.equal(0)
    [] -> panic as "expected items"
  }
}

pub fn virtual_items_overscan_clamped_at_end_test() {
  // At the last item, overscan must not exceed count-1.
  // 3×50px, container=50, scroll=100 → item 2 visible; overscan back to item 1.
  let v = make(3, 50) |> set_container_size(50) |> set_scroll_offset(100)
  let items = virtual_items(v)
  list.length(items) |> should.equal(2)
  case list.last(items) {
    Ok(last) -> last.index |> should.equal(2)
    Error(_) -> panic as "expected items"
  }
}

pub fn virtual_items_scroll_offsets_range_test() {
  // 20×50px, container=100, scroll=200
  // start_index=4, end_index=5, overscan → [3,4,5,6] (4 items, first=3)
  let v = make(20, 50) |> set_container_size(100) |> set_scroll_offset(200)
  let items = virtual_items(v)
  list.length(items) |> should.equal(4)
  case items {
    [first, ..] -> first.index |> should.equal(3)
    [] -> panic as "expected items"
  }
}

// ---------------------------------------------------------------------------
// VirtualItem fields
// ---------------------------------------------------------------------------

pub fn virtual_item_fields_single_lane_test() {
  let v = make(3, 50) |> set_container_size(1000)
  case virtual_items(v) {
    [a, b, c] -> {
      a.index |> should.equal(0)
      a.start |> should.equal(0)
      a.size |> should.equal(50)
      a.end |> should.equal(50)
      a.lane |> should.equal(0)
      a.key |> should.equal("0")

      b.index |> should.equal(1)
      b.start |> should.equal(50)
      b.size |> should.equal(50)
      b.end |> should.equal(100)

      c.index |> should.equal(2)
      c.start |> should.equal(100)
      c.end |> should.equal(150)
    }
    _ -> panic as "expected exactly 3 items"
  }
}

pub fn virtual_item_gap_fields_test() {
  let opts = Options(..fixed(2, 50), gap: 10)
  let v = new(opts) |> set_container_size(1000)
  case virtual_items(v) {
    [a, b] -> {
      a.start |> should.equal(0)
      a.end |> should.equal(50)
      b.start |> should.equal(60)
      b.end |> should.equal(110)
    }
    _ -> panic as "expected exactly 2 items"
  }
}

// ---------------------------------------------------------------------------
// measure_item / measure_item_at
// ---------------------------------------------------------------------------

pub fn measure_item_at_updates_size_test() {
  // Item 0 promoted from 50px to 100px; total = 100+50+50 = 200
  let v = make(3, 50) |> measure_item_at(0, 100)
  total_size(v) |> should.equal(200)
}

pub fn measure_item_by_key_updates_size_test() {
  // Default key for index 1 is "1"; total = 50+80+50 = 180
  let v = make(3, 50) |> measure_item("1", 80)
  total_size(v) |> should.equal(180)
}

pub fn measure_item_ignores_zero_test() {
  let v = make(3, 50)
  total_size(measure_item_at(v, 0, 0)) |> should.equal(total_size(v))
}

pub fn measure_item_ignores_negative_test() {
  let v = make(3, 50)
  total_size(measure_item_at(v, 0, -20)) |> should.equal(total_size(v))
}

pub fn measure_item_no_op_on_same_size_test() {
  // Second call with identical size must not change the total
  let v = make(3, 50) |> measure_item_at(0, 80)
  total_size(measure_item_at(v, 0, 80)) |> should.equal(total_size(v))
}

pub fn measure_item_custom_key_test() {
  let opts =
    Options(..fixed(3, 50), get_item_key: fn(i) { "row-" <> int.to_string(i) })
  // Measure by explicit key; total = 50+50+120 = 220
  let v = new(opts) |> measure_item("row-2", 120)
  total_size(v) |> should.equal(220)
}

// ---------------------------------------------------------------------------
// invalidate_measurements
// ---------------------------------------------------------------------------

pub fn invalidate_measurements_resets_to_estimates_test() {
  // After invalidation all items fall back to estimate_size=50; total = 150
  let v =
    make(3, 50)
    |> measure_item_at(0, 200)
    |> invalidate_measurements
  total_size(v) |> should.equal(150)
}

pub fn invalidate_measurements_then_remeasure_test() {
  let v =
    make(3, 50)
    |> measure_item_at(0, 200)
    |> invalidate_measurements
    |> measure_item_at(0, 75)
  // total = 75+50+50 = 175
  total_size(v) |> should.equal(175)
}

// ---------------------------------------------------------------------------
// set_options
// ---------------------------------------------------------------------------

pub fn set_options_rebuilds_measurements_test() {
  let v = make(3, 50) |> set_options(fixed(5, 100))
  total_size(v) |> should.equal(500)
}

pub fn set_options_preserves_scroll_offset_test() {
  // set_options spreads non-option fields, so scroll_offset must survive
  let v = make(10, 50) |> set_scroll_offset(300) |> set_options(fixed(10, 50))
  scroll_offset(v) |> should.equal(300)
}

// ---------------------------------------------------------------------------
// Multi-lane layout
// ---------------------------------------------------------------------------

pub fn multi_lane_total_size_test() {
  // 4 items, 2 lanes: both lanes end at 100 → total = 100
  let opts = Options(..fixed(4, 50), lanes: 2)
  total_size(new(opts)) |> should.equal(100)
}

pub fn multi_lane_items_assigned_to_shortest_lane_test() {
  // 3 items, 2 lanes: item 0→lane 0, item 1→lane 1, item 2→lane 0 (tied→lane 0)
  let opts = Options(..fixed(3, 50), lanes: 2)
  let v = new(opts) |> set_container_size(1000)
  case virtual_items(v) {
    [item0, item1, item2] -> {
      item0.lane |> should.equal(0)
      item1.lane |> should.equal(1)
      item2.lane |> should.equal(0)
    }
    _ -> panic as "expected exactly 3 items"
  }
}

pub fn multi_lane_range_full_when_count_lte_lanes_test() {
  // 1 item with 2 lanes: length ≤ lanes → full range immediately
  let opts = Options(..fixed(1, 50), lanes: 2)
  let v = new(opts) |> set_container_size(500)
  virtual_items(v) |> list.length |> should.equal(1)
}

pub fn multi_lane_start_offsets_independent_per_lane_test() {
  // 4 items, 2 lanes, gap=10:
  // Lane 0: item 0 (start=0,end=50), item 2 (start=60,end=110)
  // Lane 1: item 1 (start=0,end=50), item 3 (start=60,end=110)
  let opts = Options(..fixed(4, 50), lanes: 2, gap: 10)
  let v = new(opts) |> set_container_size(1000)
  case virtual_items(v) {
    [i0, i1, i2, i3] -> {
      i0.start |> should.equal(0)
      i1.start |> should.equal(0)
      i2.start |> should.equal(60)
      i3.start |> should.equal(60)
    }
    _ -> panic as "expected exactly 4 items"
  }
}
