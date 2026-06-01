# Release Channels — checklist

## Phase 1 — Foundations
- [x] Decide initial version number — `v0.1.0` (matches the plan's bootstrap release; `package.json` already `0.1.0`)
- [x] Add `.github/workflows/release.yml` (CI gate → FF `stable` → GitHub Release notes)
- [x] Cut the first release tag (`v0.1.0`) and verify `stable` is created/advanced — `origin/stable` points at the `v0.1.0` tag commit (`dbf5a77`)
- [x] Add `RELEASING.md` (tag ritual, patch releases, FF-only invariant)

## Phase 2 — Channel-aware updater
- [x] `.gitignore` add `.release-channel` (and `.restart-requested`)
- [x] `release-channel.ts`: `.release-channel` helpers, channel→ref mapping, default `edge`
- [x] `services/updates.ts`: read channel, resolve ref, channel-aware `checkForUpdates()`
- [x] `services/updates.ts`: `setChannel()`; extend `UpdateStatus` (channel, currentVersion, latestVersion, isDowngrade)
- [x] Handle edge→stable downgrade direction (refs differ but `behindBy` 0)
- [x] `api-routes-updates.ts`: `POST /api/updates/channel`
- [x] `build-id.ts`: `resolveVersion()` (describe-based, against `/opt/shipit`), keep `resolveBuildId()` SHA contract
- [x] Surface `version` on `system_info` SSE event; store in `ui-store`
- [x] `deployment/vps/update.sh`: read `.release-channel`, reset to channel ref, fetch tags
- [x] Default-absent = edge (existing installs unchanged); graceful no-host-repo / local-mode fallback
- [x] Tests: channel resolution, downgrade detection, missing-file default, version fallback

## Phase 3 — UI
- [x] `Settings.tsx`: channel selector (Stable recommended / Edge) with descriptions
- [x] Channel-aware version label (e.g. "Stable · v1.4.0" / "Edge · main @ abc1234")
- [x] Inline release notes / commit list for pending update
- [x] Downgrade warning before Update Now when target not strictly ahead
- [x] Overflow-only "View release on GitHub" escape hatch (`releaseUrl` from origin remote + stable tag)
- [x] Client tests for selector + warning states

## Phase 4 — Setup & docs
- [x] `setup.sh`: default new installs to `stable`, write `.release-channel`, checkout `origin/stable`;
      re-run path is channel-aware (replaced `git pull`)
- [x] `deployment/README.md`: channels, switching, release process
- [x] Update `src/server/shipit-docs/*` if channel/version is agent-visible (N/A — not agent-visible)
- [x] Verify dogfood / `RUNTIME_MODE=local` degrades gracefully (edge fallback when `/opt/shipit` absent)
