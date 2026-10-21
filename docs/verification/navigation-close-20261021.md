# Navigation drawer close button — 2026-10-21

Version remains 1.0.101, unreleased.

The desktop header rule in material-manager.css loads after responsive.css with equal specificity and overrides the narrow-screen grid. With the logo hidden, the wordmark occupies the old 44px logo column and the close control occupies the flexible column, overlapping the wordmark. The pre-fix Edge geometry assertion reproduces an exact 44px wordmark width.

The narrow drawer grid now has greater specificity and explicit title/control columns, with the close control aligned to the top right. Short-window sticky headers use a nonnegative top offset so the button remains fully visible after scrolling. Desktop navigation and the existing close/focus behavior are preserved.

Local M3E Canvas source: `docs/design/navigation-close-20261021.m3e.json`. Share link saved in `docs/design/navigation-close-20261021-url.txt`, using project `extension-navigation-close-20261021` on `http://127.0.0.1:5186/`. Actual rendered Canvas content was inspected before applying CSS changes. Screenshots remain local.

The Edge regression uses synthetic data in an isolated profile and loads the actual extension document with and without `?surface=sidepanel`. It checks 320/420/560px widths with 100% and 200% text, wordmark/button separation, right inset, 44px click target, navigation scroll, short-window whole-drawer scroll, close/Escape/scrim dismissal, focus return and desktop behavior. It does not automate Edge's native sidebar chrome. No personal browser profile or Android emulator is used.

Results: Edge geometry/interaction regression passes all scenarios; local Canvas acceptance passes. Build/typecheck and Chromium/Firefox asset verification pass. Security and workflow audits pass. Final dist/dist-firefox build: f126a0b73c02a649e83d. Actual 420px dark screenshot inspected locally. No commit, tag or release created.
