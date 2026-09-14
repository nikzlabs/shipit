---
issue: planning#561
title: Daily update check and banner — design
description: How the once-a-day update check, the header banner, and the install-wide dismissal are built.
---

# Daily update check and banner — design

Implements [requirements.md](./requirements.md).

Today an update is only ever found because somebody opened Settings → Advanced
and pressed **Check for Updates** (`AdvancedTab.tsx` → `POST /api/updates/check`
→ `services/updates.ts checkForUpdates()`). Nothing checks on its own, so an
install can sit months behind without a hint (req 1).

## The record, and the one rule that governs it

All state lives in a single record on the `CredentialStore`
(`credential-store.ts`, alongside `voiceWebhook` — this is state, not a declared
setting, so it gets no Settings control):

```ts
updateNotice?: {
  anchor: string;              // the running version this record describes
  lastCheckedAt?: string;      // last SUCCESSFUL check
  lastAttemptAt?: string;      // last attempt, successful or not
  dismissed?: boolean;
  result?: { available: boolean; latestVersion: string; currentVersion: string };
}
```

`anchor` is the running build's commit (`VersionInfo.commit`, resolved once at
boot by `build-id.ts`; the version string is the fallback when there is no
commit). The single rule:

> **A record whose `anchor` is not the running version's anchor is discarded
> whole.**

That one comparison delivers req 5 and keeps the record honest. Performing an
update restarts the orchestrator on new code, so the anchor moves, so the
dismissal ends *and* the previous "v1.5.0 is available" result — now describing
the version the user is running — is dropped instead of being shown for another
day. It is keyed on the observed *state* (which build is running), not on
observing the update *transition*, so it survives a user who updates by re-running
the local script, a viewer that was closed at the time, and a check that never
ran.

## Checking once a day

`services/update-notice.ts` owns the schedule. `startStartupMonitors` runs a tick
every 30 minutes (unref'd, skipped in test mode) and the tick checks whether a
check is *due*:

- ≥ 24 h since `lastCheckedAt`, **and**
- ≥ 1 h since `lastAttemptAt`.

The second clause is the failure backoff: an install with no host repo, or one
that is offline, retries hourly instead of every tick, and a success is what
resets the day. `lastCheckedAt` is persisted, so restarting ShipIt — which
happens on every update — does not earn another check (req 1).

A due tick calls the existing `checkForUpdates()`, so the channel, the
stable-tag resolution and the downgrade detection are the ones Settings already
uses. Errors are swallowed with a log line: a background check must never be
louder than the thing it is checking for.

`available` on the wire is `status.available && !status.isDowngrade` — moving
*off* newer code is not "a newer version is available" (req 6), and the Settings
panel already handles that case with its own warning.

The manual **Check for Updates** button records its result through the same
path, so a manual check counts as the day's check and updates the banner rather
than being a second, disagreeing source of truth.

## Getting it to the browser

A new SSE event, `update_notice`, carrying
`{ available, latestVersion, currentVersion, dismissed }`. It is broadcast when
a check completes and when somebody dismisses, and replayed on SSE connect
(`route-registry.ts`, beside `system_info`) so a page load does not wait up to a
day to learn what the server already knows. Dismissal state travels in the same
payload, which is what makes req 8 work across devices: dismissing on the laptop
broadcasts `dismissed: true` and the phone's banner disappears.

`POST /api/updates/dismiss` sets `dismissed` and broadcasts. It is a plain
endpoint next to the other update routes.

The client stores it in `ui-store` (`updateNotice`) and renders when
`available && !dismissed`.

## The banner, and the slot it shares

Req 2 pins the position to the reconnecting banner's, which is two different
places: on desktop an absolutely-centred pill in the header
(`AppLayout.tsx`), on mobile a padded row under the header (`App.tsx`) — a
layout that has been iterated on and must not be re-derived. So the banner does
not get its own placement; **`TopPanelBanner.tsx` owns both positions and both
occupants**, and the two call sites render it instead of `ConnectionBanner`.

Precedence inside the slot: the connection banner wins. A lost connection is
urgent, transient, and self-clearing, while an available update has been
available for days and can wait a few seconds. This is a design decision, not a
requirement — the requirements only pin the position.

`ConnectionBanner.tsx` is split so one slot can hold either without two
components racing internal timers: `useConnectionBannerState(status)` owns the
1.5 s disconnect delay and the 3 s "Reconnected" flash and returns the state or
`null`; `ConnectionBannerPill` renders it. `ConnectionBanner` stays exported as
hook + pill so its existing call sites and tests are unchanged. `TopPanelBanner`
calls the hook **once** and hands the slot to the update banner when it returns
`null` — mounting `ConnectionBanner` conditionally instead would reset those
timers on every mount and the disconnect banner would never appear.

The pill itself mirrors the connection pill's shape (rounded-full, elevated
background, `shadow-lg`, `text-xs`) in `--color-info`, and carries two controls:
the label opens Settings → Advanced (`setSettingsTab("advanced")` +
`setSettingsOpen(true)`), where the changelog, the channel selector and
**Update Now** already live (req 7); the `✕` dismisses. The banner never applies
an update, so there is exactly one place in the product that does.

Visibility is not tied to a session (req 9): the desktop slot's
`showConnectionBanner` gate now only gates the *connection* occupant. The mobile
row keeps reserving its padding for the whole time a connection could be
reported — as it did before it had a second occupant, so a connected session's
chat does not shift up by 12 px — and a screen that never had the row (the home
screen) grows one only when there is an update to show.

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/services/update-notice.ts` | Due-check policy, anchor rule, dismissal, broadcast payload |
| `src/server/orchestrator/credential-store.ts` | Persists the `updateNotice` record |
| `src/server/orchestrator/startup-monitors.ts` | The 30-minute tick |
| `src/server/orchestrator/api-routes-updates.ts` | `POST /api/updates/dismiss`; manual check records the day |
| `src/server/orchestrator/route-registry.ts` | `update_notice` replay on SSE connect |
| `src/client/components/TopPanelBanner.tsx` | The shared slot, both positions, precedence |
| `src/client/components/UpdateAvailableBanner.tsx` | The pill, open-Settings and dismiss controls |
| `src/client/components/ConnectionBanner.tsx` | Split into `useConnectionBannerState` + `ConnectionBannerPill` |
