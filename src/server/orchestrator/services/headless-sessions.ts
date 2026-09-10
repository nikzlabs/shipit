import path from "node:path";
import {
  catalogueModelLabels,
  selectionHonoursEffort,
  type BillingMode,
} from "../../shared/catalogue/index.js";
import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo, AgentId, UploadRef, IssueRef } from "../../shared/types.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { toggleAutoMerge } from "./github.js";
import {
  agentIdForModel,
  getAgentCapabilities,
  getAgentDisplayName,
  KNOWN_AGENT_IDS,
} from "../../shared/agent-registry.js";
import { isHarnessInstalled } from "../../shared/installed-harnesses.js";
import { generateBranchPrefix, generateBranchSlug } from "../git-utils.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import { saveUploadedFile, MAX_UPLOAD_FILES_PER_REQUEST } from "./files.js";
import type { ClaimSessionService } from "./claim-session.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { ReconcileEgressOutcome } from "./reconcile-session-egress.js";
import { prepareDispatch } from "../prepared-dispatch.js";
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

export interface CreateHeadlessSessionOptions {
  repoUrl: string;
  prompt?: string;
  issueRef?: IssueRef;
  title?: string;
  agent?: AgentId;
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
  reasoning?: string;
  /** Replaces all five model parameters; stale composer values must not override a role. */
  role?: string;
  uploads?: HeadlessUploadInput[];
  armAutoMerge?: boolean;
  dictated?: boolean;
  /** True: contained; false: open; null or absent: inherit workspace setting. */
  networkMode?: boolean | null;
}

export interface CreateHeadlessSessionResult {
  session: SessionInfo;
  sessionId: string;
  branch: string;
  sessions: SessionInfo[];
}

export async function createHeadlessSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  claimService: ClaimSessionService,
  opts: CreateHeadlessSessionOptions,
  defaultAgentId: AgentId,
  credentialsDir: string | undefined,
  credentialStore: CredentialStore | undefined,
  providerAccountManager: ProviderAccountManager | undefined,
  graduationDeps: GraduateSessionDeps,
  autoMergeDeps?: {
    githubAuthManager: GitHubAuthManager;
    prStatusPoller: PrStatusPoller | undefined;
  },
  egressDeps?: {
    store: EgressAllowlistStore;
    reconcile: (
      sessionId: string,
      opts?: { agentSeed?: AgentId },
    ) => Promise<ReconcileEgressOutcome>;
  },
): Promise<CreateHeadlessSessionResult> {
  const repoUrl = opts.repoUrl?.trim();
  if (!repoUrl) throw new ServiceError(400, "Add a repo first.");

  const seed = opts.issueRef ? seedFromIssueRef(opts.issueRef) : undefined;
  const trimmedPrompt = (opts.prompt?.trim() || seed?.prompt)?.trim() ?? "";
  if (!trimmedPrompt && (opts.uploads ?? []).length === 0) {
    throw new ServiceError(400, "prompt is required");
  }
  if (trimmedPrompt.length > 50_000) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  const explicitBranch = seed?.branch;
  const explicitTitle = opts.title?.trim() || seed?.title;
  const branchName = explicitBranch || generateBranchPrefix();

  // Resolve and validate the role before claiming a workspace.
  const userRole = opts.role && credentialStore
    ? resolveUserRole(opts.role, { credentialStore })
    : undefined;
  if (userRole) {
    opts = {
      ...opts,
      agent: userRole.params.harnessId,
      model: userRole.params.modelId,
      serviceId: userRole.params.serviceId,
      billingMode: userRole.params.billingMode,
      reasoning: userRole.params.reasoningEffort,
    };
  }

  const explicitAgent = opts.agent;
  const explicitCapabilities = explicitAgent ? getAgentCapabilities(explicitAgent) : undefined;
  if (explicitAgent && !explicitCapabilities) {
    throw new ServiceError(
      400,
      `Unknown agent '${explicitAgent}'. Valid agents: ${KNOWN_AGENT_IDS.join(", ")}.`,
    );
  }
  const explicitAgentRunsModel = Boolean(
    explicitCapabilities && opts.model && explicitCapabilities.models.includes(opts.model),
  );

  // Check membership, not one "owner": several harnesses can run the same model.
  // Unknown model IDs pass through for forward compatibility.
  const modelOwner = agentIdForModel(opts.model);
  if (explicitAgent && explicitCapabilities && opts.model && !explicitAgentRunsModel && modelOwner) {
    const harnessName = getAgentDisplayName(explicitAgent);
    const label = catalogueModelLabels()[opts.model] ?? opts.model;
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
      : (modelOwner ?? opts.agent ?? defaultAgentId);

  // A stale picker may name a known harness this deployment has not installed.
  const agentId = isHarnessInstalled(requestedAgentId) ? requestedAgentId : defaultAgentId;
  if (agentId !== requestedAgentId) {
    console.warn(
      `[headless] requested agent '${requestedAgentId}' is not installed in this deployment; using '${agentId}'`,
    );
  }

  // Model-specific effort limits can be narrower than the harness vocabulary.
  const reasoningSelection = opts.model && opts.serviceId && opts.billingMode
    ? { serviceId: opts.serviceId, billingMode: opts.billingMode, modelId: opts.model }
    : undefined;
  const reasoning =
    opts.reasoning && selectionHonoursEffort(agentId, reasoningSelection, opts.reasoning)
      ? opts.reasoning
      : undefined;

  // Never claim a draft the user is composing in another view.
  const claimed = await claimService.claim(repoUrl, { skipReuse: true });
  const newSessionId = claimed.sessionId;
  const newWorkspaceDir = claimed.workspaceDir;

  try {
    const currentBranch = (await safeSimpleGit(newWorkspaceDir).raw(["branch", "--show-current"])).trim();
    if (currentBranch && currentBranch !== branchName) {
      await safeSimpleGit(newWorkspaceDir).raw(["branch", "-m", currentBranch, branchName]);
    }
  } catch (err) {
    throw new ServiceError(400, `Failed to rename branch to '${branchName}': ${String(err)}`);
  }

  sessionManager.setBranch(newSessionId, branchName);

  // The first dispatch reads standing instructions from this role row.
  if (userRole) sessionManager.setRoleName(newSessionId, userRole.role.name);

  // Rebuild before getOrCreate; seed the selected agent because it is not persisted yet.
  if (egressDeps && opts.networkMode !== undefined && opts.networkMode !== null) {
    egressDeps.store.setSessionOverride(newSessionId, opts.networkMode);
    const outcome = await egressDeps.reconcile(newSessionId, { agentSeed: agentId });
    if (outcome.action === "aborted") {
      throw new ServiceError(503, outcome.message);
    }
  }

  const runner = runnerRegistry.getOrCreate(newSessionId, newWorkspaceDir, agentId);
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

  const uploadInputs = opts.uploads ?? [];
  if (uploadInputs.length > MAX_UPLOAD_FILES_PER_REQUEST) {
    throw new ServiceError(400, `Maximum ${MAX_UPLOAD_FILES_PER_REQUEST} files per upload`);
  }
  const uploadRefs: UploadRef[] = [];
  if (uploadInputs.length > 0) {
    const uploadsDir = path.join(path.dirname(newWorkspaceDir), "uploads");
    for (const input of uploadInputs) {
      const saved = await saveUploadedFile(uploadsDir, input.filename, input.data);
      uploadRefs.push({ path: saved.path, type: "upload" });
    }
  }

  runner.dispatch(prepareDispatch({
    text: trimmedPrompt,
    agentInterface: undefined,
    uploads: uploadRefs.length > 0 ? uploadRefs : undefined,
    execution: undefined,
    activity: undefined,
    images: undefined,
    files: undefined,
    permissionMode: undefined,
    postTurn: undefined,
    systemTurn: undefined,
    onTurnComplete: undefined,
    deliveryId: undefined,
    dictated: opts.dictated,
    resetMergedBranch: undefined,
    compactContext: undefined,
    silent: undefined,
  }));

  graduateSession(graduationDeps, {
    sessionId: newSessionId,
    userText: trimmedPrompt,
    agentId,
    ...(explicitTitle ? { explicitTitle } : {}),
    ...(explicitBranch ? { explicitBranch } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.serviceId ? { serviceId: opts.serviceId } : {}),
    ...(opts.billingMode ? { billingMode: opts.billingMode } : {}),
    ...(reasoning ? { reasoning } : {}),
  });

  if (opts.armAutoMerge && autoMergeDeps?.prStatusPoller) {
    try {
      await toggleAutoMerge(
        autoMergeDeps.githubAuthManager,
        autoMergeDeps.prStatusPoller,
        newSessionId,
        true,
      );
    } catch (err) {
      console.warn(`[headless-session] Failed to arm auto-merge for ${newSessionId}:`, err);
    }
  }

  const session = sessionManager.get(newSessionId);
  if (!session) throw new ServiceError(500, "Failed to read back headless session");

  console.log(`[headless-session] Started ${newSessionId}: branch=${branchName} title="${session.title}"`);

  return {
    session,
    sessionId: session.id,
    branch: branchName,
    sessions: sessionManager.list(),
  };
}
