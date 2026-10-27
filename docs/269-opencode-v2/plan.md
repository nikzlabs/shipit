---
issue: planning#411
title: OpenCode 2 — fact sheet and integration shape
description: What OpenCode 2 is (released 2026-09-11 as `@opencode/cli`), how stable its API is, and the integration shape — a separate spawn-per-turn harness beside the untouched v1 one.
---

# OpenCode 2 — fact sheet and integration shape

Implements [requirements.md](./requirements.md). Nothing here is implemented
yet; the tracked work item is planning#411. The requirements have no open
questions, but the harness is blocked: MCP tools miss the first step of
every v2 turn, an upstream race (see that section). Implementation waits for
an upstream fix or an accepted workaround.

**Settled direction (user decision, 2026-08-16): ShipIt will run OpenCode 1
and OpenCode 2 integrations AT THE SAME TIME, fully separate if needed** —
v2 is a fourth harness beside the shipped v1 one (docs/268), not a
migration that replaces it. Upstream's own distribution supports this
directly: the two ship as different npm packages installing different,
coexisting binaries. Whether the v1 row is ever retired is a separate,
later decision that nothing here presumes.

> **Re-checked 2026-10-27.** Two premises in the paragraph above no longer
> hold upstream: OpenCode 2's package also installs an `opencode` binary, and
> both versions default to the same data root (see below). The user was asked
> again with those facts and kept the decision: "let's keep opencode1 intact"
> (req 2). Side-by-side is still possible; it is now ShipIt's job to keep the
> two apart rather than upstream's.

Facts checked 2026-10-27 against the npm registry, the `anomalyco/opencode`
tags and changelog (opencode.ai/changelog), `opencode.ai/v2/docs`, and an
in-container probe that installed 2.0.0 and 2.2.0, diffed the generated client
types of every 2.x release, and diffed the live OpenAPI specs of 2.0.0 and
2.2.0. The probe made no model call. OpenCode ships several releases a week —
re-verify anything volatile before acting on it.

## What OpenCode 2 is

- **Released, not beta.** npm **`@opencode/cli`** 2.0.0 shipped 2026-09-11;
  2.2.0 (2026-10-27) is the 39th stable release. `@opencode/client`,
  `@opencode/sdk` and `@opencode/ai` version in lockstep with it. The
  beta-era names (`@opencode-ai/cli`, `@opencode-ai/client`, `0.0.0-next-*`
  builds) published nothing after 2026-09-07.
- **OpenCode 1 is maintenance-only.** `opencode-ai` 1.19.x still ships
  (1.19.4 on 2026-10-22). Its notes: "OpenCode 1 now stays on the 1.x release
  line"; its install script refuses 2.x; `opencode upgrade --major` moves a v1
  user to v2. The docs split: `opencode.ai/v2/docs` is v2, `opencode.ai/docs`
  is v1.
- **Binaries.** `@opencode/cli` declares two bins, `opencode` and `opencode2`,
  pointing at the same executable. Upstream: "OpenCode 1 and OpenCode 2 both
  use the `opencode` command and are no longer installed side by side by
  default."
- **Same data root as v1.** `~/.local/share/opencode` (now holding
  `opencode.db`), plus `~/.config/opencode`, `~/.cache/opencode` and
  `~/.local/state/opencode`. Credentials live in the SQLite database
  (`OPENCODE_DB` / `XDG_DATA_HOME` override it). v2 reads a legacy
  `auth.json` at most once, inside a database migration, and never writes
  back to it (see "ChatGPT token delivery"). `serve` runs a v1-to-v2 history
  migration on the data root it is given.
- **Install shape** is unchanged from v1: a postinstall selects the native
  platform binary, so the docs/268 gated `npm rebuild` exception carries over.
- **Instructions and MCP.** v2 reads `AGENTS.md` only, with no `CLAUDE.md`
  fallback. MCP `codemode` defaults to true: MCP tools are meant to be reached
  through one JavaScript `execute` tool — but see "MCP tools miss the first
  step of every turn".

## How stable the API is

| Surface | Verdict | Why |
|---|---|---|
| `opencode run --format json` | Usable, with gaps | Captured live on 2.1.1 (Phase 0 findings): v1's line types and fields, but the final `step_finish` never arrives, the error line changed, and `callID` moved to `part.id` |
| Server HTTP API + `@opencode/client` | Not yet | Self-declared experimental; minor releases break it |
| Config file | Stable enough | v1-shaped `opencode.json` is still accepted and translated |

**Server API.** The spec (`GET /openapi.json`, Basic auth, user `opencode`)
reads `"version": "0.0.1"`, "Experimental HttpApi surface for selected
instance routes." — unchanged from 2.0.0 to 2.2.0. Paths carry no version
prefix. 41 of 156 operations are experimental, including `session.wait` and
`session.log`; `session.log` is the only event stream with replay, because
`/api/event` is "Volatile by contract" and the client has "no replay or
automatic reconnection". No semver or stability policy exists anywhere
upstream; the server reports no API version (anomalyco/opencode#55705 asks
for one).

Breaking changes across 2.x:

| Release | Kind | What broke |
|---|---|---|
| 2.0.4 (09-16) | patch, no notes | 17 routes removed, 102 operation IDs renamed, two events removed, request fields renamed |
| 2.0.6 (09-17) | patch, no notes | `GET /api/status` removed |
| 2.0.9 (09-19) | patch, no notes | provider/model config moved under `settings` |
| 2.0.20 (09-29) | patch, no notes | `run` continues after a rejected permission; new exit code |
| 2.1.0 (10-20) | minor | SDK + HTTP event fields (`state`/`providerState`/`resultState` → `native`; `session.compacted` removed) |
| 2.2.0 (10-27) | minor | `@opencode/ai` exports; experimental routes only |

The trend is good: since 2.0.6, patch releases only add; 2.1.0 → 2.2.0 broke
only experimental items; and the event fields an adapter needs (step end
tokens and cost, text, execution, idle, status) did not change in any 2.x
release. But nothing upstream promises it.

## Integration shape: spawn-per-turn

The v2 harness spawns `opencode2 run --format json` once per turn, like the v1
adapter. A live capture on 2.1.1 against a mock OpenAI-compatible provider
(ShipIt's v1 config shape and spawn env) answers the "load-bearing unknown"
this doc carried as a beta: the JSONL run mode keeps v1's line types, so the
v2 adapter can share docs/268's `shared/opencode-stream.ts` and
`shared/opencode-spawn-shaping.ts`, parameterized by harness — with the
differences below. One finding blocks the harness: MCP tools miss the first
step of every turn (next section). Attach-to-server waits (below).

Differences from v1, all observed live on 2.1.1:

- **The final `step_finish` never arrives.** Every turn's last step ends
  after its `text` line (4 of 4 text turns, and after a tool step); exit is 0.
  Intermediate `step_finish` lines keep v1's `reason`, `cost` and disjoint
  `tokens` (`tokens.total` is gone; ShipIt does not read it). So the last
  step's usage is lost and `sawFinalStop` never sets. The synthesized result
  from exit (docs/268 req 4) still ends the turn; the last step's tokens and
  cost need another source.
- **Error lines** are `{type:"error", error:{type, message, status,
  response:{body}}}` — `provider.auth` (401), `provider.internal` (500),
  `provider.no-route` (unknown model) — not v1's `{name, data:{message,
  statusCode}}`. The parser must read `error.message`, and the ChatGPT 401
  check (`adapter.ts`) must read `error.status`.
- **No post-error hang.** The CLI exits 1 right after the error line. A 500 is
  retried 11 times over ~87 s, each retry emitting a new `step_start` (v1
  retried silently).
- **Tools** are `shell` (was `bash`), `subagent` (was `task`), `question`,
  `websearch` and Code Mode's `execute` (new), plus `edit`, `glob`, `grep`,
  `read`, `skill`, `webfetch`, `write`; `todowrite` is gone. The tool
  normalizer needs the new names. `part.callID` is gone and `part.id` now
  holds the provider's call id, which the adapter's fallback already reads;
  `state` keeps `status`, `input` (an object), `output`, `title`, `time`.
- **Reasoning effort** moved into the model string: `--model
  provider/model#high` put `reasoning_effort: "high"` on the wire (title call
  included). There is no `--variant` flag.
- **Server mode.** By default `run` connects to a shared background server.
  With `--standalone`, `run` spawns a child `opencode serve --stdio` as its
  private server, so teardown must kill the tree (docs/289).
- **Config.** `OPENCODE_CONFIG` still selects the file (without it the model
  is `provider.no-route`). ShipIt's v1 provider block works unchanged —
  `{env:NAME}` keys, `variants`, `modalities` — and `instructions: [file]`
  still delivers the system prompt.
- **Instructions and skills.** `AGENTS.md` is read and `CLAUDE.md` is not.
  Skills under `.agents/skills`, `.claude/skills` and `.opencode/skills` are
  all disclosed.
- **`$PWD` still beats the real cwd** (the project was the `PWD` directory),
  so the adapter keeps pinning `PWD`.
- **Env.** `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_MODELS_FETCH` and
  `OPENCODE_CONFIG_CONTENT` exist; `OPENCODE_DISABLE_LSP_DOWNLOAD`,
  `_SHARE`, `_DEFAULT_PLUGINS` and `OPENCODE_AUTH_CONTENT` are gone and do
  nothing.
- **Unchanged:** no block-buffered stdout seen (`step_start` at 1.9 s of an
  11 s turn); `text` is one whole block, not deltas; the prompt can come on
  stdin; `--session <id>` resumes with history.

## MCP tools miss the first step of every turn (blocker; 2.1.1 and 2.2.0)

A stdio MCP server in either config shape (v1 `mcp.<name>`, v2
`mcp.servers.<name>`) is started, initialized and listed — the log says
`mcp connected server=probe tools=1` — and is shut down with the turn, so the
docs/268 keep-alive hang is gone. But **the first model request of a fresh
`run --standalone` never includes its tools**, with `codemode` default or
`false`, with an explicit allow permission, and through Code Mode (`execute`
answers "Unknown tool"; its only namespaces are `opencode` and `browser`).
**Later steps of the same turn do get them:** after an 8 s tool call, the next
request had 13 tools including `probe_phase0_ping`. A one-step turn therefore
never sees MCP tools. The same server on v1 1.19.0 exposes its tool on the
first request. ShipIt's own tools and the browser are MCP servers, so the
harness cannot launch with this.

**Cause — a race in upstream code** (v2.1.1 source; unchanged on 2.2.0 and on
`dev` at d76552c):

- `core/src/tool/mcp.ts` registers MCP tools once, from `mcp.tools()`, and
  afterwards only on `McpEvent.ToolsChanged`, debounced 100 ms, then
  `tools.reload()`.
- `mcp.tools()` (`core/src/mcp/index.ts`) returns only connected servers, and
  initial connections are deliberately asynchronous.
- `SessionContext.select()` (`core/src/session/context.ts`) awaits
  `mcpTools.flush` — which waits only for that first, empty registration — and
  then takes the step's tool snapshot. The connect's debounced reload lands
  after the first request is built ("mcp connected" was 58–70 ms before it).
  `callTool` waits on each server's `startup` latch; the snapshot does not.
- No config key makes startup blocking: the MCP options are only timeouts
  (`startup`, `catalog`, `execution`).

**Workarounds measured:**

- A resident `opencode serve` with `run --server <url>` per turn: the first
  turn in a project directory still misses the tools (the directory's Location
  and its MCP connections boot at that request), and the second turn has them;
  the MCP server started once. `opencode mcp list` has no `--server` flag, so
  it cannot warm a Location up; no warm-up path was found. A resident server
  also changes the adapter's shape (per-turn config, credentials and MCP set
  become server-lifetime), which this plan deferred.
- The fix belongs upstream: wait for each enabled server's `startup` latch
  (bounded by `timeout.startup`) before the first snapshot. A minimal
  ShipIt-free reproduction and an issue draft exist; filing them is the user's
  act.

## Keeping OpenCode 1 intact (req 2)

Upstream no longer separates the two, so ShipIt must:

- **Install.** Pin `@opencode/cli` at an exact, ≥7-day-old version BESIDE
  `opencode-ai` in `docker/agent-cli/package.json` (2.1.1 qualifies on
  2026-10-27; 2.1.0 → 2.1.4 had no breaking change in the client types).
  **Measured:** with both installed, `node_modules/.bin/opencode` points at
  `@opencode/cli` after `npm install`, `npm ci`, and any rebuild that includes
  it, in either dependency order — npm links by path, and `@opencode/…` sorts
  first. Only a single-package `npm rebuild opencode-ai` run last points it
  back at v1. `node_modules/.bin` precedes `/usr/local/bin` on PATH
  (`Dockerfile.session-worker.prod`) and ShipIt spawns `opencode` by bare name
  (`adapter.ts`, `compaction.ts`, `session-namer.ts`), so without a fix the v1
  harness silently runs v2. The installer must point `.bin/opencode` at
  `node_modules/opencode-ai/bin/opencode.exe` after every rebuild, as it
  already removes the grok shim. The v2 harness uses the `opencode2` bin.
- **Prune.** v1's prefix `opencode` globs `node_modules/opencode*`, which never
  touches `node_modules/@opencode/`. The v2 id needs its own prefix covering
  `@opencode/cli` and its `cli-linux-*` payload packages, plus
  `.bin/opencode2`.
- **Data.** v2 gets its own data, config, cache and state roots, never v1's.
  Pointed at v1's root, v2 would migrate v1's database and history.
  `AGENT_CREDENTIAL_PATHS`, the Dockerfile `/credentials/.local/share/opencode`
  symlinks and the entrypoint prep block need a per-id answer.
- **Catalogue.** A new `HarnessDef` row (proposed id `opencode2`, display
  name "OpenCode 2", `binary: "opencode2"`) with capabilities verified from
  scratch; nothing observed against v1 carries over on trust.

## Sign-ins and shared models (reqs 4, 5)

- **Sign-ins (req 4).** API keys and the ChatGPT subscription, as on v1
  (docs/295). The ChatGPT half needs a new token delivery path — v1's does not
  work on v2 (next section).
- **OpenCode 2 first (req 5).** Both harnesses run exactly the models
  ShipIt's provider block declares (v2 ran ShipIt's v1-shaped rows unchanged),
  so keeping the two model sets equal is the catalogue's job; the ChatGPT
  route's model ids on v2 belong to the real-account check. Every site that
  picks a harness from a model on its own must rank `opencode2` ahead of
  `opencode`. Most take the first
  matching harness in list order — `agentIdForModel` over `AGENT_DEFS`
  (`shared/agent-registry.ts`) and `harnessesForSelection` over
  `allHarnesses()` (`non-turn-model.ts`) — so the list order decides them.
  Known callers: `selectReviewer` (`reviewer-model.ts`), the reviewer settings
  derivation (`services/reviewer-settings.ts`), the model-owner fallback in
  `services/child-sessions.ts`, model ownership in
  `services/headless-sessions.ts`, and the client model picker
  (`client/utils/agent-for-model.ts`). The implementation must find the full
  list. An explicit harness choice (session, role) is unaffected.
- **Two existing rules stay ahead of req 5.** The reviewer moves the
  implementer's harness last (`harnessesPreferring`), so an implementer on
  OpenCode 2 gets an OpenCode 1 reviewer for a shared model. A child session
  keeps its parent's harness when that harness offers the model
  (`child-sessions.ts`), so an OpenCode 1 parent keeps OpenCode 1 children.
  Neither needs a change: list order applies only after these rules.

## ChatGPT token delivery (tested 2026-10-27, CLI 2.2.0 and 2.1.1)

On v1, ShipIt delivers the ChatGPT token by writing `auth.json` under a
managed XDG root and rewriting it on every Codex refresh
(`shared/opencode-account.ts`, `orchestrator/openai-account-delivery.ts`).
**That does not work on v2.** Tested with fake tokens in ShipIt's exact file
shape, under `--standalone`, no model call:

- The import is the database migration
  `20260805200742_import_legacy_credentials`. A NEW database is created by a
  one-step schema bootstrap that marks every migration done, so the import
  never runs: a fresh v2 data root ignores `auth.json` entirely.
- On an upgraded v1 data root the migration runs once and imports the token.
  A rewritten `auth.json` is then ignored: the database kept token A while the
  file held token B.
- `opencode auth import <file>` does not replace a credential whose id is
  present ("skipped 1 already present"), and one with a new id is added
  inactive.
- **What works:** `opencode auth logout openai <credential-id>` followed by
  `opencode auth import <file>`. The credential is replaced and active, on an
  upgraded database and on a fresh one in a separate XDG root (v1's root
  untouched). About 1.4 s for the pair. The import file is ShipIt-built:
  `[{id, integrationID: "openai", label, active: true, value: {type: "oauth",
  methodID: "chatgpt-browser", refresh: "", access, expires,
  metadata: {accountID}}}]`.
- **No gap:** import the new token under a new id (it lands inactive), then
  `opencode auth switch openai <new-id>` makes it active, then `logout` the
  old one. The logout-then-import pair leaves ~1.5 s with no credential.
- **A running turn picks up the swap.** Measured on 2.1.1 with an api-key
  credential: a replacement made during an 8 s tool call reached the same
  turn's next model request (key A → key B), with no database lock error. The
  turn's private server reads the credential on each request.
- `auth` commands need the turn's `OPENCODE_CONFIG` when the integration is a
  config-defined provider; without it they answer "Integration not found".

Open: whether the ChatGPT backend accepts the delivered token (Phase 0 item 2).

## Phase 0 status (2.1.1, 2026-10-27)

Answered above: the live JSONL capture, `OPENCODE_CONFIG`, the
`.bin/opencode` winner, model sets, the docs/268 workarounds, the mid-turn
credential swap and import race, `$PWD`, env names, skills and instructions.
Still open:

1. **MCP tools on the first step** — the upstream race above; waits for a fix
   upstream or a workaround the user accepts.
2. **Real-account ChatGPT check:** the token accepted on the wire, the v2
   ChatGPT route config (v1's uses `OPENCODE_CONFIG_CONTENT` with the built-in
   `openai` provider and sets `OPENCODE_DISABLE_DEFAULT_PLUGINS=0`, a variable
   v2 no longer has), and its model ids. Needs the user's account.
3. A source for the last step's tokens and cost.

## Attach-to-server: deferred

docs/266 deferred an attach-to-server adapter (a resident server plus an HTTP
client) as its own design task, and v2's server API is its natural target.
It is not ready: the adapter would depend on experimental routes and on an
event stream with no replay, with no written compatibility promise. Revisit
when one of these holds — the spec version reaches 1.0, `session.wait` and
`session.log` leave `/api/experimental/`, or `/api/info` reports an API
version (#55705). That work gets its own docs folder and requirements.
