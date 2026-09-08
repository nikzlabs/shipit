---
issue: planning#524
title: Automated demo video — design
description: A record/replay proxy at the Anthropic API boundary, a Playwright driver against a dedicated Docker-backed demo instance, and an ffmpeg cut step, all outside ShipIt's server.
---

# 296 — Automated demo video: design

**Requirements:** [`requirements.md`](./requirements.md) — plain-language, human-approved. Numbers like (req 3) refer to entries there. Probe evidence is on planning#524 and under `/persist/harness-probe/` (session `shipit/3qujcu`).

## Intent

Three things produce a repeatable video of a live product without touching it (reqs 2, 3, 5): the model's responses are recorded once and replayed at the API boundary, so every run makes the same agent do the same things; a browser driver clicks through the product and waits on *state*, never on time; and a cut step trims the variable waits down to the storyboard's fixed holds. Everything else is one boring choice each.

## 1. Where it lives

Two repositories, because two different things need to be checked out by two different parties:

- **This repo, `scripts/demo-video/`** — the pipeline: proxy, driver, cut, repo reset, the demo instance's Compose file, and the scenarios (req 7). Under `scripts/` beside `trace-*.mjs`, so it never enters the product build or the images (req 5). It versions with ShipIt's UI, which is what the driver's selectors are written against — a selector rename and the driver change that follows land in one PR. `playwright` (the library, not `@playwright/mcp`) becomes a pinned `devDependency` here, subject to the 7-day dependency-age rule; **not added by this doc**. `/opt/agent-cli/node_modules/playwright` exists in the session-worker image only as a transitive of the MCP package and is not a contract.
- **A sibling repo, the demo app** (`shipit-demo-app`, on the GitHub account the demo instance is connected to) — the app the agent builds on camera. It must be its own git repository because the demo instance clones it, pushes branches to it, and merges PRs into it (req 8d); and it carries the redirect (`.claude/settings.json`), which must not exist in any repo a real user opens. It is a small Vite + React scaffold with `docker-compose.yml` (`x-shipit-preview: auto` dev service) and `shipit.yaml` (`agent.install: npm ci`), no `.github/workflows` (see §6), no branch protection. Each scenario pins it by URL + commit (§3).

## 2. Record/replay proxy — `proxy.mjs`

Sits where the probe's `fake-api.mjs` sat: a dependency-free `node:http` server the Claude CLI reaches through the demo repo's `.claude/settings.json` (req 6):

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://demo-proxy:8787", "ANTHROPIC_API_KEY": "sk-ant-demo" } }
```

Measured (planning#524, CLI 2.1.252): no trust dialog; overrides an OAuth login; one `POST /v1/messages?beta=true` per simple turn, deterministic. The probe also reported that the settings file overrides an ambient `ANTHROPIC_BASE_URL` in the process env, but no artifact of that run survives under `/persist/harness-probe/` — and it matters, because a key-mode credential makes the container spawn *shaped* (`applyServiceRouting` sets `ANTHROPIC_BASE_URL=https://api.anthropic.com` in the env). It is the first checklist item, verified before anything is built on it. The **dummy key is part of the measured redirect** — the probe's three Claude variants all carried it — and it is what keeps the real credential out of the demo repo and the session container.

**Reachability.** Session containers join `DOCKER_NETWORK` (`deployment/vps/docker-compose.yml:50`; `container-lifecycle.ts:1322` `NetworkMode: deps.networkName`), the same Compose network the orchestrator is on. So `demo-proxy` is a **Compose sibling** of the demo instance in `scripts/demo-video/compose.yml`, and the service name is the hostname baked into the settings file — no host IP, no DNS, no dependence on where the host is. The demo instance runs `SESSION_EGRESS_ENFORCE=0` (the documented opt-out, same file) so plain HTTP to a non-allowlisted host is not firewalled; a dedicated instance building a toy app has nothing to contain.

**Lanes.** Two callers reach the proxy and they race each other, so "the nth request" is keyed per lane, and the lane is the auth header kind — a fact of the mechanism, not configuration:
- `x-api-key` (the settings file's dummy) — every CLI spawned in the session container: the resident turn process **and** the PR-description spawn (`non-turn-work.ts` → `runner.spawnSubAgent`, cwd = the workspace, so it reads the same settings file). Strictly sequential within the lane, because the description is generated inside the turn's post-turn flow and the driver waits for its result (§6, beat 2) before typing the next prompt.
- `Authorization: Bearer` / anything else — passthrough in record mode, refused with 401 in replay. Session naming (`session-namer.ts`, orchestrator-side, cwd `/tmp`) never reaches the proxy at all: a key-mode credential shapes its spawn with the catalogue base URL (`applyServiceRouting`, `spawn-routing.ts:121`), so it runs live against Anthropic. See §6 for what that costs.

**Record mode** (`--record <cassette-dir>`): forward to `https://api.anthropic.com`, headers verbatim except `x-api-key`, which is replaced with the proxy's own `ANTHROPIC_API_KEY` (a metered key present only on the demo host); save each response — status, headers, the SSE stream byte-for-byte — as `<lane>/<n>.sse`, plus a `fingerprint` line per request (`model`, message count, tool count, body bytes: the fields `fake-api.mjs` already logs). Bodies are not saved; they carry the system prompt and nothing the replay needs.

**Replay mode** (`--replay <cassette-dir> --pace <spec>`): ignore the body, answer lane request *n* with `<lane>/<n>.sse`, streamed with pacing — `content_block_delta` text at a configured chars/second, tool-input JSON deltas faster, everything else immediate — so the transcript types at a human rate. Log every request's fingerprint beside the cassette's; a mismatch (wrong model, message count off by one) is logged as a **cassette drift** and answered anyway, so a broken take is diagnosable from the log rather than from the video. `HEAD /api/hello` → 200 (seen only under the env redirect, harmless to keep). Running out of cassette → 400 `invalid_request_error`, which ends the turn with a visible error instead of hanging the driver (a 5xx is retried by the CLI — 16 attempts over ~90 s, measured in phase 1).

**Record and replay under the same redirect.** Measured: the request shape differs between `ANTHROPIC_BASE_URL` in the environment and in the settings file (`HEAD /api/hello`, body size, system hash), so a cassette is recorded through the settings file and replayed through the settings file — the recording run is the same driver, same instance, with the proxy in record mode. Recording is authoring: the author records takes until one looks right, then commits that cassette; nothing in a *production* run is manual (req 2).

## 3. Scenario format — `scenarios/<name>/`

One directory per scenario, adding one changes nothing else (req 7):

```
scenarios/website-hero/
  storyboard.json     beats + demo repo pin + pacing
  cassette/           x-api-key/001.sse … + fingerprints.jsonl (recorded, committed)
```

JSON, not YAML: Node parses it with nothing added, and a storyboard is a dozen lines. `storyboard.json`:

```json
{
  "repo": { "url": "https://github.com/<demo-account>/shipit-demo-app", "commit": "<sha>" },
  "viewport": { "width": 1440, "height": 900 },
  "pace": { "textCharsPerSecond": 120 },
  "beats": [
    { "id": "prompt", "type": "…", "pane": "transcript",
      "wait": [{ "turn": "running" }], "lead": 4, "hold": 1 }
  ]
}
```

A beat has one **action** (`type` — text typed into the composer and sent — or `click` — a named UI target such as `merge`), a **pane** to bring to the front (`transcript`, `preview`, `files`, `pr-card`), a list of **wait** conditions that must all hold before the beat is ready (`turn: running|finished`, `preview_text: "…"`, `pr_card: open|merged`, `merge_button: visible`), and two durations the cut step uses (§5): `lead` — seconds kept from the action, showing the work in progress — and `hold` — seconds kept from the moment the beat is ready. `wait` is a list because one beat (§6, beat 2) has to wait for two independent things — the preview *and* the PR-description round-trip — and the second is what keeps the cassette lane sequential.

## 4. Driver — `driver.mjs`

Playwright (library) against the demo instance at `http://localhost:<port>`. Localhost is mandatory, not a convenience: previews are served on `{sessionId}--{port}.<host>` subdomains and the client refuses to build that URL for a non-loopback IP literal (`usePreviewSlot.ts:43`), while Chromium resolves `*.localhost` to loopback natively. So the driver runs on the demo host (or in a `network_mode: host` container). Per run:

1. **Reset** — `reset-demo-repo.sh` (§6) and a fresh state dir: `rm -rf state/ && mkdir` before `docker compose up` (the `onboarding` service's reset, `dogfooding-shipit` skill), so every run is a first boot (req 4). The Compose file gives the instance `SHIPIT_STATE_DIR` on that dir, `ANTHROPIC_API_KEY` (adopted into a stored credential at boot, docs/252 req 20 — this is what enables the composer; it is spent only on session naming), `GITHUB_TOKEN`, `SESSION_EGRESS_ENFORCE=0`, `DOCKER_NETWORK` shared with `demo-proxy`.
2. **Setup, over HTTP, unrecorded** — not part of the picture, so the headless endpoints are the honest tool: wait for `GET /api/bootstrap`; `POST /api/repos` + `POST /api/repos/trust` (the calls `scripts/seed-inner-sessions.js:169-177` already makes); `PUT /api/settings { autoCreatePr: true }`. Then open the browser, collapse the sidebar (§6), start `recordVideo` at the storyboard viewport.
3. **Beats** — everything on camera is a user gesture (req 5): a new session is started from the repo bar, the prompt is typed with `pressSequentially` at a per-character delay and sent with the composer's send button, panes are switched by clicking their tabs, the merge is the card's own button. Waits resolve against the UI (`data-testid` where one exists — ~446 in the client; role/name selectors for the merge button, which has none) or against `GET /api/sessions/:id/status` for `turn: finished`. The driver never sleeps: container boot, `npm ci`, and GitHub round-trips vary between runs, which is the reason waits are on state.
4. **Cursor** (req 11) — headless Chromium draws no pointer, so `page.addInitScript` injects a fixed-position dot that follows `mousemove` and pulses on `mousedown`; every click is preceded by `page.mouse.move(x, y, { steps })` along a short path, so the pointer glides rather than teleports. It lives in the DOM, so `recordVideo` captures it with no post step; a scenario can switch it off with `"cursor": false`.
5. **Beat log** — `beats.json` beside the video: per beat, `actionAt` and `readyAt` as seconds from recording start (wall clock minus the context's creation time). The anchor is *not* the first frame: Playwright's video starts 1–2.5 s after the context opens (measured on the dogfood runs), so the driver also writes `wallDuration` (context open → close) into `run.json`, and the cut step shifts every stamp by `wallDuration − videoDuration` — the file ends at the close, so that difference is exactly how late the first frame was. The driver keeps recording through the last beat's `hold`, or the final slice would run off the end of the file.

Fails loudly: a wait that exceeds a generous ceiling (minutes, not seconds) aborts the run with the beat id and the last screenshot, and the proxy log names any cassette drift.

## 5. Cut — `cut.sh`

Runs **ffmpeg on the demo host** (`apt install ffmpeg`, or a throwaway ffmpeg container with the recording dir mounted). No ShipIt image ships a usable one: the session-worker image has Playwright's `/opt/playwright-browsers/ffmpeg-1011`, but it is built with `libvpx` only (measured) — it can write the webm Playwright records and nothing else.

From the beat log and storyboard it keeps, per beat, `[actionAt, actionAt + lead]` then `[readyAt, readyAt + hold]` (merged when they overlap; a beat with no action starts where the previous hold ends), drops everything before the first beat's action, concatenates, and exports. Everything outside those slices is gone — that is how loading and waiting disappear (req 12). `lead: 0` is the **instant** case: the frame after the click is the frame where the result is ready, so opening a session with its preview takes no time on camera whatever it took on the host. `lead` is only ever non-zero where the work in progress *is* the picture (beat 2's agent-at-work footage).

Exports:
- `hero.mp4` — h264, `yuv420p`, even dimensions, `-movflags +faststart`, no audio track (req 9);
- `hero.webm` — VP9, same cut, no audio.

Both at the recorded viewport, no scaling. The last kept frame is the final beat's static hold and the first is a fresh session with an empty composer, so the loop is a hard cut back to the start (req 8) — no crossfade, nothing to tune.

## 6. Scenario 1 — `website-hero` (req 8)

Silent, looping, ≤ 40 s. Four beats; the app is a habit tracker, chosen because its second prompt repaints the whole preview.

| # | Action | Pane | Ready when | lead | hold |
|---|---|---|---|---|---|
| 0 | Click **New session** on the demo repo | transcript | `composer: ready` | 0 | 1 |
| 1 | Type + send: *"Build a habit tracker: a list of daily habits, a check button on each, and a streak counter that goes up when you check one."* | transcript | `turn: running` | 4 | 1 |
| 2 | (none — the agent works) | preview | `preview_text: "streak"` **and** `pr_card: open` | 6 | 6 |
| 3 | Type + send: *"Switch it to dark mode with a violet accent, and retitle the page 'Streaks'."* | preview | `turn: finished` **and** `preview_text: "Streaks"` | 5 | 6 |
| 4 | Click **Merge** on the PR card | pr-card | `pr_card: merged` | 3 | 4 |

Kept time: 1 + 5 + 12 + 11 + 7 = **36 s**. Beat 0 is the instant case (req 12): the container boot and `npm ci` between the click and a ready composer are cut to nothing, so a session opens the moment it is clicked. Beat 2's `lead` is the agent-at-work footage (files appearing, transcript streaming); the jump-cut to the rendered preview is the compression that fits a real turn into the budget. Sidebar collapsed throughout: more room for transcript + preview, and it hides the one thing that varies between runs — the AI-generated session title. The same live naming also picks the branch name shown on the PR card. Both are words, not sequence or timings (req 3); replaying naming would need an orchestrator-level redirect that a key-mode spawn overwrites (§2), and the alternative — an OAuth account, connected by a human once and refreshed across on-demand runs weeks apart — trades a cosmetic variance for a fragile one.

**Why `autoCreatePr` is on and beat 4 is one click.** With auto-create, turn 1's post-turn flow creates the PR (docs/099); its description is generated through the proxy and the card shows the PR number only after that request has completed, which is what beat 2's second wait pins. Turn 2 auto-pushes onto the PR. The merge button appears when the poller reports mergeability and CI is terminal: a repo with **no workflow files** short-circuits the 20 s "no checks" grace (`ci-grace-tracker.ts`, exit 1), so the button is there on the first poll after the PR opens.

**Repeatable GitHub state.** `reset-demo-repo.sh` runs before each take against the pinned repo: close every open PR, delete every branch but the default, `git push --force origin <pinned-sha>:refs/heads/main`. The demo account's token is the same `GITHUB_TOKEN` the instance gets. After the run the merged squash commit sits on `main` until the next reset; nothing else is retained.

## 7. Open questions (from `requirements.md`, not answered here)

- **Where the demo instance is hosted.** Depends on it: the Compose file's bind address and published ports; where Playwright's Chromium and ffmpeg are installed (the driver must run on that host, §4); whether the prod images (`shipit:prod`, `shipit-session-worker:prod`, built by `deploy.sh`) exist there or the file builds them. The proxy hostname does not depend on it.

## 8. Phase 1 — dogfood (req 13)

Measured 2026-09-08 against the `dev` Compose service (`shipit service start dev`, URL from `shipit service list`, `http://172.16.37.2:3000` that day). The inner orchestrator runs `RUNTIME_MODE=local`: agents spawn in-process inside the `dev` container, and there is no preview, no terminal and no file watcher.

**Where the proxy runs.** On the agent container (this session's), bound to `0.0.0.0:8787`. The `dev` container and the agent container are siblings on the session's Compose network, so the address that reaches the proxy from inside `dev` is the agent container's IP on that network — the `hostname -I` entry in the same /24 as the inner instance's URL (`172.16.37.3` beside `172.16.37.2`). It is not stable across sessions; the storyboard records it as `proxyUrl` and `make-demo-repo.sh` bakes it into `.claude/settings.json`. **Verified reachable, and the settings file wins over a shaped spawn:** with the redirect in the repo, a turn on a Z.ai route (whose `applyServiceRouting` sets `ANTHROPIC_BASE_URL` + key in the process env) arrived at the proxy on the `x-api-key` lane with the dummy key — zero requests reached Z.ai or Anthropic. That is checklist item 5 measured for the in-process spawn; the container spawn (phase 2) is the same CLI reading the same file.

**Repo mechanism.** A local bare repo built by `make-demo-repo.sh` under the gitignored `.inner-shipit/` (the only path `dev` shares with the agent container), added over `POST /api/repos` by `file://` URL — `addRepo` validates no scheme, the bare-cache clone and the warm session's `clone --local` both work, and `POST /api/repos/trust` accepts it. One trap: the URL must be **`file://localhost/…`**, not `file:///…`. With an empty host the client's repo label starts with `/`, the new-session route it builds (`/repo//workspace/…/new`) is collapsed by React Router to a single slash, the slug no longer matches any repo, and `useSessionActivation` bounces to the home screen. The commit is deterministic (fixed identity and dates), so the storyboard's `repo.commit` pin survives a rebuild: `214dd22a…` without the redirect, `c75af3af…` with `http://172.16.37.3:8787`.

**Waits unavailable without a preview.** `preview_text` — there is no Preview tab in local mode at all (`App.tsx` hides it on `isLocalMode`), so the condition is implemented and never holds. `pr_card` / `merge_button` are implementable but out of reach here too: a `file://` remote has no PR to open (the agent's own `gh pr create` reports "Remote URL is not a GitHub repository" and moves on). `file_tree` does hold — the client refetches the tree on `git_committed` after the post-turn commit — but only once the Files tab has been *clicked*: in local mode the tab is displayed by coercion while the ui-store still reads `preview`, and `handleGitCommitted` keys its refresh off the store. The driver clicks each pane tab once even when it already reads as current for that reason; the bug itself is ShipIt's (local-mode only) and is left unmodified (req 5).

**Credentials.** The dogfood install held an Anthropic subscription route (`ANTHROPIC_AUTH_TOKEN`), DeepSeek/xAI/Z.ai/OpenRouter/Vercel keys, and **no `ANTHROPIC_API_KEY`** — so the proxy's record mode had nothing to swap the dummy key for and no cassette was recorded. The phase-1 take is therefore a **live** turn with no proxy in the loop: the storyboard's `model` field pins the warm session (WS `set_model`, unrecorded setup) onto a route the install can run, because the default — the Anthropic subscription — fails every turn there ("not authenticated", planning#358). DeepSeek ran one turn and then answered `402 Insufficient Balance`; the Z.ai subscription (`glm-5.3[1m]`) carried the full take. Session naming still fails on camera (the `nonTurnModel` pin to DeepSeek fails differently: `unrecognized_model` through the CLI's `-p` path), leaving a "Session naming failed" card in the transcript — cosmetic, and phase 2's metered Anthropic key removes it.

**What the run produced.** `scenarios/dogfood-smoke` — three beats: click New session (`composer: ready`), a prompt that creates `hello.txt` (`turn: finished` + `file_tree`), a follow-up that edits it (`turn: finished` + `transcript_text`). Runs 4 and 6 (`/persist/demo-video/run-6/`) completed all three: `recording.webm` 1440×900 VP8 25 fps, ~66 s; `beats.json` (the bare `[{ id, actionAt, readyAt }]` array `cut-plan.mjs` reads, plus `sentAt` on a `type` beat) with `actionAt`/`readyAt` 2.35/4.21, 4.76/47.54, 47.55/65.35 s, which `cut-plan.mjs` turns into 18.6 s kept, and `cut.sh` with a full ffmpeg (`/persist/ffmpeg/bin/ffmpeg`, a static build — the Playwright one has no `concat`) exported `smoke.mp4` (h264) and `smoke.webm` (VP9); the first take came out 16.6 s because the recording stopped at the last beat's ready moment, so the driver now records through the last `hold`; `run.json` beside it carries scenario, mode, viewport and `completed`; `final.png` shows the collapsed sidebar, the file in the tree, the quoted reply, and the cursor dot on the send button. `actionAt` for a `type` beat is the *first keystroke*, so the prompt is typed on camera (req 8a) and `lead` must cover the typing (~5.5 s for a 100-character prompt at 30 chars/s, `pace.typingCharsPerSecond`). The earlier runs exercised the abort path (screenshot named for the beat, video and partial `beats.json` still written). Two facts the plan had wrong: the composer's send button is *unmounted* while a turn runs (a stop button takes its place), so `turn` waits read the stop button and `/status`, not a disabled send; and the Claude CLI **retries a 500** — 16 attempts in 90 s against an exhausted cassette — so the proxy answers exhaustion with a 400, which the CLI treats as final (§2).

**Commands** (agent container): `PLAYWRIGHT_BROWSERS_PATH=/persist/ms-playwright npx playwright install chromium` once (the baked `/opt/playwright-browsers/chromium-1237` belongs to an alpha and does not match 1.62.1's build 1234); `scripts/demo-video/make-demo-repo.sh /workspace/.inner-shipit/demo-video/demo-repo.git [proxyUrl]`; `PLAYWRIGHT_BROWSERS_PATH=/persist/ms-playwright node scripts/demo-video/driver.mjs --instance <url> --scenario scripts/demo-video/scenarios/dogfood-smoke --out /persist/demo-video/run-N --mode record`.

## Key files (planned)

- `scripts/demo-video/proxy.mjs` — record/replay at `/v1/messages`, lanes by auth kind, pacing
- `scripts/demo-video/driver.mjs` — Playwright run: reset, setup over HTTP, beats, `recordVideo`, `beats.json`
- `scripts/demo-video/selectors.mjs` — every selector the driver uses, one map (`data-testid` where the client has one, aria-label/text otherwise)
- `scripts/demo-video/make-demo-repo.sh` — phase-1 demo repo as a deterministic local bare repo, optional `.claude/settings.json` redirect
- `scripts/demo-video/scenarios/dogfood-smoke/storyboard.json` — the phase-1 three-beat scenario (§8)
- `scripts/demo-video/cut.sh` — ffmpeg trim + export (mp4 h264 / webm), muted
- `scripts/demo-video/reset-demo-repo.sh` — close PRs, prune branches, force-reset `main` to the pin
- `scripts/demo-video/compose.yml` — the demo instance (prod image, own state dir, `SESSION_EGRESS_ENFORCE=0`) + `demo-proxy`
- `scripts/demo-video/scenarios/website-hero/{storyboard.json,cassette/}`
- `shipit-demo-app` (sibling repo) — Vite + React scaffold, `docker-compose.yml`, `shipit.yaml`, `.claude/settings.json`
- `/persist/harness-probe/fake-api.mjs` — the measured starting point for the proxy (request logging, SSE framing, upgrade refusal)

## Rejected alternatives

- **Replay inside ShipIt (a fake `agentFactory`)** — the product would run modified (req 5), and it would show a fake agent rather than the real CLI doing real tool calls.
- **Codex / OpenCode** — measured (planning#524): Codex rejects a project-local redirect; OpenCode's is shadowed by ShipIt's own `OPENCODE_CONFIG` inside a session. Either needs a ShipIt-owned config change.
- **A live model take** — timings vary run to run (req 3); it also makes every re-cut cost inference.
- **The dogfood inner instance** — `RUNTIME_MODE=local` has no preview (req 4).
- **CDP screencast via `scripts/trace-*.mjs`** — those drive a raw Chromium over CDP for measurement; a screencast gives exact per-frame timestamps but hands us frame assembly, and typing/clicking/waiting needs the Playwright library anyway. `recordVideo` is one context option and its timing is good enough for a hero loop.
- **A seeded state-dir snapshot** — a tarball of an onboarded instance would let an OAuth account replace the metered key; it carries secrets, ages, and buys only deterministic naming (§6).

Removal pass: cut a `wait_before` field on beats (the `wait` list covers it) and per-lane cassette manifests (the `<lane>/<n>.sse` naming is the manifest).
