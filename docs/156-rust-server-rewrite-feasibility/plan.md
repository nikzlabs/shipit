---
description: Feasibility study for rewriting the ShipIt server in Rust to reduce memory footprint and improve runtime guarantees. Rejected — costs are high, the leak classes Rust prevents aren't the ones we'd hit, and the orchestrator is the smallest memory tenant in the system.
---

# Rust server rewrite — feasibility

The question: should we rewrite the server portion of ShipIt (orchestrator + session worker, ~59k LOC TS) in Rust, motivated by smaller memory footprint, better performance, and stronger runtime guarantees against memory leaks?

**Verdict: rejected.** The cost is large, the realistic memory win is small relative to total system RSS, and the leak classes Rust prevents are not the ones a long-running Node orchestrator actually hits. Surgical extraction of specific hot paths remains on the table; a wholesale rewrite does not.

This doc exists so future contributors who ask the same question can read the analysis instead of re-deriving it.

## Scope of the current TS server

Measured at the time of writing:

- **~59,475 lines** of non-test TypeScript under `src/server/` + `src/server/shared/`
- **192 non-test files**, **189 test files**
- Largest single files run to ~1.5k LOC (`orchestrator/index.ts`, `container-session-runner.ts`, `session/session-worker.ts`)
- **154 `import` sites in `src/client/` reach into `src/server/shared/types/`** — the WebSocket and HTTP contracts are structurally shared TypeScript types; the client compiles against them directly.

The integration test harness (`integration_tests/test-helpers.ts`, `TestClient`, `FakeClaudeProcess`, `StubGitHubAuthManager`, etc.) encodes much of the product's behavior and is roughly as much work to port as the production code.

A faithful Rust port at standard rewrite multipliers (~1.5–2× LOC for equivalent semantics) lands around **90–120k Rust LOC** plus ~189 ported test files. Realistic calendar cost: **6–12 engineer-months**, during which the TS server keeps shipping features that also need porting.

## Where memory actually lives

The orchestrator is **one** Node process. The system's RSS is dominated by other tenants:

1. **N session-worker containers** — each runs its own Node + Fastify + `node-pty` + `dockerode`. Scales with active sessions. Tied to Node regardless of orchestrator language because Claude CLI and Codex CLI are Node tools and `node-pty` is a Node native module.
2. **N user compose stacks** — Vite, Next.js, Prisma Studio, etc. inside the user's container. Outside our control entirely.
3. **BuildKit / image cache** — already handled by `deployment/vps/deploy.sh` (`docker image prune -af --filter "until=168h"` and `docker builder prune -f --filter "until=72h"`).
4. **The orchestrator process** — typically 100–300 MB. The smallest tenant on the host.

A Rust orchestrator might save ~150 MB on the host. It does **not** reduce per-session-worker RSS (still Node) and **does not touch** user compose stacks. The memory pitch does not survive that breakdown.

## What Rust does and doesn't guarantee

The memory-leak classes a long-running orchestrator actually hits:

- Unbounded `Map`/`Set` growth (session registry, viewer maps, terminal buffers, PR-status caches)
- Event-listener accumulation on shared emitters
- Closures capturing large objects beyond their needed lifetime
- Channel/queue backpressure not honored
- Idle resources never reclaimed

Rust prevents use-after-free, double-free, and data races on mutable state. It does **not** prevent any of the bullets above: `HashMap` grows fine, `Arc` cycles leak, `tokio::sync::mpsc` deadlocks under backpressure just like Node streams, idle tasks need explicit cancellation just like Node intervals.

The discipline already encoded in `CLAUDE.md` is what prevents these classes today:

- Capture per-connection state at the top of long-running functions, never inside async callbacks
- Resolve runners via the registry (`getRunnerRegistry().get(capturedSessionId)`) rather than per-connection `getRunner()`
- Mutate runner state directly (`runner.running = false`) rather than via setters that silently no-op on closed connections
- Emit via `runner.emitMessage()` (broadcasts + buffers) rather than `ctx.send()` (single socket, drops on close)
- Never trigger `runner.dispose()`, `agent.kill()`, or `container.destroy()` from a WebSocket close handler

That discipline ports unchanged to Rust — which is the point. We don't need Rust to have it, and switching languages doesn't grant it.

The legitimate Rust wins for this codebase:

- **Lower per-process baseline RSS** — real but small in absolute terms (~150 MB on a host running many session containers)
- **Stricter exhaustiveness on enums** — a marginal upgrade over TS discriminated unions, not a revolution; the dispatch switch in `orchestrator/index.ts` already narrows each WS message to its specific type
- **CPU throughput** — largely irrelevant; this codebase is I/O orchestration (Docker socket, GitHub API, agent NDJSON, container HTTP+SSE), not CPU-bound work

## The shared-types boundary

The single biggest hidden cost of a Rust server is **not** the rewrite itself — it's the permanent friction introduced at the client/server boundary.

Today the client imports server types directly:

```ts
// src/client/App.tsx
import type { TurnUsage } from "../server/shared/types.js";
import type { AgentId, DocEntry, ProviderAccount } from "../server/shared/types.js";

// src/client/AppLayout.tsx
import type { SessionInfo, RepoInfo, DockerMemoryStats, SubscriptionLimitsMap } from "../server/shared/types.js";
```

154 such imports across the client. Renaming a WS message field is a TypeScript compile error that points at every consumer. Adding a discriminated-union variant gets exhaustiveness-checked end-to-end. The refactor velocity this enables is one of the codebase's most valuable properties and is invisible until you lose it.

A Rust server gives you two bad choices:

1. **Codegen** (`ts-rs`, `specta`, similar) — a regen step in the inner loop. Schema bumps become two-step: edit Rust enum, run codegen, then the TS client recompiles. CI must enforce that the regen artifact is current. Live in this for a year and the regen artifacts will drift in PRs and you'll merge mismatched contracts.
2. **Hand-maintained parallel definitions** — drift is now a question of when, not if. Every WS message and HTTP body needs two definitions kept in lockstep by reviewer discipline.

Both options cost real velocity forever, not just during the rewrite.

## Where Rust would meaningfully help (the surgical alternative)

Three modules are essentially byte-shoveling, have small surface area, and are touched by every session:

- **`orchestrator/preview-proxy.ts`** — HTTP/WS reverse proxy with HMR script injection. Subdomain and path-based routing into containers. Sits on the user's hot path.
- **`orchestrator/docker-proxy.ts`** — Docker socket proxy.
- **`orchestrator/sse-client.ts` + `worker-http.ts`** — fan-in of container SSE streams.

Each is under ~1k LOC, has a narrow type surface, and would shrink meaningfully in Rust (`hyper` + `tower`, a few hundred LOC each). Extracting any of these as a standalone sidecar service captures the bulk of the runtime upside available from Rust without touching the 59k LOC of business logic, without breaking the shared-types boundary, and without an integration-test port.

This option remains open and is the natural next step if profiling identifies any of these as bottlenecks. It is explicitly **not** what this doc rejects.

## Recommendation (the path we should actually take)

1. **Profile first, in production.** Get per-tenant RSS numbers — orchestrator vs. each session worker vs. each compose stack. The skills already mention `DockerMemoryStats`; surface it for the orchestrator process too. Almost certainly the orchestrator is not the hot tenant.

2. **Tighten the TS server first.** Days of work, addresses the leak classes that actually bite:
   - RSS budget alerts on the orchestrator process
   - Audit pass for unbounded `Map`s in `SessionManager`, `SessionRunnerRegistry`, `terminal-buffer`, `pr-status-poller`, viewer counts
   - Lint rule against `setInterval` without a registered cleanup
   - Periodic heap-snapshot diff in staging to catch regressions
   - Continue enforcing the WS-lifecycle discipline already documented in `CLAUDE.md`

3. **If a specific hot path still looks bad after profiling, extract just that.** Preview proxy first — clearest win, smallest surface, no shared types with the client.

4. **Skip the full rewrite.** Cost is high, win is small, the leak classes Rust prevents aren't the ones we hit, and the shared-types boundary with the React client makes a Rust server permanently more expensive to evolve than the current monorepo.

## Key data points (for future re-litigation)

| Dimension | Value |
|---|---|
| Non-test server + shared TS LOC | ~59,475 |
| Non-test server + shared files | 192 |
| Test files | 189 |
| Client→shared-types import sites | 154 |
| Realistic Rust port LOC | ~90–120k |
| Realistic calendar cost | 6–12 engineer-months |
| Estimated host RSS saved | ~150 MB (orchestrator process only) |
| Per-session-worker RSS impact | None (still Node) |
| User compose stack RSS impact | None |
| Leak classes Rust prevents that we hit in practice | None of the routine ones (unbounded maps, listener accumulation, Arc/closure capture, channel backpressure) |

## When to revisit

The verdict could change if any of these become true:

- Profiling shows the orchestrator process itself (not session workers, not user containers) is the dominant RSS or CPU tenant on the host.
- The agent backend stops being Node (Claude CLI and Codex CLI rewritten in another language), removing the Node anchor in session workers.
- The shared TS-types coupling between client and server is removed for an unrelated reason (e.g. moving to a strict OpenAPI/proto-defined contract with codegen on both sides), eliminating the boundary cost.

Absent those, the surgical-extraction path (one Rust sidecar at a time, behind the existing route surface) captures essentially all the realistic upside of this proposal at a small fraction of the cost.
