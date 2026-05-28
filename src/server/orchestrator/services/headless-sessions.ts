import path from "node:path";
import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo, AgentId, UploadRef } from "../../shared/types.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import { generateBranchPrefix } from "../git-utils.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import { saveUploadedFile, MAX_UPLOAD_FILES_PER_REQUEST } from "./files.js";
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

export interface HeadlessUploadInput {
  filename: string;
  data: Buffer;
}

export interface CreateHeadlessSessionOptions {
  repoUrl: string;
  prompt: string;
  title?: string;
  branch?: string;
  base?: string;
  agent?: AgentId;
  model?: string;
  maxActiveHeadlessSessions?: number;
  /**
   * Raw files uploaded alongside the prompt (multipart). Saved into the new
   * session's uploads dir before the agent turn is dispatched, so the
   * resulting `UploadRef[]` rides along with `runner.dispatch({ text, uploads })`
   * and the first turn sees the attachments. See docs/145.
   */
  uploads?: HeadlessUploadInput[];
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

  // Workspace-side branch identity must be set before graduateSession so the
  // session row matches what's on disk.
  sessionManager.setBranch(newSessionId, branchName);

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

  // Persist any uploaded files into the new session's uploads dir before the
  // first turn fires, so the resulting UploadRefs are visible to the agent.
  // Uploads live as a sibling of the workspace checkout (same convention as
  // /api/sessions/:id/files/uploads — see `api-routes-files.ts`).
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

  quickSessionIds.add(newSessionId);
  runner.dispatch({
    text: trimmedPrompt,
    ...(uploadRefs.length > 0 ? { uploads: uploadRefs } : {}),
  });

  // graduate-session.ts owns the warm → active transition (docs/156).
  // Do not inline setWarm / track / setBranchRenamed / scheduleSessionNaming /
  // repoStore.touch / sseBroadcast("session_list") here — call graduateSession.
  graduateSession(graduationDeps, {
    sessionId: newSessionId,
    userText: trimmedPrompt,
    agentId,
    ...(explicitTitle ? { explicitTitle } : {}),
    ...(explicitBranch ? { explicitBranch } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  });

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
