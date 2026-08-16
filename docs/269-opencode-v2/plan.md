---
issue: planning#411
title: OpenCode 2.0 — fact sheet and adoption shape
description: What OpenCode 2.0 is (beta, separate `opencode2` binary, new server API), why docs/268 stayed on v1, and what adopting 2.0 will take.
---

# OpenCode 2.0 — fact sheet and adoption shape

Reference for the **future** migration of ShipIt's OpenCode harness
(docs/268, shipped on the v1 line) onto OpenCode 2.0, and for the deferred
attach-to-server adapter design that 2.0's server API is the natural target
for. Nothing here is implemented; the tracked work item is planning#411.
This is a fact sheet in the docs/266 candidates.md tradition — when adoption
actually starts, that work begins at its own `requirements.md` per this
repo's requirements discipline, not from this doc.

Facts checked 2026-08-16 against `opencode.ai/v2/docs`,
`opencode.ai/v2/docs/migrate-v1`, and the npm registry. OpenCode ships
multiple builds per day — re-verify everything volatile before acting on it.

## What OpenCode 2.0 is

- **A beta, distributed in parallel with v1 — not an upgrade of it.** The
  npm package is **`@opencode-ai/cli`** (dist-tag `beta`, resolving to
  `0.0.0-next-*` build numbers — no semver 2.x exists yet), and it installs
  a **separate `opencode2` binary** that coexists with the v1 `opencode`
  binary. The same package's `latest` tag still resolves to the v1 line
  (1.18.x), as does `opencode-ai` — v1 is the released product.
- **Upstream's own stability statement:** the beta "is still changing:
  things may break, and APIs, configuration, and plugin APIs may change."
- **Install shape** mirrors v1: a trusted postinstall selects the native
  platform binary (so the docs/268 installer exception — a gated
  `npm rebuild` under the blanket `--ignore-scripts` — carries over).
- **Declared v1→v2 breaking changes** (migrate-v1 page): a new plugin API
  (v1 plugins do not work), new server API/client contracts (v1 server-API
  integrations must migrate), and TUI configuration moving from layered
  `tui.json(c)` files to one global `cli.json` (auto-migrated).
- **Headline features:** provider/model configuration via `/connect`,
  undo/redo, session sharing and snapshots, and a finalized server API with
  a first-party **`@opencode-ai/client`** package.

## Why docs/268 stayed on v1

Both gates the docs/266 recipe imposes fail against the beta, and would
today:

1. **The dependency policy cannot be satisfied.** An exact pin at least
   7 days published is meaningless against a `0.0.0-next-*` stream that
   ships several disposable builds per day.
2. **The stream-conformance blocker cannot be closed.** docs/268's whole
   terminal contract rests on a captured, test-locked event schema; a
   schema upstream declares unstable cannot be locked.

The declared v2 breaking changes do not touch the shipped adapter's
surface (`run --format json` JSONL, `OPENCODE_CONFIG` provider blocks,
`--variant`, auth.json) — so nothing in docs/268 is invalidated by v2's
existence. The exposure runs the other way: with upstream attention on 2.0,
the v1 defects the adapter works around (the post-error hang, block-buffered
stdout, the MCP keep-alive) may never be fixed in v1. The adapter's
synthesized-terminal-result design already assumes that.

## The load-bearing unknown

**Whether v2 keeps a v1-compatible `run --format json` mode is unknown** —
the migration guide documents config and API changes, not CLI run-mode
changes, and recommends `@opencode-ai/client` for programmatic use. Until
this is answered empirically against a stabilized v2, the size of the
adapter rework is unbounded in both directions: near-zero if the JSONL
stream survives, or a rewrite of `shared/opencode-stream.ts` +
`shared/opencode-spawn-shaping.ts` and the adapter's spawn layer if run-mode
output moved to the server API. Every other part of the docs/268
integration — catalogue row, eligibility (`carriers`), tables, themes,
client, credential paths — is version-agnostic.

## What adoption takes (the migration shape)

A deliberate migration, **not** a Renovate bump — the package and binary
both change names:

1. `docker/agent-cli/package.json` + lockfile: `@opencode-ai/cli` at an
   exact, ≥7-day-old **stable** version, replacing (or joining) the v1
   `opencode-ai` pin; installer `harness_pkg_prefix`/`harness_bin` mappings
   and the gated `npm rebuild` follow.
2. Catalogue: the harness row's `binary` becomes `opencode2` (the `AgentId`
   and everything keyed on it stays `"opencode"`).
3. A full re-run of docs/268's empirical verification (the docs/266 Phase 0
   + Phase 10 lists): stream capture + conformance re-lock, the error/hang
   and MCP keep-alive behaviors (v2 may fix, reshape, or keep them — each
   adapter workaround is then kept or retired on evidence), `$PWD`
   resolution, config/auth surfaces (`/connect` may change the auth story,
   including whether any subscription path becomes viable), env-var surface
   (`OPENCODE_DISABLE_*` names), skills disclosure, and the reasoning
   variant vocabulary.
4. Credential paths: verify the v2 data root — if it moves off
   `~/.local/share/opencode`, `AGENT_CREDENTIAL_PATHS`, the Dockerfile
   symlinks, and the entrypoint prep block all follow.

## The attach-to-server connection

docs/266 deliberately scoped the first OpenCode integration to
spawn-per-turn and deferred an attach-to-server adapter shape (a resident
`opencode serve` + HTTP attach) as its own design task. **v2 supersedes the
v1 `serve` API as that task's target**: the v1 server API is one of the
things v2 explicitly breaks, and v2 ships the finalized contracts plus a
first-party client. If the attach-to-server design is ever pursued, it
should start from v2's generated API reference and `@opencode-ai/client`,
in its own docs folder with its own requirements — not from the v1 surface
described in docs/266 candidates.md, which predates v2.
