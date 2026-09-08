# demo-video — usage

The automated demo-video pipeline of `docs/296-automated-demo-video` (design in
its `plan.md`; this file is only how to run what exists). Phase 1 pieces:

| File | Role |
|---|---|
| `proxy.mjs` | Record/replay proxy at the Anthropic API boundary (plan §2) |
| `driver.mjs` | Playwright run against an instance: setup over HTTP, beats, `recording.webm` + `beats.json` + `run.json` (plan §4) |
| `selectors.mjs` | Every selector the driver uses, one map |
| `make-demo-repo.sh` | The phase-1 demo repo as a deterministic local bare repo (plan §8) |
| `scenarios/<name>/storyboard.json` | Beats, repo pin, viewport, pace (plan §3) |
| `cut-plan.mjs` | Slice math: beat log + storyboard + anchor to ffmpeg trim/concat filter (plan §5) |
| `cut.sh` | ffmpeg wrapper around `cut-plan.mjs`: blackdetect anchor, muted VP9 webm + h264 mp4 |
| `__fixtures__/cassette/` | A tiny cassette the tests replay |

`proxy.mjs`, `cut-plan.mjs` and `cut.sh` are plain ESM / bash with no
dependencies: the demo host needs node and a full ffmpeg (with ffprobe), nothing
else. `driver.mjs` needs the repo's pinned `playwright` devDependency (`npm
install` in this checkout) and a Chromium it can launch — see the environment
notes under "Run a scenario".

## Run a scenario

Everything below is from the repo root. Values in `<…>` come from the
storyboard or the host; the ones shown are this dogfood session's
(`shipit service list` gives the inner instance URL, `hostname -I` the agent
container's address the instance can reach the proxy at).

```sh
# 0. Once per host: a Chromium the pinned playwright can launch, and a full ffmpeg.
export PLAYWRIGHT_BROWSERS_PATH=/persist/ms-playwright   # `npx playwright install chromium` once
export FFMPEG=/persist/ffmpeg/bin/ffmpeg                  # static build; ffprobe sits beside it

# 1. The demo repo, pinned. With a proxy URL the repo carries the redirect
#    (.claude/settings.json) and its SHA differs — put the printed SHA in the
#    storyboard's repo.commit; the driver refuses to run against any other.
scripts/demo-video/make-demo-repo.sh /workspace/.inner-shipit/demo-video/demo-repo.git http://172.16.37.3:8787

# 2a. Authoring: the proxy in record mode (a real key on the host, never in the repo).
DEMO_PROXY_ANTHROPIC_API_KEY=sk-ant-... \
  node scripts/demo-video/proxy.mjs --record scripts/demo-video/scenarios/<name>/cassette &

# 2b. Production: replay the committed cassette, paced at the storyboard's pace.textCharsPerSecond.
node scripts/demo-video/proxy.mjs --replay scripts/demo-video/scenarios/<name>/cassette \
  --pace-chars-per-second 120 &

# 3. The take. --mode replay refuses to start unless the storyboard's proxyUrl
#    answers HEAD /api/hello; both modes refuse unless the repo pin matches.
node scripts/demo-video/driver.mjs \
  --instance http://172.16.37.2:3000 \
  --scenario scripts/demo-video/scenarios/<name> \
  --out /persist/demo-video/run-N \
  --mode replay            # or record, with 2a

# 4. The cut.
bash scripts/demo-video/cut.sh \
  /persist/demo-video/run-N/recording.webm \
  /persist/demo-video/run-N/beats.json \
  scripts/demo-video/scenarios/<name>/storyboard.json \
  /persist/demo-video/run-N/hero
```

A take with no proxy in the loop at all (the phase-1 smoke against the dogfood
instance, plan §8) is step 1 without the proxy URL, then step 3 with `--mode
record` — the driver behaves the same; which side of a proxy the turn lands on
is the repo's `.claude/settings.json`'s business.

## Add a scenario

1. `mkdir scripts/demo-video/scenarios/<name>` and write `storyboard.json`
   (plan §3): `repo { url, commit }` (a full SHA), `viewport`, `pace {
   textCharsPerSecond, typingCharsPerSecond }`, optional `proxyUrl` (required
   for replay), `settings` (applied with `PUT /api/settings` before the take),
   `model` (pins the warm session), `cursor`, and `beats[]`. Every beat has an
   `id`, at most one of `type` / `click`, a `pane`, a `wait` list, and numeric
   `lead` and `hold` (seconds). `scenarios/dogfood-smoke/storyboard.json` is a
   complete example.
2. Record it: steps 1, 2a, 3 (`--mode record`) above, until a take looks right.
   Commit `cassette/`.
3. Replay it once (2b, 3 with `--mode replay`) and check the proxy log shows no
   `cassette drift`.

Wait conditions: `turn: running|finished`, `composer: ready`, `transcript_text:
"…"` (the transcript only), `file_tree: "<name>"`, `pr_card: open|merged` and
`merge_button: visible` (the active session's card; "visible" also means
enabled), `preview_text: "…"` (needs a preview — not on a local-mode instance).
Click targets: `new-session`, `merge`, `trust`.

## Proxy

The Claude CLI in the demo session reaches the proxy through the demo repo's
`.claude/settings.json` (`ANTHROPIC_BASE_URL` plus a dummy `ANTHROPIC_API_KEY`).
Requests are counted per lane, where the lane is the auth header kind:
`x-api-key` (the dummy key) or `bearer` (anything else).

Record mode forwards `POST /v1/messages*` to `https://api.anthropic.com` with
the headers verbatim except the dummy `x-api-key`, which becomes the proxy's own
(`DEMO_PROXY_ANTHROPIC_API_KEY`); a bearer request is forwarded untouched. The
body is read whole and sent with a `content-length` (a chunked request's
`transfer-encoding` is dropped). Each response is saved as `<lane>/NNN.sse`
(status line, headers, blank line, body bytes verbatim) and one line per request
goes to `fingerprints.jsonl` (`model`, message count, tool count, body bytes,
stream flag). Request bodies are not saved. The cassette directory must not
already hold a take. `--upstream <url>` points the recorder elsewhere (the tests
use a local fake).

Replay mode answers lane request *n* with `<lane>/NNN.sse`. `content_block_delta`
text is paced at `--pace-chars-per-second` (the storyboard's
`pace.textCharsPerSecond`), tool-input JSON deltas at four times that, every
other event immediately. A request whose fingerprint differs from the recorded
one is logged as `cassette drift` and answered anyway. Once a lane runs out the
proxy answers 400 (a 5xx would be retried by the CLI); a lane with recordings
replays, a lane the cassette never recorded gets 401. `HEAD /api/hello` is 200
and any other path is 404 JSON.

Both modes take `--port` (default 8787) and `--host` (default 0.0.0.0), print
the bound port on stdout, and log one line per request to stderr: mode, lane,
n, path, status, milliseconds.

## Driver

`driver.mjs --instance URL --scenario DIR --out DIR [--mode record|replay]
[--wait-ceiling S] [--headed]`. Environment: `PLAYWRIGHT_BROWSERS_PATH` (where
`npx playwright install chromium` put the browser; `/persist/ms-playwright` in
a ShipIt session, since the baked `/opt/playwright-browsers` holds a build the
pinned package will not launch), `DEMO_CHROMIUM` (an executable override).

Before recording it verifies the repo pin (`git ls-remote <url> HEAD` must
equal `repo.commit`) and, in replay mode, that `HEAD <proxyUrl>/api/hello`
answers 200. It then paints a black splash, stamps `anchor.wallAt` into
`run.json`, navigates, and runs the beats — typing at
`pace.typingCharsPerSecond`, waiting on state, and after each beat recording,
still, until `max(actionAt + lead, readyAt + hold)` so every hold is real
footage. A wait past the ceiling aborts with the beat id and a screenshot.
Exit codes: 0 done, 3 wait ceiling, 1 anything else, 2 bad arguments.

## Cut

```sh
FFMPEG=/persist/ffmpeg/bin/ffmpeg bash scripts/demo-video/cut.sh \
  recording.webm beats.json storyboard.json out/hero
```

`beats.json` is the driver's beat log, `[{ id, actionAt, readyAt }]` in seconds
on the driver's clock (`actionAt` is `null` for a beat with no action);
`storyboard.json` carries each beat's `lead` and `hold`. Per beat the cut keeps
`[actionAt, actionAt + lead]` then `[readyAt, readyAt + hold]`, merged when they
overlap; a beat with no action starts where the previous hold ends; everything
before the first action is dropped. `lead: 0` makes an action look instant.

The driver's clock is not the video's. `cut.sh` reads `run.json` beside the beat
log, runs `ffmpeg -vf blackdetect` on the recording to find where the driver's
black splash ends, and passes `--anchor-wall`/`--anchor-video` (plus the ffprobe
duration) to `cut-plan.mjs`, which shifts the slices by the difference and clips
them to the file. A `run.json` with an anchor that cannot be found in the file
fails the cut; `CUT_UNANCHORED=1` overrides, falling back to `wallDuration −
duration` with a warning. `FFPROBE=<path>` overrides the probe (default: beside
`$FFMPEG`, else on PATH).

Outputs `out/hero.webm` (VP9) and, when the ffmpeg has libx264, `out/hero.mp4`
(h264, yuv420p, even dimensions, faststart). Both are muted and at the recorded
size. The ffmpeg needs the `trim`, `setpts`, `concat` and `blackdetect` filters
and the `libvpx-vp9` encoder; Playwright's bundled ffmpeg has none of these and
is refused with a message naming what is missing.

To inspect the plan without cutting:

```sh
node scripts/demo-video/cut-plan.mjs beats.json storyboard.json            # JSON
node scripts/demo-video/cut-plan.mjs beats.json storyboard.json --print filter
node scripts/demo-video/cut-plan.mjs beats.json storyboard.json \
  --anchor-wall 0.312 --anchor-video 0.2 --video-duration 70.92 --print kept
```

## Tests

```sh
npx vitest run scripts/demo-video/
```
