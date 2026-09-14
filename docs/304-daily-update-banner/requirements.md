---
issue: planning#561
title: Daily update check and banner
description: ShipIt checks for a newer version once a day and shows a dismissible banner in the header slot the reconnecting banner uses.
---

# Daily update check and banner

1. ShipIt checks by itself whether a newer version is available, at most once a
   day, without the user pressing anything.
2. When a check finds a newer version, ShipIt shows a banner in the top panel,
   in exactly the position the "Reconnecting…" banner occupies today — the
   centred header position on desktop and the separate mobile position, both
   unchanged.
3. The user can dismiss that banner.
4. After a dismissal, no further update notification appears — not for this
   version and not for any later version that becomes available.
5. Performing an update ends the dismissal: once ShipIt is running the newer
   code, a later available version notifies again.
6. No update notification appears while ShipIt is already running the newest
   version on its channel.
7. Acting on the banner opens Settings → Software Updates, where the changelog,
   the channel selector and the existing update control already are. The banner
   itself never applies an update.
8. A dismissal covers the whole install: every browser and every device pointed
   at this ShipIt goes quiet, and stays quiet across reloads and restarts.
9. The banner can appear anywhere the top panel is — including the home screen
   and the new-session view, where the reconnecting banner is never shown.

## Open questions

- None.

## Resolved questions

- 2026-09-14 — What should the banner do besides let the user dismiss it?
  Nik: open Settings → Software Updates; do not apply the update from the
  banner. Carries the constraint that no update-applying logic is duplicated
  outside Settings (req 7).
- 2026-09-14 — Is a dismissal per install or per browser? Nik: the whole
  install, stored on the server (req 8).
- 2026-09-14 — Should the banner appear on the home screen and the new-session
  view, where the reconnecting banner is hidden? Nik: yes, everywhere the top
  panel is (req 9).
