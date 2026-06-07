# Checklist — Align the local install with the VPS install

## New scripts (`deployment/local/`)
- [x] `lib.sh` — channel resolution, compose path, `shipit_build_and_up()`, `shipit_cleanup_sessions()`
- [x] `setup.sh` — one-line installer: OS/docker/git preflight, clone to `~/.shipit`, default stable channel, Linux-only inotify bump, build + `up -d`
- [x] `update.sh` — refuse-on-dirty, channel-aware fetch+reset, rebuild + `up -d`
- [x] `stop.sh` — `compose down` + session-container/network sweep; `--purge` for volumes

## VPS stop script
- [x] `deployment/vps/stop.sh` — `compose down` + `shipit-parent-session` / `shipit-stack=shipit` sweep; `--purge` for volumes

## Repointing
- [x] `docker/local/prod.sh` — reverted to a dev-time prod-like test runner (prod counterpart of `dev.sh`); dropped the channel/update logic, removed from the install/update path
- [x] `src/server/orchestrator/services/updates.ts` — 503 message points at `deployment/local/update.sh`
- [x] `README.md` — "Try it locally" one-liner + "Software updates" bullet
- [x] `deployment/README.md` — "Local install" section + VPS "Stopping" section + `SHIPIT_HOME` / `SHIPIT_REPO_URL` docs

## Verification
- [x] `bash -n` on all new/changed scripts (shellcheck not installed in this env; `# shellcheck disable=SC2046` added on the intentional word-split lines)
- [x] `npm run typecheck` after the `updates.ts` change
- [ ] Manual e2e on macOS + Linux (install / update / stop / vps stop) — requires a real Docker host
