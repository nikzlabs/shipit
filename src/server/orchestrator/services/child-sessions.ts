/**
 * Agent-spawned child sessions (docs/117).
 *
 * Extracted from `session.ts` to keep the parent-session module focused on
 * reads/mutations against a single session. The child-session feature is its
 * own sub-feature: a parent session can spawn sibling sessions under it, each
 * with its own clone, branch, chat history, and runner.
 */

import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { SessionInfo, AgentId, SessionMergeWatch, SpawnTarget } from "../../shared/types.js";
import type { BillingMode } from "../../shared/catalogue/index.js";
import { selectionExists } from "../../shared/catalogue/index.js";
import {
  implementerFor,
  resolveSpawnTargetForChild,
  type ResolvedSpawnTarget,
} from "./sub-agent-target.js";
import { joinRolePrompt, ROLE_PROMPT_LIMITS } from "./roles.js";
import { applyModelRetirement } from "../model-retirement.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionContainerManager } from "../session-container.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { agentIdForModel, getAgentCapabilities, KNOWN_AGENT_IDS } from "../../shared/agent-registry.js";
import { isHarnessInstalled } from "../../shared/installed-harnesses.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { reconcileRunnerAgent } from "../reconcile-runner-agent.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import type { ClaimSessionService } from "./claim-session.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { restoreLfsAfterTreeRewrite } from "../git-lfs.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import { isResolvedForGrouping } from "../../shared/session-resolution.js";

export class ResolvedChildMessageError extends ServiceError {
  constructor(public readonly child: SessionInfo) {
    super(409, `${child.title} is resolved; no message, card, or wake turn was sent.`);
  }
}

function hasVisibleDirectChildren(sessionManager: SessionManager, sessionId: string): boolean {
  return sessionManager.findChildren(sessionId).some(
    (child) => child.archived !== true && child.userArchived !== true,
  );
}

/**
 * Read a positive-integer env var override. Returns `undefined` when the var
 * is unset or unparseable (non-integer, ≤ 0) so the caller falls back to the
 * compile-time default. Logged once on parse failure to make typos visible.
 */
function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`[child-sessions] ignoring ${name}=${raw} (must be a positive integer)`);
    return undefined;
  }
  return parsed;
}

/**
 * Default per-parent quota for active spawned child sessions.
 * Overridable via the `MAX_SPAWNED_SESSIONS_PER_PARENT` env var (positive
 * integer); the compile-time default is `16`. Read once at module init.
 */
export const DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS =
  readPositiveIntEnv("MAX_SPAWNED_SESSIONS_PER_PARENT") ?? 16;

/**
 * Default per-turn quota for newly-spawned child sessions.
 *
 * Sized at `6`: it covers the fan-out shapes that are actually legitimate — one
 * child per subsystem, per failing test area, per independent slice of a
 * migration — while staying short of the width at which an agent is usually
 * over-slicing one task. It also keeps {@link DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS}
 * (16) as the bound that binds over a session's *life* (~3 turns to reach it)
 * rather than something a single turn nearly exhausts.
 *
 * Why not higher: nothing downstream will say no. There is no global cap on
 * live containers — `createContainerForRunner` (`app-lifecycle.ts`) gates only
 * on the per-session OOM breaker — and reclaim is idle-only, since
 * `idle-enforcer.ts` skips any runner with `agentBusy` or an attached viewer
 * even under memory pressure. A spawned child is born busy, so N of them are
 * exempt from every reclaim path for as long as they work. Meanwhile each
 * container's memory ceiling is ~half of usable host RAM (deliberately not
 * `1 / expectedConcurrency`, `container-config-builder.ts`), so on a 16 GB host
 * even this cap is ~3× over-subscribed and survives only on statistical
 * multiplexing. The real fix is host-derived sizing (docs/229) or admission
 * control on the create path, not a larger constant.
 *
 * Overridable via the `MAX_SPAWNED_SESSIONS_PER_TURN` env var (positive
 * integer). Read once at module init.
 */
export const DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN =
  readPositiveIntEnv("MAX_SPAWNED_SESSIONS_PER_TURN") ?? 6;

/**
 * docs/162 — per-turn cap for Ops `--shipit-source` fix-session spawns.
 *
 * What this bounds: the container burst of a *single* Ops turn. Each fix child
 * claims the ShipIt repo, boots its own container, and opens a PR, so a turn
 * that fans out a dozen of them is a capacity spike worth smoothing.
 *
 * What this is **not**: a containment boundary against a runaway agent. There
 * is no spawn-depth limit for sessions — docs/117 dropped grandchild quotas
 * deliberately — and a child can spawn grandchildren of its own, so nested
 * spawns route around any per-turn number. The only other gate on that path is
 * {@link DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS} (16 active children per parent),
 * which is also per-parent and so is evaded the same way. (Distinct from
 * docs/144's depth-1 cap, which bounds *sub-agent* recursion — a different
 * mechanism entirely.)
 *
 * Do **not** read "the global container ceiling" as the backstop, as docs/117
 * does — verified absent at `app-lifecycle.ts:createContainerForRunner`, which
 * gates only on the per-session OOM breaker: nothing anywhere counts live
 * containers and refuses. Capacity control is reclaim-only and idle-only
 * (`idle-enforcer.ts` skips any runner with `agentBusy` or an attached viewer,
 * even under memory pressure). A spawned child is born busy, so a fleet of them
 * is exempt from every reclaim path for as long as it works. That makes this
 * cap load-bearing for simultaneity, not merely a smoother of bursts — raise it
 * with that in mind, and prefer host-derived sizing (docs/229) or real
 * admission control over a larger constant.
 *
 * Sized at `6`, raised from the original `2`: an Ops investigation is exactly
 * the workflow that legitimately finds several *independent* defects in one
 * pass, and the alternatives a low cap forces — batching unrelated fixes into
 * one muddled PR, or splitting a diagnosis across turns and losing the
 * connective tissue between findings — are worse than the burst it prevents.
 *
 * That happens to equal {@link DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN} today,
 * but the two are **not** coupled and should not be collapsed into one
 * constant: they answer different questions (generic = parallel width across
 * slices of *one* task; Ops = how many *independent* findings one investigation
 * may ship, each as its own PR) and carry separate env overrides so a
 * deployment can tune Ops without touching generic fan-out. Expect them to
 * diverge again.
 *
 * Overridable via `MAX_SHIPIT_FIX_SESSIONS_PER_TURN` (positive integer). Read
 * once at module init.
 */
export const DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN =
  readPositiveIntEnv("MAX_SHIPIT_FIX_SESSIONS_PER_TURN") ?? 6;

export interface SpawnChildSessionOptions {
  /** The required initial user prompt that the spawned session's agent runs. */
  prompt: string;
  /** Session title. Defaults to a slug derived from `prompt`. */
  title?: string;
  /**
   * Git ref to hard-reset the claimed workspace onto. **Internal only** —
   * there is no agent-facing `--base`. The sole caller that sets this is the
   * Ops `--shipit-source` spawn path, which pins the fix session to the exact
   * inspected build commit (`resolveShipitFixTarget().ref`). It is therefore a
   * system-resolved ref, never user input.
   *
   * When omitted (every generic fan-out spawn), the child stays on the claim's
   * freshly-fetched `origin/main` (or `origin/HEAD` / `origin/master`) — so a
   * just-merged parent change (e.g. a design doc) is visible to the child by
   * construction, and the child's "Changes vs main" diff doesn't inherit the
   * parent's WIP.
   */
  base?: string;
  /** Optional agent id override. Defaults to the parent's selected agent. */
  agent?: AgentId;
  /** Optional model override. Defaults to the parent's selected model. */
  model?: string;
  /**
   * docs/264 phase 3 (reqs 11, 16) — what this child runs on, in the vocabulary
   * both spawn commands share: a **role** (± overrides), a **complete target**
   * naming all five parameters, or **inheritance** from this parent.
   *
   * Supersedes {@link SpawnChildSessionOptions.agent} / `model`, which remain for
   * the callers that predate it (and are read as `{ kind: "inherit" }` overrides
   * when no `target` is given, so there is exactly one code path below rather
   * than two that must agree).
   *
   * **A role decides what the child STARTS as, not what it is bound to** (req 11).
   * It is resolved once, here, before any disk work; from then on the child is an
   * ordinary session with the ordinary routing, account-failover and
   * model-retirement behaviour. Nothing re-reads the role afterwards, and
   * `originRoleName` is a snapshot of the name rather than a live link.
   */
  target?: SpawnTarget;
  /**
   * Free-form id of the parent turn that triggered the spawn. Persisted as
   * `spawnedByTurn` so `shipit session list` can sort "this turn first"
   * without walking chat history.
   */
  spawnedByTurn?: string;
  /**
   * Per-turn cap. Default {@link DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN}.
   * Counted by matching `spawnedByTurn` on the parent's existing children.
   * Skipped when `spawnedByTurn` is undefined (no turn id ⇒ nothing to
   * count, but the per-parent cap still applies).
   */
  maxSpawnedSessionsPerTurn?: number;
  /**
   * Per-parent cap on active (non-archived) spawned children. Default
   * {@link DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS}.
   */
  maxActiveSpawnedSessions?: number;
  /**
   * docs/162 — claim the child's workspace from this repo instead of the
   * parent's `remoteUrl`. Used by the Ops "fix ShipIt itself" spawn, where the
   * parent is an Ops session with no ShipIt remote of its own. The repo must
   * already be registered + ready in the repo store (the caller ensures that).
   * Combine with `base` to pin the child to the exact inspected source commit.
   */
  repoUrlOverride?: string;
  /**
   * docs/205 — spawn a **completely separate** session instead of a child.
   * When true, NO parent linkage (`parentSessionId`) or root linkage
   * (`rootSessionId`) is written, so the new session renders as a flat,
   * top-level row (indistinguishable from a manually-created session) and is
   * uncoordinatable by construction — the shim's `list`/`view`/`wait`/
   * `message`/`notify-on-merge` all resolve through `parentSessionId`, which a
   * detached session lacks. No `session_spawned` card is emitted in the parent
   * chat either (the route gates on this). The spawning turn id is still
   * recorded so the per-turn spawn cap counts it; the per-parent active-children
   * cap does not apply (a detached session is nobody's child).
   *
   * For the case where the agent spins off genuinely unrelated work (e.g.
   * fixing an unrelated bug it noticed) and should never hear about it again.
   */
  detached?: boolean;
}

export interface SpawnChildSessionResult {
  /** The newly-created child session. */
  session: SessionInfo;
  /**
   * The harness the child was actually created on — an explicit `--agent`, the
   * one derived from a model, the one a **role** resolved to, or the parent's.
   *
   * Returned rather than read back off {@link SpawnChildSessionResult.session},
   * whose snapshot is taken BEFORE `prepareSessionAgentEnvironment` pins the
   * agent and therefore usually carries no `agentId` at all. A caller that needs
   * to say what drives this child — the spawn telemetry does — would otherwise
   * fall back to the request, and a role-started child would be filed under the
   * parent's harness while its row says the opposite. Cross-agent review found
   * that.
   */
  agentId: AgentId;
  /** Convenience field for the CLI shim's text output. */
  sessionId: string;
  /** The child's branch name (generated or user-supplied). */
  branch: string;
  /** Updated session list (for SSE broadcast on the parent's side). */
  sessions: SessionInfo[];
}

/**
 * Spawn a sibling session under `parentSessionId`. The new session shares
 * the parent's repo but gets its own clone, branch, chat history, and
 * runner — exactly like a session created from the UI. Spawn is *only* a
 * thin wrapper around the home-screen claim flow: it requires the parent
 * to have a registered, ready remote URL and delegates workspace
 * provisioning to `ClaimSessionService`. There is no local-clone fallback
 * — production sessions always come from a registered repo, and tests
 * must register one too.
 *
 * The agent never reaches this function directly; the call chain is:
 *   `shipit session create` (shim)
 *   → worker `/agent-ops/session/create`
 *   → orchestrator `POST /api/sessions/:parentId/spawn`
 *   → `spawnChildSession`.
 *
 * Quotas are enforced fail-closed (the orchestrator returns 429 / ServiceError
 * before any disk work happens). The first prompt is dispatched on the child's
 * runner via `runner.dispatch` so it kicks off the agent the moment the
 * runner is ready — matching the home-screen "send a message" behaviour
 * without needing a WS to be attached.
 */
export async function spawnChildSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  claimService: ClaimSessionService,
  parentSessionId: string,
  opts: SpawnChildSessionOptions,
  defaultAgentId: AgentId,
  credentialsDir: string | undefined,
  credentialStore: CredentialStore | undefined,
  providerAccountManager: ProviderAccountManager | undefined,
  graduationDeps: GraduateSessionDeps,
): Promise<SpawnChildSessionResult> {
  const parent = sessionManager.get(parentSessionId);
  if (!parent) throw new ServiceError(404, "Parent session not found");
  if (parent.archived) throw new ServiceError(400, "Parent session is archived");
  if (!parent.workspaceDir) {
    throw new ServiceError(400, "Parent session has no workspace");
  }

  // docs/264 phase 3 (req 16) — one vocabulary, three bases. `agent`/`model` from
  // a caller that predates the target are read as overrides over the parent, so
  // everything below has exactly one shape to handle and the shipped `--model X`
  // form is a partial call over a base rather than a special case.
  const target: SpawnTarget = opts.target ?? {
    kind: "inherit",
    overrides: {
      ...(opts.agent ? { harnessId: opts.agent } : {}),
      ...(opts.model ? { modelId: opts.model } : {}),
    },
  };

  // docs/264-agent-roles req 11 — a role (or a complete target) is resolved ONCE, here,
  // before any disk work, and hands the child a complete starting tuple. The
  // one-shot path's frozen ROUTE is deliberately not carried in
  // (`resolveSpawnTargetForChild`): a child takes turns of its own for days, and
  // a credential pinned at creation would break account failover the first time
  // that subscription hit its quota — long after anyone would connect the two.
  const seeded = ((): ResolvedSpawnTarget | undefined => {
    if (target.kind === "inherit") return undefined;
    if (!credentialStore) {
      // Roles live in the credential store, so without one there is nothing to
      // resolve a role or validate a complete target against. Said plainly rather
      // than dereferenced: a minimal runtime (a test harness) can still spawn a
      // child by inheritance, which needs none of this.
      throw new ServiceError(
        500,
        "This runtime cannot resolve a role or an explicit target (no credential store).",
      );
    }
    return resolveSpawnTargetForChild(
      target,
      implementerFor(
        parent,
        parent.agentId ?? defaultAgentId,
        runnerRegistry.get(parentSessionId)?.appliedSpawnIdentity,
      ),
      {
        credentialStore,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    );
  })();
  const overrides = target.kind === "inherit" ? target.overrides : {};

  // The TASK is checked for emptiness before anything is joined onto it. A role's
  // standing instructions are never a substitute for one: joining first would
  // make an empty prompt non-empty and spawn a child holding a standing brief and
  // no task at all.
  const task = opts.prompt?.trim();
  if (!task) {
    throw new ServiceError(400, "prompt is required");
  }
  // docs/264-agent-roles req 8 — the role's standing instructions and the spawn's own prompt
  // become the child's first message, labelled. The length check runs on the
  // JOINED string (that is what is sent) and its refusal names the ROLE, because
  // the caller cannot shorten instructions it did not write.
  const trimmedPrompt = seeded
    ? joinRolePrompt(task, seeded, ROLE_PROMPT_LIMITS.child)
    : task;
  if (trimmedPrompt.length > ROLE_PROMPT_LIMITS.child) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  // Resolve and validate the agent/model overrides BEFORE any disk work, so a
  // bad value fails fast (400 surfaced on the shim) instead of booting a
  // container that 401s or errors on its first turn. The spawning agent supplies
  // these as free text — an LLM picking an exact model id is a known source of
  // typos and cross-backend mismatches — so the registry is the source of truth.
  if (overrides.harnessId && !getAgentCapabilities(overrides.harnessId)) {
    throw new ServiceError(
      400,
      `Unknown agent '${overrides.harnessId}'. Valid agents: ${KNOWN_AGENT_IDS.join(", ")}.`,
    );
  }
  // Mirror the client's rule that the model is the source of truth and the agent
  // is derived from it (`agentIdForModel`): when `--model` names a backend-owned
  // model and `--agent` was omitted, route to that backend so `--model gpt-5.5`
  // alone lands on Codex instead of silently inheriting the parent's Claude.
  // When both are given, reject a cross-backend mismatch with an actionable
  // message. An unlisted/versioned id (`modelOwner === undefined`) is passed
  // through for forward-compat — the CLI forwards `--model` as-is, so a
  // valid-but-newer id the picker hasn't surfaced yet must not be rejected.
  //
  // planning#304 — both halves ask **"does this harness offer this model"**, not
  // "who owns it". `agentIdForModel` answers with the first harness whose list
  // contains the id, and ownership is not unique: the catalogue anticipates two
  // harnesses offering the same id (`model-switch.ts`), where the owner answer is
  // whichever sorts first. Under the owner test `--agent codex --model <shared>`
  // was refused while the reverse pair was accepted — an asymmetry with no rule
  // behind it. Membership is symmetric, and identical on today's catalogue (no id
  // is listed twice, so owner and membership agree everywhere). `modelOwner`
  // survives for the error text and as the "is this id known at all" test.
  const parentAgentId: AgentId = parent.agentId ?? defaultAgentId;
  const harnessOffersModel = (harnessId: AgentId, modelId: string): boolean =>
    (getAgentCapabilities(harnessId)?.models ?? []).includes(modelId);
  let agentOverride: AgentId | undefined = overrides.harnessId;
  if (overrides.modelId) {
    const modelOwner = agentIdForModel(overrides.modelId);
    if (modelOwner && !agentOverride) {
      // A shared id needs no switch: the parent's own harness can run it, so
      // "the model is the source of truth" is already satisfied where the child
      // is, and switching would move a harness the caller never named.
      //
      // Written as `parentAgentId` rather than left unset, because `agentOverride`
      // is not only the switch — it is also what the installed-harness gate below
      // is asked about. Leaving it unset for "no switch needed" would skip that
      // gate, so a bare `--model claude-sonnet-5` on a Codex-only deployment would
      // stop failing fast with 400 and start creating a Claude child whose first
      // turn cannot run. Same resolved harness either way; the gate keeps its
      // subject. Cross-agent review caught this.
      agentOverride = harnessOffersModel(parentAgentId, overrides.modelId) ? parentAgentId : modelOwner;
    } else if (modelOwner && agentOverride && !harnessOffersModel(agentOverride, overrides.modelId)) {
      throw new ServiceError(
        400,
        `Model '${overrides.modelId}' belongs to agent '${modelOwner}', not '${agentOverride}'. ` +
          `Pass --agent ${modelOwner}, or omit --agent to derive it from the model.`,
      );
    }
  }

  // docs/252 phase 9 (req 14) — the catalogue check above says the harness EXISTS;
  // this says this deployment INSTALLED it. Checked after the model derivation so
  // it covers both `--agent claude` and a bare `--model opus` that resolves to it,
  // and before any disk work, so a spawn onto an absent CLI fails here with a
  // reason instead of booting a container that dies on its first turn.
  if (agentOverride && !isHarnessInstalled(agentOverride)) {
    throw new ServiceError(
      400,
      `Agent '${agentOverride}' is not installed in this deployment.`,
    );
  }
  // Same gate for a seeded target. A ROLE's harness was already checked by the
  // role validator, but a **complete target** names its harness directly and
  // reaches here unexamined — so this covers it rather than letting a five-flag
  // spawn boot a container whose CLI is absent.
  if (seeded && !isHarnessInstalled(seeded.harnessId)) {
    throw new ServiceError(
      400,
      `Agent '${seeded.harnessId}' is not installed in this deployment.`,
    );
  }

  // docs/264-agent-roles req 16 — a reasoning level is now sayable on a child spawn, which it
  // was not before (`session create` parsed `--agent`/`--model` and nothing
  // else). A NAMED level is validated against the harness the child will run and
  // **refused** when that harness does not declare it — an override the caller
  // wrote is never dropped, because a dropped override runs something other than
  // what was asked for.
  //
  // Deliberately different from the INHERITED level below, which is dropped
  // rather than refused when it does not fit. The two are different things: the
  // caller chose one and merely happens to have the other, so failing a spawn
  // over a parent's setting would be hostile where failing over a stated one is
  // the point.
  const namedReasoning = overrides.reasoningEffort;
  if (namedReasoning) {
    const childHarness = agentOverride ?? parentAgentId;
    const options = getAgentCapabilities(childHarness)?.reasoning?.options ?? [];
    if (!options.some((o) => o.value === namedReasoning)) {
      const valid = options.length > 0
        ? `Valid levels: ${options.map((o) => o.value).join(", ")}.`
        : "That agent declares no reasoning levels.";
      throw new ServiceError(
        400,
        `Invalid --effort '${namedReasoning}' for agent '${childHarness}'. ${valid}`,
      );
    }
  }

  // Quota: per-parent cap on active spawned children. Fail-closed.
  // docs/205 — a detached spawn is not a child (no parent linkage), so it does
  // not count against and is not bounded by the per-parent active-children cap;
  // the per-turn cap below is its only fan-out bound.
  const existingChildren = sessionManager.findChildren(parentSessionId);
  if (!opts.detached) {
    const maxActive = opts.maxActiveSpawnedSessions ?? DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS;
    if (existingChildren.length >= maxActive) {
      throw new ServiceError(
        429,
        `This session already has ${existingChildren.length} spawned children (max ${maxActive}). Archive one before spawning another.`,
      );
    }
  }

  // Quota: per-turn cap. Skipped when no turn id is supplied. Counts BOTH
  // linked children of this parent (via findChildren) AND detached sessions
  // spawned in the same turn (docs/205 — detached sessions are parentless so
  // they never appear in findChildren; `countDetachedSpawnedInTurn` is how the
  // cap still bounds them). Applies to detached and linked spawns alike — the
  // cap exists to stop a runaway turn booting unbounded containers, and a
  // detached spawn boots one just the same.
  if (opts.spawnedByTurn) {
    const maxPerTurn = opts.maxSpawnedSessionsPerTurn ?? DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN;
    const linkedThisTurn = existingChildren.filter((c) => c.spawnedByTurn === opts.spawnedByTurn).length;
    const detachedThisTurn = sessionManager.countDetachedSpawnedInTurn(opts.spawnedByTurn);
    if (linkedThisTurn + detachedThisTurn >= maxPerTurn) {
      throw new ServiceError(
        429,
        `Per-turn spawn limit reached (${maxPerTurn}). Wait for the current turn to end before spawning more sessions.`,
      );
    }
  }

  // The child's branch is always a generated `shipit/<slug>` — the agent
  // cannot pick it (dropping `--branch` is intentional: agent-supplied names
  // drifted outside the `shipit/` namespace and broke our branch conventions).
  // A title is REQUIRED: the spawning (parent) agent already knows what the
  // session is for and is the best-placed namer, so it must name the session
  // explicitly. This also avoids spending a separate `generateSessionName`
  // agent-CLI call per spawn — AI naming earns its keep on the home-screen
  // first-message path (a human typed it, no agent in the loop), not here.
  const explicitTitle = opts.title?.trim();

  // Spawn requires the parent to be backed by a registered, ready remote.
  // We route the workspace creation through the same warm-pool-aware claim
  // path the home-screen "new session" flow uses (`claimSessionService`) so
  // the child gets a workspace branched off freshly-fetched `origin/main` —
  // identical shape to a manual new session, with no chance of inheriting
  // the parent's WIP. There is no local-only fallback: in production every
  // session is created from a registered repo, and tests must register one
  // too (use `claimGraduatedParent` / the home-screen claim endpoint).
  // docs/162 — an Ops fix spawn claims the ShipIt source repo (the override)
  // rather than the parent's own remote (an Ops session has none).
  const claimUrl = opts.repoUrlOverride ?? parent.remoteUrl;
  if (!claimUrl) {
    // docs/211 — a sandbox parent hits this by construction, not by
    // misconfiguration: a sandbox has no `remoteUrl` at all (the agent clones
    // into `/workspace/<name>` subdirs, and none of those is the session's
    // repo). The generic message below reads as "register your repo and retry",
    // which sends a sandbox agent chasing a fix that does not exist — so say
    // plainly that the capability is absent here and name what does work. The
    // sandbox system-prompt section says the same thing up front; this is the
    // authoritative backstop for an agent that tries anyway (and it covers
    // every backend, unlike the prompt's `SHIPIT_SANDBOX` sibling signal).
    if (parent.kind === "sandbox") {
      throw new ServiceError(
        400,
        "Cannot spawn a session from a sandbox session: spawning claims the parent's repo and " +
          "branches the child off it, and a sandbox has no repo bound to it. " +
          "Do the work in this session, or ask the user to start a repo-backed session from the sidebar. " +
          "In-turn subagents and `shipit agent run` need no repo and still work here.",
      );
    }
    throw new ServiceError(
      400,
      "Cannot spawn a child session: the parent has no remote URL. Spawn requires the parent's repo to be registered.",
    );
  }

  // Require a title before any disk work. The spawning agent names the session
  // (see the `explicitTitle` note above) — without one the session would be
  // unidentifiable in the sidebar, and falling back to an AI naming call would
  // both cost a model round-trip and ignore the parent's superior context.
  if (!explicitTitle) {
    throw new ServiceError(
      400,
      "A session title is required when spawning a session (pass --title). " +
        "Give it a short, human-readable name describing what the session is for.",
    );
  }
  // `forceFetch: true` bypasses the docs/145 prefetch-skip optimization so the
  // child always branches off a freshly-fetched `origin/main`. The home-screen
  // claim accepts up to ~6 minutes of bare-cache staleness for latency, but a
  // child spawned moments after a merge must see the merged commit on `main`,
  // not the pre-merge snapshot the cache happens to hold.
  // `excludeSessionIds` keeps the claim from handing back the calling parent
  // itself: an ungraduated parent is a valid reuse-path hit, and "claiming" it
  // would hard-reset the parent's live workspace and self-parent the session
  // (whose findChildren cycle then blows the recursive archive's stack).
  // `skipReuse: true` is the broader guard: a spawn is a background action and
  // must NEVER recycle an ungraduated warm session, because that pool includes
  // `/{repo}/new` drafts a user is actively typing in. Without it, the reuse
  // path (`findUngraduatedWarm`) could alias the child onto a live draft and
  // dispatch the child's first prompt into the session the user is viewing —
  // a message appearing from nowhere mid-typing. Spawns take the pre-warmed
  // pool or slow-clone instead.
  const claimed = await claimService.claim(claimUrl, {
    forceFetch: true,
    skipReuse: true,
    excludeSessionIds: [parentSessionId],
  });
  const newSessionId = claimed.sessionId;
  const newWorkspaceDir = claimed.workspaceDir;

  // The claim cut a `shipit/<random>` branch off freshly-fetched origin/HEAD.
  // That's already the shape we want for the child's branch, so we adopt it
  // verbatim instead of renaming.
  let branchName: string;
  try {
    branchName = (await safeSimpleGit(newWorkspaceDir).raw(["branch", "--show-current"])).trim();
    if (!branchName) {
      throw new Error("claim produced an empty branch name");
    }
  } catch (err) {
    throw new ServiceError(500, `Failed to read claimed branch: ${String(err)}`);
  }

  // Pin to an explicit `base` when one was supplied. The only caller that does
  // so is the Ops `--shipit-source` path (the exact inspected build commit);
  // the claim placed HEAD at `origin/HEAD`, so a hard reset is needed for the
  // pin to take effect. Safe because the claim's workspace has no user changes
  // yet. Generic fan-out spawns pass no `base` and stay on `origin/main`.
  if (opts.base) {
    try {
      await safeSimpleGit(newWorkspaceDir).raw(["reset", "--hard", opts.base]);
    } catch (err) {
      throw new ServiceError(400, `Failed to reset to base '${opts.base}': ${String(err)}`);
    }
    // nikzlabs/shipit#2349: that same re-materialization ran through a git whose LFS
    // smudge filter is disabled, so it wrote pointer text over the content the
    // claim's `git lfs pull` had just materialized at `origin/HEAD`. Restore it
    // for the pinned base before the child's first turn reads any of it.
    await restoreLfsAfterTreeRewrite(newWorkspaceDir, `Pin to ${opts.base}`, (message) =>
      console.warn(`[spawn] ${message}`),
    );
    // docs/150 §7 addendum (planning#147): the `reset --hard` ran as the root
    // orchestrator. It re-materializes the WORKTREE (not just `.git/index`/refs)
    // as root:root, so hand the whole workspace back — `.git` alone would leave
    // the reset worktree files uneditable by the non-root agent.
    handWorkspaceBackToWorker(newWorkspaceDir);
  }

  // graduate-session.ts owns the warm → active transition (docs/156).
  // Do not inline setWarm / track / setBranchRenamed / scheduleSessionNaming
  // / repoStore.touch / sseBroadcast("session_list") here.
  //
  // skipBranchRename: true because `POST /spawn`'s response body returns
  // `branch` synchronously to the CLI shim — a delayed AI branch rename
  // would make the printed value stale. A title is always supplied here
  // (required above), so `graduateSession` takes its `explicitTitle` path
  // and does NOT fire AI naming (`generateSessionName`) — no extra model
  // round-trip per spawn. The branch row keeps the claim-time
  // `shipit/<random>` value.
  // docs/201 — the child's root ancestor. If the parent is itself spawned it
  // inherits the parent's root; otherwise the parent IS the root. Computed once
  // here (one field read) so the chain is never walked at read time, and so a
  // grandchild groups under the same top-level session as its parent.
  // docs/205 — a detached spawn writes NEITHER `parentSessionId` nor
  // `rootSessionId`: null `rootSessionId` makes the sidebar render it flat
  // (top-level, like a manual session), and null `parentSessionId` makes it
  // uncoordinatable by construction. `spawnedByTurn` is still passed so
  // `graduateSession` records it (for the per-turn cap) even without a parent.
  const rootSessionId = parent.rootSessionId ?? parentSessionId;
  // docs/252 — a child inherits the parent's **selection**, not a bare model id.
  // A bare id re-resolves through the catalogue to whichever mode sorts first, so
  // a parent on a service's metered key would silently seed its child onto that
  // service's subscription — the same cross-mode move req 12 refuses on failover
  // and req 13 refuses on retirement, arriving through the spawn path instead.
  //
  // An explicit `opts.model` override is a different choice and inherits
  // nothing: the same rule the WS seed follows, since a service the caller did
  // not name must not be attached to a model it did.
  //
  // The parent's own retirement is resolved first (against the PARENT's harness,
  // because it is the parent's row being written), so a child of a session
  // pinned to a retired model starts on the successor rather than on an id the
  // catalogue cannot place — which would drop the triple and land the child
  // wherever a bare id happens to resolve.
  // Precedence: the resolved `agentOverride` (an explicit `--agent`, or the
  // agent derived from `--model` above) wins; otherwise inherit the parent's
  // pinned `agentId` so a child spawned from a Codex session stays on Codex (the
  // orchestrator's `defaultAgentId` is global and may point at a provider the
  // user hasn't authenticated). Fall back to `defaultAgentId` only when the
  // parent hasn't been pinned yet (fresh parent, no turn taken). Resolved BEFORE
  // graduation because the row written there is pinned to it, and because
  // neither the model nor the reasoning level below means anything except
  // relative to it. (`parentAgentId` itself is resolved with the validation
  // block above, which needs it to answer whether an explicit `--model` the
  // parent's harness already offers implies a switch at all.)
  //
  // docs/264-agent-roles req 11 — a SEEDED target (a role, or a complete five-parameter
  // call) skips all of this: it already holds the harness, and the block below
  // is about completing from a parent, which a seeded child does not do. The
  // completion rules stay exactly as they are for the inheriting case, which is
  // the whole of "unify the surface, not the completion semantics".
  const childAgentId: AgentId = seeded?.harnessId ?? agentOverride ?? parentAgentId;
  const inherited = ((): { model?: string; serviceId?: string; billingMode?: BillingMode } => {
    // A seeded target names the complete triple; nothing is inherited and
    // nothing is dropped.
    if (seeded) {
      return {
        model: seeded.selection.modelId,
        serviceId: seeded.selection.serviceId,
        billingMode: seeded.selection.billingMode,
      };
    }
    // A named model inherits NO service or billing mode from the parent
    // (docs/261 req 10, preserved verbatim): a model id names one backend's
    // catalogue, so a service the caller did not name must not be attached to a
    // model it did. What is new is only that the caller may now name the service
    // and mode ITSELF — `--service`/`--billing-mode` are part of the shared
    // vocabulary (req 16) — and a named half is honoured rather than dropped.
    if (overrides.modelId) {
      return {
        model: overrides.modelId,
        ...(overrides.serviceId ? { serviceId: overrides.serviceId } : {}),
        ...(overrides.billingMode ? { billingMode: overrides.billingMode } : {}),
      };
    }
    // A bare `--agent codex` from a Claude parent inherits NOTHING of the
    // selection: a model id names one backend's catalogue, so carrying the
    // parent's across a harness switch pins the child to a model its own CLI
    // cannot run — the first turn then spawns Codex with `claude-opus-5`. The
    // documented behaviour for `--agent` alone is "that backend's default
    // model" (`shipit-docs/sessions.md`), which is what an empty row means. This
    // is the same rule `opts.model` already follows one line up, arriving from
    // the other direction. Cross-backend review (Codex) found this.
    if (childAgentId !== parentAgentId) return {};
    applyModelRetirement(sessionManager, parent, parentAgentId);
    const fresh = sessionManager.get(parentSessionId) ?? parent;
    const serviceId = overrides.serviceId ?? fresh.serviceId;
    const billingMode = overrides.billingMode ?? fresh.billingMode;
    return {
      ...(fresh.model ? { model: fresh.model } : {}),
      // A named service or billing mode wins over the inherited one, on the
      // inherited model — the caller moved half the location and the rest stands.
      ...(serviceId ? { serviceId } : {}),
      ...(billingMode ? { billingMode } : {}),
    };
  })();
  // req 16 — a NAMED service or billing mode is validated against the resulting
  // triple and **refused** when the catalogue has no such row, never dropped. The
  // inherited case below keeps its own rule (drop, do not refuse) for the reason
  // stated there: the caller chose one and merely happens to have the other.
  if ((overrides.serviceId || overrides.billingMode) && !seeded) {
    const named = inherited.model && inherited.serviceId && inherited.billingMode
      ? {
          serviceId: inherited.serviceId,
          billingMode: inherited.billingMode,
          modelId: inherited.model,
        }
      : undefined;
    if (!named || !selectionExists(named)) {
      throw new ServiceError(
        400,
        `No model '${inherited.model ?? "(none)"}' is offered by `
          + `'${inherited.serviceId ?? "(no service)"}' on the `
          + `'${inherited.billingMode ?? "(no billing mode)"}' billing mode. `
          + "Name --service, --billing-mode and --model together, or omit them to inherit "
          + "the parent's selection.",
      );
    }
  }
  // planning#304 — the cross-backend guard is asked of the **resolved** pair, not
  // only of the flags the caller passed. The rejection above inspects `opts.model`
  // alone, so inheritance sat outside it entirely and could assemble a
  // `(harness, model)` combination the explicit path would have refused: that is
  // how a child ended up pinned to `codex` AND `claude-opus-5` and errored without
  // running a turn.
  //
  // The branch above closes the reported route, but it tests a PROXY for the
  // question that decides whether the child can run — parent harness vs child
  // harness, rather than "can the harness that will spawn run this model". Today
  // the two answers only diverge on a parent row that is itself incoherent, which
  // the live writers prevent (`set_model` refuses a cross-harness model on a
  // pinned session, and WS connect self-heals a legacy row), so this is an
  // invariant at the boundary rather than a fix for a reachable path. It is here
  // because that boundary is where the row is written, and because the recurrence
  // this feature already shipped came from the two checks living apart with
  // nothing tying them together.
  //
  // **Membership in the child harness's own list, not `agentIdForModel`'s single
  // "owner".** Ownership is not unique and the catalogue says so: two harnesses
  // can both offer `anthropic/claude-opus-5` (`model-switch.ts`), and
  // `agentIdForModel` answers with whichever harness sorts first — so the
  // ownership test would erase a Codex parent's valid selection the day such a
  // model lands. This is the same degradation `conformSelectionToAgent` applies to
  // a bare id: does the target harness offer it at all. The catalogue join, not
  // the credential-filtered subset — a model this install currently has no
  // credential for is turn-time routing's question, not this one.
  //
  // An id no harness lists is left alone — the same forward-compat passthrough the
  // explicit `--model` check makes, for the same reason.
  //
  // Dropped, not rejected, and the whole triple goes (a service and mode without
  // their model is not a selection). The caller passed nothing wrong, so failing
  // their spawn over a stale parent row would be hostile; an empty row means "that
  // backend's default model", resolved at turn time against what this install can
  // actually run (`firstEligibleSelectionForHarness`, planning#353). Keep the
  // harness and drop the model — the rule the WS connect path already applies to a
  // pinned session's incoherent row (`route-registry.ts`).
  //
  // A SEEDED target is exempt: this rule repairs a stale PARENT row, and a
  // seeded child has no parent row in its history. Its tuple came from the role
  // validator, which asked the sharper question (`resolveStyle` — do the harness
  // and the model share an API style) against the harness the role named, so
  // degrading it here on the coarser membership test could silently drop a
  // perfectly valid role — the substitution req 7 forbids.
  const inheritedModel = inherited.model;
  const childHarnessOffersModel =
    seeded !== undefined
    || inheritedModel === undefined
    || harnessOffersModel(childAgentId, inheritedModel)
    // No harness lists it: unproven, so unchanged.
    || agentIdForModel(inheritedModel) === undefined;
  const selection: { model?: string; serviceId?: string; billingMode?: BillingMode } =
    childHarnessOffersModel ? inherited : {};
  // docs/217 — the reasoning level is the third half of the parent's selection
  // (Control B), and it inherits for the same reason the harness and the model
  // do: a fan-out the parent set to `high` must not quietly drop to the harness
  // default, which is what an unset child row means at turn time
  // (`getSelectedReasoning` reads the row and nothing else — there is no global
  // to fall back to). Validated against the CHILD's harness, not the parent's:
  // an explicit `--agent` / `--model` can move the child to a backend whose
  // levels differ, and an unlisted value would reach the CLI as a bad flag.
  // Dropped rather than remapped when it doesn't fit — the same rule the
  // `?reasoning=` connect param and the quick-capture path already follow.
  //
  // Why this survives a harness switch when the model above does not: a level is
  // a depth the user asked for, and `high` means the same thing on either
  // backend, so it carries whenever the target harness offers it. A model id
  // names one backend's catalogue and can mean nothing at all on the other.
  //
  // docs/264-agent-roles req 16 — a NAMED `--effort` (validated far above, against the
  // child's harness) and a SEEDED role's level both win outright: they are what
  // the caller asked for, not something the child happens to have inherited.
  const inheritedReasoning = ((): string | undefined => {
    if (seeded) return seeded.reasoningEffort;
    if (namedReasoning) return namedReasoning;
    const level = parent.reasoningEffort;
    if (!level) return undefined;
    const options = getAgentCapabilities(childAgentId)?.reasoning?.options;
    return options?.some((o) => o.value === level) ? level : undefined;
  })();
  graduateSession(graduationDeps, {
    sessionId: newSessionId,
    userText: trimmedPrompt,
    agentId: childAgentId,
    skipBranchRename: true,
    ...(explicitTitle ? { explicitTitle } : {}),
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.serviceId ? { serviceId: selection.serviceId } : {}),
    ...(selection.billingMode ? { billingMode: selection.billingMode } : {}),
    ...(inheritedReasoning ? { reasoning: inheritedReasoning } : {}),
    // docs/264-agent-roles req 14 — provenance: which role started this session. Written at
    // creation and never again (see `sessions.ts`'s `setOriginRoleName`), because
    // it is a SNAPSHOT of the name and not a live link: editing that role later
    // does not change this child, deleting it does not orphan it, and the child
    // may over time run on something other than what the role named (req 11).
    ...(seeded?.roleName ? { originRoleName: seeded.roleName } : {}),
    ...(opts.detached ? {} : { parentSessionId, rootSessionId }),
    ...(opts.spawnedByTurn ? { spawnedByTurn: opts.spawnedByTurn } : {}),
  });

  // docs/272-user-selectable-roles req 5 — the role is also IN FORCE, not merely recorded, so
  // the composer of the child a user opens names it exactly as it names a role
  // the user picked themselves. The two fields differ in what happens next: this
  // one is cleared the moment anyone moves the child's harness, model or
  // reasoning (req 15), while the provenance above never changes.
  //
  // The standing instructions are NOT re-delivered on that account: docs/264
  // already joined them into the creating task, and `takeRoleStandingInstructions`
  // latches on the `originRoleName` written just above.
  if (seeded?.roleName) sessionManager.setRoleName(newSessionId, seeded.roleName);

  const child = sessionManager.get(newSessionId);
  if (!child) throw new ServiceError(500, "Failed to read back spawned child session");

  // Enqueue the first prompt. `getOrCreate` on the runner registry creates a
  // container-backed runner (in production) or a SessionRunner (in tests);
  // `runner.dispatch` then either starts the turn directly (when
  // SystemTurnDeps are wired) or enqueues for the next agent start. `childAgentId`
  // is the one resolved above graduation — the same value the child's row was
  // pinned to.
  const runner = runnerRegistry.getOrCreate(newSessionId, newWorkspaceDir, childAgentId);

  // docs/149 — bring the child to full env-prep parity with the WS path
  // BEFORE the first system turn fires. Otherwise the freshly-spawned
  // container has no agent credentials, a stale OAuth token, no MCP env
  // pushed, and no `agentPinned` flag — so the CLI reports "Not logged in"
  // (or 401 on a rotated token) on its first turn. Subsumes the previous
  // inline `provisionAgentCredentials` + `setAgentId` + `setAgentPinned`
  // block (docs/138). Idempotent; safe to call before every system turn.
  if (credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: newSessionId,
      agentId: childAgentId,
      deps: {
        credentialsDir,
        credentialStore,
        sessionManager,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    });
  } else {
    // Tests without credentialsDir / credentialStore still need the pin so
    // `runner.agentId` is meaningful when the agent factory is invoked.
    sessionManager.setAgentId(newSessionId, childAgentId);
    sessionManager.setAgentPinned(newSessionId);
  }

  runner.dispatch(prepareDispatch({
    text: trimmedPrompt,
    agentInterface: undefined,
    ...(!opts.detached ? {
      messageOrigin: {
        sessionId: parent.id,
        sessionTitle: parent.title,
        relation: "parent" as const,
      },
    } : {}),
    execution: undefined,
    activity: undefined,
    images: undefined,
    files: undefined,
    uploads: undefined,
    permissionMode: undefined,
    postTurn: undefined,
    systemTurn: undefined,
    onTurnComplete: undefined,
    deliveryId: undefined,
    dictated: undefined,
  }));

  console.log(
    `[spawn-child] Spawned session ${newSessionId} under parent ${parentSessionId}: branch=${branchName} title="${child.title}"`,
  );

  return {
    session: child,
    sessionId: child.id,
    agentId: childAgentId,
    branch: branchName,
    sessions: sessionManager.list(),
  };
}

// ---- Reads scoped by parent (docs/117) ----

/**
 * Snapshot of a single child session for `shipit session view`. Strictly a
 * read-only projection — the shim cannot mutate the child through this shape.
 */
export interface ChildSessionView {
  id: string;
  title: string;
  branch?: string;
  status: "running" | "idle" | "error";
  queueLength: number;
  parentSessionId: string;
  spawnedAt: string;
  spawnedByTurn?: string;
  prUrl?: string;
  /** Most recent assistant message text. Undefined when the child has not produced one yet. */
  latestAssistantMessage?: string;
  /**
   * Agent backend the child is pinned to (`claude`/`codex`). Surfaced so the
   * spawning agent can confirm which backend a child actually runs on rather
   * than trusting the child's (unreliable) self-report. Undefined until the
   * child's first turn pins it.
   */
  agent?: AgentId;
  /**
   * Model the child is pinned to. Undefined when the child inherited the
   * default (no explicit `--model` and no parent model pin).
   */
  model?: string;
  /**
   * docs/264-agent-roles req 14 — the role this child was started from, when one started it.
   * A snapshot of the name: it says what was asked for at creation, not what the
   * child is running now (`agent`/`model` above answer that, per turn).
   */
  originRoleName?: string;
}

/**
 * Optional projections wired into `buildChildView` to populate
 * `latestAssistantMessage` and `prUrl`. Phase 3 (docs/117) wired these in:
 * `view` now surfaces the child's most recent assistant text and PR URL when
 * either projection is available, so `shipit session view` / `wait` can give
 * the agent a useful snapshot without forcing it to crack open the child's
 * full chat history.
 */
export interface ChildViewProjections {
  /** ChatHistoryManager — used to pull the child's last assistant message text. */
  chatHistoryManager?: { loadLatestAssistantText(sessionId: string): string | undefined };
  /** PR status poller — used to surface the child's open-PR URL. */
  prStatusPoller?: { getStatus(sessionId: string): { prUrl: string } | undefined };
}

/**
 * List the children spawned under `parentSessionId`. Sorted "this turn first"
 * if `currentTurn` is provided; otherwise most-recently-used first.
 */
export function listSpawnedChildren(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  currentTurn?: string,
  projections: ChildViewProjections = {},
): ChildSessionView[] {
  const children = sessionManager.findChildren(parentSessionId);
  const views = children.map((c) => buildChildView(c, runnerRegistry, projections));
  if (currentTurn) {
    return views.sort((a, b) => {
      const aIn = a.spawnedByTurn === currentTurn ? 0 : 1;
      const bIn = b.spawnedByTurn === currentTurn ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return b.spawnedAt.localeCompare(a.spawnedAt);
    });
  }
  return views;
}

/**
 * Look up a single child session and verify it's a descendant of `parentSessionId`.
 * Throws 404 (`ServiceError`) when the id doesn't exist *or* when it isn't a
 * direct child of the supplied parent — the orchestrator never tells the shim
 * "wrong parent" because cross-tenancy leakage is the threat that motivates
 * this whole boundary in the first place.
 */
export function getSpawnedChild(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
  projections: ChildViewProjections = {},
): ChildSessionView {
  const child = assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  return buildChildView(child, runnerRegistry, projections);
}

/**
 * Verify that `childSessionId` exists and was spawned by `parentSessionId`.
 * Throws a 404 `ServiceError` in either case — the orchestrator deliberately
 * doesn't disambiguate "wrong parent" from "not found" so cross-tenancy
 * existence isn't leaked.
 *
 * Shared with the Phase 3 mutations (`sendChildMessage`, `archiveChild`,
 * `waitForChildIdle`) so they all share one cross-tenancy contract.
 */
function assertChildOfParent(
  sessionManager: SessionManager,
  parentSessionId: string,
  childSessionId: string,
): SessionInfo {
  const child = sessionManager.get(childSessionId);
  if (child?.parentSessionId !== parentSessionId) {
    throw new ServiceError(404, "Spawned session not found");
  }
  return child;
}

/**
 * Project a session row + its live runner into the read-only `ChildSessionView`
 * the shim renders. Exported so the cohort view (docs/233 `shipit session
 * whoami`) describes a peer session in exactly the same shape a parent sees for
 * its children — one projection, one set of status semantics.
 */
export function buildChildView(
  child: SessionInfo,
  runnerRegistry: SessionRunnerRegistry,
  projections: ChildViewProjections,
): ChildSessionView {
  const runner = runnerRegistry.get(child.id);
  // docs/182 — surface a distinct `error` status when the child's last completed
  // turn errored. The runner's live flag wins while it exists; the persisted
  // `SessionInfo.lastTurnErrored` is the fallback after an orchestrator restart
  // rebuilt the runner (clearing its in-memory flag). A running turn always
  // reports `running` — the error flag describes the *previous* completed turn.
  const errored = (runner?.lastTurnErrored ?? false) || child.lastTurnErrored === true;
  const view: ChildSessionView = {
    id: child.id,
    title: child.title,
    status: runner?.running ? "running" : errored ? "error" : "idle",
    queueLength: runner?.queueLength ?? 0,
    parentSessionId: child.parentSessionId ?? "",
    spawnedAt: child.createdAt,
  };
  if (child.branch) view.branch = child.branch;
  if (child.spawnedByTurn) view.spawnedByTurn = child.spawnedByTurn;
  if (child.agentId) view.agent = child.agentId;
  if (child.model) view.model = child.model;
  if (child.originRoleName) view.originRoleName = child.originRoleName;
  const latest = projections.chatHistoryManager?.loadLatestAssistantText(child.id);
  if (latest) view.latestAssistantMessage = latest;
  const pr = projections.prStatusPoller?.getStatus(child.id);
  if (pr?.prUrl) view.prUrl = pr.prUrl;
  return view;
}

// ---- Phase 3 mutations: message / wait / archive ----

/**
 * Result of `sendChildMessage`. Mirrors the home-screen "send a message" hop:
 * the orchestrator returns immediately after the runner accepts the message
 * (either as a direct turn start or by enqueuing it behind the running turn).
 */
export interface SendChildMessageResult {
  /**
   * Position in the runner's queue (1-based) when the prompt was enqueued
   * because the child was already running, OR `0` when the prompt was
   * accepted directly and the runner started a turn (or queued because no
   * SystemTurnDeps are wired in tests).
   */
  queuePosition: number;
  /** `true` when the message was enqueued behind a running turn; `false` when it started immediately. */
  enqueued: boolean;
}

/**
 * How long `sendChildMessage` waits for a freshly-booted container's worker to
 * become ready before it gives up and reports the truthful outcome. The wait
 * is a backstop only — `prepareSessionAgentEnvironment` already awaits worker
 * readiness on the credentialed path — so it's generous but finite. On timeout
 * we still dispatch (the dispatched turn's own `_startAgentViaProxy` awaits
 * readiness too), so a slow-but-eventual boot is not a false failure; the wait
 * exists so a boot *failure* (which disposes the runner) is observed before we
 * ack, not after.
 */
const CHILD_MESSAGE_WORKER_READY_TIMEOUT_MS = 30_000;

/**
 * True when `containerManager` is tracking a live (running or starting)
 * container for the session. A runner can outlive its container in the
 * registry — an idle-eviction race, a missed Docker `die` event, a daemon
 * restart, or an external `docker rm` all leave the runner pointed at a dead
 * worker URL. `getOrCreate` would then hand that stale runner straight back,
 * and `dispatch()` would fire a turn into the void. Used to detect that case
 * so the stale runner can be torn down and re-created (booting a fresh
 * container via the registry factory).
 */
function hasLiveContainer(
  containerManager: SessionContainerManager,
  sessionId: string,
): boolean {
  const sc = containerManager.get(sessionId);
  return !!sc && (sc.status === "running" || sc.status === "starting");
}

/**
 * Phase 3 — send a follow-up prompt to a child session the parent itself
 * spawned. Returns the child's queue position so the shim can surface a
 * "queued behind N turns" hint to the agent.
 *
 * Validates the parent → child linkage (cross-tenancy 404) and the prompt
 * shape (non-empty, ≤ 50,000 chars) before reaching for the runner registry,
 * so a malformed call doesn't even create a runner.
 *
 * Container resume: an agent-driven follow-up must honor the idle-enforcer's
 * "Send a message to resume" contract just like a browser viewer reopening the
 * tab does. When the child's container has been idle-reaped, two states are
 * possible: (a) the runner was disposed too (the common idle-enforcer path) —
 * `getOrCreate` then builds a fresh runner and the registry factory boots a new
 * container; or (b) the runner survives in the registry while its container is
 * gone (eviction race / missed `die` event / external `docker rm`) — here
 * `getOrCreate` returns the stale, container-less runner, so we dispose it
 * first to force a fresh boot. Either way the turn is only acked as
 * started/queued once a live worker holds it; if the container fails to boot we
 * fail loudly rather than reporting a phantom "starting turn".
 */
export async function sendChildMessage(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
  text: string,
  defaultAgentId: AgentId,
  credentialsDir: string | undefined,
  credentialStore: CredentialStore | undefined,
  providerAccountManager?: ProviderAccountManager,
  containerManager?: SessionContainerManager | null,
): Promise<SendChildMessageResult> {
  const trimmed = text?.trim();
  if (!trimmed) throw new ServiceError(400, "Message text is required");
  if (trimmed.length > 50_000) {
    throw new ServiceError(400, "Message text exceeds 50,000 characters");
  }
  const child = assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  if (isResolvedForGrouping(child, {
    hasVisibleBrood: hasVisibleDirectChildren(sessionManager, child.id),
    isRunning: runnerRegistry.get(child.id)?.running === true,
  })) {
    throw new ResolvedChildMessageError(child);
  }
  if (!child.workspaceDir) {
    throw new ServiceError(400, "Child session has no workspace");
  }
  if (child.archived) {
    throw new ServiceError(400, "Child session is archived");
  }

  // If a runner is lingering in the registry but its container has already
  // been reaped, it points at a dead worker — dispatching into it silently
  // fails (the symptom: `delivered: starting turn` with no agent reaction).
  // Tear it down so the `getOrCreate` below builds a fresh runner and the
  // registry factory boots a new container. `force` because a stale runner may
  // still believe a turn is `running` even though the worker that ran it is
  // gone. Only meaningful in container mode (a `containerManager` is wired).
  if (containerManager) {
    const stale = runnerRegistry.get(childSessionId);
    if (stale && !hasLiveContainer(containerManager, childSessionId)) {
      runnerRegistry.dispose(childSessionId, { force: true });
    }
  }

  // Resolve or create the runner. `getOrCreate` matches the spawn path:
  // creating a runner here primes the registry, and — in container mode — the
  // registry factory boots a container for a brand-new runner (so an
  // idle-reaped or never-started session is resumed, not silently dropped).
  // Prefer the child's pinned `agentId` (set by `spawnChildSession` /
  // first-turn provisioning) so a Codex child stays on Codex even if the
  // orchestrator's `defaultAgentId` points elsewhere. Only newly-created,
  // never-run children are missing `agentId`, in which case the default is the
  // right fallback.
  const runner = runnerRegistry.getOrCreate(childSessionId, child.workspaceDir, child.agentId ?? defaultAgentId);

  // ...but `getOrCreate` honours that argument only when it CONSTRUCTS a
  // runner. An existing one — seeded with the global default by container
  // rescue or the warm pool — comes back carrying that default, and everything
  // below reads `runner.agentId`. Reconcile before env-prep so a Codex child
  // does not run Claude (and get Claude's credentials provisioned to match).
  const effectiveAgentId = reconcileRunnerAgent(runner, child.agentId);

  // docs/149 — refresh per-session credentials + OAuth + MCP env before the
  // follow-up turn fires. Mirrors the spawn path; idempotent so re-running
  // it on every message is fine. Without this, a child whose OAuth token
  // has been rotated by another session since the first turn 401s here too.
  // Skipped while the agent is already running — `runner.dispatch` will
  // enqueue, and the env-prep of the next-starting turn covers it.
  const wasRunning = runner.running;
  if (!wasRunning && credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: childSessionId,
      agentId: effectiveAgentId,
      deps: {
        credentialsDir,
        credentialStore,
        sessionManager,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    });
  }
  // Truthful ack: in container mode, only report a started/queued turn once a
  // live worker actually exists to run it. For a fresh runner the registry
  // factory boots the container asynchronously and resolves `whenWorkerReady`
  // on success — or disposes the runner on boot failure. Wait (bounded) for
  // that to settle. The credentialed env-prep above already awaits readiness,
  // so on the common path this resolves immediately; the explicit wait covers
  // the no-credentials path and makes the boot-failure case observable here.
  if (runner instanceof ContainerSessionRunner) {
    await Promise.race([
      runner.whenWorkerReady(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, CHILD_MESSAGE_WORKER_READY_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
  }
  if (runner.disposed) {
    // The container failed to boot (the factory disposed the runner). Fail
    // loudly instead of returning a phantom "starting turn" the agent will
    // wait on forever.
    throw new ServiceError(503, "Could not resume the session container; the message was not delivered.");
  }

  runner.dispatch(prepareDispatch({
    text: trimmed,
    agentInterface: undefined,
    messageOrigin: {
      sessionId: parentSessionId,
      sessionTitle: sessionManager.get(parentSessionId)?.title ?? "Parent session",
      relation: "parent",
    },
    execution: undefined,
    activity: undefined,
    images: undefined,
    files: undefined,
    uploads: undefined,
    permissionMode: undefined,
    postTurn: undefined,
    systemTurn: undefined,
    onTurnComplete: undefined,
    deliveryId: undefined,
    dictated: undefined,
  }));
  return {
    queuePosition: wasRunning ? runner.queueLength : 0,
    enqueued: wasRunning,
  };
}

// ---- Notify-on-merge watch (docs/196) ----

export interface RegisterMergeWatchResult {
  childId: string;
  state: SessionMergeWatch["state"];
  /** True when an armed watch already existed (the call is idempotent). */
  alreadyArmed: boolean;
}

/**
 * docs/196 — arm an async notify-on-merge watch: when `childSessionId`'s PR
 * later merges (or closes without merging), the orchestrator enqueues a
 * self-describing system turn into the parent's message queue and surfaces a
 * merge card. Non-blocking — this just persists the watch and returns.
 *
 * Reuses the same parent→child cross-tenancy guard as the other child
 * operations (`assertChildOfParent`, 404 on wrong-parent / not-found), so only
 * the parent that spawned the child may watch it. The child's PR need not exist
 * yet — the watch arms and fires once a terminal state is observed.
 *
 * Idempotent: re-arming an already-armed (or mid-delivery) watch is a no-op that
 * reports the current state. Re-arming after a previous watch reached a terminal
 * state starts a fresh `armed` watch — useful if the child opens a new PR, and
 * the sanctioned recovery for a `delivery-failed` watch (planning#260), which
 * deliberately never resurrects itself.
 */
export function registerMergeWatch(
  sessionManager: SessionManager,
  parentSessionId: string,
  childSessionId: string,
): RegisterMergeWatchResult {
  const child = assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  if (child.archived) {
    throw new ServiceError(400, "Child session is archived");
  }
  // Symmetric with the delivery-time guard in `merge-watch.ts`
  // (`handleChildPrTerminal`): an archived parent receives nothing, so arming a
  // watch that points at it is pointless — the watch would only ever be dropped
  // on fire. Refuse at arm time so the invariant is explicit at both ends. (A
  // parent can't normally be archived while running the turn that arms this —
  // archive force-disposes its runner — so this is defense-in-depth.)
  const parent = sessionManager.get(parentSessionId);
  if (!parent || parent.archived || parent.userArchived) {
    throw new ServiceError(400, "Parent session is archived");
  }
  const existing = child.mergeWatch;
  const liveForThisParent =
    existing?.parentSessionId === parentSessionId
    && (existing?.state === "armed" || existing?.state === "merge-observed");
  if (existing && liveForThisParent) {
    return { childId: childSessionId, state: existing.state, alreadyArmed: true };
  }
  const watch: SessionMergeWatch = {
    parentSessionId,
    state: "armed",
    registeredAt: new Date().toISOString(),
  };
  sessionManager.setMergeWatch(childSessionId, watch);
  return { childId: childSessionId, state: "armed", alreadyArmed: false };
}

/**
 * Idle predicate used by both the fast-path return and the long-poll inside
 * `waitForChildIdle`. A child counts as idle when no runner exists in the
 * registry (already torn down / never started) OR when the runner reports
 * `running: false && queueLength == 0`.
 */
function isRunnerIdle(runner: SessionRunnerInterface | undefined): boolean {
  if (!runner) return true;
  return !runner.running && runner.queueLength === 0;
}

/** Server-side cap on `shipit session wait --timeout`. */
export const MAX_WAIT_FOR_CHILD_IDLE_MS = 60 * 60 * 1000; // 1 hour

/** Default `shipit session wait --timeout` when the agent omits one. */
export const DEFAULT_WAIT_FOR_CHILD_IDLE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * docs/182 — machine-readable wait outcomes. Only genuine terminal conditions
 * end a wait: the child finished (`idle`), its last turn errored (`error`), it
 * was torn down (`archived`), or — in the legacy single long-poll — the deadline
 * elapsed (`timed-out`). `pending` is the segmented-poll signal "still running,
 * poll again": the shim re-issues another segment, so transport resets cost one
 * retried segment rather than the whole wait.
 */
export type WaitOutcome = "idle" | "error" | "archived" | "pending" | "timed-out";

export interface WaitForChildIdleResult {
  outcome: WaitOutcome;
  /** Back-compat: a terminal-idle outcome (`idle` or `archived`). */
  idle: boolean;
  /** Back-compat: the legacy single long-poll hit its deadline still running. */
  timedOut: boolean;
  /** True when a bounded segment elapsed with the child still running. */
  pending: boolean;
  child: ChildSessionView;
}

export interface WaitForChildIdleOptions {
  /**
   * Overall deadline for the legacy single long-poll (no `segmentMs`). When
   * `segmentMs` is set, this still caps the segment length so a caller can't
   * ask for a segment longer than the time it's willing to wait.
   */
  timeoutMs: number;
  /**
   * docs/182 — bounded server segment. When set and the child is still running
   * after `segmentMs`, the call resolves with `outcome: "pending"` instead of
   * holding the socket open for the full `timeoutMs`. The shim owns the overall
   * deadline and re-issues segments until a terminal outcome or its `--timeout`.
   * When unset, the call behaves as the legacy single long-poll (resolves
   * `timed-out` at `timeoutMs`).
   */
  segmentMs?: number;
  projections?: ChildViewProjections;
}

/**
 * docs/182 — re-derive the child's terminal readiness from durable state plus a
 * live worker probe, rather than trusting a transient in-memory event we had to
 * be listening for. This is what makes the wait level-triggered and
 * restart-resilient: any fresh request can compute it.
 *
 * - `archived` — the session is gone or user-archived; nothing left to wait for.
 * - `error`    — the runner/session records the last completed turn errored.
 * - `idle`     — not running, no queue, last turn clean.
 * - `running`  — still working (after reconciling a possibly-stuck flag).
 *
 * The worker probe (`verifyRunningState`) is the fix for vector #5: a headless
 * child runner has no viewer, so the runner's own viewer-gated reconciler never
 * runs. Calling it here, from the readiness check, corrects a stuck
 * `running=true` (e.g. a dropped `agent_result` SSE event) within one segment —
 * for an in-process runner it's a cheap no-op that returns the live flag.
 */
async function deriveTerminalOutcome(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
): Promise<"idle" | "error" | "archived" | "running"> {
  const child = sessionManager.get(childSessionId);
  // Session vanished or reparented mid-wait — treat as torn down (nothing to
  // wait for) rather than stranding the caller.
  if (child?.parentSessionId !== parentSessionId) return "archived";
  if (child.archived || child.userArchived) return "archived";

  let runner = runnerRegistry.get(childSessionId);
  if (!isRunnerIdle(runner) && runner) {
    // Runner believes it's running — reconcile against the worker before we
    // conclude "still running". A stuck flag is reset in place by this call.
    await runner.verifyRunningState();
    runner = runnerRegistry.get(childSessionId);
  }
  if (isRunnerIdle(runner)) {
    const errored = (runner?.lastTurnErrored ?? false) || child.lastTurnErrored === true;
    return errored ? "error" : "idle";
  }
  return "running";
}

/**
 * Phase 3 (docs/117) + docs/182 — resolve a child's readiness as a re-derivable
 * function of durable state, optionally bounded to a single short segment.
 *
 * Returns a snapshot view of the child so the agent doesn't need a separate
 * `view` call after wait. The in-memory `idle`/`disposed` events stay, but only
 * as a fast-wakeup optimization — every resolution re-derives the outcome from
 * existence + `userArchived` + a live worker probe, so an orchestrator restart
 * (which loses the listener and the in-memory `running` flag) can no longer
 * strand a wait.
 *
 * Resolves (never rejects) with a `WaitForChildIdleResult` so the route returns
 * 200 and the shim decides the exit code from `outcome`.
 */
export async function waitForChildIdle(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
  opts: WaitForChildIdleOptions,
): Promise<WaitForChildIdleResult> {
  // Validate up front so a stale child id fails fast (404) without arming a timer.
  assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  const projections = opts.projections ?? {};
  const segmented = opts.segmentMs !== undefined && opts.segmentMs > 0;
  const waitMs = segmented
    ? Math.min(opts.segmentMs!, Math.max(0, opts.timeoutMs))
    : Math.min(Math.max(0, opts.timeoutMs), MAX_WAIT_FOR_CHILD_IDLE_MS);

  const buildResult = (outcome: WaitOutcome): WaitForChildIdleResult => {
    let child: ChildSessionView;
    try {
      child = getSpawnedChild(sessionManager, runnerRegistry, parentSessionId, childSessionId, projections);
    } catch {
      // The session was deleted out from under us between the readiness derive
      // and the snapshot. Surface a minimal placeholder so an `archived` outcome
      // still returns 200 rather than throwing a 404 at the route.
      child = {
        id: childSessionId,
        title: "",
        status: "idle",
        queueLength: 0,
        parentSessionId,
        spawnedAt: "",
      };
    }
    return {
      outcome,
      idle: outcome === "idle" || outcome === "archived",
      timedOut: outcome === "timed-out",
      pending: outcome === "pending",
      child,
    };
  };

  const derive = (): Promise<"idle" | "error" | "archived" | "running"> =>
    deriveTerminalOutcome(sessionManager, runnerRegistry, parentSessionId, childSessionId);

  // Fast path: re-derive immediately. Covers already-idle / already-errored /
  // already-torn-down children without arming a timer.
  const initial = await derive();
  if (initial !== "running") return buildResult(initial);

  const runner = runnerRegistry.get(childSessionId);
  return new Promise<WaitForChildIdleResult>((resolve) => {
    let settled = false;
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runner?.off("idle", onIdle);
      runner?.off("disposed", onDisposed);
      resolve(buildResult(outcome));
    };
    const reDerive = (): void => {
      if (settled) return;
      void (async () => {
        const o = await derive();
        if (o !== "running") finish(o);
      })();
    };
    // The runner's `idle` event is a fast-wakeup hint only — re-derive to get
    // the authoritative outcome (idle vs error vs archived).
    const onIdle = (): void => reDerive();
    const onDisposed = (): void => finish("archived");
    const timer = setTimeout(() => {
      // Segment (or legacy deadline) elapsed. Re-derive once more so a missed
      // `idle` event during this segment is still caught before we report
      // "still running".
      void (async () => {
        const o = await derive();
        if (o !== "running") {
          finish(o);
          return;
        }
        finish(segmented ? "pending" : "timed-out");
      })();
    }, waitMs);

    // Attach AFTER scheduling the timer so a race where the runner emits idle
    // synchronously inside the attach is still observed.
    runner?.on("idle", onIdle);
    runner?.on("disposed", onDisposed);
  });
}

/**
 * Phase 3 — pre-archive validation. Confirms the child belongs to the
 * caller's parent AND is not currently running, then returns the resolved
 * child + runner-presence flag so the route can pass them to the existing
 * `archiveSession` service.
 *
 * Why not call `archiveSession` directly here? Because that lives in
 * `session.ts`, and `session.ts` re-exports the child-sessions service —
 * importing back from there would form a module cycle. Splitting the work
 * (validation here, archive at the route) keeps the import graph tidy and
 * lets `archiveSession`'s container/volume cleanup hooks stay in one place.
 */
export function assertArchivableChild(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
): SessionInfo {
  const child = assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  if (child.archived) {
    throw new ServiceError(400, "Child session is already archived");
  }
  const runner = runnerRegistry.get(childSessionId);
  if (runner?.running) {
    throw new ServiceError(
      409,
      "Cannot archive a running child session. Wait for it to finish (try `shipit session wait`) or interrupt it from the UI.",
    );
  }
  return child;
}
