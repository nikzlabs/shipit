# Checklist — propose work in another repository as a card

- [x] `RepoSessionProposalCard` domain type + WS message types
- [x] Shared validation module
- [x] `propose_repo_session` MCP tool + worker relay, enabled on all five harnesses
- [x] Orchestrator emit route (parse, own-repo guard, write-access check)
- [x] `ensureRepoReady()` extracted from `services/shipit-source.ts`
- [x] Start route (spawn detached, card transitions, stale-start recovery)
- [x] Chat-history column, migration, find/update, rehydration
- [x] Client card component + message handlers + transcript scoping
- [x] Tests: validation, emit route, start route, card component, handlers, history round-trip
- [x] `src/server/shipit-docs/sessions.md` — agent-facing documentation
- [x] lint:dev + typecheck clean
- [x] Independent review against the numbered requirements
- [x] Claude `--allowedTools`: the bridge served the tool but neither tool list
      named it, so the CLI routed every call to `--permission-prompt-tool` and the
      user approved `mcp__shipit__propose_repo_session` by hand before the card
      appeared. Both lists hoisted to one module constant; guard derives the
      expectation from the bridge's own tool list
      (`agents/claude/shipit-tool-allowlist.test.ts`)

## Decline, and telling the agent (reqs 10, 11)

- [x] `declined` card state, `declinedAt`, `agentNotifiedState`
- [x] Decline route; the start route refuses a declined card
- [x] Card: Decline button and declined state; client handler keeps `declined` terminal
- [x] `services/repo-session-outcome-notice.ts`, wired into both prompt paths
- [x] Tool description, tool result, `shipit-docs/sessions.md`, wiki `chat.md`
- [x] Row handlers: `onDismissBugReport` was never wired, so the bug-report Cancel
      stayed local; handler keys are now a `Record` the compiler checks
- [x] Tests: notice service, decline route, both prompt paths, card, handler, transcript wiring
- [x] lint:dev + typecheck clean
- [x] Independent review against reqs 10 and 11 (applied: persist before emit;
      the start response updates a card with no runner; dropped an unused field)

## Trusting the target from the card (req 12)

- [x] Start route: `{ trust: true }` grants trust after registration, before the spawn
- [x] Start route: the trust refusal carries `code: repository_untrusted` and a reason that points at the card
- [x] Card: trust notice and "Trust and start in owner/repo"; the server's refusal code overrides the repository list
- [x] `ApiError.code`; `useRepoTrust().known`
- [x] `shipit-docs/sessions.md`, wiki `chat.md` and `repos-and-sandboxes.md`
- [x] Tests: start route with and without the consent, card, `useApi`
- [x] lint:dev + typecheck clean
- [x] Independent review against req 12 (applied: a target the list does not have
      needs the consent, also when the card was written for a registered one; the
      refusal override ends when the next start settles)
