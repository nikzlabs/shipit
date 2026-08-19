# TEMPORARY — reproduction harness for nikzlabs/shipit#2418

**This directory is not part of ShipIt and must be removed before the branch merges.**
It exists so the stall in [#2418](https://github.com/nikzlabs/shipit/issues/2418) can be
reproduced from the reporter's own phone, in a real ShipIt Preview pane, with an
instrument attached that can name the cause.

## Run it from the phone

1. Open this session in ShipIt on the phone.
2. Go to the **Workspace** tab → **Preview**. The `reward-tag` service is
   `x-shipit-preview: auto`, so it is already starting; the first start fetches the
   game and installs it, which takes a minute or two. If it is not running:
   `shipit service start reward-tag`.
3. The game appears with a small profiler panel over the top left. **Leave it alone
   for a minute** and watch. Tap the panel's header to fold it out of the way; the
   measurement keeps running while it is folded.
4. When something stalls, tap **Send to agent** — the report lands in this chat.
   **Copy** puts the same text on the clipboard if the send is refused.

The first six seconds are not measured. Booting the game — shaders, ground
textures, building the world — blocks the main thread by design, and counting it
would answer "the thread is blocked" on every run.

## What the panel says, and why it can be trusted

The original report could show the *page* was not at fault, but not what was. Two
host-side causes look identical from inside a cross-origin iframe, and the report's
instrumentation could not separate them. This one can, from the phone, with no
cooperation from ShipIt: it runs a **timer heartbeat** beside the rAF loop.
Render-throttling stops frames and leaves the event loop alone; a blocked main
thread stops both.

Measured on Chromium 141 at a phone-shaped viewport, nine induced stalls per row
(harness kept out of the repository, at `/persist/repro-2418`):

| Host does… | rAF stalls | timer gaps | this page laid out |
|---|---|---|---|
| blocks its main thread | 9 | **9** (max 3004 ms) | yes |
| scrolls the iframe out of view | 9 | **0** (max 19 ms) | yes |
| sets the iframe `display: none` | 9 | **0** (max 19 ms) | **no** (0×0) |
| nothing (control) | 0 | 0 (max 19 ms) | yes |

So the verdict line reads:

- **`thread-blocked`** — frames and timers stopped together. Something is hogging
  the shared main thread. *(This is what you get in a session container with no
  GPU, where the game itself is the hog. It is the expected answer there and not
  the reported bug.)*
- **`pane-hidden`** — frames withheld, timers fine, and this page was not laid out
  at the time. The pane was `display: none` — e.g. the Chat tab was in front.
- **`frames-withheld`** — frames withheld, timers fine, page laid out normally.
  The browser throttled this frame's rendering, which it does when the iframe
  **element** is outside the ShipIt viewport. **This is the one that matches the
  original report.** If it comes up, the remaining question is what moves the pane.

`window.shipit.visibility` is recorded too. On a build carrying the fix from
PR #2459 its transitions should bracket the stalls; on a build without it, it stays
`true` throughout and the heartbeat carries the diagnosis alone.

## What is here

| File | What it is |
|---|---|
| `fetch.sh` | Fetches the game. Runs on the **agent's** side of the session. |
| `prepare.sh` | Installs the game and injects the profiler, then Vite starts. Idempotent; the service runs it on every start. |
| `frame-profiler.js` | The instrument and its on-screen panel. Served to the game at `/shipit-frame-profiler.js`. |
| `reward-tag/` | The game, from `nicolasalt/reward-tag`. **Gitignored** — fetched, never committed. |

The game's own source is not edited except for one `<script>` tag added to
`game/index.html`, guarded by a marker so re-running is safe.

**Why fetching and preparing are two scripts.** The service container has no DNS,
so a `git clone` inside it fails with `Could not resolve host: github.com`. Only
the agent's side can fetch. If ShipIt reclaims this workspace for disk the clone
goes with it — the service then refuses to start and prints what to run:

```sh
repro-2418/fetch.sh && shipit service restart reward-tag
```

or just ask the agent in chat.

## Removing it

```sh
git rm -r --cached repro-2418 && rm -rf repro-2418
```

then delete the `reward-tag` service from `docker-compose.yml` and the three
`repro-2418/` lines from `.gitignore`.
