# Checklist — local bind address and Tailscale access

- [x] `requirements.md` written from the human's own words, with both answers recorded as dated receipts
- [x] `docker/local/prod/compose.yml` binds `${SHIPIT_BIND_ADDR:-127.0.0.1}` (req 1, 2)
- [x] `lib.sh`: `shipit_refresh_tailnet_bind()` re-derives the tailnet binding at every start (req 5, 6)
- [x] `lib.sh`: `shipit_compose_files()` threads the generated overlay through every compose call
- [x] `lib.sh`: `|| true` on the `tailscale ip` substitution so a disconnected daemon can't abort `set -e` callers (req 5)
- [x] `deployment/local/tailscale.sh` — opt in, print the sslip.io URL (req 4)
- [x] `setup.sh` output points at `tailscale.sh` and states the loopback default
- [x] `.gitignore`: `.shipit.env` + generated overlay, unblocking `update.sh` (req 9)
- [x] `suggestWildcardHost()` + preview empty state names a usable host (req 8)
- [x] `SECURITY-MODEL.md` describes the real default and both opt-ins (req 7)
- [x] `README.md` + `deployment/README.md` remote-access sections (req 7)
- [x] `CLAUDE.md` preview-routing paragraph corrected (path-based fallback was deleted in docs/175)
- [x] Tests: `local-install-bind.test.ts` (7) drives the real `lib.sh` against a stubbed `tailscale`
- [x] Tests: `preview-host.test.ts` extended for `suggestWildcardHost` (7 new)
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Independent requirements review by a fresh-context reviewer (Codex), findings resolved below

## Review round (2026-08-06, Codex against `requirements.md`)

Accepted and fixed:

- [x] **Req 9 didn't actually work.** `shipit_sync_checkout` refused on *untracked* files, but
      `git reset --hard` never touches those — so the check protected nothing while permanently
      wedging updates for anyone with a `.shipit.env`. Narrowed to `--untracked-files=no`; the
      `.gitignore` entry alone would not have reached already-affected installs, since `update.sh`
      sources their old `lib.sh` before fetching. One-time recovery documented in `deployment/README.md`.
- [x] **Best-effort path could still abort startup.** `mktemp`/`cat`/`mv`/`rm` were unguarded under
      `set -e`. All now degrade to loopback-only. Overlay *removal* failure warns instead of failing
      silently, because `shipit_compose_files` keys off the file's existence.
- [x] **Req 3 violated by our own setup output** — it advertised Tailscale on the default path. Replaced
      with a neutral pointer to `deployment/README.md`.
- [x] **`tailscale.sh` printed a possibly-stale address.** It now reports what `lib.sh` actually bound
      (`SHIPIT_TAILNET_IP`), and errors if the binding was skipped rather than claiming success.
- [x] Doc inaccuracies: wildcard DNS alone ≠ HTTPS (`README.md`); the client exempts loopback IPs from
      the raw-IP refusal (`CLAUDE.md`); the "never blocks startup" claim needed scoping to the start
      paths, not `tailscale.sh` (`deployment/README.md`).
- [x] `suggestWildcardHost`'s IPv6 comment claimed no fix exists; sslip.io does serve dashed IPv6. Now
      stated as a scope decision, and the test says so.
- [x] Coverage gaps: added the two `sync_checkout` cases, the unwritable-overlay case, the
      undeletable-overlay case, and two `PreviewFrame` assertions (suggestion shown / correctly absent).

Rejected, with reasons:

- **"Req 5: `tailscale.sh` should record the opt-in and start anyway when Tailscale is down."** The
  requirement is about *ShipIt* starting, and the start paths (`setup.sh`/`update.sh`) handle that
  correctly. `tailscale.sh` is the opt-in command; failing its own precondition is the right outcome,
  and silently proceeding would be worse.
- **"Req 4: support IPv6-only tailnets."** Real but rare — Tailscale assigns IPv4 by default and
  disabling it is an advanced setting. Recorded as a known limitation rather than built.

Amended:

- **Req 5's "recovers on its own"** was an agent-authored over-promise: a published Docker port binding
  cannot be added to a running container, so restoration requires recreating it either way. Reworded to
  the strongest achievable behaviour, flagged rather than quietly loosened.

## Live-machine verification round (2026-08-06, real macOS laptop + tailnet)

- [x] **Blocking macOS bug fixed.** `command -v tailscale` reported "not installed" on a connected Mac:
      the standalone app keeps its CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` and
      never puts it on `PATH`. It broke both the preflight *and* `shipit_refresh_tailnet_bind`, so a
      user who hand-set `SHIPIT_TAILNET_BIND=1` got loopback-only on every start forever — no
      configuration made the feature work on a stock macOS install. Now resolved via
      `shipit_tailscale_bin()`, shared by both scripts, which returns an invocable *path* (symlinking
      the bundle binary is not a workaround — it resolves its bundle identifier from its own path and
      aborts). `SHIPIT_TAILSCALE_BIN` overrides for nonstandard installs.
- [x] Test gap closed: every prior case stubbed the binary onto `PATH`, the exact assumption that fails
      on macOS. Added bundle-path resolution (via the `SHIPIT_TAILSCALE_PREFIX` test seam) and
      override-precedence cases.
- [x] Nit: "every compose invocation threads the overlay" was inaccurate — `stop.sh` doesn't, and
      correctly so (`down` resolves by project name; the overlay adds only a port). Reworded.

Confirmed empirically on that machine, closing the gaps this branch could not verify in-container:

- The exposure was real: `TCP *:4123`, HTTP 200 from both the LAN address and a second tailnet host.
  After the change, `127.0.0.1` only, both refused, `localhost` still 200.
- The Compose `-f` merge **appends** (host_ip `127.0.0.1`/`127.0.0.1`/`100.x`), so the documented-spec
  reasoning in `plan.md` was right. `SHIPIT_BIND_ADDR=0.0.0.0` resolves both bindings as documented.
- Previews resolve over the tailnet; the subdomain proxy parsed `<sessionId>--3000.<sslip>` and did a
  session lookup (the install had archived sessions only, so no container to serve).
- Degradation and the update-path fix both behave as designed against a real git repo.

## Follow-up from on-laptop verification (2026-08-06)

- [x] **`tailscale.sh`'s "CLI not found" hint told users to `export SHIPIT_TAILSCALE_BIN=…`**, which
      fixes only the shell in front of them. The next `update.sh` from a fresh shell has no such
      variable, `shipit_refresh_tailnet_bind` falls to "Tailscale not reachable", and tailnet access
      silently disappears — the exact persistence problem the branch already solves for
      `SHIPIT_TAILNET_BIND` via `.shipit.env`, so the hint contradicted the design's own model. Both
      the Darwin and non-Darwin branches now show the appending-to-`.shipit.env` form (with the real
      expanded path, so it is copy-pasteable) and say why the shell-local form is not enough.
- [x] **One code change was needed after all**, contrary to the initial read: `tailscale.sh` sourced
      `lib.sh` but never called `shipit_load_env_file`, so its own preflight could not see a
      `SHIPIT_TAILSCALE_BIN` persisted in `.shipit.env`. The advice worked for `update.sh` (which loads
      the env file via `shipit_build_and_up`) but not for the script printing it — a user would add the
      line, re-run, and hit the identical error. Verified both directions before and after the fix.

No new test: this is user-facing message wording, and asserting literal prose is against convention.
`bash -n` clean, both error branches rendered and inspected (Darwin via a stubbed `uname`), and the 14
existing `local-install-bind.test.ts` cases still pass.

## Deliberately not done

- **Removing the `4124:5173` mapping.** Nothing listens on 5173 in the prod image — the client is
  built at image-build time and served from `dist/client/` on 4123, and `EXPOSE 3000 5173` in
  `Dockerfile.prod` is stale metadata. The mapping is narrowed to the bind variable rather than
  deleted, because deleting it is beyond what was asked and wants its own change.
- **A `SHIPIT_BIND_ADDR` equivalent for the VPS.** It already binds `127.0.0.1` behind Caddy plus
  Zero Trust or the tailnet forwarder, so there is no exposed port to harden.
- **Reusing the docs/216 `.tailnet-preview-host` mechanism.** It exists to serve the app on a native
  MagicDNS `.ts.net` name while routing only preview iframes through sslip.io, and is hard-gated to
  `.ts.net` browsing. Here the user browses the sslip host directly, so it would be inert.
