---
issue: https://linear.app/shipit-ai/issue/SHI-126
title: Precompile internal MCP bridges to plain JS
description: Agent turns fail at the 0.5-CPU AGENT_DEFAULTS because tsx-spawned bridges miss the CLI's 2000ms MCP pre-wait; precompiling them to self-contained JS fixes it.
---

# Precompile internal MCP bridges (docs/199)

## Problem

Agent turns fail **100% reproducibly** on sessions running at the default agent
limits (`AGENT_DEFAULTS`: memory 1536 MB, **cpu 0.5**). OPS sessions hit it too
because `templates-ops.ts` sets no memory/cpu and therefore inherits the
defaults. The Claude CLI exits 1 "without running" with:

```
Error: MCP tool mcp__shipit-permission__permission_prompt (passed via --permission-prompt-tool) not found.
```

The error's "Available MCP tools" list contains the user's claude.ai connectors
and **all** `mcp__playwright__*` tools, but **none** of the ShipIt stdio bridges
(`shipit-permission`/`present`/`voice`/`bug`, and `review` where applicable).
Plain-JS stdio MCP (Playwright) connects; the tsx-spawned TypeScript bridges do
not. The turn is retried once and surfaced as "The agent exited with code 1
without running."

## Root cause (mechanism)

Each bridge shipped as TypeScript and was spawned by the agent CLI as
`<app>/node_modules/.bin/tsx <app>/src/server/session/mcp-*-bridge.ts`. **tsx
compiles the file with esbuild on every spawn** — a CPU-bound cost paid per
process. Claude spawns **five** bridges (review/present/voice/bug/permission)
concurrently, alongside the CLI itself, the session worker, and the Playwright
MCP server — all in **one container cgroup**.

Two Claude CLI internals (confirmed by reading the shipped binary) decode the
failure:

1. **`Yjq(H, $=2000, ...)`** — the headless MCP **pre-wait** window defaults to
   **2000 ms**. The CLI waits at most ~2s for stdio MCP servers to connect
   before proceeding.
2. **`mx9(...)`** — the `--permission-prompt-tool` is resolved **lazily**: when
   the permission tool is first needed, the CLI looks it up among connected MCP
   tools and, if absent, does `process.stderr.write("Error: MCP tool … not
   found …"), i9(1)` — i.e. `process.exit(1)`. Exactly the observed error + hard
   exit.

The CLI also exposes `MCP_TIMEOUT` (default 30000), `MCP_CONNECT_TIMEOUT_MS`
(default 5000), and `MCP_SERVER_CONNECTION_BATCH_SIZE` (default 3).

At 0.5 CPU the five concurrent tsx/esbuild compiles contend for half a core and
don't finish before the 2000 ms pre-wait elapses → the permission server is not
connected when its tool is needed → exit 1. **Playwright never fails because it
ships as prebuilt JS — no compile**, so it connects well inside the window.

### It is CPU, not memory

Measured in-session (cgroup `memory.events` `oom_kill` = 0 throughout):

| Variant | time-to-ready (idle) | time-to-ready (CPU contention*) | memory, 5 bridges |
|---|---|---|---|
| **tsx source (before)** | ~1.7 s | **~3.0 s ❌** (> 2000 ms) | ~274 MB |
| compiled, external SDK | ~0.7 s | ~1.5 s | ~164 MB |
| **compiled, self-contained (after)** | **~0.3 s** | **~0.74 s ✓** | **~138 MB** |

\* Contention = 6 CPU hogs pinned to 2 cores while the 5 bridges start — i.e.
**harsher** than a steady 0.5 CPU. The compiled bundle still cleared the 2000 ms
window with ~2.7× margin; tsx did not. Total session-container memory at the
defaults (worker ~80 + CLI ~150 + Playwright ~150 + 5 bridges) is well under
1536 MB, and no OOM kill ever fired — so **memory is not the binding constraint
and `AGENT_DEFAULTS` does not need to be raised**. The A/B that raised memory
*and* cpu together was fixed by the **cpu** half.

(A true 0.5-CPU cgroup couldn't be created in-session — child-cgroup creation is
denied — so the contention proxy above is the closest measurable signal. Stated
as a limitation rather than guessed.)

## Fix

Precompile each bridge to a **self-contained** plain-JS bundle at image-build
time and run it with plain `node`:

- `scripts/build-mcp-bridges.mjs` — esbuild-bundles the consolidated bridge
  (`mcp-shipit-bridge`, which pulls in every `mcp-tools/*` module) to
  `dist/mcp-bridges/mcp-shipit-bridge.js`. The `@modelcontextprotocol/sdk` is
  **inlined**, so the bundle has zero runtime `node_modules` dependency. A
  `createRequire` banner covers any transitive CJS `require`. npm script:
  `build:bridges`. (Pre-SHI-128 this built six separate bundles.)
- `src/server/session/mcp-bridge-paths.ts` — `resolveBridge(basename)` prefers
  `dist/mcp-bridges/<basename>.js` (launched with `process.execPath`) and falls
  back to running the `.ts` source through tsx when the bundle is absent
  (dev/local images), or returns `null` (stripped-down test image). The worker
  calls it once for `mcp-shipit-bridge`.
- `docker/Dockerfile.session-worker.prod` — runs `node
  scripts/build-mcp-bridges.mjs` **before** the devDependency prune (esbuild is a
  devDep) and copies `/app/dist/mcp-bridges` into the prod image.

Consolidating the five bridges into a single stdio process was deferred as a
**follow-up** (precompile alone clears the window with comfortable margin and was
the smaller, lower-risk change). That follow-up is now done — see below.

## Consolidation into one process (SHI-128)

The precompile fixed correctness; this follow-up cuts the per-tool stdio
processes from **5 → 1** for density (~138 MB → ~30 MB resident). All six tools
now live in ONE server named `shipit`, so their names are `mcp__shipit__<tool>`
(was `mcp__shipit-<x>__<tool>`).

- `src/server/session/mcp-tools/` — one `ToolDescriptor` module per tool
  (`review`/`present`/`voice`/`bug`/`permission`/`ask`), each holding the tool
  def + the worker-forwarding `call()` lifted verbatim from the old per-tool
  bridge (voice's `delivered` echo, permission's resilient request→await poll,
  ask's hold-open-forever all preserved).
- `src/server/session/mcp-shipit-bridge.ts` — the single stdio entry. Reads the
  enabled subset from the `SHIPIT_MCP_TOOLS` env (comma-separated ids), builds
  one `Server({ name: "shipit" })`, registers ListTools/CallTool for the subset.
  `createShipitBridgeServer(tools, deps)` is factored out for tests.
- Per-agent subset is chosen by the adapters via that env: **Claude** →
  `review,present,voice,bug,permission` (native AskUserQuestion, so no ask);
  **Codex** → `review,present,voice,ask,bug` (native approval, so no permission).
- The worker resolves ONE bridge (`resolveBridge("mcp-shipit-bridge")`); the
  `AgentMcpWriteContext` carries a single `shipitBridge` instead of six fields.
- Allowed-tools (`claude/process.ts`) list the four model-facing tools by exact
  name (`mcp__shipit__submit_review_comments`, `…__present`, `…__voice_note`,
  `…__report_shipit_bug`) — NOT a `mcp__shipit__*` glob — so the permission tool
  (the CLI's `--permission-prompt-tool`, never model-callable) stays unlisted.
- Client present-card detection (`message-tools.tsx`) matches both `shipit` and
  the legacy `shipit-present` server so pre-SHI-128 persisted cards still render.

## Key files

- `scripts/build-mcp-bridges.mjs` — the esbuild precompile step (one bundle).
- `src/server/session/mcp-shipit-bridge.ts` — consolidated stdio server + `selectTools`/`createShipitBridgeServer` (SHI-128).
- `src/server/session/mcp-tools/*.ts` — per-tool `ToolDescriptor` modules + shared `types.ts` (SHI-128).
- `src/server/session/mcp-bridge-paths.ts` — `resolveBridge()` (compiled-JS-first, tsx fallback).
- `src/server/session/session-worker.ts` — `shipitBridgePaths()` delegates to `resolveBridge`.
- `src/server/session/agents/{claude,codex}/adapter.ts` — write one `shipit` server with the per-agent `SHIPIT_MCP_TOOLS` subset.
- `docker/Dockerfile.session-worker.prod` — build step + `dist/mcp-bridges` copy.
- `src/server/session/mcp-bridge-paths.test.ts` — resolution order (compiled → tsx → null).
- `src/server/session/mcp-bridge-bundle.test.ts` — end-to-end: bundle runs under `node` with no `node_modules` and registers the selected tools.
- `src/server/session/mcp-shipit-bridge.test.ts` — tool selection, dispatch, permission resilient poll, unknown-tool guard.

## Operator validation

The reproduction repos `nicolasalt/pnpm-canary-183` and `py-canary-183` at the
default limits failed 100% before. To validate the fix after the image ships:

1. Deploy the new `shipit-session-worker:prod` image.
2. Create a session on `pnpm-canary-183` at the **default** limits (no
   `shipit.yaml` memory/cpu override) and send any turn that edits a sensitive
   file (so `--permission-prompt-tool` is exercised). It should no longer exit 1.
3. Repeat on `py-canary-183` and on a fresh OPS session.
4. Confirm in the session container that the bridges run as `node
   …/dist/mcp-bridges/mcp-*-bridge.js` (not `tsx …`).
