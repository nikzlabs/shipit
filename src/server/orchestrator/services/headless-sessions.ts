import path from "node:path";
import {
  catalogueModelLabels,
  selectionHonoursEffort,
  type BillingMode,
} from "../../shared/catalogue/index.js";
import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import type { TurnHandle } from "../turn-settlement.js";
import type {
  SessionInfo,
  AgentId,
  UploadRef,
  IssueRef,
  SessionStartParams,
  SessionStartTarget,
} from "../../shared/types.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionManager } from "../sessions.js";
import type { CredentialStore } from "../credential-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { SessionContainerManager } from "../session-container.js";
import type { SessionOomCircuitBreaker } from "../oom-circuit-breaker.js";
import type { SessionLoopDetector } from "../loop-detector.js";
import { reconcileSessionEgress } from "./reconcile-session-egress.js";
import {
  agentIdForModel,
  getAgentCapabilities,
  getAgentDisplayName,
  KNOWN_AGENT_IDS,
} from "../../shared/agent-registry.js";
import { isHarnessInstalled } from "../../shared/installed-harnesses.js";
import { generateBranchPrefix, generateBranchSlug } from "../git-utils.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { applySessionSelection, graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import { saveUploadedFile, MAX_UPLOAD_FILES_PER_REQUEST } from "./files.js";
import type { ClaimSessionService } from "./claim-session.js";
import { createSandboxSession } from "./templates.js";
import {
  applyStartParams,
  checkSshHosts,
  firstDispatchParams,
  hasStartParams,
  startSelection,
  type StartParamDeps,
  type StartSelection,
} from "./session-start-params.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { prepareDispatch, type PreparedDispatch } from "../prepared-dispatch.js";
import { resolveUserRole } from "./session-role.js";
import { buildIssueSeedPrompt } from "../../shared/issue-ref.js";

export interface HeadlessUploadInput {
  filename: string;
  data: Buffer;
}

/** Use only the pointer: branch names must not publish private issue titles. */
export function issueBranchBase(identifier: string): string {
  return identifier
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

export function isIssueSeededBranch(branch: string, identifier: string): boolean {
  const base = issueBranchBase(identifier);
  return base !== "" && (branch === base || branch.startsWith(`${base}-`));
}

export function seedFromIssueRef(issueRef: IssueRef): {
  prompt: string;
  branch: string;
  title: string;
} {
  const identifier = issueRef.identifier.trim();
  const titleText = issueRef.title.trim();

  const base = issueBranchBase(identifier);
  // Separate sessions on one issue must not share a remote branch or inherit its PR.
  const branch = base ? `${base}-${generateBranchSlug()}` : generateBranchPrefix();

  return {
    prompt: buildIssueSeedPrompt({ identifier, title: titleText }),
    branch,
    title: `${identifier}: ${titleText}`,
  };
}

export interface HeadlessSessionDeps extends StartParamDeps {
  runnerRegistry: SessionRunnerRegistry;
  claimService: ClaimSessionService;
  /** Creates a session with no repository, for the sandbox target. */
  createSessionDir?: (title: string) => Promise<{ appSessionId: string; sessionDir: string; workspaceDir: string }>;
  defaultAgentId: AgentId;
  credentialsDir: string | undefined;
  providerAccountManager: ProviderAccountManager | undefined;
  graduationDeps: GraduateSessionDeps;
}

/** What the headless start needs from the app; the route and the scheduler build it the same way. */
export interface HeadlessDepsSource {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  claimService: ClaimSessionService;
  createSessionDir: NonNullable<HeadlessSessionDeps["createSessionDir"]>;
  defaultAgentId: AgentId;
  credentialsDir?: string | undefined;
  credentialStore: CredentialStore;
  providerAccountManager?: ProviderAccountManager | undefined;
  graduationDeps: GraduateSessionDeps;
  githubAuthManager: GitHubAuthManager;
  prStatusPoller?: PrStatusPoller | undefined;
  egressAllowlistStore?: EgressAllowlistStore | undefined;
  containerManager?: SessionContainerManager | null | undefined;
  oomBreaker?: SessionOomCircuitBreaker | undefined;
  loopDetector?: SessionLoopDetector | undefined;
  sseBroadcast: (event: string, data: unknown) => void;
}

export function headlessSessionDeps(src: HeadlessDepsSource): HeadlessSessionDeps {
  const containerManager = src.containerManager ?? null;
  const { egressAllowlistStore, oomBreaker, loopDetector } = src;
  return {
    sessionManager: src.sessionManager,
    runnerRegistry: src.runnerRegistry,
    claimService: src.claimService,
    createSessionDir: src.createSessionDir,
    defaultAgentId: src.defaultAgentId,
    credentialsDir: src.credentialsDir,
    credentialStore: src.credentialStore,
    providerAccountManager: src.providerAccountManager,
    graduationDeps: src.graduationDeps,
    autoMergeDeps: {
      githubAuthManager: src.githubAuthManager,
      prStatusPoller: src.prStatusPoller,
    },
    ...(egressAllowlistStore
      ? {
          egressDeps: {
            store: egressAllowlistStore,
            reconcile: (sid: string, reconcileOpts?: { agentSeed?: AgentId }) => reconcileSessionEgress(
              {
                containerManager,
                egressAllowlistStore,
                ...(oomBreaker ? { oomBreaker } : {}),
                recovery: {
                  sessionManager: src.sessionManager,
                  containerManager,
                  runnerRegistry: src.runnerRegistry,
                  defaultAgentId: src.defaultAgentId,
                  ...(oomBreaker ? { oomBreaker } : {}),
                  ...(loopDetector ? { loopDetector } : {}),
                  sseBroadcast: src.sseBroadcast,
                },
              },
              sid,
              reconcileOpts ?? {},
            ),
          },
        }
      : {}),
    ...(containerManager ? { reloadEgress: containerManager.reloadEgress.bind(containerManager) } : {}),
  };
}

export interface CreateHeadlessSessionOptions {
  target: SessionStartTarget;
  params: SessionStartParams;
  prompt?: string;
  issueRef?: IssueRef;
  /** Turns automatic naming off. */
  title?: string;
  uploads?: HeadlessUploadInput[];
  dictated?: boolean;
  /** The first dispatch's delivery id, which the runner's delivery tracking keeps across a restart. */
  deliveryId?: string;
  /** Fetch the base before the clone, as a child session does. Best effort: a failed fetch is logged. */
  fetchBase?: boolean;
  /**
   * docs/324-scheduled-sessions — the schedule run this session is. Stamped as soon as the
   * session exists, so a start that fails later still leaves a session linked to its run.
   */
  scheduleRun?: { scheduleId: string; runId: string; timeZone: string };
  /** Runs once the run's session is linked, before its container starts; a throw fails the start. */
  onRunLinked?: (sessionId: string) => void;
  /** Runs the first dispatch; a throw cancels it, and the session stays without a turn. */
  dispatchGate?: (sessionId: string, dispatch: () => TurnHandle) => Promise<TurnHandle>;
}

export interface CreateHeadlessSessionResult {
  session: SessionInfo;
  sessionId: string;
  /** Absent for a sandbox, which has no branch of its own. */
  branch?: string;
  sessions: SessionInfo[];
  /** The first turn. A dispatch that fails during setup settles it `errored` rather than throwing. */
  turn: TurnHandle;
}

interface ResolvedSelection {
  agentId: AgentId;
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
  reasoning?: string;
  roleName?: string;
}

function resolveSelection(requested: StartSelection, deps: HeadlessSessionDeps): ResolvedSelection {
  const { credentialStore, defaultAgentId } = deps;
  let selection = requested;
  // A role replaces all five model parameters; stale composer values must not override it.
  const userRole = selection.role && credentialStore
    ? resolveUserRole(selection.role, { credentialStore })
    : undefined;
  if (userRole) {
    selection = {
      agent: userRole.params.harnessId,
      model: userRole.params.modelId,
      serviceId: userRole.params.serviceId,
      billingMode: userRole.params.billingMode,
      reasoning: userRole.params.reasoningEffort,
    };
  }

  const explicitAgent = selection.agent;
  const explicitCapabilities = explicitAgent ? getAgentCapabilities(explicitAgent) : undefined;
  if (explicitAgent && !explicitCapabilities) {
    throw new ServiceError(
      400,
      `Unknown agent '${explicitAgent}'. Valid agents: ${KNOWN_AGENT_IDS.join(", ")}.`,
    );
  }
  const explicitAgentRunsModel = Boolean(
    explicitCapabilities && selection.model && explicitCapabilities.models.includes(selection.model),
  );

  // Check membership, not one "owner": several harnesses can run the same model.
  // Unknown model IDs pass through for forward compatibility.
  const modelOwner = agentIdForModel(selection.model);
  if (explicitAgent && explicitCapabilities && selection.model && !explicitAgentRunsModel && modelOwner) {
    const harnessName = getAgentDisplayName(explicitAgent);
    const label = catalogueModelLabels()[selection.model] ?? selection.model;
    throw new ServiceError(
      400,
      `${harnessName} cannot run ${label} — they share no API style. `
        + `Choose a model ${harnessName} can run, or run ${label} on `
        + `${getAgentDisplayName(modelOwner)}.`,
    );
  }

  const requestedAgentId: AgentId =
    explicitAgent && explicitAgentRunsModel
      ? explicitAgent
      : (modelOwner ?? selection.agent ?? defaultAgentId);

  // A stale picker may name a known harness this deployment has not installed.
  const agentId = isHarnessInstalled(requestedAgentId) ? requestedAgentId : defaultAgentId;
  if (agentId !== requestedAgentId) {
    console.warn(
      `[headless] requested agent '${requestedAgentId}' is not installed in this deployment; using '${agentId}'`,
    );
  }

  // Model-specific effort limits can be narrower than the harness vocabulary.
  const reasoningSelection = selection.model && selection.serviceId && selection.billingMode
    ? { serviceId: selection.serviceId, billingMode: selection.billingMode, modelId: selection.model }
    : undefined;
  const reasoning =
    selection.reasoning && selectionHonoursEffort(agentId, reasoningSelection, selection.reasoning)
      ? selection.reasoning
      : undefined;

  return {
    agentId,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.serviceId ? { serviceId: selection.serviceId } : {}),
    ...(selection.billingMode ? { billingMode: selection.billingMode } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(userRole ? { roleName: userRole.role.name } : {}),
  };
}

// Long enough for a cold container start; the first turn waits for the same container anyway.
const CONTAINER_READY_TIMEOUT_MS = 120_000;

async function waitForContainer(runner: SessionRunnerInterface): Promise<void> {
  if (!(runner instanceof ContainerSessionRunner)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    (async () => {
      await runner.whenWorkerReady();
      return true;
    })(),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CONTAINER_READY_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  // Disposal resolves whenWorkerReady too.
  if (!ready || runner.disposed) {
    throw new ServiceError(503, "This session's container did not start, so its settings could not be applied.");
  }
}

/** Starts a session with a prompt and no viewer attached: Quick Capture, and later scheduled runs. */
export async function createHeadlessSession(
  deps: HeadlessSessionDeps,
  opts: CreateHeadlessSessionOptions,
): Promise<CreateHeadlessSessionResult> {
  const { sessionManager, runnerRegistry, graduationDeps } = deps;
  const { target } = opts;
  if (target.kind === "repo" && !target.repoUrl.trim()) throw new ServiceError(400, "Add a repo first.");

  const seed = opts.issueRef ? seedFromIssueRef(opts.issueRef) : undefined;
  const trimmedPrompt = (opts.prompt?.trim() || seed?.prompt)?.trim() ?? "";
  if (!trimmedPrompt && (opts.uploads ?? []).length === 0) {
    throw new ServiceError(400, "prompt is required");
  }
  if (trimmedPrompt.length > 50_000) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  const uploadInputs = opts.uploads ?? [];
  if (uploadInputs.length > MAX_UPLOAD_FILES_PER_REQUEST) {
    throw new ServiceError(400, `Maximum ${MAX_UPLOAD_FILES_PER_REQUEST} files per upload`);
  }

  const explicitBranch = target.kind === "repo" ? seed?.branch : undefined;
  const explicitTitle = opts.title?.trim() || seed?.title;

  // Resolve and check every parameter before creating anything.
  const selection = resolveSelection(startSelection(opts.params), deps);
  checkSshHosts(opts.params.sshHosts, deps);
  const { agentId } = selection;

  const linkScheduleRun = (sessionId: string): void => {
    if (!opts.scheduleRun) return;
    const { scheduleId, runId, timeZone } = opts.scheduleRun;
    sessionManager.setScheduleRun(sessionId, scheduleId, runId, timeZone);
    if (explicitTitle) sessionManager.rename(sessionId, explicitTitle);
    opts.onRunLinked?.(sessionId);
  };

  let newSessionId: string;
  let newWorkspaceDir: string;
  let branchName: string | undefined;
  if (target.kind === "repo") {
    const repoUrl = target.repoUrl.trim();
    branchName = explicitBranch || generateBranchPrefix();
    // Never claim a draft the user is composing in another view.
    const claimed = await deps.claimService.claim(repoUrl, {
      skipReuse: true,
      // A warm standby container started without the run's notes mount.
      ...(opts.scheduleRun ? { skipWarm: true } : {}),
      ...(opts.fetchBase ? { forceFetch: true } : {}),
    });
    newSessionId = claimed.sessionId;
    newWorkspaceDir = claimed.workspaceDir;
    linkScheduleRun(newSessionId);

    try {
      const currentBranch = (await safeSimpleGit(newWorkspaceDir).raw(["branch", "--show-current"])).trim();
      if (currentBranch && currentBranch !== branchName) {
        await safeSimpleGit(newWorkspaceDir).raw(["branch", "-m", currentBranch, branchName]);
      }
    } catch (err) {
      throw new ServiceError(400, `Failed to rename branch to '${branchName}': ${String(err)}`);
    }

    sessionManager.setBranch(newSessionId, branchName);
  } else {
    if (!deps.createSessionDir) {
      throw new ServiceError(500, "This start path cannot create a sandbox session");
    }
    // Sandboxes never graduate, so the title is set here and never replaced by automatic naming.
    const created = await createSandboxSession(
      sessionManager,
      deps.createSessionDir,
      target.capabilities,
      explicitTitle,
    );
    newSessionId = created.session.id;
    newWorkspaceDir = created.sessionDir;
    linkScheduleRun(newSessionId);
    applySessionSelection(sessionManager, newSessionId, agentId, selection);
  }

  // The first dispatch reads standing instructions from this role row.
  if (selection.roleName) sessionManager.setRoleName(newSessionId, selection.roleName);

  const paramCtx = { sessionId: newSessionId, agentId, deps };
  // Before getOrCreate, which starts the container: its network topology is fixed at start.
  await applyStartParams("session", opts.params, paramCtx);

  const runner = runnerRegistry.getOrCreate(newSessionId, newWorkspaceDir, agentId);
  const { credentialsDir, credentialStore, providerAccountManager } = deps;
  if (credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: newSessionId,
      agentId,
      deps: {
        credentialsDir,
        credentialStore,
        sessionManager,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    });
  } else {
    sessionManager.setAgentId(newSessionId, agentId);
    sessionManager.setAgentPinned(newSessionId);
  }

  if (hasStartParams(opts.params, "ready")) {
    await waitForContainer(runner);
    await applyStartParams("ready", opts.params, paramCtx);
  }

  const uploadRefs: UploadRef[] = [];
  if (uploadInputs.length > 0) {
    const uploadsDir = path.join(path.dirname(newWorkspaceDir), "uploads");
    for (const input of uploadInputs) {
      const saved = await saveUploadedFile(uploadsDir, input.filename, input.data);
      uploadRefs.push({ path: saved.path, type: "upload" });
    }
  }

  const dispatch = (): TurnHandle => runner.dispatch(firstDispatch({
    text: trimmedPrompt,
    params: opts.params,
    uploads: uploadRefs,
    deliveryId: opts.deliveryId,
    dictated: opts.dictated,
  }));
  const turn = opts.dispatchGate ? await opts.dispatchGate(newSessionId, dispatch) : dispatch();

  if (target.kind === "repo") {
    const { model, serviceId, billingMode, reasoning } = selection;
    graduateSession(graduationDeps, {
      sessionId: newSessionId,
      userText: trimmedPrompt,
      agentId,
      ...(explicitTitle ? { explicitTitle } : {}),
      ...(explicitBranch ? { explicitBranch } : {}),
      ...(model ? { model } : {}),
      ...(serviceId ? { serviceId } : {}),
      ...(billingMode ? { billingMode } : {}),
      ...(reasoning ? { reasoning } : {}),
    });
  } else {
    graduationDeps.sseBroadcast("session_list", { sessions: sessionManager.list() });
  }

  await applyStartParams("started", opts.params, paramCtx);

  const session = sessionManager.get(newSessionId);
  if (!session) throw new ServiceError(500, "Failed to read back headless session");

  console.log(`[headless-session] Started ${newSessionId}: branch=${branchName ?? "(sandbox)"} title="${session.title}"`);

  return {
    session,
    sessionId: session.id,
    ...(branchName ? { branch: branchName } : {}),
    sessions: sessionManager.list(),
    turn,
  };
}

/** The session's own task, so it is not `automatic`: no docs/322 hold applies to it. */
function firstDispatch(opts: {
  text: string;
  params: SessionStartParams;
  uploads?: UploadRef[];
  deliveryId: string | undefined;
  dictated?: boolean | undefined;
}): PreparedDispatch {
  return prepareDispatch({
    text: opts.text,
    agentInterface: undefined,
    uploads: opts.uploads && opts.uploads.length > 0 ? opts.uploads : undefined,
    execution: undefined,
    activity: undefined,
    images: undefined,
    files: undefined,
    permissionMode: firstDispatchParams(opts.params).permissionMode,
    postTurn: undefined,
    systemTurn: undefined,
    automatic: undefined,
    heldId: undefined,
    onTurnComplete: undefined,
    deliveryId: opts.deliveryId,
    dictated: opts.dictated,
    resetMergedBranch: undefined,
    compactContext: undefined,
    silent: undefined,
  });
}

export interface RedispatchOptions {
  params: SessionStartParams;
  prompt: string;
  deliveryId?: string;
  dispatchGate?: CreateHeadlessSessionOptions["dispatchGate"];
}

/**
 * Sends a started session's first prompt again, when a restart came between its dispatch
 * and its delivery (docs/324-scheduled-sessions → recovery). Every parameter applied
 * before the dispatch is already stored on the session; only the `started` ones remain.
 */
export async function redispatchHeadlessPrompt(
  deps: HeadlessSessionDeps,
  sessionId: string,
  opts: RedispatchOptions,
): Promise<TurnHandle> {
  const { sessionManager, runnerRegistry, credentialsDir, credentialStore, providerAccountManager } = deps;
  const session = sessionManager.get(sessionId);
  if (!session?.workspaceDir) throw new ServiceError(404, "The run's session no longer exists.");
  const agentId = session.agentId ?? deps.defaultAgentId;
  const runner = runnerRegistry.getOrCreate(sessionId, session.workspaceDir, agentId);
  if (credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId,
      agentId,
      deps: {
        credentialsDir,
        credentialStore,
        sessionManager,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    });
  }
  const dispatch = (): TurnHandle => runner.dispatch(firstDispatch({
    text: opts.prompt.trim(),
    params: opts.params,
    deliveryId: opts.deliveryId,
  }));
  const turn = opts.dispatchGate ? await opts.dispatchGate(sessionId, dispatch) : dispatch();
  await applyStartParams("started", opts.params, { sessionId, agentId, deps });
  return turn;
}
