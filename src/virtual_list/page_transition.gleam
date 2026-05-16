import gleam/list

/// Page transition support for virtual lists.
///
/// Virtual lists pool and reuse DOM nodes, so a `view-transition-name` set via
/// inline style on one slot can linger when that slot is repurposed for a
/// different item. Two elements with the same name in a snapshot causes an
/// `InvalidStateError`. The pattern to avoid it:
///
/// 1. Before starting a transition, clear **all** `[data-vt-field]` elements.
/// 2. Tag only the specific item's fields right before the snapshot.
/// 3. Repeat on cleanup.
///
/// Place `item_id_attr` on each row element and `vt_field_attr` on each child
/// element that should morph during the transition. The JS helpers query by
/// these attributes and set `style.viewTransitionName` from the value.
/// Attribute placed on each row element to identify the item.
/// Set it to the item's string id.
///
/// ```gleam
/// attribute.attribute(page_transition.item_id_attr, int.to_string(item.id))
/// ```
pub const item_id_attr = "data-list-item-id"

/// Attribute placed on child elements that should morph during a view
/// transition. The attribute **value** becomes the `view-transition-name`,
/// so each value must be unique within the page at snapshot time.
///
/// ```gleam
/// attribute.attribute(page_transition.vt_field_attr, "contact-name")
/// ```
pub const vt_field_attr = "data-vt-field"

/// A (list_re, detail_re) route pair. Each page module owns its `Pair` —
/// declare it as a module-level constant next to the rest of the page's
/// routing config, then pass it to `register` at app init.
///
/// `list` matches the list page path(s), e.g. `"^(/contacts|/)$"`.
/// `detail` matches the detail path AND captures the item id in group 1,
/// e.g. `"^/contacts/(\\d+)$"`.
///
/// ```gleam
/// pub const transition = page_transition.Pair(
///   list: "^(/contacts|/)$",
///   detail: "^/contacts/(\\d+)$",
/// )
/// ```
pub type Pair {
  Pair(list: String, detail: String)
}

/// Install the global page-transition event handlers. Idempotent — calling
/// twice is a no-op. Call once at app init, BEFORE `modem.init`, so the
/// capture-phase popstate handler runs ahead of modem's bubble-phase one.
///
/// Per-page route pairs are added separately via `register`.
@external(javascript, "./page_transition_ffi.mjs", "install")
pub fn install() -> Nil

/// Remove every listener `install` registered and clear the pair registry.
/// Useful for hot-reload and tests; ordinary SPAs never need this.
@external(javascript, "./page_transition_ffi.mjs", "uninstall")
pub fn uninstall() -> Nil

/// Register a batch of route pairs. The popstate handler iterates registered
/// pairs to find a list ↔ detail transition match. Idempotent by regex
/// source — registering the same `Pair` twice yields one registry entry.
///
/// Pass every page's pair in one call from app init:
///
/// ```gleam
/// vt_pt.register([contacts.route_transition, users.route_transition])
/// ```
pub fn register(pairs: List(Pair)) -> Nil {
  list.each(pairs, register_one)
}

@external(javascript, "./page_transition_ffi.mjs", "register")
fn register_one(pair: Pair) -> Nil

/// Navigate back (detail → list) with a view transition.
/// Call this instead of `history.back()` when inside the app (e.g. a back
/// button click). `item_id` must match the `item_id_attr` on the list row
/// to morph back to.
@external(javascript, "./page_transition_ffi.mjs", "navigate_back")
pub fn navigate_back(item_id: Int) -> Nil

/// Navigate forward (list → detail) with a view transition.
/// `then_fn` is called after the history push (use it to mark history state).
@external(javascript, "./page_transition_ffi.mjs", "navigate_forward")
pub fn navigate_forward(item_id: Int, path: String, then_fn: fn() -> Nil) -> Nil
