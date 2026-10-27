---
issue: planning#411
title: OpenCode 2 — fact sheet and integration shape
description: What OpenCode 2 is (released 2026-09-11 as `@opencode/cli`), how stable its API is, and the integration shape — a separate spawn-per-turn harness beside the untouched v1 one.
---

# OpenCode 2 — fact sheet and integration shape

Implements [requirements.md](./requirements.md). Nothing here is implemented
yet; the tracked work item is planning#411. Implementation code waits until
the requirements' open questions are resolved.

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
  (`OPENCODE_DB` / `XDG_DATA_HOME` override it). v2 imports a legacy
  `auth.json` but never writes back to it, and `serve` runs a v1-to-v2
  history migration on the data root it is given.
- **Install shape** is unchanged from v1: a postinstall selects the native
  platform binary, so the docs/268 gated `npm rebuild` exception carries over.
- **Instructions and MCP.** v2 reads `AGENTS.md` only, with no `CLAUDE.md`
  fallback. MCP `codemode` defaults to true: MCP tools are reached through
  one JavaScript `execute` tool instead of the provider's native tool list.

## How stable the API is

| Surface | Verdict | Why |
|---|---|---|
| `opencode run --format json` | Stable enough | A v1-compatible JSONL layer whose keys did not change across 2.x |
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
adapter. This answers the "load-bearing unknown" this doc carried as a beta:
the JSONL run mode survived, so the v2 adapter can share docs/268's
`shared/opencode-stream.ts` and `shared/opencode-spawn-shaping.ts`,
parameterized by harness. Attach-to-server waits (below).

Differences from v1 the adapter must handle:

- **Reasoning effort** moved into the model string: `--model
  provider/model#variant`. There is no `--variant` flag.
- **Server mode.** By default `run` connects to a shared background server.
  The adapter passes `--standalone` so each turn owns a private server inside
  its own process tree (docs/289 teardown).
- **Error lines** are `{type,message}`, not v1's `{name,data:{message}}`.
  Without a parser change the user sees only the generic "OpenCode reported an
  error".
- **MCP `codemode: false`** must be set, or ShipIt's MCP tools arrive as one
  `execute` call and its tool cards break.
- **Config.** `OPENCODE_CONFIG` is not in the v2 docs. A v1-shaped config file
  loads and is translated (`whitelist` is silently dropped); whether the env
  var still selects the file is untested.
- **Flags** (2.2.0, verbatim from `run --help`): `--continue`, `--session`,
  `--fork`, `--model`, `--agent`, `--format`, `--file`, `--title`,
  `--thinking`, `--auto`; global `--standalone`, `--server`.

## Keeping OpenCode 1 intact (req 2)

Upstream no longer separates the two, so ShipIt must:

- **Install.** Pin `@opencode/cli` at an exact, ≥7-day-old version BESIDE
  `opencode-ai` in `docker/agent-cli/package.json` (2.1.1 qualifies on
  2026-10-27; 2.1.0 → 2.1.4 had no breaking change). Its `opencode` bin
  collides with v1's in `node_modules/.bin`, and the v1 harness links
  `node_modules/.bin/opencode` (`install-agent-clis.sh`,
  `harness_link_target`). Which package npm links there is unverified; the v1
  link must resolve to `opencode-ai` regardless — link it to the package's own
  bin rather than `.bin` if npm's choice is not deterministic. The v2 harness
  uses the `opencode2` bin.
- **Prune.** v1's prefix `opencode` globs `node_modules/opencode*`, which never
  touches `node_modules/@opencode/`. The v2 id needs its own prefix covering
  `@opencode/cli` and its platform payload packages.
- **Data.** v2 gets its own data, config, cache and state roots, never v1's.
  Pointed at v1's root, v2 would migrate v1's database and history.
  `AGENT_CREDENTIAL_PATHS`, the Dockerfile `/credentials/.local/share/opencode`
  symlinks and the entrypoint prep block need a per-id answer.
- **Catalogue.** A new `HarnessDef` row (proposed id `opencode2`, display
  name "OpenCode 2", `binary: "opencode2"`) with capabilities verified from
  scratch; nothing observed against v1 carries over on trust.

## Phase 0 unknowns (empirical, before code)

1. **ChatGPT token refresh.** ShipIt delivers the ChatGPT token by writing
   `auth.json` under a managed XDG root (`shared/opencode-account.ts`). v2
   imports `auth.json` and then reads SQLite. Does v2 re-import a refreshed
   `auth.json`? If not, delivery has to go through v2's own surface
   (`opencode auth import` is a candidate, unverified). This decides whether
   the subscription route is viable at all.
2. Which package wins `node_modules/.bin/opencode` when both are installed.
3. Whether `OPENCODE_CONFIG` still selects the config file.
4. A live JSONL capture and conformance lock, including the error line shape.
5. Re-test each docs/268 workaround (post-error hang, block-buffered stdout,
   MCP keep-alive, missing final `step_finish`) and adopt or drop it on
   evidence. Upstream has open reports of the last one (#59652), a hang before
   session creation over non-interactive SSH (#59287), an intermittent
   `--standalone` boot deadlock (#59645), and a dead turn that leaves the
   session busy (#59559).
6. `$PWD` resolution, `OPENCODE_DISABLE_*` env names, skills disclosure.

## Attach-to-server: deferred

docs/266 deferred an attach-to-server adapter (a resident server plus an HTTP
client) as its own design task, and v2's server API is its natural target.
It is not ready: the adapter would depend on experimental routes and on an
event stream with no replay, with no written compatibility promise. Revisit
when one of these holds — the spec version reaches 1.0, `session.wait` and
`session.log` leave `/api/experimental/`, or `/api/info` reports an API
version (#55705). That work gets its own docs folder and requirements.
