/**
 * Agent run-params assembly (docs/149).
 *
 * Turns "we want to run this prompt on this session" into the full
 * `AgentRunParams` payload the CLI adapter expects: system prompt, settings
 * path, model, MCP servers, autoCreatePr gate, permission mode. Lives
 * outside any turn-execution module so the user path
 * (`runAgentWithMessage`) and the system-turn path (`runDispatchedTurn`) build
 * the same shape — without this, agent-spawned sessions used to run with no
 * system prompt, no settings (so neither the branch-block PreToolUse hook
 * nor the Stop-hook PR enforcement applied), no MCP, and no model.
 */

import type { AgentId, AgentRunParams, PermissionMode } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import { buildAgentSystemInstructions } from "./agent-instructions.js";
import {
  getPrepareRunParams,
  type PrepareRunParamsFn,
} from "./agent-run-params-prep.js";
import { serviceRoutingForSelection } from "./service-routing.js";

export interface BuildAgentRunParamsDeps {
  credentialStore: CredentialStore;
  /** Only `.authenticated` is read — keeps tests' stub manager compatible. */
  githubAuthManager: { authenticated: boolean };
  sessionManager: SessionManager;
  /**
   * Returns the user-configured system prompt suffix (Settings > Instructions).
   * Plumbed in from the WS handler context on the user path and from a
   * settings reader on the system-turn path.
   */
  readSystemPrompt: () => Promise<string | undefined>;
  /**
   * Returns the model alias/id selected for this turn. WS path reads the
   * per-connection selection; the system-turn path uses the session's
   * persisted model (set at spawn time).
   */
  getSelectedModel: () => string | undefined;
  /**
   * docs/217 — reasoning effort for this turn (Control B). WS path reads the
   * per-connection selection; the system-turn path uses the session's persisted
   * value. Undefined ⇒ pass no flag. Optional so older callers/tests omit it.
   */
  getSelectedReasoning?: () => string | undefined;
  /**
   * Per-agent run-params prep hooks (docs/155 Phase 3). Each backend's hook
   * injects its own backend-specific fields — Claude's adds `settingsPath`
   * and `autoCreatePr`; others are identity today. Optional so test setups
   * without the map fall back to the identity hook. See
   * `agent-run-params-prep.ts`.
   */
  runParamsPreps?: Map<AgentId, PrepareRunParamsFn>;
}

export interface BuildAgentRunParamsArgs {
  deps: BuildAgentRunParamsDeps;
  sessionId: string;
  agentId: AgentId;
  prompt: string;
  /** For `--resume` — undefined kicks off a fresh agent session. */
  agentSessionId?: string;
  /** Container path the agent runs in (workspace dir). */
  sessionDir: string;
  permissionMode?: PermissionMode;
  /**
   * docs/178 — this spawn is a context-compaction request (`/compact` with no
   * resident live process to call `compact()` on). Forwarded to the adapter so
   * Codex issues `thread/compact/start` instead of a normal turn; Claude's
   * `/compact` rides the prompt so it ignores the flag.
   */
  compact?: boolean;
}

/**
 * Assemble the agent run params. Mirrors the inline assembly in
 * `runAgentWithMessage`, minus the prompt-text composition (file/image
 * context, slash-command ordering) — that stays in the WS handler because
 * it depends on `validatedFiles` / `images` which only exist on the user
 * path.
 */
export async function buildAgentRunParams(
  args: BuildAgentRunParamsArgs,
): Promise<AgentRunParams> {
  const {
    deps,
    sessionId,
    agentId,
    prompt,
    sessionDir,
    permissionMode,
    compact,
  } = args;
  let agentSessionId = args.agentSessionId;

  // Consume the conversation replay SYNCHRONOUSLY before any await — it's a
  // session-mutating DB transaction (clears the replay column). If the
  // session's database closes between an earlier `await` (e.g. the
  // `readSystemPrompt` fs read below) and this call, better-sqlite3 throws
  // `The database connection is not open`. The fix is order: every DB read
  // the function needs lives ahead of the first `await`, so the params
  // build either runs to completion or never starts. See docs/149.
  const agentInstructionsEnabled = deps.credentialStore.getAgentSystemInstructionsEnabled();
  const mcpServers = Object.values(deps.credentialStore.getAllMcpServers()).filter(
    (s) => s.enabled,
  );
  const replay = deps.sessionManager.consumeConversationReplay(sessionId);
  // docs/128 / docs/211 — read the server-authoritative session kind
  // synchronously, in the pre-`await` DB block (same ordering rule as the reads
  // above), so the ops overlay in the system prompt can't be lost to a mid-build
  // DB close.
  const sessionInfo = deps.sessionManager.get(sessionId);
  // docs/252 phase 4 — **the model and the shaping come from ONE source.**
  // `getSelectedModel` is per-CONNECTION on the user path, while the service,
  // billing mode and credential below are read from the session row. With two
  // viewers on one session, a switch in tab A leaves tab B's closure holding the
  // previous model — so a turn sent from B spawned model X against service Y's
  // endpoint and credential, and the resident process was then stamped with Y's
  // identity (`turn-executor.ts`) even though it was spawned with X, so a later
  // switch back to X reused it. The row is the authoritative answer to "what
  // will this session run next" and is what every other reader already uses;
  // the connection's value survives only as the fallback for a session that has
  // no row model yet. Cross-backend review found this.
  const selectedModel = sessionInfo?.model ?? deps.getSelectedModel();
  // docs/217 — the reasoning level follows the model's rule, and for the same
  // reason. `getSelectedReasoning` is per-CONNECTION on the user path, resolved
  // once at connect for the session the socket was opened on — but a
  // `send_message` carrying an explicit `sessionId` retargets that socket
  // (`send-message.ts`) without recomputing it, so the turn ran at the OTHER
  // session's depth. The row is authoritative: WS connect persists the level it
  // resolved (`route-registry.ts`), and every non-WS path (child spawn, Fix CI,
  // `/agent/dispatch`) reads the row already. The connection value survives only
  // as the fallback for a session whose row carries none. Cross-backend review
  // (Codex) found this.
  const reasoningEffort = sessionInfo?.reasoningEffort ?? deps.getSelectedReasoning?.();
  // docs/252 phase 3 — where this turn's model lives, and what authenticates it.
  // Read here with the other synchronous DB reads (the pre-`await` ordering rule
  // above). The credential route is already pinned: env prep runs before this
  // (`turn-executor.ts`), which is what makes an account-delivered credential
  // detectable and therefore leaves today's first-party spawn untouched.
  const serviceRouting = sessionInfo
    ? serviceRoutingForSelection(
        agentId,
        sessionInfo.serviceId && sessionInfo.billingMode && sessionInfo.model
          ? {
              serviceId: sessionInfo.serviceId,
              billingMode: sessionInfo.billingMode,
              modelId: sessionInfo.model,
            }
          : undefined,
        sessionInfo.providerRouteKind && sessionInfo.providerRouteId
          ? { kind: sessionInfo.providerRouteKind, id: sessionInfo.providerRouteId }
          : undefined,
      )
    : undefined;
  const sessionKind = sessionInfo?.kind;
  const isOps = sessionKind === "ops";
  const isSandbox = sessionKind === "sandbox";
  // planning#267 — a recorded `mergedHeadSha` means the PR merged and ShipIt anchored
  // the branch's pre-merge tip: the exact state `shipit branch reset-to-base`
  // guards, and the only one where a hand-rolled `git reset --hard` can silently
  // destroy unmerged work. Arms the PreToolUse hook's destructive-git rule for
  // this turn only; the field is cleared by `clearMerged` and by a successful
  // reset, so the guard disarms itself. Read here with the other synchronous DB
  // reads (see the pre-`await` ordering rule above). Sandbox sessions never carry
  // one, and the hook self-gates off for them regardless (docs/211).
  const guardDestructiveGit = Boolean(sessionInfo?.mergedHeadSha);
  // docs/211 — a sandbox has no bound repo / session branch, so the Stop-hook PR
  // enforcement must never fire even when the user opted into auto-PR. The agent
  // opens PRs itself per-clone with `gh`.
  const autoCreatePr = !isSandbox
    && deps.credentialStore.getAutoCreatePr()
    && deps.githubAuthManager.authenticated;

  const userSystemPrompt = await deps.readSystemPrompt();

  const agentInstructions = agentInstructionsEnabled
    ? buildAgentSystemInstructions({ agentId, isOps, isSandbox })
    : undefined;
  let systemPrompt: string | undefined =
    [agentInstructions, userSystemPrompt].filter(Boolean).join("\n\n") || undefined;

  // A pending replay means the CLI-side conversation is either absent or must
  // not be continued, so this turn starts a fresh one seeded with ShipIt's own
  // persisted transcript. Dropping the resume id is half the mechanism, not a
  // detail: `--resume` against a cleared/missing conversation is the docs/153
  // "no conversation found" loop, and against a *live* one it would restore
  // exactly the turns the replay was built to exclude.
  //
  // (This comment used to attribute the replay to a session graduating from a
  // warm slot. No warm-pool path writes `sessions.conversation_replay` — a warm
  // session has no conversation to replay.) The writers, all of which pair the
  // arm with `clearAgentSessionId`:
  //   - rewind chat / both / code — `ws-handlers/rollback-handlers.ts:197`,
  //     `:308`, `:340`, `:373`. Chat and both replay the TRUNCATED history;
  //     code replays the full one because only the tree moved.
  //   - fork — `rollback-handlers.ts:264`. The child session id has no CLI
  //     transcript of its own, so the parent's is replayed into it.
  //   - rewind-snapshot restore — `rollback-handlers.ts:415`, `:441`.
  //   - unresumable-conversation recovery — `session-agent-env.ts:869`
  //     (`armConversationReplay`), when the docs/153 leak repair finds no
  //     resumable jsonl on disk.
  //
  // Not on the list, deliberately: a provider-account failover keeps
  // `agentSessionId` and resumes normally, because the resume files are local
  // and carry no account identity (`services/provider-account-switch.ts`).
  if (replay) {
    agentSessionId = undefined;
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${replay}` : replay;
  }

  // docs/155 Phase 3 — `settingsPath` and `autoCreatePr` used to be injected
  // here behind an `agentId === "claude"` branch. Both are documented on
  // `AgentRunParams` as Claude-only; non-Claude adapters ignored them. The
  // shared shape now stays agent-agnostic — the per-agent prep hook below
  // decides which backend-specific fields to add.
  const baseParams: AgentRunParams = {
    prompt,
    cwd: sessionDir,
    ...(agentSessionId !== undefined ? { sessionId: agentSessionId } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(selectedModel !== undefined ? { model: selectedModel } : {}),
    ...(serviceRouting !== undefined ? { serviceRouting } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(compact ? { compact: true } : {}),
  };
  const prepare = getPrepareRunParams(deps.runParamsPreps, agentId);
  return prepare(baseParams, {
    autoCreatePrActive: autoCreatePr,
    sandboxActive: isSandbox,
    guardDestructiveGitActive: guardDestructiveGit,
  });
}
