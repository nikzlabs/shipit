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

**Replay mode** (`--replay <cassette-dir> --pace <spec>`): ignore the body, answer lane request *n* with `<lane>/<n>.sse`, streamed with pacing — `content_block_delta` text at a configured chars/second, tool-input JSON deltas faster, everything else immediate — so the transcript types at a human rate. Log every request's fingerprint beside the cassette's; a mismatch (wrong model, message count off by one) is logged as a **cassette drift** and answered anyway, so a broken take is diagnosable from the log rather than from the video. `HEAD /api/hello` → 200 (seen only under the env redirect, harmless to keep). Running out of cassette → 500, which ends the turn with a visible error instead of hanging the driver.

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
5. **Beat log** — `beats.json` beside the video: per beat, `actionAt` and `readyAt` as seconds from recording start (wall clock minus the context's creation time; a sub-100 ms anchor error is invisible at hero-loop precision).

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

## Key files (planned)

- `scripts/demo-video/proxy.mjs` — record/replay at `/v1/messages`, lanes by auth kind, pacing
- `scripts/demo-video/driver.mjs` — Playwright run: reset, setup over HTTP, beats, `recordVideo`, `beats.json`
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
