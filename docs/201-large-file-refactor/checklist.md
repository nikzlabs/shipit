# Checklist — large-file split & tech-debt

Each **phase below is one PR**, sized to land independently. They are designed to be
**implemented in parallel**: every phase keeps its original file as a thin facade and
preserves the existing export surface (the plan's guiding rule), so **importers never
change** and no two phases touch the same file.

**Why parallel-safe:** a split produces new sibling modules that only the facade imports —
there is no shared "registration" churn. The one exception is **P10** (route split), which
must register its new sub-route files in the shared dispatcher `orchestrator/api-routes.ts`;
no other phase touches that file, so P10 is still conflict-free against the rest. Client
phases keep the original component filename as the directory entry (e.g. `Settings.tsx` →
`Settings/Settings.tsx` re-exported), so parents like `App.tsx` resolve unchanged.

**Per-phase done criteria (same for all):** extract → re-export from facade so the public
surface is byte-identical → move matching tests alongside the new modules → `npm run
typecheck` + `npm run lint:dev` clean → no behavior change. Open one PR per phase with
`Refs SHI-131`.

> The plan's "Suggested sequencing" is a **priority hint** (do the highest-payoff ones
> first if capacity is limited), **not** a dependency order. Any phase can start at any time.

---

## Group 1 — Cross-cutting (additive, zero behavior risk)

- [x] **P1 · Split `shared/types/ws-server-messages.ts`** (1402) → `ws-server-messages/{auth,agent,git,service,files,preview,session,repo,rollback,spawn,present,cards,misc}.ts`, re-assemble the union in `index.ts` + keep `ws-server-messages.ts` as a thin barrel re-export. Touches only `shared/types/`.
- [x] **P2 · Split `shared/types/domain-types.ts`** (1206) → `domain-types/{provider,egress,session,issue,chat,marketplace,git,review,misc}.ts`, keep barrel re-export. Touches only `shared/types/`.
- [x] **P3 · Extract `agents/agent-auth-base.ts`** — dedup the genuinely-identical, transport-agnostic core out of `claude/auth-manager.ts` + `codex/auth-manager.ts`: credential-file parsing (`probeNestedString` token probe across top-level + nested wrapper, `firstEpochMs` seconds-vs-ms expiry), `pickString`, and the symlink-resolve+mkdir dance (`resolveSymlinkTarget`/`ensureConfigDir`). Each manager keeps its transport-specific code (PTY readline vs device flow) + auth-URL extraction (the regexes genuinely differ per CLI) + event emission (payloads differ: code-paste-url vs device-code). Public export surface unchanged; new `agent-auth-base.test.ts` covers the helpers.

## Group 2 — Orchestrator god-modules (one file each → one PR each)

- [ ] **P4 · `index.ts`** (2118) → `app-assembly.ts` / `bootstrap-managers.ts` / `startup-monitors.ts` / `route-registry.ts`; `index.ts` = ordered entry point.
- [x] **P5 · `disk-janitor.ts`** (1850) → `startup-janitor.ts` / `tier-escalation.ts` / `disk-utils.ts`. `disk-janitor.ts` kept as a thin re-export facade so callers (`index.ts`) are unchanged; tests split into `startup-janitor.test.ts` + `disk-tier-escalation.test.ts`.
- [x] **P6 · `ws-handlers/agent-listeners.ts`** (1715) → `agent-event-normalizer.ts` / `agent-message-builder.ts` / `agent-voice-handler.ts` / `agent-auth-handler.ts` / `agent-rate-limits.ts`; facade keeps `wireAgentListeners` (1715 → 1235 lines). Public export surface preserved via facade re-exports; co-located tests for each module (incl. new `agent-rate-limits.test.ts`).
- [ ] **P7 · `session-credentials.ts`** (1216) → `session-credentials-scaffold.ts` / `session-agent-credentials.ts` / `token-sync-manager.ts` / `repo-memory-manager.ts`.
- [ ] **P8 · `service-manager.ts`** (1484) → extract `compose-cli.ts` (+ optional `install-gate.ts`); keep reconcile state machine in facade.
- [ ] **P9 · `pr-status-poller.ts`** (1367) → `pr-polling-supervisor.ts` / `pr-session-tracker.ts` / `polling-global-gate.ts`; collaborators stay.
- [ ] **P10 · `api-routes-session.ts`** (1255) → `api-routes-session-{crud,repos,spawn}.ts` + `api-routes-shipit-fix.ts`. **Registers new files in `api-routes.ts`** (only phase that touches it).
- [ ] **P11 · `session-container.ts`** (1124) → `container-config-builder.ts` / `container-overlay-provisioner.ts`; keep create/destroy/monitor in facade.

## Group 3 — Session & agent layer

- [ ] **P12 · `agent-shim/shipit.ts`** (2057) **+ `gh.ts`** (736) → `shipit-{session,issue,agent,source}.ts` + shared `shim-common.ts` (parseFlags/callBroker/ShimIO/wait loop) used by both. *(These two ship together — they share `shim-common.ts`.)*
- [ ] **P13 · `session-worker.ts`** (1693) → `agent-controller.ts` / `terminal-controller.ts` / `file-watcher-controller.ts` / `install-controller.ts` / `mcp-config-controller.ts`; facade = app builder.
- [ ] **P14 · `codex/adapter.ts`** (1634) → `codex-adapter.ts` (lifecycle + JSON-RPC) / `codex-event-handler.ts` / `codex-tool-normalizer.ts` / `codex-rate-limits.ts`.

## Group 4 — Client god-components (each → its own directory, original filename re-exported)

- [ ] **P15 · `Settings.tsx`** (1995) → `Settings/` with per-tab files (`AuthTab`, `VoiceTab`, `PrAutomationTab`, `AdvancedTab`, `AgentAccountsTab`) + provider-account/voice-credential hooks.
- [ ] **P16 · `App.tsx`** (1607) → `AppBootstrap` + `hooks/{useSessionActivation,useAppKeyboardShortcuts,useAppModals}`; `App.tsx` renders shell + wires hooks.
- [ ] **P17 · `SessionSidebar.tsx`** (1500) → `SessionSidebar/` with `SessionItem` / `SessionGroup` / `SessionStatusIndicators` + `useSidebarResize` / `useSessionGrouping`.
- [ ] **P18 · `MessageList.tsx`** (1199) → `MessageList/` with `useMessageScroll` + `MessageToolUse` / `MessageMedia` + `cards/` subdir.
- [ ] **P19 · `MessageInput.tsx`** (1015) → `MessageInput/` with `useTextareaSizing` / `useMessageDraft` / `useUploadBackend` + `AutoComplete/` / `VoiceInputSection` / `ContextDial`.
- [ ] **P20 · `PreviewFrame.tsx`** (887) → extract `useIframePool` / `usePreviewHealthPoller` + device/error/toolbar children.
- [ ] **P21 · `PrLifecycleCard.tsx`** (868) → one file per lifecycle phase + indicator children.
- [ ] **P22 · `SessionHealthStrip.tsx`** (808) → `useContainerHealthPoll` hook + `healthState` utils + summary/details/recovery children.
- [ ] **P23 · `MarkdownSelectionComments.tsx`** (800) → selection/anchoring hooks + markdown utils + comment children.
- [ ] **P24 · `McpServerSettings.tsx`** (789) → form/oauth hooks + row/form children + payload utils.
