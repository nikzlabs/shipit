# Release Channels — checklist

## Phase 1 — Foundations
- [ ] Decide initial version number; bump `package.json` `version`
- [ ] Add `.github/workflows/release.yml` (CI gate → FF `stable` → GitHub Release notes)
- [ ] Cut the first release tag (`vX.Y.Z`) and verify `stable` is created/advanced
- [ ] Add `RELEASING.md` (tag ritual, patch releases, FF-only invariant)

## Phase 2 — Channel-aware updater
- [ ] `.gitignore` add `.release-channel`
- [ ] `services/updates.ts`: read channel, resolve ref, channel-aware `checkForUpdates()`
- [ ] `services/updates.ts`: `setChannel()`; extend `UpdateStatus` (channel, currentVersion, latestVersion)
- [ ] Handle edge→stable downgrade direction (refs differ but `behindBy` 0)
- [ ] `api-routes-updates.ts`: `POST /api/updates/channel`
- [ ] `build-id.ts`: `resolveVersion()` (describe-based), keep `resolveBuildId()` SHA contract
- [ ] `deployment/vps/update.sh`: read `.release-channel`, reset to channel ref, fetch tags
- [ ] Default-absent = edge (existing installs unchanged); graceful no-host-repo / local-mode fallback
- [ ] Tests: channel resolution, downgrade detection, missing-file default

## Phase 3 — UI
- [ ] `Settings.tsx`: channel selector (Stable recommended / Edge) with descriptions
- [ ] Channel-aware version label (e.g. "Stable · v1.4.0" / "Edge · main @ abc1234")
- [ ] Inline release notes / commit list for pending update
- [ ] Downgrade warning before Update Now when target not strictly ahead
- [ ] Overflow-only "View release on GitHub" escape hatch
- [ ] Client tests for selector + warning states

## Phase 4 — Setup & docs
- [ ] `setup.sh`: default new installs to `stable`, write `.release-channel`, checkout `origin/stable`
- [ ] `deployment/README.md`: channels, switching, release process
- [ ] Update `src/server/shipit-docs/*` if channel/version is agent-visible
- [ ] Verify dogfood / `RUNTIME_MODE=local` degrades gracefully
