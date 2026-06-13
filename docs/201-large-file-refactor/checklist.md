# Checklist — large-file split & tech-debt

## Cross-cutting (do first / alongside)
- [ ] A. Split `shared/types/ws-server-messages.ts` by domain (keep union + barrel)
- [ ] A. Split `shared/types/domain-types.ts` by domain (session/issue/provider/marketplace/mcp)
- [ ] B. Extract `agents/agent-auth-base.ts`; dedup Claude/Codex auth managers

## Tier 1 — orchestrator god-modules
- [ ] `index.ts` → app-assembly / bootstrap-managers / startup-monitors / route-registry
- [ ] `disk-janitor.ts` → startup-janitor / tier-escalation / disk-utils
- [ ] `ws-handlers/agent-listeners.ts` → normalizer / message-builder / voice / auth / rate-limits
- [ ] `session-credentials.ts` → scaffold / agent-credentials / token-sync / repo-memory
- [ ] `service-manager.ts` → compose-cli (+ optional install-gate)
- [ ] `pr-status-poller.ts` → supervisor / session-tracker / global-gate
- [ ] `api-routes-session.ts` → crud / repos / spawn / shipit-fix
- [ ] `session-container.ts` → config-builder / overlay-provisioner

## Tier 2 — session & agent layer
- [ ] `agent-shim/shipit.ts` → session/issue/agent/source + `shim-common.ts` (shared with `gh.ts`)
- [ ] `session-worker.ts` → agent / terminal / file-watcher / install / mcp-config controllers
- [ ] `codex/adapter.ts` → adapter / event-handler / tool-normalizer / rate-limits

## Tier 3 — client components
- [ ] `Settings.tsx` → tab modules + hooks
- [ ] `App.tsx` → bootstrap + hooks (activation / shortcuts / modals)
- [ ] `SessionSidebar.tsx` → item / group / indicators / hooks
- [ ] `MessageList.tsx` → scroll hook + tool-use / media / cards
- [ ] `MessageInput.tsx` → sizing / draft / upload hooks + autocomplete / voice
- [ ] `PreviewFrame.tsx` (lower priority)
- [ ] `PrLifecycleCard.tsx` (lower priority)
- [ ] `SessionHealthStrip.tsx` (lower priority)
- [ ] `MarkdownSelectionComments.tsx` (lower priority)
- [ ] `McpServerSettings.tsx` (lower priority)
