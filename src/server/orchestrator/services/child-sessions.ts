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

export const DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS =
  readPositiveIntEnv("MAX_SPAWNED_SESSIONS_PER_PARENT") ?? 16;

// Per-turn caps limit bursts, not recursive spawning or total host capacity.
export const DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN =
  readPositiveIntEnv("MAX_SPAWNED_SESSIONS_PER_TURN") ?? 6;

export const DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN =
  readPositiveIntEnv("MAX_SHIPIT_FIX_SESSIONS_PER_TURN") ?? 6;

export interface SpawnChildSessionOptions {
  prompt: string;
  title?: string;
  /** Internal inspected-build ref for Ops fixes; never an agent-supplied base. */
  base?: string;
  agent?: AgentId;
  model?: string;
  target?: SpawnTarget;
  spawnedByTurn?: string;
  maxSpawnedSessionsPerTurn?: number;
  maxActiveSpawnedSessions?: number;
  repoUrlOverride?: string;
  /** No parent/root linkage; the originating turn still counts toward the spawn cap. */
  detached?: boolean;
}

export interface SpawnChildSessionResult {
  session: SessionInfo;
  /** The returned session snapshot predates environment preparation's agent pin. */
  agentId: AgentId;
  sessionId: string;
  branch: string;
  sessions: SessionInfo[];
}

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

  const target: SpawnTarget = opts.target ?? {
    kind: "inherit",
    overrides: {
      ...(opts.agent ? { harnessId: opts.agent } : {}),
      ...(opts.model ? { modelId: opts.model } : {}),
    },
  };

  // Resolve starting parameters once, without freezing an account route across future turns.
  const seeded = ((): ResolvedSpawnTarget | undefined => {
    if (target.kind === "inherit") return undefined;
    if (!credentialStore) {
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

  // Inherit the current role's brief, not its original parameters or a role the parent has left.
  const inheritedRole = ((): { roleName: string; rolePrompt?: string } | undefined => {
    if (target.kind !== "inherit" || target.noRole) return undefined;
    if (!parent.roleName) return undefined;
    const role = credentialStore?.getRole(parent.roleName);
    if (!role) return undefined;
    const prompt = role.prompt?.trim();
    return { roleName: parent.roleName, ...(prompt ? { rolePrompt: prompt } : {}) };
  })();

  const roleForChild = seeded ?? inheritedRole;

  // Check the task before joining: standing instructions alone must not make an empty task valid.
  const task = opts.prompt?.trim();
  if (!task) {
    throw new ServiceError(400, "prompt is required");
  }
  const trimmedPrompt = roleForChild
    ? joinRolePrompt(task, roleForChild, ROLE_PROMPT_LIMITS.child)
    : task;
  if (trimmedPrompt.length > ROLE_PROMPT_LIMITS.child) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  if (overrides.harnessId && !getAgentCapabilities(overrides.harnessId)) {
    throw new ServiceError(
      400,
      `Unknown agent '${overrides.harnessId}'. Valid agents: ${KNOWN_AGENT_IDS.join(", ")}.`,
    );
  }
  // Membership matters: more than one harness can offer the same model.
  const parentAgentId: AgentId = parent.agentId ?? defaultAgentId;
  const harnessOffersModel = (harnessId: AgentId, modelId: string): boolean =>
    (getAgentCapabilities(harnessId)?.models ?? []).includes(modelId);
  let agentOverride: AgentId | undefined = overrides.harnessId;
  if (overrides.modelId) {
    const modelOwner = agentIdForModel(overrides.modelId);
    if (modelOwner && !agentOverride) {
      // Set even when unchanged so the installed-harness check still runs.
      agentOverride = harnessOffersModel(parentAgentId, overrides.modelId) ? parentAgentId : modelOwner;
    } else if (modelOwner && agentOverride && !harnessOffersModel(agentOverride, overrides.modelId)) {
      throw new ServiceError(
        400,
        `Model '${overrides.modelId}' belongs to agent '${modelOwner}', not '${agentOverride}'. ` +
          `Pass --agent ${modelOwner}, or omit --agent to derive it from the model.`,
      );
    }
  }

  if (agentOverride && !isHarnessInstalled(agentOverride)) {
    throw new ServiceError(
      400,
      `Agent '${agentOverride}' is not installed in this deployment.`,
    );
  }
  if (seeded && !isHarnessInstalled(seeded.harnessId)) {
    throw new ServiceError(
      400,
      `Agent '${seeded.harnessId}' is not installed in this deployment.`,
    );
  }

  // Invalid explicit effort is an error; incompatible inherited effort is dropped below.
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

  // Detached sessions have no parent link, but must not bypass the per-turn cap.
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

  const explicitTitle = opts.title?.trim();
  const claimUrl = opts.repoUrlOverride ?? parent.remoteUrl;
  if (!claimUrl) {
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

  if (!explicitTitle) {
    throw new ServiceError(
      400,
      "A session title is required when spawning a session (pass --title). " +
        "Give it a short, human-readable name describing what the session is for.",
    );
  }
  // Fetch recent merges; exclude the parent and any draft the user is still composing.
  const claimed = await claimService.claim(claimUrl, {
    forceFetch: true,
    skipReuse: true,
    excludeSessionIds: [parentSessionId],
  });
  const newSessionId = claimed.sessionId;
  const newWorkspaceDir = claimed.workspaceDir;

  let branchName: string;
  try {
    branchName = (await safeSimpleGit(newWorkspaceDir).raw(["branch", "--show-current"])).trim();
    if (!branchName) {
      throw new Error("claim produced an empty branch name");
    }
  } catch (err) {
    throw new ServiceError(500, `Failed to read claimed branch: ${String(err)}`);
  }

  if (opts.base) {
    try {
      await safeSimpleGit(newWorkspaceDir).raw(["reset", "--hard", opts.base]);
    } catch (err) {
      throw new ServiceError(400, `Failed to reset to base '${opts.base}': ${String(err)}`);
    }
    // Reset runs with smudge disabled; restore LFS content for the pinned commit.
    await restoreLfsAfterTreeRewrite(newWorkspaceDir, `Pin to ${opts.base}`, (message) =>
      console.warn(`[spawn] ${message}`),
    );
    handWorkspaceBackToWorker(newWorkspaceDir);
  }

  const rootSessionId = parent.rootSessionId ?? parentSessionId;
  const childAgentId: AgentId = seeded?.harnessId ?? agentOverride ?? parentAgentId;
  const inherited = ((): { model?: string; serviceId?: string; billingMode?: BillingMode } => {
    if (seeded) {
      return {
        model: seeded.selection.modelId,
        serviceId: seeded.selection.serviceId,
        billingMode: seeded.selection.billingMode,
      };
    }
    // A named model must not acquire an unrequested service or billing mode from the parent.
    if (overrides.modelId) {
      return {
        model: overrides.modelId,
        ...(overrides.serviceId ? { serviceId: overrides.serviceId } : {}),
        ...(overrides.billingMode ? { billingMode: overrides.billingMode } : {}),
      };
    }
    if (childAgentId !== parentAgentId) return {};
    // Resolve retirement before copying the full selection, preserving its service and billing mode.
    applyModelRetirement(sessionManager, parent, parentAgentId);
    const fresh = sessionManager.get(parentSessionId) ?? parent;
    const serviceId = overrides.serviceId ?? fresh.serviceId;
    const billingMode = overrides.billingMode ?? fresh.billingMode;
    return {
      ...(fresh.model ? { model: fresh.model } : {}),
      ...(serviceId ? { serviceId } : {}),
      ...(billingMode ? { billingMode } : {}),
    };
  })();
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
  // Drop an incompatible inherited triple. Seeded targets are already validated; unknown IDs pass through.
  const inheritedModel = inherited.model;
  const childHarnessOffersModel =
    seeded !== undefined
    || inheritedModel === undefined
    || harnessOffersModel(childAgentId, inheritedModel)
    || agentIdForModel(inheritedModel) === undefined;
  const selection: { model?: string; serviceId?: string; billingMode?: BillingMode } =
    childHarnessOffersModel ? inherited : {};
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
    ...(roleForChild?.roleName ? { originRoleName: roleForChild.roleName } : {}),
    ...(opts.detached ? {} : { parentSessionId, rootSessionId }),
    ...(opts.spawnedByTurn ? { spawnedByTurn: opts.spawnedByTurn } : {}),
  });

  // The live role can later clear; originRoleName remains the creation record.
  if (roleForChild?.roleName) sessionManager.setRoleName(newSessionId, roleForChild.roleName);

  const child = sessionManager.get(newSessionId);
  if (!child) throw new ServiceError(500, "Failed to read back spawned child session");

  const runner = runnerRegistry.getOrCreate(newSessionId, newWorkspaceDir, childAgentId);
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
    resetMergedBranch: undefined,
    compactContext: undefined,
    silent: undefined,
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
  latestAssistantMessage?: string;
  agent?: AgentId;
  model?: string;
  originRoleName?: string;
}

export interface ChildViewProjections {
  chatHistoryManager?: { loadLatestAssistantText(sessionId: string): string | undefined };
  prStatusPoller?: { getStatus(sessionId: string): { prUrl: string } | undefined };
}

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

// Use the same 404 for missing and foreign children to avoid disclosing their existence.
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

export function buildChildView(
  child: SessionInfo,
  runnerRegistry: SessionRunnerRegistry,
  projections: ChildViewProjections,
): ChildSessionView {
  const runner = runnerRegistry.get(child.id);
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

export interface SendChildMessageResult {
  /** One-based when queued behind a running turn; otherwise zero. */
  queuePosition: number;
  enqueued: boolean;
}

// Observe boot failure before acknowledging; timeout still permits dispatch to await readiness itself.
const CHILD_MESSAGE_WORKER_READY_TIMEOUT_MS = 30_000;

function hasLiveContainer(
  containerManager: SessionContainerManager,
  sessionId: string,
): boolean {
  const sc = containerManager.get(sessionId);
  return !!sc && (sc.status === "running" || sc.status === "starting");
}

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

  // A runner can survive its container. Dispose it so getOrCreate starts a fresh worker.
  if (containerManager) {
    const stale = runnerRegistry.get(childSessionId);
    if (stale && !hasLiveContainer(containerManager, childSessionId)) {
      runnerRegistry.dispose(childSessionId, { force: true });
    }
  }

  const runner = runnerRegistry.getOrCreate(childSessionId, child.workspaceDir, child.agentId ?? defaultAgentId);
  // getOrCreate ignores the agent argument for an existing runner; reconcile before provisioning.
  const effectiveAgentId = reconcileRunnerAgent(runner, child.agentId);

  // A queued turn refreshes its own environment when it starts.
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
    resetMergedBranch: undefined,
    compactContext: undefined,
    silent: undefined,
  }));
  return {
    queuePosition: wasRunning ? runner.queueLength : 0,
    enqueued: wasRunning,
  };
}

export interface RegisterMergeWatchResult {
  childId: string;
  state: SessionMergeWatch["state"];
  alreadyArmed: boolean;
}

// Terminal watches can be explicitly re-armed, including a failed delivery.
export function registerMergeWatch(
  sessionManager: SessionManager,
  parentSessionId: string,
  childSessionId: string,
): RegisterMergeWatchResult {
  const child = assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  if (child.archived) {
    throw new ServiceError(400, "Child session is archived");
  }
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

function isRunnerIdle(runner: SessionRunnerInterface | undefined): boolean {
  if (!runner) return true;
  return !runner.running && runner.queueLength === 0;
}

export const MAX_WAIT_FOR_CHILD_IDLE_MS = 60 * 60 * 1000;
export const DEFAULT_WAIT_FOR_CHILD_IDLE_MS = 5 * 60 * 1000;

export type WaitOutcome = "idle" | "error" | "archived" | "pending" | "timed-out";

export interface WaitForChildIdleResult {
  outcome: WaitOutcome;
  idle: boolean;
  timedOut: boolean;
  pending: boolean;
  child: ChildSessionView;
}

export interface WaitForChildIdleOptions {
  timeoutMs: number;
  /** Return pending after this segment; the caller owns the overall retry deadline. */
  segmentMs?: number;
  projections?: ChildViewProjections;
}

async function deriveTerminalOutcome(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
): Promise<"idle" | "error" | "archived" | "running"> {
  const child = sessionManager.get(childSessionId);
  if (child?.parentSessionId !== parentSessionId) return "archived";
  if (child.archived || child.userArchived) return "archived";

  let runner = runnerRegistry.get(childSessionId);
  if (!isRunnerIdle(runner) && runner) {
    // Probe even without a viewer, so a missed worker event cannot leave the running flag stuck.
    await runner.verifyRunningState();
    runner = runnerRegistry.get(childSessionId);
  }
  if (isRunnerIdle(runner)) {
    const errored = (runner?.lastTurnErrored ?? false) || child.lastTurnErrored === true;
    return errored ? "error" : "idle";
  }
  return "running";
}

export async function waitForChildIdle(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
  opts: WaitForChildIdleOptions,
): Promise<WaitForChildIdleResult> {
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
      // Deletion between readiness and snapshot must still allow a terminal result.
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
    const onIdle = (): void => reDerive();
    const onDisposed = (): void => finish("archived");
    const timer = setTimeout(() => {
      // Recheck at the deadline in case the idle event was missed.
      void (async () => {
        const o = await derive();
        if (o !== "running") {
          finish(o);
          return;
        }
        finish(segmented ? "pending" : "timed-out");
      })();
    }, waitMs);

    // Create the timer before attaching: a synchronous event must be able to clear it.
    runner?.on("idle", onIdle);
    runner?.on("disposed", onDisposed);
  });
}

// The route performs archiveSession to avoid a cycle through session.ts's re-exports.
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
