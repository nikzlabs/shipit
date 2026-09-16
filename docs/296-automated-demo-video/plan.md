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
- `Authorization: Bearer` / anything else — passthrough in record mode. In replay, a lane with recordings replays like any other; a lane the cassette never recorded gets 401. Session naming (`session-namer.ts`, orchestrator-side, cwd `/tmp`) never reaches the proxy at all: a key-mode credential shapes its spawn with the catalogue base URL (`applyServiceRouting`, `spawn-routing.ts:121`), so it runs live against Anthropic. See §6 for what that costs.

**Record mode** (`--record <cassette-dir>`): forward to `https://api.anthropic.com`, headers verbatim except `x-api-key`, which is replaced with the proxy's own key from `DEMO_PROXY_ANTHROPIC_API_KEY` (a metered key present only on the demo host); the body is read whole and forwarded with a `content-length`, so a chunked request's `transfer-encoding` is dropped rather than sent alongside it. Save each response — status, headers, the SSE stream byte-for-byte — as `<lane>/<n>.sse`, plus a `fingerprint` line per request (`model`, message count, tool count, body bytes: the fields `fake-api.mjs` already logs). Bodies are not saved; they carry the system prompt and nothing the replay needs.

**Replay mode** (`--replay <cassette-dir> --pace-chars-per-second <n>`, the storyboard's `pace.textCharsPerSecond`): ignore the body, answer lane request *n* with `<lane>/<n>.sse`, streamed with pacing — `content_block_delta` text at that many chars/second, tool-input JSON deltas faster, everything else immediate — so the transcript types at a human rate. Log every request's fingerprint beside the cassette's; a mismatch (wrong model, message count off by one) is logged as a **cassette drift** and answered anyway, so a broken take is diagnosable from the log rather than from the video. `HEAD /api/hello` → 200 (seen only under the env redirect, harmless to keep). Running out of cassette → 400 `invalid_request_error`, which ends the turn with a visible error instead of hanging the driver (a 5xx is retried by the CLI — 16 attempts over ~90 s, measured in phase 1).

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
  "pace": { "textCharsPerSecond": 120, "typingCharsPerSecond": 30 },
  "beats": [
    { "id": "prompt", "type": "…", "pane": "transcript",
      "wait": [{ "turn": "running" }], "lead": 4, "hold": 1 }
  ]
}
```

A beat has one **action** (`type` — text typed into the composer and sent — or `click` — a named UI target such as `merge`), a **pane** to bring to the front (`transcript`, `preview`, `files`, `pr-card`), a list of **wait** conditions that must all hold before the beat is ready (`turn: running|finished`, `preview_text: "…"`, `pr_card: open|merged`, `merge_button: visible`), and two durations the cut step uses (§5): `lead` — seconds kept from the action, showing the work in progress — and `hold` — seconds kept from the moment the beat is ready. `pace` carries two rates for two different typists: `typingCharsPerSecond` is the driver's, for the prompt typed into the composer; `textCharsPerSecond` is the proxy's, passed as `--pace-chars-per-second` when the cassette is replayed. `wait` is a list because one beat (§6, beat 2) has to wait for two independent things — the preview *and* the PR-description round-trip — and the second is what keeps the cassette lane sequential.

## 4. Driver — `driver.mjs`

Playwright (library) against the demo instance at `http://localhost:<port>`. Localhost is mandatory, not a convenience: previews are served on `{sessionId}--{port}.<host>` subdomains and the client refuses to build that URL for a non-loopback IP literal (`usePreviewSlot.ts:43`), while Chromium resolves `*.localhost` to loopback natively. So the driver runs on the demo host (or in a `network_mode: host` container). Per run:

1. **Reset** — `reset-demo-repo.sh` (§6) and a fresh state dir: `rm -rf state/ && mkdir` before `docker compose up` (the `onboarding` service's reset, `dogfooding-shipit` skill), so every run is a first boot (req 4). The Compose file gives the instance `SHIPIT_STATE_DIR` on that dir, `ANTHROPIC_API_KEY` (adopted into a stored credential at boot, docs/252 req 20 — this is what enables the composer; it is spent only on session naming), `GITHUB_TOKEN`, `SESSION_EGRESS_ENFORCE=0`, `DOCKER_NETWORK` shared with `demo-proxy`.
2. **Setup, over HTTP, unrecorded** — not part of the picture, so the headless endpoints are the honest tool. First the two checks that make a take worth recording: `git ls-remote <repo.url> HEAD` must equal the storyboard's `repo.commit` (git runs on the driver host; `file://` URLs work), and in replay mode the storyboard must carry `proxyUrl` and `HEAD <proxyUrl>/api/hello` must answer 200 — a replay against a proxy that is not there would be a live take by accident. Either failure aborts before the browser opens, naming both SHAs or the URL. Then: wait for `GET /api/bootstrap`; `POST /api/repos` + `POST /api/repos/trust` (the calls `scripts/seed-inner-sessions.js:169-177` already makes); `PUT /api/settings { autoCreatePr: true }`. Then open the browser, collapse the sidebar (§6), start `recordVideo` at the storyboard viewport.
3. **Beats** — everything on camera is a user gesture (req 5): a new session is started from the repo bar, the prompt is typed with `pressSequentially` at `pace.typingCharsPerSecond` and sent with the composer's send button, panes are switched by clicking their tabs, the merge is the card's own button. Waits resolve against the UI (`data-testid` where one exists — ~446 in the client; role/name selectors for the merge button, which has none) or against `GET /api/sessions/:id/status`. `turn: finished` is three facts about the present — a new assistant message group in the transcript since the send, no stop button, `/status` idle — never the observation of a transition: a poll every 250 ms can miss a short turn's running state entirely. `transcript_text` reads the transcript's scroll container only (the same words in the composer or a file name must not satisfy it); `pr_card` and `merge_button` read the active session's card, not the sidebar, which renders the same badge for every session; and `merge_button: visible` also requires the button enabled, since it is rendered disabled while the branch is unsynced or the agent runs. The driver never sleeps on state: container boot, `npm ci`, and GitHub round-trips vary between runs, which is the reason waits are on state.
4. **Cursor** (req 11) — headless Chromium draws no pointer, so `page.addInitScript` injects a fixed-position dot that follows `mousemove` and pulses on `mousedown`; every click is preceded by `page.mouse.move(x, y, { steps })` along a short path, so the pointer glides rather than teleports. It lives in the DOM, so `recordVideo` captures it with no post step; a scenario can switch it off with `"cursor": false`.
5. **Holds are footage** — the one place the driver waits on the clock, deliberately. After a beat is ready it keeps recording, touching nothing, until its clock reads `beatFootageEnd`: the later of `actionAt + lead` and `readyAt + hold` (a beat with no action starts its lead where the previous hold ended, the same rule as the cut, and the helper shares `cut-plan.mjs`'s slice math so the two cannot disagree). Only then does the next beat switch panes and type, or the context close. So the hold the cut keeps is the result held still, never the next prompt being typed — and whenever a turn outlasts its `lead`, the kept footage is exactly Σ(lead + hold).
6. **Beat log and anchor** — `beats.json` beside the video: per beat, `actionAt` and `readyAt` as seconds on the driver's clock (wall clock minus the context's creation time). That clock is not the video's: Playwright's first frame lands some time after the page opens, and the file's *end* is no better a reference — the recorder ends the file `max(time since the last frame, 1 s)` after the last frame (`videoRecorder.ts` `_stop()`), so a blinking caret makes the tail up to a second long. The anchor is a moment seen on both clocks. Before navigating, the driver paints a black splash (`page.setContent`, held ~250 ms), stamps `anchor.wallAt` into `run.json` immediately before `page.goto(instance, { waitUntil: "commit" })`, and the first non-black frame in the recording is the first paint after that stamp. The cut step finds it with `ffmpeg -vf blackdetect=d=0.08:pix_th=0.10` (the first `black_end`) and shifts every slice by `wallAt − black_end`. Run 9 measured the pair at 0.312 s / 0.200 s and cut exactly the storyboard's 21 s. `wallDuration`, measured just before the context closes, stays in `run.json` as the fallback the cut step uses — loudly, `CUT_UNANCHORED=1` — only when a take has no anchor to find.

Fails loudly: a wait that exceeds a generous ceiling (minutes, not seconds) aborts the run with the beat id and the last screenshot, and the proxy log names any cassette drift.

## 5. Cut — `cut.sh`

Runs **ffmpeg on the demo host** (`apt install ffmpeg`, or a throwaway ffmpeg container with the recording dir mounted). No ShipIt image ships a usable one: the session-worker image has Playwright's `/opt/playwright-browsers/ffmpeg-1011`, but it is built with `libvpx` only (measured) — it can write the webm Playwright records and nothing else.

From the beat log and storyboard it keeps, per beat, `[actionAt, actionAt + lead]` then `[readyAt, readyAt + hold]` (merged when they overlap; a beat with no action starts where the previous hold ends), drops everything before the first beat's action, moves the slices onto the video's clock by the anchor offset (§4 item 6 — slices are shifted after they are computed and then clipped to `[0, duration]`, so a slice that starts before the first frame loses that part rather than sliding), concatenates, and exports. A `run.json` that carries an anchor the file does not show (no black splash found, or no ffprobe to read the duration) is a hard failure, not a silent unanchored cut; `CUT_UNANCHORED=1` overrides it. Everything outside those slices is gone — that is how loading and waiting disappear (req 12). `lead: 0` is the **instant** case: the frame after the click is the frame where the result is ready, so opening a session with its preview takes no time on camera whatever it took on the host. `lead` is only ever non-zero where the work in progress *is* the picture (beat 2's agent-at-work footage).

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

## 7. Open questions

None. The last one (where the demo instance is hosted) was answered on 2026-09-16 — requirements.md req 14 — and §9 records the deployment. What depended on it: the driver and ffmpeg run in the session container (not on the demo host), reaching the instance over the tailnet at an sslip.io host; the proxy hostname never depended on it.

## 8. Phase 1 — dogfood (req 13)

Measured 2026-09-08 against the `dev` Compose service (`shipit service start dev`, URL from `shipit service list`, `http://172.16.37.2:3000` that day). The inner orchestrator runs `RUNTIME_MODE=local`: agents spawn in-process inside the `dev` container, and there is no preview, no terminal and no file watcher.

**Where the proxy runs.** On the agent container (this session's), bound to `0.0.0.0:8787`. The `dev` container and the agent container are siblings on the session's Compose network, so the address that reaches the proxy from inside `dev` is the agent container's IP on that network — the `hostname -I` entry in the same /24 as the inner instance's URL (`172.16.37.3` beside `172.16.37.2`). It is not stable across sessions; the storyboard records it as `proxyUrl` and `make-demo-repo.sh` bakes it into `.claude/settings.json`. **Verified reachable, and the settings file wins over a shaped spawn:** with the redirect in the repo, a turn on a Z.ai route (whose `applyServiceRouting` sets `ANTHROPIC_BASE_URL` + key in the process env) arrived at the proxy on the `x-api-key` lane with the dummy key — zero requests reached Z.ai or Anthropic. That is checklist item 5 measured for the in-process spawn; the container spawn (phase 2) is the same CLI reading the same file.

**Repo mechanism.** A local bare repo built by `make-demo-repo.sh` under the gitignored `.inner-shipit/` (the only path `dev` shares with the agent container), added over `POST /api/repos` by `file://` URL — `addRepo` validates no scheme, the bare-cache clone and the warm session's `clone --local` both work, and `POST /api/repos/trust` accepts it. One trap: the URL is written **`file://localhost/…`**, not `file:///…`. Measured: three runs completed with it; runs with `file:///` bounced home; the mechanism is not pinned down (Node normalises both forms alike). The commit is deterministic (fixed identity and dates), so the storyboard's `repo.commit` pin survives a rebuild: `214dd22a…` without the redirect, `c75af3af…` with `http://172.16.37.3:8787`.

**Waits unavailable without a preview.** `preview_text` — there is no Preview tab in local mode at all (`App.tsx` hides it on `isLocalMode`), so the condition is implemented and never holds. `pr_card` / `merge_button` are implementable but out of reach here too: a `file://` remote has no PR to open (the agent's own `gh pr create` reports "Remote URL is not a GitHub repository" and moves on). `file_tree` does hold — the client refetches the tree on `git_committed` after the post-turn commit — but only once the Files tab has been *clicked*: in local mode the tab is displayed by coercion while the ui-store still reads `preview`, and `handleGitCommitted` keys its refresh off the store. The driver clicks each pane tab once even when it already reads as current for that reason; the bug itself is ShipIt's (local-mode only) and is left unmodified (req 5).

**Credentials.** The dogfood install held an Anthropic subscription route (`ANTHROPIC_AUTH_TOKEN`), DeepSeek/xAI/Z.ai/OpenRouter/Vercel keys, and **no `ANTHROPIC_API_KEY`** — so the proxy's record mode had nothing to swap the dummy key for and no cassette was recorded. The phase-1 take is therefore a **live** turn with no proxy in the loop: the storyboard's `model` field pins the warm session (WS `set_model`, unrecorded setup) onto a route the install can run, because the default — the Anthropic subscription — fails every turn there ("not authenticated", planning#358). DeepSeek ran one turn and then answered `402 Insufficient Balance`; the Z.ai subscription (`glm-5.3[1m]`) carried the full take. Session naming still fails on camera (the `nonTurnModel` pin to DeepSeek fails differently: `unrecognized_model` through the CLI's `-p` path), leaving a "Session naming failed" card in the transcript — cosmetic, and phase 2's metered Anthropic key removes it.

**What the run produced.** `scenarios/dogfood-smoke` — three beats: click New session (`composer: ready`), a prompt that creates `hello.txt` (`turn: finished` + `file_tree`), a follow-up that edits it (`turn: finished` + `transcript_text`). Runs 4, 6, 8 and 9 (`/persist/demo-video/run-9/`) completed all three: `recording.webm` 1440×900 VP8 25 fps, ~71 s; `beats.json` (the bare `[{ id, actionAt, readyAt }]` array `cut-plan.mjs` reads, plus `sentAt` on a `type` beat) with `actionAt`/`readyAt` 0.33/4.53, 6.09/44.22, 46.23/67.97 s on run 9; `run.json` beside it with `anchor.wallAt` 0.312 s, which `cut.sh` matched to blackdetect's `black_end` 0.200 s; and a full ffmpeg (`/persist/ffmpeg/bin/ffmpeg`, a static build — the Playwright one has no `concat`) exported `smoke.mp4` (h264) and `smoke.webm` (VP9) at **21.000 s, exactly the storyboard's Σ(lead + hold)** — every beat's hold was recorded (§4 item 5), and a frame at the last hold's start shows the finished, quoted reply and an idle composer, not typing. The first takes came out short (16.6 s) because the recording stopped at the last beat's ready moment, and run 8's 18.56 s was still one beat's typing cut into another's hold; `final.png` shows the collapsed sidebar, the file in the tree, the quoted reply, and the cursor dot on the send button. `actionAt` for a `type` beat is the *first keystroke*, so the prompt is typed on camera (req 8a) and `lead` must cover the typing (~5.5 s for a 100-character prompt at 30 chars/s, `pace.typingCharsPerSecond`). The earlier runs exercised the abort path (screenshot named for the beat, video and partial `beats.json` still written). Two facts the plan had wrong: the composer's send button is *unmounted* while a turn runs (a stop button takes its place), so `turn: finished` counts assistant message groups against the send and reads the stop button and `/status`, not a disabled send; and the Claude CLI **retries a 500** — 16 attempts in 90 s against an exhausted cassette — so the proxy answers exhaustion with a 400, which the CLI treats as final (§2).

**Commands** (agent container): `PLAYWRIGHT_BROWSERS_PATH=/persist/ms-playwright npx playwright install chromium` once (the baked `/opt/playwright-browsers/chromium-1237` belongs to an alpha and does not match 1.62.1's build 1234); `scripts/demo-video/make-demo-repo.sh /workspace/.inner-shipit/demo-video/demo-repo.git [proxyUrl]`; `PLAYWRIGHT_BROWSERS_PATH=/persist/ms-playwright node scripts/demo-video/driver.mjs --instance <url> --scenario scripts/demo-video/scenarios/dogfood-smoke --out /persist/demo-video/run-N --mode record`; `FFMPEG=/persist/ffmpeg/bin/ffmpeg scripts/demo-video/cut.sh /persist/demo-video/run-N/recording.webm /persist/demo-video/run-N/beats.json scripts/demo-video/scenarios/dogfood-smoke/storyboard.json /persist/demo-video/run-N/smoke`. The full recipe, with the proxy in the loop, is in `scripts/demo-video/README.md`.

## 9. Phase 2 — the demo instance (req 14)

Deployed 2026-09-16 from public `main` at `8aef63a5` (two commits past the workspace's `origin/main` snapshot `a7a9ab86`, which is its ancestor). It is the **local install** recipe (`deployment/local/`), unmodified — not the `scripts/demo-video/compose.yml` §1 and §4 planned, which is now replaced by it (see §Key files). Nothing in §2–§6 changes: the proxy still becomes a Compose sibling on the instance's network, now `shipit-prod`.

**Host.** SSH alias `services` (tailnet `100.81.125.94`, user `nik`, passwordless sudo, docker group; Ubuntu, kernel 6.8, Docker 29.7.2, Compose v5.5.0, 4 cores, 7.8 GB, 141 GB free before the install). Req 14 names the "shipit stable" machine (`100.87.221.1`); the coordinator directed this deploy to `services` instead — both are granted to session `3qujcu`, and requirements.md still says the other one. Untouched and verified so after the install: `reply-radar-app-1` on `127.0.0.1:8080`, `tailscaled` serving on `100.81.125.94:443`.

**What the scripts do, measured.** `setup.sh` runs non-interactively when `SHIPIT_HARNESSES` is set (no TTY → every other question takes its default); on the host it writes `/etc/sysctl.d/99-shipit-inotify.conf` via sudo and checks Docker, nothing else — Docker is never installed by it. Two knobs did **not** do what the brief expected. `SHIPIT_EGRESS=off` is consulted only when the NET_ADMIN probe *fails*; this host passes it, so the answer is ignored and containment stays on. The opt-out that works is the same file the script would have written: `SESSION_EGRESS_ENFORCE=0` in `$SHIPIT_HOME/.shipit.env`, which `shipit_build_and_up` loads into the Compose environment. And a fresh clone gets `.release-channel=stable`, so `shipit_sync_checkout` resets to `origin/stable`, not main — the channel is set to `edge` before the first run. Both are `$SHIPIT_HOME` files, so the install stays within the recipe.

**Commands run** (on `services`, in this order; `setup.sh` was launched detached with `nohup setsid … < /dev/null` and polled):

```bash
git clone https://github.com/nikzlabs/shipit.git ~/.shipit
echo edge > ~/.shipit/.release-channel                      # sync to origin/main, not origin/stable
printf 'SESSION_EGRESS_ENFORCE=0\n' > ~/.shipit/.shipit.env  # the egress opt-out that a NET_ADMIN-capable host honours
chmod 600 ~/.shipit/.shipit.env
SHIPIT_HARNESSES=claude SHIPIT_EGRESS=off bash ~/.shipit/deployment/local/setup.sh   # 204 s, launch → "Started"
bash ~/.shipit/deployment/local/tailscale.sh                                          # 23 s: cached rebuild + restart
```

`setup.sh` persisted `SHIPIT_HARNESSES=claude` beside the egress line, so only the Claude CLI is baked in (bootstrap: `claude installed=true`, the other four `installed=false`). `tailscale.sh` appended `SHIPIT_TAILNET_BIND=1` and wrote the overlay `~/.shipit/.shipit-tailnet.compose.yml` publishing `100.81.125.94:4123:4123`. Disk after: images 7.3 GB (`shipit-session-worker:prod` 5.44 GB, `shipit-prod-shipit` 1.74 GB, sidecar 48 MB) + 10 GB build cache; `/` went from 3.9 to 18 GB used.

**Bind and URL.** `ss -ltnp`: `4123` on `100.81.125.94` and `127.0.0.1`, `4124` (the Vite port, unused in prod) on loopback only. Browse at **`http://100-81-125-94.sslip.io:4123`** — the sslip host, never the raw IP: `usePreviewSlot.ts:39` returns no preview URL for an IPv4 literal, while on the sslip host the client builds `http://{sessionId}--{port}.100-81-125-94.sslip.io:4123/`, and a probe of that shape (`GET` with a random UUID) reached the instance's preview proxy and got its 502 JSON — the wildcard resolves and routes. Both names resolve from a session whose network mode is **Open**; a contained session cannot resolve `*.sslip.io` at all, so the driver, which must run at `localhost` anyway (§4), belongs on `services`. Verified from session `3qujcu`: `GET /` 200 (`x-frame-options: DENY`), `GET /api/bootstrap` → `runtimeMode: "containerized"`, `sessions: []`, `repos: []`, `githubStatus.authenticated: false`, `settings.canRunTurns: false`, `autoCreatePr: false`; the container env carries `SESSION_EGRESS_ENFORCE=0` and `SHIPIT_BUILD_ID=8aef63a5…`; a warm-pool worker `agent-00000000-000` was up within seconds. The first screen is the onboarding modal, **Connect GitHub** — a "GitHub personal access token" field (placeholder `ghp_…`, disabled Connect button, a link to a classic PAT with `repo` + `workflow`) beside the product pitch; behind it the app shell with an empty sidebar ("No repositories yet"). Nothing was entered. The harness and credential steps come after GitHub, so they were not seen.

**What it still needs from Nik.** (1) A GitHub token for the demo account — the account that owns `shipit-demo-app` (§1), entered in that modal; it also becomes the `GITHUB_TOKEN` `reset-demo-repo.sh` uses (§6). (2) A metered **Anthropic API key**, added as a credential in Settings — this is what makes `canRunTurns` true and what session naming spends (§6); the recording run additionally needs it as `DEMO_PROXY_ANTHROPIC_API_KEY` on the proxy (§2). The local Compose file passes no `ANTHROPIC_API_KEY` env, so the docs/252 boot adoption §4 item 1 relies on is not available here; the key is entered once and lives in the credentials volume. Both are Nik's to type — nothing was entered by the session.

**Reset between takes.** State is in two named volumes: `shipit-prod_workspace` (mounted at `/workspace`; `.shipit.db` at its root — `app-di.ts:238`, the state dir is the workspace dir in container mode — plus `sessions/`, `repo-cache/`) and `shipit-prod_credentials` (`/credentials/shipit-credentials.json`: provider keys **and** the GitHub token, `credential-store.ts:72,152`). So a take-to-take reset drops the workspace volume and keeps the credentials one — not `stop.sh --purge`, which deletes both and puts the instance back at the GitHub modal. Not run; the sequence:

```bash
~/.shipit/deployment/local/stop.sh                 # compose down (volumes kept) + removes session containers
docker volume rm shipit-prod_workspace
SHIPIT_HOME=~/.shipit bash -c '. ~/.shipit/deployment/local/lib.sh && shipit_build_and_up'   # cached build, loads .shipit.env, refreshes the tailnet overlay, up
```

`update.sh` would do the last step too, but it also re-syncs the checkout to `origin/main`, which moves the instance under a pinned take. Unverified until the first reset: whether a fresh `.shipit.db` next to a populated credentials file re-runs onboarding (harness choice, `autoCreatePr`) or reads the stored token as connected — the driver's `PUT /api/settings` step covers the settings either way. This replaces §4 item 1's `rm -rf state/`: the instance's state is a volume, not a bind-mounted dir.

**Teardown.** `~/.shipit/deployment/local/stop.sh --purge` (both volumes), then `docker rmi shipit-session-worker:prod shipit-prod-shipit shipit-egress-sidecar:prod`, `docker builder prune`, `rm -rf ~/.shipit`, and `sudo rm /etc/sysctl.d/99-shipit-inotify.conf` (the one file outside `$SHIPIT_HOME`). The `shipit-prod` network goes with `down`.

## Key files (planned)

- `scripts/demo-video/proxy.mjs` — record/replay at `/v1/messages`, lanes by auth kind, pacing
- `scripts/demo-video/driver.mjs` — Playwright run: pin + proxy checks, setup over HTTP, black-splash anchor, beats with per-beat holds (`beatFootageEnd`), `recordVideo`, `beats.json` + `run.json`
- `scripts/demo-video/selectors.mjs` — every selector the driver uses, one map (`data-testid` where the client has one, aria-label/text otherwise; transcript and PR-card scopes)
- `scripts/demo-video/make-demo-repo.sh` — phase-1 demo repo as a deterministic local bare repo, optional `.claude/settings.json` redirect
- `scripts/demo-video/scenarios/dogfood-smoke/storyboard.json` — the phase-1 three-beat scenario (§8)
- `scripts/demo-video/cut-plan.mjs` — slice math: beat log + storyboard → slices, anchor offset (`anchorOffset`, `anchorSlices`), ffmpeg filter
- `scripts/demo-video/cut.sh` — ffprobe + blackdetect anchor, then ffmpeg trim + export (mp4 h264 / webm), muted
- `scripts/demo-video/reset-demo-repo.sh` — close PRs, prune branches, force-reset `main` to the pin
- `deployment/local/{setup,tailscale,lib,stop}.sh` + `docker/local/prod/compose.yml` — the demo instance (§9); replaces the planned `scripts/demo-video/compose.yml`. `demo-proxy` still to be added as a sibling on the `shipit-prod` network
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
