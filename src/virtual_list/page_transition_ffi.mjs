// Lustre + View Transition API interop.
//
// During a view transition's DOM update phase the browser pauses paint and
// `requestAnimationFrame` callbacks don't fire. Lustre's renderer schedules
// via rAF, so the DOM never updates inside the callback and the transition
// times out. Workaround: while a VT is in flight, redirect rAF to
// queueMicrotask. Microtasks DO fire during the DOM update phase, so Lustre
// renders and the new snapshot reflects the new page.
//
// _vtRafGuards is a refcount, not a boolean: it ensures that overlapping
// owners (the row-click prelude, the active transition, a re-entrant
// transition) compose. Each owner increments on entry and decrements on
// exit; rAF stays patched while count > 0.
let _vtRafGuards = 0;
const _origRAF = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = function (cb) {
  if (_vtRafGuards > 0) {
    queueMicrotask(() => cb(performance.now()));
    return 0;
  }
  return _origRAF(cb);
};

// Attribute names: keep in sync with page_transition.gleam constants.
const ITEM_ATTR = "data-list-item-id";
const FIELD_ATTR = "data-vt-field";

// The virtualizer pools row DOM nodes, so a `view-transition-name` set via
// inline style on one slot can linger when that slot is repurposed for a
// different item. Two elements with the same vt-name in a snapshot triggers
// `InvalidStateError`. Always clear before setting.
function clear_vt_fields() {
  document.querySelectorAll(`[${FIELD_ATTR}]`).forEach((el) => {
    el.style.viewTransitionName = "";
  });
}

// Tag the animatable fields of the item identified by `item_id`. The VT name
// for each field is read from the `data-vt-field` attribute value.
function tag_item(item_id) {
  const row = document.querySelector(`[${ITEM_ATTR}="${item_id}"]`);
  if (!row) return;
  row.querySelectorAll(`[${FIELD_ATTR}]`).forEach((el) => {
    el.style.viewTransitionName = el.dataset.vtField;
  });
}

// Registry of (list_re, detail_re) pairs registered by individual pages.
// Each page module owns its own pair; the popstate handler iterates these to
// find a match. Stored as compiled RegExps to avoid re-compiling per event.
let _pairs = [];

let _installed = false;
let _prevUrl = typeof window !== "undefined" ? window.location.href : "";
let _inSyntheticPopstate = false;
// Set while navigate_back() is in flight. Tells the capture-phase popstate
// handler to let modem see the real event (no stopImmediatePropagation)
// instead of calling vt_back — navigate_back() handles tagging itself.
let _inNavigateBack = false;

function update_scroll_lock() {
  if (!_pairs.length) return;
  const path = window.location.pathname;
  const onDetail = _pairs.some((p) => p.detailRe.test(path));
  document.documentElement.classList.toggle("scroll-locked", onDetail);
}

// Browser-driven forward navigation (forward swipe / forward button).
// The real popstate has already fired and changed the URL; modem must NOT see
// it again, so we stopImmediatePropagation and drive Lustre via synthetic popstate.
function vt_forward(item_id) {
  clear_vt_fields();
  tag_item(item_id);

  _vtRafGuards++;
  const savedScroll = window.scrollY;

  document
    .startViewTransition(() => {
      return new Promise((resolve) => {
        _inSyntheticPopstate = true;
        window.dispatchEvent(new PopStateEvent("popstate"));
        _inSyntheticPopstate = false;

        requestAnimationFrame(() => {
          if (window.scrollY !== savedScroll) window.scrollTo(0, savedScroll);
          // Detail overlay is now in DOM with its own vt-names; clear the
          // row's so the NEW snapshot has one element per name.
          clear_vt_fields();
          requestAnimationFrame(resolve);
        });
      });
    })
    .finished.catch(() => {})
    .finally(() => {
      _vtRafGuards--;
    });
}

// Browser-driven back navigation (back button / back swipe / keyboard).
//
// The capture-phase handler stopImmediatePropagation's the real popstate so
// modem doesn't dispatch immediately. Per the View Transitions spec, the OLD
// snapshot is captured during the next "update the rendering" cycle — not
// synchronously inside startViewTransition. If modem dispatched at bubble
// phase, Lustre's render microtask (rAF is patched to queueMicrotask) would
// drain and remove the detail overlay BEFORE the snapshot ran, so the snapshot
// would miss the [view-transition-name] elements on the detail page. Instead
// we fire a synthetic popstate inside the VT callback below — that drives
// Lustre's render AFTER the OLD snapshot is taken, mirroring vt_forward.
function vt_back(item_id) {
  _vtRafGuards++;
  const savedScroll = window.scrollY;

  document
    .startViewTransition(() => {
      return new Promise((resolve) => {
        _inSyntheticPopstate = true;
        window.dispatchEvent(new PopStateEvent("popstate"));
        _inSyntheticPopstate = false;

        requestAnimationFrame(() => {
          if (window.scrollY !== savedScroll) window.scrollTo(0, savedScroll);
          clear_vt_fields();
          tag_item(item_id);
          requestAnimationFrame(resolve);
        });
      });
    })
    .finished.catch(() => {})
    .finally(() => {
      _vtRafGuards--;
      clear_vt_fields();
    });
}

// Listener references — stored at install time so uninstall can remove them.
const _onScrollLockEvent = () => update_scroll_lock();

const _onClick = (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest(`[${ITEM_ATTR}]`)) {
    // Patch rAF BEFORE Lustre's bubble-phase click handler runs — Lustre's
    // dispatch will call scheduleRender, which reads the guard's value at
    // that moment. The microtask-scheduled release fires AFTER Lustre's
    // dispatch (which has already called navigate_forward and acquired its
    // own guard), so if a transition started, count stays > 0.
    _vtRafGuards++;
    queueMicrotask(() => {
      _vtRafGuards--;
    });
  }
};

// Capture-phase popstate handler. Wraps list ↔ detail navigations in a view
// transition. Handles back button, trackpad swipe, keyboard back/forward.
//
// Both back and forward stopImmediatePropagation: modem must NOT process the
// real popstate, because doing so synchronously schedules Lustre's render
// microtask, which drains BEFORE the browser captures the OLD VT snapshot.
// vt_back / vt_forward drive Lustre themselves via a synthetic popstate
// dispatched inside the VT callback (after the snapshot is taken).
const _onPopstateTransition = (e) => {
  if (_inSyntheticPopstate || _inNavigateBack) {
    _prevUrl = window.location.href;
    return;
  }
  const newUrl = window.location.href;
  const oldUrl = _prevUrl;
  _prevUrl = newUrl;

  if (typeof document.startViewTransition !== "function") return;

  const oldPath = (() => {
    try {
      return new URL(oldUrl).pathname;
    } catch {
      return "";
    }
  })();
  const newPath = new URL(newUrl).pathname;

  for (const p of _pairs) {
    const fromDetail = oldPath.match(p.detailRe);
    if (fromDetail && p.listRe.test(newPath)) {
      e.stopImmediatePropagation();
      vt_back(parseInt(fromDetail[1], 10));
      return;
    }
    const toDetail = newPath.match(p.detailRe);
    if (toDetail && p.listRe.test(oldPath)) {
      e.stopImmediatePropagation();
      vt_forward(parseInt(toDetail[1], 10));
      return;
    }
  }
};

// install() registers all page-transition event handlers.
// Idempotent: calling twice is a no-op.
//
// Call once at app init. Per-page route pairs are added via `register`.
export function install() {
  if (_installed) return;
  _installed = true;
  _prevUrl = window.location.href;

  // Initial scroll lock (handles direct-load to a detail URL — relies on
  // pairs being registered before or shortly after install).
  update_scroll_lock();
  // Keep scroll lock in sync on every navigation source: native popstate,
  // modem.push, and modem.replace all fire independently.
  window.addEventListener("popstate", _onScrollLockEvent);
  window.addEventListener("modem-push", _onScrollLockEvent);
  window.addEventListener("modem-replace", _onScrollLockEvent);

  // Capture-phase click handler: set the rAF-patch flag BEFORE Lustre's click
  // handler runs so its scheduleRender uses the patched rAF too.
  document.addEventListener("click", _onClick, true);

  window.addEventListener("popstate", _onPopstateTransition, true);
}

// Remove every listener install() registered and clear the pair registry.
// Useful for hot-reload and tests; ordinary SPAs never need this.
export function uninstall() {
  if (!_installed) return;
  _installed = false;
  window.removeEventListener("popstate", _onScrollLockEvent);
  window.removeEventListener("modem-push", _onScrollLockEvent);
  window.removeEventListener("modem-replace", _onScrollLockEvent);
  document.removeEventListener("click", _onClick, true);
  window.removeEventListener("popstate", _onPopstateTransition, true);
  _pairs = [];
  document.documentElement.classList.remove("scroll-locked");
}

// Add a (list_re, detail_re) pair to the registry. Pages call this so their
// route shapes are colocated with the page module instead of the app root.
// Idempotent by regex source (same Pair value registered twice = one entry).
export function register(pair) {
  const listRe = new RegExp(pair.list);
  const detailRe = new RegExp(pair.detail);
  const dup = _pairs.some(
    (p) =>
      p.listRe.source === listRe.source &&
      p.detailRe.source === detailRe.source,
  );
  if (dup) return;
  _pairs.push({ listRe, detailRe });
  update_scroll_lock();
}

// Navigate back (detail → list) with a view transition.
// item_id — id matching `data-list-item-id` on the row to morph back to.
//
// Uses real history.back() inside the VT callback so that modem's popstate
// listener (registered at startup, before ours) queues Lustre's render rAF
// first. By the time our tagging rAF fires, the detail overlay is gone and
// the contacts row is in the DOM with its [data-vt-field] elements.
export function navigate_back(item_id) {
  if (!document.startViewTransition) {
    window.history.back();
    return;
  }

  const savedScroll = window.scrollY;
  _inNavigateBack = true;
  _vtRafGuards++;

  document
    .startViewTransition(() => {
      return new Promise((resolve) => {
        window.addEventListener(
          "popstate",
          () => {
            _inNavigateBack = false;
            requestAnimationFrame(() => {
              if (window.scrollY !== savedScroll)
                window.scrollTo(0, savedScroll);
              clear_vt_fields();
              tag_item(item_id);
              requestAnimationFrame(resolve);
            });
          },
          { once: true },
        );
        window.history.back();
      });
    })
    .finished.catch(() => {})
    .finally(() => {
      _inNavigateBack = false;
      _vtRafGuards--;
      clear_vt_fields();
    });
}

// Navigate forward (list → detail) with a view transition.
// item_id — id matching `data-list-item-id` on the row to animate from
// path    — URL to navigate to
// then_fn — called after history push + popstate dispatch
export function navigate_forward(item_id, path, then_fn) {
  clear_vt_fields();
  tag_item(item_id);

  const doNavigate = () => {
    window.history.pushState({}, "", path);
    _inSyntheticPopstate = true;
    window.dispatchEvent(new PopStateEvent("popstate"));
    _inSyntheticPopstate = false;
    then_fn();
  };

  if (!document.startViewTransition) {
    doNavigate();
    return;
  }

  _vtRafGuards++;
  // Preserve document scroll: modem's popstate handler scrolls to 0 on every
  // nav; with the overlay model we want the list to keep its scroll position.
  const savedScroll = window.scrollY;

  document
    .startViewTransition(() => {
      doNavigate();
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          if (window.scrollY !== savedScroll) window.scrollTo(0, savedScroll);
          clear_vt_fields();
          requestAnimationFrame(resolve);
        });
      });
    })
    .finished.catch(() => {})
    .finally(() => {
      _vtRafGuards--;
    });
}
