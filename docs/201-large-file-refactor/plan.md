---
issue: https://linear.app/shipit-ai/issue/SHI-131
title: Large-file split & architectural tech-debt plan
description: Inventory of oversized modules and type barrels with a per-file plan for splitting them by responsibility.
---

# Large-file split & architectural tech-debt plan

> **Status: fully implemented.** All 24 phases (P1–P24) have merged to main; this plan is complete. See `checklist.md`.

## Why this doc exists

ShipIt's production source is ~140k LOC across ~500 files. The structure is mostly healthy — three clean layers (client → orchestrator → session worker), a services layer of small pure functions, and per-domain route files. The debt is concentrated in a **long tail of oversized modules** that each grew to span several responsibilities, plus **two giant type barrels** that every layer imports. None of this is broken; all of it makes the affected areas slow to navigate, risky to change, and expensive to test (several test files are 2–3k lines because their source does too much).

This plan is a refactor **inventory**, not a redesign. Each finding is a near-mechanical extraction: move cohesive blocks out of a god-module into siblings, keep the original as a thin facade or coordinator, preserve public exports so callers don't churn. They are independent and can land in any order, one PR each.

**Non-goals / explicitly rejected.** We are *not* introducing a ServiceLocator, a router registry, a handler-registration framework, or a DI container. The services-as-pure-functions pattern, the per-domain `api-routes-*.ts` files, and manual wiring in `buildApp()` are deliberate (see CLAUDE.md §"Service layer pattern" and §"Keep it simple"). The 43 service files and 20 route files are *decomposition working as intended*, not fragmentation to consolidate. This doc only splits modules that are too big; it does not add abstraction layers.

## Guiding rule for every split

- Keep the original filename as the **coordinator/facade**; extract concerns into siblings in the same directory (or a new sub-dir for big client components).
- **Preserve the existing export surface** — re-export from the facade so no import site changes in the first PR. Tighten imports later if desired.
- Move the matching tests alongside each new module; a 2k-line test file splitting into 4 is a feature, not a regression.
- One finding = one PR. Land Tier 1 first (highest navigation/merge-risk payoff), then Tier 2.

---

## Tier 1 — Orchestrator god-modules

| File | Lines | Why it's debt | How to split |
|---|---|---|---|
| `orchestrator/index.ts` | 2118 | Composition root doing ~12 things: Fastify setup, DI wiring, manager instantiation, SSE registry, idle/OOM enforcement, route registration, re-exports. The "what depends on what" story is unreadable. | Keep `index.ts` as the entry point that calls ordered steps. Extract `app-assembly.ts` (Fastify + middleware), `bootstrap-managers.ts` (instantiation + wiring order), `startup-monitors.ts` (memory stats, OOM breaker, idle enforcer), `route-registry.ts` (the route registration block). |
| `orchestrator/disk-janitor.ts` | 1850 | Two unrelated lifecycle phases tangled: **one-time startup orphan sweeps** (volumes, networks, caches, branches, overlay bases) vs **steady-state tier escalation** (hot→light→evicted under disk pressure). Different timing, deps, failure modes. | `startup-janitor.ts` (all `sweep*` functions + `runDiskJanitor`), `tier-escalation.ts` (escalate/applyDiskPressure state machine), `disk-utils.ts` (statfs, watermarks, pacing). |
| `orchestrator/ws-handlers/agent-listeners.ts` | 1715 | Catch-all for the whole agent turn lifecycle: event normalization, chat-group accumulation, voice-note derivation, permission translation, rate-limit/auth-failure recovery, MCP-crash attribution, sub-agent correlation. Single point of mutation for every agent feature; risky merges. | `agent-listeners.ts` keeps `wireAgentListeners` + init/done. Extract `agent-event-normalizer.ts` (tool dedup, permission-mode translation), `agent-message-builder.ts` (chat-group accumulation), `agent-voice-handler.ts` (docs/163), `agent-auth-handler.ts` (docs/179 recovery), `agent-rate-limits.ts`. |
| `orchestrator/session-credentials.ts` | 1216 | Four concerns sharing a directory layout: per-session scaffold, per-agent credential provisioning, OAuth token sync in/out (docs/142), and per-repo shared memory (docs/155). Token-rotation logic is dense and buried. | `session-credentials-scaffold.ts`, `session-agent-credentials.ts` (provision/remove incl. sub-agents), `token-sync-manager.ts` (syncIn/syncBack/repush + freshness), `repo-memory-manager.ts`. |
| `orchestrator/service-manager.ts` | 1484 | Collaborators (Poller/SecretsResolver/RetryManager) are already split, but the class still owns both `docker compose` CLI invocation and the start/stop/reconcile state machine plus install-gate tracking. | **Done (P8):** extracted `compose-cli.ts` (`ComposeCli` — arg construction, `up`/`upService`/`stop`/`down`, single-retry conflict recovery, `killStaleContainers`, output parsing). `service-manager.ts` keeps the reconcile state machine + install gate + collaborator wiring, delegating compose calls to `this.compose`. `install-gate.ts` left in place — too coupled to the poller/retry/start machine to split cleanly. |
| `orchestrator/pr-status-poller.ts` | 1367 | Polling supervisor + per-session state tracking + viewer/autonomous-action **global gate** decision trees, on top of the (already-split) auto-fix/merge/resolve collaborators. Test file is **3007 lines** — the tell. | `pr-polling-supervisor.ts` (timer, per-repo cadence), `pr-session-tracker.ts` (lastKnown/diffs/check details), `polling-global-gate.ts` (viewer + in-flight-action gating). Collaborators stay. |
| `orchestrator/api-routes-session.ts` | 1255 | One route file absorbed five concerns: session CRUD, repo management, child-session spawn/watch, history/usage/presentations, and the ShipIt-fix flow. | Split along the existing per-domain route convention: `api-routes-session-crud.ts`, `api-routes-session-repos.ts`, `api-routes-session-spawn.ts`, `api-routes-shipit-fix.ts`. |
| `orchestrator/session-container.ts` | 1124 | Manager mixes config-building (`buildContainerConfig`, `resolveAgentDockerLimits`) with lifecycle (create/destroy/rediscover) and overlay/pnpm provisioning. | `container-config-builder.ts` (env/mounts/limits resolution), `container-overlay-provisioner.ts` (overlay + pnpm store). Keep create/destroy/monitor in the manager (already delegates to container-lifecycle/discovery/health). |

---

## Tier 2 — Session-worker & agent layer

| File | Lines | Why it's debt | How to split |
|---|---|---|---|
| `session/agent-shim/shipit.ts` | 2057 | One CLI shim routing four unrelated domains: sessions, issues, sub-agents, and Ops source-browsing — plus its own flag parser, HTTP broker, and poll loop. `gh.ts` (736) duplicates the broker/parser/IO boilerplate. | `shipit-session.ts`, `shipit-issue.ts`, `shipit-agent.ts`, `shipit-source.ts` domain handlers + `shim-common.ts` (parseFlags, callBroker, ShimIO, wait loop) **shared with `gh.ts`**. |
| `session/session-worker.ts` | 1693 | One Fastify class owns agent control, sub-agent lifecycle, terminal PTY, file watcher, MCP config, permission broker, SSE, and install state. Textbook SRP violation. | Controllers per concern: `agent-controller.ts`, `terminal-controller.ts`, `file-watcher-controller.ts`, `install-controller.ts`, `mcp-config-controller.ts`; `session-worker.ts` becomes the app builder that registers them. |
| `session/agents/codex/adapter.ts` | 1634 | JSON-RPC protocol parsing, tool/diff normalization, rate-limit tracking, and compaction are all inline in the adapter — 2.8× the Claude adapter (576 lines). Test file is 1663 lines. | `codex-adapter.ts` (lifecycle + JSON-RPC wire), `codex-event-handler.ts` (stream processing), `codex-tool-normalizer.ts` (fileChange/webSearch/permission), `codex-rate-limits.ts`. |

---

## Tier 3 — Large client components

These are React god-components. The pattern is identical for each: promote the file to a directory, extract sub-components and custom hooks, leave a thin orchestrator at the top. (No `AppLayout.tsx` exists — layout lives inline in `App.tsx`.)

| File | Lines | Why it's debt | How to split |
|---|---|---|---|
| `client/components/Settings.tsx` | 1995 | 11 internal settings sub-panels (auth, voice, PR automation, ops, MCP, accounts) in one file. | `Settings/` dir: one file per tab (`AuthTab`, `VoiceTab`, `PrAutomationTab`, `AdvancedTab`, `AgentAccountsTab`), `Settings.tsx` = tab routing only, hooks for provider-account + voice-credential CRUD. |
| `client/App.tsx` | 1607 | Root god-component: bootstrap, URL routing, store subscriptions, WS/SSE wiring, keyboard shortcuts, and ~9 modal dialogs. | `AppBootstrap` (init + WS/SSE), `hooks/useSessionActivation`, `hooks/useAppKeyboardShortcuts`, `hooks/useAppModals`; `App.tsx` renders shell + wires hooks. |
| `client/components/SessionSidebar.tsx` | 1500 | List rendering + grouping strategy + drag-drop + resize + status badges in one. | `SessionSidebar/` dir: `SessionItem`, `SessionGroup`, `SessionStatusIndicators`, `useSidebarResize`, `useSessionGrouping`. |
| `client/components/MessageList.tsx` | 1199 | Scroll logic + segment parsing + ~10 specialized card renderers (spawned-session, review, permission, todo, voice). | `MessageList/` dir: `useMessageScroll` hook, `MessageToolUse`, `MessageMedia`, and a `cards/` subdir for the specialized cards. |
| `client/components/MessageInput.tsx` | 1015 | Textarea sizing + two upload backends + file/skill autocomplete + drag-drop + voice + draft persistence. | `MessageInput/` dir: `useTextareaSizing`, `useMessageDraft`, `useUploadBackend` hooks; `AutoComplete/`, `VoiceInputSection`, `ContextDial` components. |

Lower-priority client splits (same recipe, do as touched): `PreviewFrame.tsx` (887 — extract `useIframePool`/`usePreviewHealthPoller` + device/error/toolbar children), `PrLifecycleCard.tsx` (868 — one file per lifecycle phase + indicators), `SessionHealthStrip.tsx` (808 — `useContainerHealthPoll` hook + `healthState` utils), `MarkdownSelectionComments.tsx` (800 — selection/anchoring hooks + markdown utils), `McpServerSettings.tsx` (789 — form/oauth hooks + row/form children).

---

## Cross-cutting findings (not "one big file")

### A. Shared-type barrels split by domain
`shared/types/ws-server-messages.ts` (1402, ~86 `Ws*` variants in one union) and `shared/types/domain-types.ts` (1206, ~40 unrelated interfaces — session, issue, provider, marketplace, MCP all mixed) are imported by nearly every file via the `shared/types.ts` barrel. Any type edit ripples widely and IDE navigation is slow.
**How:** split each by domain — `ws-server-messages/{auth,git,service,agent,...}.ts` re-assembled into the union; `domain-types/{session,issue,provider,marketplace,mcp}.ts`. Keep `index.ts` barrel re-exporting so no import site changes.

### B. Shared agent-auth base (Claude ↔ Codex duplication)
`orchestrator/agents/claude/auth-manager.ts` (755) and `codex/auth-manager.ts` (695) independently re-implement auth-URL extraction, credential-file lifecycle (exists/wait-for-write/validate), and event emission, despite genuinely different transports (PTY readline vs device flow). A bug fix in one must be hand-ported to the other; a third agent means copying ~700 lines.
**How:** extract the shared lifecycle/validators into `agents/agent-auth-base.ts` (or shared helpers); each adapter keeps only its transport-specific code. Mirrors the existing `agent-auth-manager.ts` interface already in the tree.

### C. Watch the test-bloat outliers as a signal
`pr-status-poller.test.ts` (3007), `service-manager.test.ts` (2184), `codex/adapter.test.ts` (1663 ≈ source) are symptoms, not independent work — they shrink naturally once their sources split above. No separate task; just confirm coverage moves with the code.

---

## Suggested sequencing

1. **Type barrels (A)** first — purely additive, unblocks cleaner imports everywhere, zero behavior risk.
2. **Tier 1 orchestrator** modules — biggest navigation/merge-risk payoff: `agent-listeners`, `index`, `disk-janitor`, `pr-status-poller`.
3. **Tier 2 session layer** + **agent-auth base (B)** — `shim-common` extraction and the auth base remove real duplication.
4. **Tier 3 client** components — independent, parallelizable, low cross-file risk.

Each PR: extract → re-export from facade → move tests → `npm run typecheck` + `npm run lint:dev`. No public-surface change in the first pass, so the blast radius is contained per file.
