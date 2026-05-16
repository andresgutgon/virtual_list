# Changelog

All notable changes to `virtual_list` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-17

### Added

- New `virtual_list/page_transition` module — wires the
  [View Transitions API](https://developer.chrome.com/docs/web-platform/view-transitions)
  to a list ↔ detail flow built on Lustre + modem. Handles row clicks,
  in-app back buttons, and native back/forward/swipe/keyboard navigation
  with a row-to-detail morph.
- `Pair`, `install`, `uninstall`, `register`, `navigate_forward`,
  `navigate_back` exports.
- `item_id_attr` and `vt_field_attr` constants for tagging rows and the
  child elements that should morph during a transition.
- `install` is idempotent and `uninstall` symmetrically removes every
  listener, suitable for hot-reload and tests.

## [0.1.0]

Initial release.

- Pure-Gleam `Virtualizer` with measurements, range extraction, and
  pure setters (`set_scroll_offset`, `set_container_size`,
  `measure_item`, …).
- Lustre adapter (`virtual_list/lustre`) for container-scroll and
  window-scroll layouts.
- Dynamic row heights via `ResizeObserver` with `estimate_size`
  fallback.
- Padding, gaps, lanes (multi-column), and overscan.
