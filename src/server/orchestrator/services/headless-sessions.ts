import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo, AgentId } from "../../shared/types.js";
import type { GitManager } from "../../shared/git.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import { generateBranchPrefix } from "../git-utils.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { scheduleSessionNaming } from "../session-graduation.js";
import { ServiceError } from "./types.js";
import type { ClaimSessionService } from "./claim-session.js";

const quickSessionIds = new Set<string>();

function assertValidBranchName(name: string): void {
  if (/[\s~^:?*[\\]/.test(name) || name.includes("..")) {
    throw new ServiceError(400, "Invalid branch name");
  }
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`[headless-sessions] ignoring ${name}=${raw} (must be a positive integer)`);
    return undefined;
  }
  return parsed;
}

export const DEFAULT_MAX_ACTIVE_HEADLESS_SESSIONS =
  readPositiveIntEnv("MAX_ACTIVE_HEADLESS_SESSIONS") ?? 8;

export interface CreateHeadlessSessionOptions {
  repoUrl: string;
  prompt: string;
  title?: string;
  branch?: string;
  base?: string;
  agent?: AgentId;
  model?: string;
  maxActiveHeadlessSessions?: number;
}

export interface CreateHeadlessSessionResult {
  session: SessionInfo;
  sessionId: string;
  branch: string;
  sessions: SessionInfo[];
}

/**
 * Dependencies for the AI-naming step shared with warm graduation. Wired by
 * the route layer when present so quick sessions get the same descriptive
 * `shipit/<slug>-<random>` branches and human-readable titles as
 * graduated-from-warm sessions. Optional only because the unit test layer
 * doesn't stand up a `PrStatusPoller` or `createGitManager` — in production
 * the route always provides it.
 */
export interface HeadlessSessionGraduationDeps {
  createGitManager: (dir: string) => GitManager;
  prStatusPoller: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
}

export async function createHeadlessSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  claimService: ClaimSessionService,
  opts: CreateHeadlessSessionOptions,
  defaultAgentId: AgentId,
  credentialsDir: string | undefined,
  credentialStore: CredentialStore | undefined,
  providerAccountManager?: ProviderAccountManager,
  graduationDeps?: HeadlessSessionGraduationDeps,
): Promise<CreateHeadlessSessionResult> {
  const repoUrl = opts.repoUrl?.trim();
  if (!repoUrl) throw new ServiceError(400, "Add a repo first.");

  const trimmedPrompt = opts.prompt?.trim();
  if (!trimmedPrompt) throw new ServiceError(400, "prompt is required");
  if (trimmedPrompt.length > 50_000) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  const maxActive = opts.maxActiveHeadlessSessions ?? DEFAULT_MAX_ACTIVE_HEADLESS_SESSIONS;
  const activeQuick = [...quickSessionIds].filter((id) => {
    const session = sessionManager.get(id);
    const runner = runnerRegistry.get(id);
    if (!session || session.archived || !runner?.running) {
      quickSessionIds.delete(id);
      return false;
    }
    return true;
  });
  if (activeQuick.length >= maxActive) {
    throw new ServiceError(
      429,
      `You already have ${maxActive} quick sessions running. Open one from the sidebar before starting another.`,
    );
  }

  const explicitBranch = opts.branch?.trim();
  const explicitTitle = opts.title?.trim();
  const branchName = explicitBranch || generateBranchPrefix();
  assertValidBranchName(branchName);
  // Placeholder title — replaced asynchronously by `scheduleSessionNaming`
  // below when neither branch nor title was supplied by the caller. Mirrors
  // the warm-graduation placeholder in `ws-handlers/send-message.ts`.
  const title = explicitTitle || trimmedPrompt.slice(0, 60) || "Quick session";

  const claimed = await claimService.claim(repoUrl);
  const newSessionId = claimed.sessionId;
  const newWorkspaceDir = claimed.workspaceDir;

  try {
    const currentBranch = (await simpleGit(newWorkspaceDir).raw(["branch", "--show-current"])).trim();
    if (currentBranch && currentBranch !== branchName) {
      await simpleGit(newWorkspaceDir).raw(["branch", "-m", currentBranch, branchName]);
    }
  } catch (err) {
    throw new ServiceError(400, `Failed to rename branch to '${branchName}': ${String(err)}`);
  }

  if (opts.base) {
    try {
      await simpleGit(newWorkspaceDir).raw(["reset", "--hard", opts.base]);
    } catch (err) {
      throw new ServiceError(400, `Failed to reset to base '${opts.base}': ${String(err)}`);
    }
  }

  sessionManager.rename(newSessionId, title);
  sessionManager.setBranch(newSessionId, branchName);
  sessionManager.setWarm(newSessionId, false);
  if (opts.model) {
    sessionManager.setModel(newSessionId, opts.model);
  }

  // When the caller didn't pin a branch/title, fall through to the same
  // AI-naming + branch-rename flow warm graduation uses. The "branch
  // renamed" flag is owned by `scheduleSessionNaming` so the PR-ready
  // card waits for the rename to finish (or fail) before progressing.
  // When the caller pinned either field, treat the explicit value as
  // authoritative and mark the branch renamed immediately.
  const shouldAutoName = !explicitBranch && !explicitTitle && graduationDeps !== undefined;
  if (!shouldAutoName) {
    sessionManager.setBranchRenamed(newSessionId, true);
  }

  const session = sessionManager.get(newSessionId);
  if (!session) throw new ServiceError(500, "Failed to read back headless session");

  const agentId = opts.agent ?? defaultAgentId;
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

  quickSessionIds.add(newSessionId);
  runner.dispatch({ text: trimmedPrompt });

  if (shouldAutoName && graduationDeps) {
    scheduleSessionNaming(
      {
        sessionManager,
        runnerRegistry,
        createGitManager: graduationDeps.createGitManager,
        prStatusPoller: graduationDeps.prStatusPoller,
        sseBroadcast: graduationDeps.sseBroadcast,
      },
      {
        sessionId: newSessionId,
        userText: trimmedPrompt,
        agentId,
      },
    );
  }

  console.log(`[headless-session] Started ${newSessionId}: branch=${branchName} title="${title}"`);

  return {
    session,
    sessionId: session.id,
    branch: branchName,
    sessions: sessionManager.list(),
  };
}
