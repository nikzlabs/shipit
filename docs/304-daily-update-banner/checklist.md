# Daily update check and banner — checklist

- [x] `CredentialStore` persists the `updateNotice` record (anchor, timestamps, dismissal, last result)
- [x] `services/update-notice.ts`: due-check policy, anchor reset rule, dismissal, wire payload
- [x] Daily tick wired into `startStartupMonitors` (skipped in test mode, unref'd)
- [x] Manual **Check for Updates** and the channel switch record the day's check
- [x] `POST /api/updates/dismiss` + `update_notice` SSE broadcast and connect-time replay
- [x] `ui-store` holds `updateNotice`; `useServerEvents` handles the event
- [x] `ConnectionBanner` split into `useConnectionBannerState` + `ConnectionBannerPill`
- [x] `TopPanelBanner` owns both positions and the precedence; both call sites use it
- [x] `UpdateAvailableBanner` pill: opens Settings → Advanced, dismiss control
- [x] Server tests: due/not-due, backoff, anchor reset clears dismissal and stale result, downgrade not advertised
- [x] Client tests: banner visibility, dismiss POST, Settings navigation, connection banner wins the slot
- [x] Checked in the dogfood UI: desktop header pill, mobile row, Settings navigation, dismiss
- [x] `npm run lint:dev` and `npm run typecheck` clean
- [x] Independent review via `shipit agent run --role reviewer`, twice — the second on the reworked diff
- [x] Review fixes: claim-and-recheck around the fetch, `null` replay, channel-switch invalidation, client rollback reconciliation, `SHIPIT_BUILD_ID` on the local build paths
- [x] Integration test for the dismiss endpoint, live broadcast, disk persistence and connect-time replay; client SSE handler covered
