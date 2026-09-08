# demo-video — usage

The automated demo-video pipeline of `docs/296-automated-demo-video` (design in
its `plan.md`; this file is only how to run what exists). Phase 1 pieces:

| File | Role |
|---|---|
| `proxy.mjs` | Record/replay proxy at the Anthropic API boundary (plan §2) |
| `cut-plan.mjs` | Slice math: beat log + storyboard to ffmpeg trim/concat filter (plan §5) |
| `cut.sh` | ffmpeg wrapper around `cut-plan.mjs`: muted VP9 webm + h264 mp4 |
| `__fixtures__/cassette/` | A tiny cassette the tests replay |

The runtime scripts are plain ESM with no dependencies: the demo host needs
node and ffmpeg, nothing else.

## Proxy

The Claude CLI in the demo session reaches the proxy through the demo repo's
`.claude/settings.json` (`ANTHROPIC_BASE_URL` plus a dummy `ANTHROPIC_API_KEY`).
Requests are counted per lane, where the lane is the auth header kind:
`x-api-key` (the dummy key) or `bearer` (anything else).

Record a take (authoring; needs a real key on the host):

```sh
DEMO_PROXY_ANTHROPIC_API_KEY=sk-ant-... \
  node scripts/demo-video/proxy.mjs --record scenarios/<name>/cassette
```

Forwards `POST /v1/messages*` to `https://api.anthropic.com` with the headers
verbatim except the dummy `x-api-key`, which becomes the proxy's own; a bearer
request is forwarded untouched. Each response is saved as
`<lane>/NNN.sse` (status line, headers, blank line, body bytes verbatim) and
one line per request goes to `fingerprints.jsonl` (`model`, message count, tool
count, body bytes, stream flag). Request bodies are not saved. The cassette
directory must not already hold a take. `--upstream <url>` points the recorder
elsewhere (the tests use a local fake).

Replay a cassette (production runs):

```sh
node scripts/demo-video/proxy.mjs --replay scenarios/<name>/cassette \
  [--pace-chars-per-second 120]
```

Lane request *n* is answered with `<lane>/NNN.sse`. `content_block_delta` text
is paced at the given characters per second, tool-input JSON deltas at four
times that, every other event immediately. A request whose fingerprint differs
from the recorded one is logged as `cassette drift` and answered anyway. Once a
lane runs out the proxy answers 500; a lane the cassette never recorded gets
401. `HEAD /api/hello` is 200 and any other path is 404 JSON.

Both modes take `--port` (default 8787) and `--host` (default 0.0.0.0), print
the bound port on stdout, and log one line per request to stderr: mode, lane,
n, path, status, milliseconds.

## Cut

```sh
FFMPEG=/usr/bin/ffmpeg scripts/demo-video/cut.sh \
  recording.webm beats.json storyboard.json out/hero
```

`beats.json` is the driver's beat log, `[{ id, actionAt, readyAt }]` in seconds
from recording start (`actionAt` is `null` for a beat with no action);
`storyboard.json` carries each beat's `lead` and `hold`. Per beat the cut keeps
`[actionAt, actionAt + lead]` then `[readyAt, readyAt + hold]`, merged when they
overlap; a beat with no action starts where the previous hold ends; everything
before the first action is dropped. `lead: 0` makes an action look instant.

Outputs `out/hero.webm` (VP9) and, when the ffmpeg has libx264, `out/hero.mp4`
(h264, yuv420p, even dimensions, faststart). Both are muted and at the recorded
size. The ffmpeg needs the `trim`, `setpts` and `concat` filters and the
`libvpx-vp9` encoder; Playwright's bundled ffmpeg has none of these and is
refused with a message naming what is missing.

To inspect the plan without cutting:

```sh
node scripts/demo-video/cut-plan.mjs beats.json storyboard.json            # JSON
node scripts/demo-video/cut-plan.mjs beats.json storyboard.json --print filter
```

## Tests

```sh
npx vitest run scripts/demo-video/
```
