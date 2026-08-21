---
issue: planning#411
title: OpenCode 2.0 — fact sheet and integration shape
description: What OpenCode 2.0 is (beta, separate `opencode2` binary, new server API), why docs/268 stayed on v1, and the settled decision to integrate v2 as its own harness ALONGSIDE v1.
---

# OpenCode 2.0 — fact sheet and integration shape

Reference for the **future** integration of OpenCode 2.0 into ShipIt, and
for the deferred attach-to-server adapter design that 2.0's server API is
the natural target for. Nothing here is implemented; the tracked work item
is planning#411. This is a fact sheet in the docs/266 candidates.md
tradition — when the integration actually starts, that work begins at its
own `requirements.md` per this repo's requirements discipline, not from
this doc.

**Settled direction (user decision, 2026-08-16): ShipIt will run OpenCode 1
and OpenCode 2 integrations AT THE SAME TIME, fully separate if needed** —
v2 is a fourth harness beside the shipped v1 one (docs/268), not a
migration that replaces it. Upstream's own distribution supports this
directly: the two ship as different npm packages installing different,
coexisting binaries. Whether the v1 row is ever retired is a separate,
later decision that nothing here presumes.

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
changes, and recommends `@opencode-ai/client` for programmatic use. Under
the coexistence decision this stops being a rework risk and becomes the
**adapter-shape question for the v2 harness**: if the JSONL stream
survives, the v2 adapter can share docs/268's stream/shaping modules
(`shared/opencode-stream.ts`, `shared/opencode-spawn-shaping.ts`)
parameterized by binary; if run-mode output moved to the server API, the v2
harness is the natural first user of the attach-to-server shape below and
shares nothing. Answering it empirically against a stabilized v2 is the
first step of the integration's Phase 0.

## What the v2 integration takes (coexistence shape)

Because v1 and v2 coexist, this is **a full fourth-harness integration
through the docs/266 recipe** — a new `AgentId` with its own catalogue row,
adapter folder, tables, silent-site entries, and empirical verification —
with docs/268 as the closest sibling template. Not a migration of the v1
row, which stays untouched. The v2-specific facts:

1. **Install**: `@opencode-ai/cli` at an exact, ≥7-day-old **stable**
   version, added BESIDE the v1 `opencode-ai` pin in
   `docker/agent-cli/package.json`; both install cleanly side by side (the
   binaries differ: `opencode` vs `opencode2`). Installer
   `harness_pkg_prefix`/`harness_bin` mappings and a gated `npm rebuild`
   for the new package. Prune nuance: v1's deselection prune globs
   `node_modules/opencode*` (the unscoped package and its platform
   payloads); the v2 package lives under `node_modules/@opencode-ai/`, a
   path that glob never touches — so each id needs its own prefix mapping,
   and the v2 one must cover the scoped package AND wherever its platform
   payloads land.
2. **Catalogue**: a new `HarnessDef` row (id to be settled in the future
   requirements — e.g. `"opencode2"` — with its own display name), `binary:
   "opencode2"`, and honest capabilities from scratch: nothing observed
   against v1 carries over on trust.
3. **A full docs/266 Phase 0 + Phase 10 pass against the v2 binary**:
   stream capture + conformance lock (the run-mode question above IS this
   step), the error/hang and MCP keep-alive behaviors (v2 may fix, reshape,
   or keep them — each docs/268 workaround is adopted or dropped on
   evidence), `$PWD` resolution, config/auth surfaces (`/connect` may
   change the auth story, including whether any subscription path becomes
   viable), env-var surface (`OPENCODE_DISABLE_*` names), skills
   disclosure, and the reasoning variant vocabulary.
4. **Credential paths**: verify the v2 data root and its SEPARATION from
   v1's — if both harnesses share `~/.local/share/opencode` (or v2 moves
   elsewhere), `AGENT_CREDENTIAL_PATHS`, the Dockerfile symlinks, and the
   entrypoint prep block need per-id answers; two harnesses writing one
   auth store would break per-agent credential isolation.
5. **Shared-model arbitration**: a fourth harness widens the two known
   defects docs/266 already flags (`reviewer-settings.ts` harness
   derivation, `child-sessions.ts` first-harness-wins) and the docs/268
   review's harness-only reviewer tie (planning#408) — v1 and v2 will offer
   IDENTICAL model sets, the strongest same-model-different-harness overlap
   ShipIt will have had. The future requirements should decide how the two
   rank against each other.

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
