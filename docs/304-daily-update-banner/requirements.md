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

## Open questions

- What the banner offers besides "dismiss": does it apply the update in place,
  or open Settings → Software Updates where the changelog and the existing
  "Update Now" button live?
- Whether a dismissal is per install (stored on the server, so every browser
  and device is quiet) or per browser (stored locally, so another device still
  sees the notice).
- Whether the banner appears on the home screen and the new-session view, where
  the reconnecting banner is not shown at all today because it has no session
  to report on.

## Resolved questions

- None yet.
