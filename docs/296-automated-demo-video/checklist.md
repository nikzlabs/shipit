# 296 — Automated demo video checklist

- [ ] Resolve the two open questions in `requirements.md` (demo-instance host; cursor overlay) — implementation code waits on them
- [ ] Create the `shipit-demo-app` repo on the demo GitHub account: Vite + React scaffold, `docker-compose.yml` with the `x-shipit-preview: auto` dev service, `shipit.yaml` with `agent.install: npm ci`, `.claude/settings.json` (`ANTHROPIC_BASE_URL` → `http://demo-proxy:8787`, dummy `ANTHROPIC_API_KEY`), no `.github/workflows`, no branch protection; record the snapshot SHA
- [ ] Add `playwright` as an exact-pinned `devDependency` (≥ 7 days old, `npm run check-deps` green) — with user sign-off if a younger release is needed
- [ ] `scripts/demo-video/compose.yml` — `shipit` (prod image, bind-mounted fresh `SHIPIT_STATE_DIR`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `SESSION_EGRESS_ENFORCE=0`, `DOCKER_NETWORK`) + `demo-proxy` on the same network
- [ ] Verify the settings-file redirect beats a *shaped* container spawn (`applyServiceRouting` sets `ANTHROPIC_BASE_URL` + the real key in the env): one turn on the demo instance with the proxy logging, zero requests at api.anthropic.com
- [ ] `proxy.mjs` — lanes by auth header kind; record mode (forward, swap `x-api-key` for the proxy's key, save `<lane>/<n>.sse` + fingerprints); replay mode (nth response per lane, paced SSE, drift log, `HEAD /api/hello` → 200, exhausted cassette → 500)
- [ ] `reset-demo-repo.sh` — close open PRs, delete non-default branches, force-push `main` to the pinned SHA
- [ ] `driver.mjs` — fresh state dir + `compose up`; HTTP setup (`/api/bootstrap`, `/api/repos`, `/api/repos/trust`, `PUT /api/settings { autoCreatePr: true }`); browser at `localhost`, sidebar collapsed, `recordVideo`; beat loop with `type` / `click` actions, pane switching, `wait` conditions (`turn`, `preview_text`, `pr_card`, `merge_button`), ceiling-abort with screenshot; `beats.json`
- [ ] `cut.sh` — keep `[actionAt, +lead]` and `[readyAt, +hold]` per beat, concatenate, export `hero.mp4` (h264, yuv420p, faststart, no audio) and `hero.webm` (VP9, no audio)
- [ ] `scenarios/website-hero/storyboard.json` — the four beats from plan §6, repo pin, viewport, pace
- [ ] Record the `website-hero` cassette through the settings-file redirect; replay it once and confirm the fingerprint log shows no drift; commit `cassette/`
- [ ] Run the full pipeline twice from a fresh state dir and confirm the two cuts have the same length and beat boundaries (req 3)
- [ ] `scripts/demo-video/README.md` — one page: prerequisites on the demo host, `record` / `run` / `cut` invocations, how to add a scenario
- [ ] Update plan §Key files with anything that moved during implementation; `npm run lint:dev`, `npm run typecheck`
