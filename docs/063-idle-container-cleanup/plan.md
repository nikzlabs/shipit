---
status: done
---

# 063: Idle Container Cleanup (`maxIdleContainers`)

## Problem

Resource management is misaligned with actual costs:

| Mechanism | What it manages | Cost per unit | Effective? |
|-----------|----------------|---------------|------------|
| Runner idle timer (10 min) | In-memory runners | ~KB | No — disposes the cheap thing, leaves the expensive container running |
| `maxConcurrentRunners` (1000) | In-memory runners | ~KB | No — same mismatch |
| Nothing | Docker containers | 512 MB + 0.5 CPU | **Unmanaged** |

With dozens of parallel agents, idle containers accumulate. A user who runs 20 agents across sessions and walks away leaves 20 Docker containers consuming ~10 GB RAM.

## Design

Replace both runner-level mechanisms with a single container-level setting:

**`maxIdleContainers`** (default 5, configurable in Settings UI)

An **idle container** is one where:
- Its runner has `viewerCount === 0` AND `!running`, OR
- It has no runner at all (e.g., post-restart orphan rediscovered by `containerManager.rediscover()`)

When the idle count exceeds the limit, the oldest idle containers are stopped via `containerManager.destroy()` and their runners disposed. The session data (worktree, git history, chat) is preserved — only the Docker container is removed. If the user revisits, a new container is created on demand (lazy creation from feature 059).

### What gets removed

- **Runner idle timer** — `_idleTimer`, `_idleTimeoutMs`, `resetIdleTimer()` in both `SessionRunner` and `ContainerSessionRunner`. The "idle" event emission in `onAgentFinished()` is kept (it becomes the trigger for enforcement).
- **`maxConcurrentRunners`** — field, constructor opt, and eviction logic in `SessionRunnerRegistry`. Runners are cheap; let them accumulate freely.
- **`defaultIdleTimeoutMs`** — no longer passed to runners.

### Enforcement

```
enforceIdleContainerLimit():
  maxIdle = credentialStore.getMaxIdleContainers()   // default 5
  idleContainers = []

  for (sessionId, container) in containerManager.containers:
    runner = runnerRegistry.get(sessionId)
    if !runner OR (runner.viewerCount === 0 AND !runner.running):
      idleContainers.push(sessionId)

  if idleContainers.length > maxIdle:
    // Map preserves insertion order → oldest containers first
    excess = idleContainers.slice(0, idleContainers.length - maxIdle)
    for sessionId in excess:
      containerManager.destroy(sessionId)    // stops Docker container
      runnerRegistry.dispose(sessionId)      // cleans up runner if exists
```

**Trigger points** (two transitions make a container idle):

1. **Viewer disconnects** — WS close handler calls `runner.detachViewer()`, then `enforceIdleContainerLimit()`.
2. **Agent finishes** — Runner emits "idle" event. Registry forwards via `onRunnerIdle` callback → `enforceIdleContainerLimit()`.

### User experience

- Idle containers within the limit: instant reconnect (container already running).
- Idle containers beyond the limit: stopped. Revisiting takes ~3-5s (container cold boot via lazy creation).
- Changing the setting in the UI takes effect on the next idle transition (no retroactive enforcement needed — though we could add it).

## Settings integration

### Storage

Add to `CredentialStore` (already persists JSON to disk, survives resets):

```typescript
// credential-store.ts
interface CredentialData {
  agentEnv?: Record<string, string>;
  githubToken?: string;
  utilityModel?: UtilityModelConfig;
  maxIdleContainers?: number;             // NEW
}

getMaxIdleContainers(): number {
  return this.data.maxIdleContainers ?? 5;
}

setMaxIdleContainers(n: number): void {
  this.data.maxIdleContainers = n;
  this.save();
}
```

### API

Extend existing `PUT /api/settings` endpoint (already handles `gitIdentity` and `systemPrompt`):

```typescript
// api-routes.ts — PUT /api/settings
const { gitIdentity, systemPrompt, maxIdleContainers } = request.body;
if (maxIdleContainers !== undefined) {
  validate: integer, >= 0
  credentialStore.setMaxIdleContainers(maxIdleContainers);
}
```

Add `maxIdleContainers` to `GlobalSettings` type so it flows through bootstrap:

```typescript
// services/types.ts
interface GlobalSettings {
  gitIdentity: { name: string; email: string };
  systemPrompt: string;
  agents: AgentInfo[];
  defaultAgentId: AgentId;
  maxIdleContainers: number;              // NEW
}
```

### UI

Settings → Advanced tab, above "Reset Container":

- Label: **Max Idle Containers**
- Description: "Maximum Docker containers kept running when not in use. Containers beyond this limit are stopped. Set to 0 to stop all idle containers immediately."
- Number input (min 0) with save button
- Pre-populated from `settings.maxIdleContainers` via bootstrap

## Files to modify

| File | Change |
|------|--------|
| `src/server/orchestrator/session-runner.ts` | Remove idle timer from SessionRunner; remove maxConcurrentRunners + idleTimeoutMs + eviction from registry; add `onRunnerIdle` callback |
| `src/server/orchestrator/container-session-runner.ts` | Remove idle timer |
| `src/server/orchestrator/credential-store.ts` | Add `maxIdleContainers` get/set |
| `src/server/orchestrator/services/types.ts` | Add to `GlobalSettings` |
| `src/server/orchestrator/services/settings.ts` | Include in `getGlobalSettings` / `saveGlobalSettings` |
| `src/server/orchestrator/api-routes.ts` | Handle `maxIdleContainers` in `PUT /api/settings` |
| `src/server/orchestrator/index.ts` | Add `enforceIdleContainerLimit()`; wire to `onRunnerIdle` + WS close |
| `src/client/components/Settings.tsx` | Add number input in Advanced tab |
| `docs/architecture/sessions.md` | Rewrite idle timer / eviction / constants sections |
| `src/server/orchestrator/session-runner.test.ts` | Remove idle timer + eviction tests; add `onRunnerIdle` test |

## Verification

1. `npm test` + `npm run typecheck` — all pass
2. Manual: open 8 sessions, switch away from all → 3 oldest containers stopped (8 - 5 = 3)
3. Manual: change to 2 in Settings → more containers stopped on next idle transition
4. Manual: revisit a stopped session → new container created on demand (~3-5s)
5. Manual: server restart → `rediscover()` finds containers, enforcement runs on first idle transition
