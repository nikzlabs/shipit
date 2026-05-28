---
status: in-progress
priority: high
title: Agent abstraction — hairs to clean up and per-agent folder layout
description: Catalog of agentId-branching hairs across the codebase and a proposed per-agent folder layout so a new backend (Cursor, Gemini, …) drops in as one package instead of edits in twelve files.
---

# Agent abstraction — hairs and per-agent folder layout

ShipIt's agent abstraction is genuinely working: every backend implements the
same `AgentProcess` interface, the orchestrator's turn machinery is mostly
agent-agnostic, and Codex was added without ripping anything up. But two years
of per-agent feature work has accumulated a trail of `agentId === "claude"` /
`agentId === "codex"` branches scattered across the codebase, plus per-agent
files scattered across multiple directories under names like
`claude-oauth-refresher.ts`, `codex-auth.ts`, `claude-limits.ts`, etc. Adding
Cursor (`docs/154`) will add the next twelve branches in the same twelve places.
Gemini after that adds another twelve. This doc catalogs the hairs and proposes
a cleaner per-agent folder layout so the next backend is one package instead of
twelve edits.

## Goals

1. Inventory every place in the codebase that hardcodes `agentId === "claude"`
   or `agentId === "codex"`, with a recommendation per site (capability flag,
   registry lookup, per-agent hook, or "leave alone").
2. Consolidate per-agent code into per-agent folders so a new backend is one
   directory to add, not a dozen scattered edits across `session/`,
   `orchestrator/`, `orchestrator/limits/`, `orchestrator/services/`,
   `shared/types/`, and `client/themes/`.
3. Keep the existing session/orchestrator runtime boundary intact — adapters
   run in the session worker, auth managers run in the orchestrator. The
   per-agent folder lives in whichever layer the code already runs in; we are
   not collapsing the two-process architecture.

## Non-goals

- Removing per-agent code that genuinely differs (Codex's `config.toml` vs
  Claude's `--mcp-config` is a real CLI-shape difference and the wiring code
  for each will remain distinct).
- Inventing capability flags for one-off branches that aren't going to repeat.
- Changing user-visible behavior. This is a refactor.
- Pre-implementing Cursor or Gemini. The Cursor adapter (docs/154) and any
  future backend land separately; this doc clears the path for them.

## Current state

### The seam that works

- `src/server/shared/types/agent-types.ts` — `AgentProcess` (EventEmitter
  contract), `AgentEvent` (normalized union), `AgentCapabilities`,
  `AgentRunParams`. Almost all turn-loop code consumes these without knowing
  which CLI is running.
- `src/server/shared/agent-registry.ts` — single `AGENT_DEFS` array with
  per-agent capability fixtures, binary names, and auth-env-key map.
- `src/server/session/agents/{claude,codex}-adapter.ts` — implementations.
- `src/server/session/session-worker.ts:1357` (`createWorkerAgent`) — single
  factory that dispatches on `agentId`. A regression test
  (`session-worker-agent-factory.test.ts`) encodes the rule that the worker
  must spawn the agent the orchestrator selected.
- `src/server/orchestrator/proxy-agent-process.ts` — proxies the
  `AgentProcess` interface over HTTP+SSE so the orchestrator treats local and
  containerized agents identically.
- `src/server/session/agents/tool-map.ts` — single table normalizing
  CLI-specific tool names into a canonical vocabulary.

### Why the hairs accumulated

Each per-agent feature was added in the place where the work needed to happen
at the time. Auth env-key resolution, rate-limit dispatch, MCP wiring, skills
dir resolution, marketplace prefix character — each is a one-line branch at
its call site. Individually they are reasonable; collectively they are the
maintenance cost the Cursor adapter doc (`docs/154`) flags up front:

> Audit all switch statements and local-storage validators that currently
> assume only `"claude" | "codex"`.

That audit is the thing this doc is making mechanical.

## Inventory of hairs

Twelve files branch on `agentId === "claude"` or `agentId === "codex"` today.
Each entry below names the file, the site, the reason, and the cleanup path.

### 1. Auth env-key lookup (DUPLICATED)

**Sites**

- `src/server/orchestrator/services/settings.ts:167` —
  `const envKey = agentId === "codex" ? "OPENAI_API_KEY" : "";`
- `src/server/orchestrator/index.ts:1361` — same shape.

**Why it's a hair**: `AGENT_DEFS` in `shared/agent-registry.ts` already encodes
`AUTH_ENV_KEYS: Partial<Record<AgentId, string>> = { codex: "OPENAI_API_KEY" }`,
but the registry keeps it private and consumers re-hardcode the string. Adding
Cursor's `CURSOR_API_KEY` means editing three places.

**Cleanup**: Promote `AUTH_ENV_KEYS` to an exported registry method
(`agentRegistry.getAuthEnvKey(agentId)`) or add it to `AgentInfo`. Replace both
inline strings with the registry lookup.

### 2. Rate-limits dispatch (LIES IN COMMENT)

**Site**: `src/server/orchestrator/index.ts:453-460`

```ts
const recordAgentRateLimits: AppCtx["recordAgentRateLimits"] = (agentId, session, weekly) => {
  if (agentId === "claude") {
    claudeLimitsProvider.setRateLimits(session, weekly);
  } else if (agentId === "codex") {
    codexLimitsProvider.setRateLimits(session, weekly);
  }
  limitsRegistry?.markAuthRefreshed(agentId);
};
```

**Why it's a hair**: The accompanying comment says "the dispatch is keyed by
`agentId` so a single callback serves every backend." It does not. The
providers are explicit singletons and the dispatch is an if/else. Adding
Cursor means a new `cursorLimitsProvider` + a new branch.

**Cleanup**: `src/server/orchestrator/limits/` already groups per-agent
providers by folder. Build a `Map<AgentId, LimitsProvider>` at app-DI time and
make `recordAgentRateLimits` a one-line lookup. The per-agent provider files
stay where they are — only the registration point becomes generic.

### 3. Per-agent OAuth refresh hook on auth_required

**Site**: `src/server/orchestrator/ws-handlers/agent-listeners.ts:865`

```ts
if (turnSession?.agentId === "claude") {
  deps.nudgeClaudeOAuthRefresh?.();
}
```

**Why it's a hair**: Hardcoded to Claude. When Codex gets a comparable refresh
nudge (`docs/154-codex-oauth-refresh-readiness`), this becomes a second branch.

**Cleanup**: Move to a per-agent hook table:
`agentDeps.onAuthRequired?.(turnSession.agentId)`. Each per-agent module
registers its own hook at app-DI time; the listener becomes agent-agnostic.

### 4. Claude-only settings path in run params

**Site**: `src/server/orchestrator/session-agent-run-params.ts:106`

```ts
const settingsPath = agentId === "claude"
  ? "/etc/shipit/managed-settings.json"
  : undefined;
```

**Why it's a hair**: `AgentRunParams.settingsPath` is documented as
"Claude-only; other adapters ignore it" (along with `autoCreatePr` and
`useStreaming`). Each agent accumulating its own ignored fields on the
shared run-params shape is a slow-burning anti-pattern.

**Cleanup**: Two options:
- (a) Add a `prepareRunParams(agentId, params)` per-agent hook that each
  agent's module owns; the orchestrator calls it after the shared assembly.
  Claude's hook injects `settingsPath`; Codex/Cursor's hook is a no-op.
- (b) Keep the field but pull the constant out of the call site: replace the
  literal with `agentRuntime[agentId].settingsPath`.

(a) is the cleaner extension point but a bigger refactor. Start with (b) and
move to (a) when a second adapter needs its own knob.

### 5. Per-agent skills directory

**Sites**

- `src/server/orchestrator/services/skills.ts:28` —
  `path.join(dir, agentId === "codex" ? ".codex" : ".claude", "skills")`
- `src/server/orchestrator/services/marketplace.ts:351` — same shape.

**Why it's a hair**: The dotfolder name (`.claude` vs `.codex`) is a per-CLI
convention. Cursor would add `.cursor/skills`. The branch repeats in two
places.

**Cleanup**: Add `skillsDirName: ".claude"` to `AgentCapabilities` (or a
sibling `AgentRuntime` table). Both call sites become
`path.join(dir, registry.get(agentId).skillsDirName, "skills")`.

### 6. Per-agent skill invocation prefix character

**Sites**

- `src/server/orchestrator/services/marketplace.ts:359` —
  `const prefix = agentId === "codex" ? "$" : "/";`
- `src/client/components/MessageInput.tsx:333` — same shape on the client.

**Why it's a hair**: Two-sided duplication (server and client). When Cursor
ships, both sides need the new prefix.

**Cleanup**: Add `skillInvocationPrefix: "/"` to `AgentCapabilities`. Both
sites read it from the registry/capability. The capability is already
shipped to the client over the bootstrap response, so the client mirror
disappears.

### 7. Marketplace install: Claude-only gate

**Site**: `src/server/orchestrator/services/marketplace.ts:395`

```ts
if (agentId !== "claude") {
  throw new ServiceError(400, "v1 only supports Claude installs (Codex is v1b)");
}
```

**Why it's a hair**: This one is honest — it's a deliberate
not-yet-implemented gate, not a divergence. The branch is doing work.

**Cleanup**: Leave for now. When Codex install lands (v1b in the marketplace
doc), this becomes either two branches or a capability flag
(`supportsMarketplaceInstall`). Don't pre-generalize.

### 8. Skills endpoint: Codex-only built-in merge

**Site**: `src/server/orchestrator/api-routes-files.ts:162`

```ts
if (agentId !== "codex") {
  return { skills: projectSkills };
}
// Merge Codex's container-side built-ins.
```

**Why it's a hair**: Codex ships system skills inside the container at
`~/.codex/skills/**` and the route merges those with project skills. Claude
has no equivalent today. If Cursor ships built-in skills, this becomes a
two-agent branch.

**Cleanup**: Add a `getBuiltinSkills?(): Promise<SkillInfo[]>` method to the
runner interface, with the default being "no built-ins." The route calls the
optional method unconditionally. Each agent's session-worker side decides
whether to implement it.

### 9. Per-agent system-prompt section (Parallel sessions)

**Site**: `src/server/orchestrator/agent-instructions.ts:52-75`

The "Parallel sessions" section has hand-written Claude-vs-Codex prose
because Claude has the in-process `Task` tool for fan-out and Codex doesn't.

**Why it's a hair**: Adding Cursor means a third hand-written paragraph.
Worse, the Cursor doc flags that Cursor may not have a stable system-prompt
flag at all and the prompt may need to be prepended to the user message —
that's a transport-shaped variation the abstraction doesn't model.

**Cleanup**: Two layers:
- The Parallel-sessions section becomes a per-agent override: each agent
  module exports an optional `parallelSessionsPromptSection: string`. The
  builder collects them; agents without a primitive get the default
  (Codex-shaped) wording.
- The system-prompt delivery (flag vs prepend) becomes a per-adapter
  responsibility. Adapters take a `systemPrompt` string in `AgentRunParams`
  and decide internally how to deliver it. (Most already do — this is
  documenting current behavior, not adding a knob.)

### 10. Per-agent MCP config wiring

**Sites**

- `src/server/session/session-worker.ts:178` —
  `if (agentId !== "claude") return undefined;` in `generateMcpConfig`.
- `src/server/session/session-worker.ts:443` —
  `agentId === "codex" ? this.ensureCodexMcpConfig(params) : {}`.

**Why it's a hair**: Each CLI has its own MCP config shape (Claude:
`--mcp-config` flag pointing at a JSON file; Codex: `config.toml` entries;
Cursor: `mcp.json`). Today the worker has two explicit branches; Cursor adds
a third. The Cursor adapter doc explicitly defers MCP work to a later phase
because of this shape mismatch.

**Cleanup**: Add a `writeMcpConfig(workspaceDir, servers, params)` method to
each adapter (or a sibling `AgentMcpWriter` per agent). The worker calls
`adapter.writeMcpConfig(...)` unconditionally before spawn and `adapter` is
the one that knows whether to write a JSON file, mutate config.toml, or
no-op. The two `if` branches in `session-worker.ts` disappear.

### 11. Worker factory dispatch (LEGITIMATE)

**Site**: `src/server/session/session-worker.ts:1357`

```ts
agentId === "codex" ? new CodexAdapter() : new ClaudeAdapter(new ClaudeProcess());
```

**Why it's a hair**: It isn't. Construction has to dispatch on the discriminator
somewhere, and concentrating it in one factory with a regression test is the
correct design.

**Cleanup**: When Cursor lands, this grows to a three-way switch (or a
`Map<AgentId, () => AgentProcess>` factory table). Either is fine. Don't
over-generalize.

### 12. Client agent type guards (MECHANICAL)

**Sites**: scattered across `src/client/` (selector, local-storage validator,
type narrowing in stores).

**Why it's a hair**: `AgentId` is a closed string union, so every narrowing site
needs a new case. Mechanical, but the Cursor doc lists this as a real audit
target.

**Cleanup**: Most of these are exhaustive switches that TypeScript will flag
on a `AgentId` union widening. A few are runtime validators (local-storage
reads) that need explicit "is this a known agent id" lookups against
`agentRegistry.list()`. Centralize the runtime validator into a single
`isKnownAgentId()` helper sourced from the registry.

## Other hairs that aren't `agentId === X` but belong here

### Auth managers are bespoke files

`auth.ts` (Claude OAuth) and `codex-auth.ts` (Codex device flow) are
standalone classes with no shared interface. Cursor sidesteps this by using
only an env var for v0. A real Cursor login flow would be a third bespoke
file. There is no `AgentAuthManager` interface.

This is the biggest gap in the abstraction today. Auth flows really do differ
between providers (OAuth vs RFC-8628 device flow vs API-key vs file login),
but the lifecycle is the same: kick off a flow, surface pending state to the
client, finalize on success, fail on timeout/denial. A shared interface with
events (`pending`, `complete`, `failed`) would let the WebSocket dispatch
table be agent-agnostic.

**Cleanup**: Extract a minimal `AgentAuthManager` interface:

```ts
interface AgentAuthManager extends EventEmitter<{ pending: [unknown]; complete: []; failed: [unknown] }> {
  readonly agentId: AgentId;
  start(): Promise<void>;
  cancel(): Promise<void>;
  isConfigured(): boolean;
}
```

The Claude OAuth manager and Codex device-flow manager already match this
shape in practice — formalizing it lets the WS handler dispatch by
`agentId` against a `Map<AgentId, AgentAuthManager>` lookup instead of two
separate handlers.

### Themes are duplicated per agent

`src/client/themes/{claude,codex}{,-light}.css` exist as four files. This is
deliberate — each agent gets its own brand palette — but adding Cursor means
two more files. Less of a hair, more of a maintenance cost. Out of scope here.

### `claude.ts` is unprefixed at `src/server/session/claude.ts`

The Claude PTY process lives at `src/server/session/claude.ts`, not under
`agents/`. The Claude adapter at `agents/claude-adapter.ts` imports from it.
Codex doesn't have an equivalent "low-level process" file because the Codex
adapter spawns its CLI directly. Adding a third agent that needs a similar
helper would either drop into `session/` flat (inconsistent with Codex) or
into `agents/cursor-something.ts` (inconsistent with Claude). The folder
proposal below fixes this.

## Proposed per-agent folder layout

The goal: a new backend is one folder to add. Existing backends move into the
same shape so the pattern is visible.

### Constraints

- **Session vs orchestrator boundary stays.** Adapters run in the session
  worker container; auth managers, OAuth refreshers, limits providers,
  marketplace/skills wiring all run in the orchestrator process. Moving any
  of them across this boundary changes runtime semantics — we are not doing
  that.
- **Per-layer per-agent folders.** Each layer gets its own `agents/` tree
  with per-agent subfolders.

### Target structure

```
src/
  server/
    session/
      agents/
        claude/
          adapter.ts            # was: claude-adapter.ts
          adapter.test.ts
          process.ts            # was: ../claude.ts (PTY)
          process.test.ts
          auth-detection.test.ts # was: ../claude-auth-detection.test.ts
          mcp-writer.ts         # NEW: generateMcpConfig logic moved out of session-worker.ts
          tool-map.ts           # per-agent slice of the canonical tool table
        codex/
          adapter.ts            # was: codex-adapter.ts
          adapter.test.ts
          review-mcp.test.ts    # was: ../codex-review-mcp.test.ts
          mcp-writer.ts         # NEW: ensureCodexMcpConfig moved out of session-worker.ts
          tool-map.ts
        index.ts                # re-exports + factory table
        agent-process.ts        # shared interface re-export (stays put)
        tool-map.ts             # merges per-agent slices into one canonical table

    orchestrator/
      agents/
        claude/
          auth-manager.ts       # was: ../auth.ts (Claude-only parts)
          oauth-refresher.ts    # was: ../claude-oauth-refresher.ts
          oauth-refresher.test.ts
          limits-provider.ts    # was: ../limits/claude-limits.ts
          limits-provider.test.ts
          run-params-prep.ts    # NEW: where settingsPath injection moves to
          system-prompt.ts      # NEW: Parallel-sessions section text
        codex/
          auth-manager.ts       # was: ../codex-auth.ts
          auth-manager.test.ts
          limits-provider.ts    # was: ../limits/codex-limits.ts
          limits-provider.test.ts
          run-params-prep.ts
          system-prompt.ts
        index.ts                # builds the per-agent runtime tables consumed by app-di.ts
        types.ts                # AgentRuntime, AgentAuthManager, etc. interfaces

    shared/
      agents/
        types.ts                # AgentId, AgentEvent, AgentProcess (was: types/agent-types.ts)
        registry.ts             # AgentRegistry, AGENT_DEFS (was: agent-registry.ts)
        capabilities.ts         # AgentCapabilities + the new runtime knobs

  client/
    agents/
      claude/
        theme.css               # was: themes/claude.css
        theme-light.css
      codex/
        theme.css
        theme-light.css
      index.ts                  # per-agent client metadata (display name, icon path)
```

### What each per-agent folder owns

**Session-side (`src/server/session/agents/<id>/`)** owns everything the
container worker needs to run the CLI:

- `adapter.ts` — the `AgentProcess` implementation.
- `process.ts` — any low-level child-process helper the adapter needs
  (Claude has a PTY wrapper; Codex spawns directly so this file is absent;
  Cursor will likely need a JSONL parser helper here).
- `mcp-writer.ts` — generates/writes whatever MCP config shape this CLI
  expects (`--mcp-config` JSON file, `config.toml` mutation, etc.). Exposes
  a `writeMcpConfig(workspaceDir, servers, params)` function the worker
  calls unconditionally.
- `tool-map.ts` — the per-agent slice of the canonical tool table.

**Orchestrator-side (`src/server/orchestrator/agents/<id>/`)** owns
everything the orchestrator needs to manage the agent:

- `auth-manager.ts` — implements the shared `AgentAuthManager` interface.
- `oauth-refresher.ts` — only present if the agent has a refresh loop
  (Claude does today; Codex `docs/154` is adding one).
- `limits-provider.ts` — implements the shared `LimitsProvider` interface.
- `run-params-prep.ts` — exports a `prepareRunParams(params): AgentRunParams`
  function that the shared assembler calls. Claude's injects `settingsPath`;
  others' is a no-op.
- `system-prompt.ts` — exports any per-agent prompt sections (e.g., the
  Parallel-sessions section's wording).

**Shared (`src/server/shared/agents/`)** holds the contracts only:

- `types.ts` — `AgentId`, `AgentEvent`, `AgentProcess`, `AgentRunParams`.
- `registry.ts` — `AgentRegistry`, `AGENT_DEFS`.
- `capabilities.ts` — `AgentCapabilities` + the new
  `skillsDirName` / `skillInvocationPrefix` knobs that absorb hairs 5, 6.

### Wiring it up

A single `src/server/orchestrator/agents/index.ts` builds the per-agent
runtime tables at app-DI time:

```ts
import * as claude from "./claude/index.js";
import * as codex from "./codex/index.js";

export function buildAgentRuntime(deps: {…}): AgentRuntime {
  const authManagers = new Map<AgentId, AgentAuthManager>([
    ["claude", claude.createAuthManager(deps)],
    ["codex", codex.createAuthManager(deps)],
  ]);
  const limitsProviders = new Map<AgentId, LimitsProvider>([
    ["claude", claude.createLimitsProvider(deps)],
    ["codex", codex.createLimitsProvider(deps)],
  ]);
  const runParamsPreps = new Map<AgentId, RunParamsPrep>([
    ["claude", claude.prepareRunParams],
    ["codex", codex.prepareRunParams],
  ]);
  // … other per-agent hooks (auth-required nudge, system prompt sections, …)
  return { authManagers, limitsProviders, runParamsPreps, … };
}
```

Adding Cursor (or Gemini) becomes:

1. Create `src/server/session/agents/cursor/` with `adapter.ts` and
   `mcp-writer.ts`.
2. Create `src/server/orchestrator/agents/cursor/` with the per-agent files
   that apply (most start as no-ops).
3. Add `cursor` to `AgentId` and one entry to `AGENT_DEFS`.
4. Add three `["cursor", cursor.x(deps)]` entries to the maps in
   `buildAgentRuntime`.
5. Add `client/agents/cursor/theme.css`.

That is the "one folder to add" target.

## What this refactor explicitly does NOT change

- The session worker / orchestrator boundary.
- `AgentProcess`, `AgentEvent`, `AgentRunParams` shapes (except possibly
  removing/relocating Claude-only fields like `settingsPath`).
- The HTTP+SSE proxy contract between orchestrator and worker.
- Test layout — per-agent tests move with their source files, not
  consolidated into a separate tests/ tree.
- Per-agent themes — they stay user-facing per-agent files; the move into
  `client/agents/<id>/` is cosmetic.

## Phasing

The refactor is mostly mechanical and the scariest part is breaking imports
across the codebase. Phase it so each phase is independently mergeable and
ships a measurable win.

### Phase 0 — Capability knobs (small, low risk)

Add the easy capability flags that absorb the simplest hairs. No file
movement.

- Add `skillsDirName` and `skillInvocationPrefix` to `AgentCapabilities`.
- Replace hairs 5, 6 inline branches with capability reads.
- Promote `AUTH_ENV_KEYS` to a registry method; replace hair 1.

Outcome: three hairs gone, no file movement, easy to review.

### Phase 1 — Dispatch tables (small, low risk)

Replace per-agent if/else dispatch with registry-keyed lookups.

- Build the limits-provider `Map<AgentId, LimitsProvider>` at app-DI; replace
  hair 2.
- Add `onAuthRequired` per-agent hook table; replace hair 3.

Outcome: two more hairs gone. The "lying comment" in hair 2 becomes true.

### Phase 2 — Extract `AgentAuthManager` interface

Introduce the shared auth manager interface and retrofit Claude and Codex to
it. No file movement yet, just interface extraction.

Outcome: prepares the ground for the per-agent folder consolidation.

### Phase 3 — Per-agent run-params prep hooks

Pull `settingsPath` injection out of `session-agent-run-params.ts` into a
per-agent `prepareRunParams` hook. Move equivalent Codex-side hooks (if any)
into the same shape. Replace hair 4.

Outcome: `AgentRunParams` stops accumulating Claude-only fields at call
sites.

### Phase 4 — Per-agent MCP writers

Pull `generateMcpConfig` and `ensureCodexMcpConfig` out of
`session-worker.ts` into per-agent `mcp-writer.ts` files. The worker calls
`adapter.writeMcpConfig(...)` unconditionally. Replace hair 10.

Outcome: the largest two `agentId === X` branches in the worker disappear.

### Phase 5 — Per-agent folder consolidation

Move files. This is the most file-churn-heavy phase but introduces no
behavior changes — just relocations and import-path updates.

- Move `claude.ts` to `session/agents/claude/process.ts`.
- Move `{claude,codex}-adapter.ts` to `session/agents/<id>/adapter.ts`.
- Move `auth.ts`, `claude-oauth-refresher.ts` to
  `orchestrator/agents/claude/`.
- Move `codex-auth.ts` to `orchestrator/agents/codex/`.
- Move `orchestrator/limits/{claude,codex}-limits.ts` to
  `orchestrator/agents/<id>/limits-provider.ts`.
- Move per-agent system-prompt fragments from `agent-instructions.ts` to
  per-agent `system-prompt.ts` files.
- Move client themes into `client/agents/<id>/theme.css`.

Outcome: one folder per agent across each layer. Adding Cursor becomes
copy-the-folder.

### Phase 6 — Documentation and pattern enforcement

- Update CLAUDE.md "Project structure" listing.
- Add a `docs/N-add-an-agent.md` walkthrough showing the steps from §"Wiring
  it up" above.
- Optional: an ESLint rule that flags new `agentId === "claude"` /
  `agentId === "codex"` comparisons outside the per-agent folders.

## Risks and tradeoffs

- **Import-path churn.** Phase 5 touches every importer of the moved files.
  Mitigated by phasing the moves separately from the behavior-changing work
  in Phases 0-4, so each PR is either "code moved" or "behavior changed",
  not both.
- **Per-agent folders create asymmetry when an agent doesn't need a file.**
  Codex has no `process.ts` because it spawns its CLI directly. The
  asymmetry is intentional — present-file-means-needed is clearer than
  empty-stub files. Document the convention in the per-agent README.
- **The "AgentAuthManager" interface might fit poorly.** OAuth, device flow,
  and API-key auth genuinely have different lifecycles. If the interface
  ends up being mostly `unknown`-typed events, that's a sign to stop and
  re-evaluate rather than force a bad shape. Phase 2 can be deferred or
  dropped if it doesn't pay off.
- **Cursor lands during the refactor.** Either: (a) Cursor adopts the new
  layout from the start and the refactor lands first; (b) Cursor lands in
  the old layout and gets moved in Phase 5. (a) is cleaner; (b) is fine if
  the Cursor timeline can't wait.

## Open questions

- Are there `agentId === X` branches in the client (beyond `MessageInput`)
  that aren't already captured here? A wider grep over `src/client/` should
  be the first concrete checklist item.
- Should `AgentCapabilities` and `AgentRuntime` be one type or two? Today
  capabilities is "what does the agent support" (a static fact) and runtime
  is "how do we drive it" (live functions). Keeping them split is probably
  right; merging would muddle the static/dynamic distinction.
- Should `client/themes/<id>.css` move to `client/agents/<id>/theme.css` in
  the same refactor or be deferred? Cosmetic move with non-trivial CSS
  import-path churn — likely defer.
- For Phase 6's ESLint rule: how do we exempt the per-agent folder itself?
  Probably by path glob (`!**/agents/*/**`).

## Success criteria

- All twelve `agentId === "claude"` / `agentId === "codex"` branches listed
  in §"Inventory of hairs" are either eliminated, justified in code with a
  comment explaining why the branch is correct, or behind a capability /
  registry lookup.
- Each backend's code lives under one per-layer folder (`session/agents/<id>/`
  + `orchestrator/agents/<id>/`).
- The "add a new agent" walkthrough in Phase 6 names ≤5 files to touch
  outside the new per-agent folder (`AgentId` widening, one factory table
  entry, one DI registration block — that's about it).
- Existing tests still pass with no behavior changes attributable to this
  refactor.
