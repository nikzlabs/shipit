import path from "node:path";
import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionInfo, AgentId, UploadRef, IssueRef } from "../../shared/types.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { toggleAutoMerge } from "./github.js";
import { agentIdForModel, getAgentCapabilities } from "../../shared/agent-registry.js";
import { generateBranchPrefix } from "../git-utils.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import { saveUploadedFile, MAX_UPLOAD_FILES_PER_REQUEST } from "./files.js";
import type { ClaimSessionService } from "./claim-session.js";

function assertValidBranchName(name: string): void {
  if (/[\s~^:?*[\\]/.test(name) || name.includes("..")) {
    throw new ServiceError(400, "Invalid branch name");
  }
}

export interface HeadlessUploadInput {
  filename: string;
  data: Buffer;
}

/**
 * docs/170 — turn a fetched tracker issue into a branch slug + seed prompt.
 * Shared seeding primitive: the in-app "Start session" path (pull, docs/170)
 * and the future webhook trigger (push, docs/156) both build an `IssueRef` and
 * route through here, so the branch/prompt derivation stays in one place.
 */
export function seedFromIssueRef(issueRef: IssueRef): {
  prompt: string;
  branch: string;
  title: string;
} {
  const identifier = issueRef.identifier.trim();
  const titleText = issueRef.title.trim();

  // Branch: "<identifier>-<title-slug>", lowercased, kebab, capped so it stays
  // a valid, readable git ref (assertValidBranchName rejects spaces/specials).
  const slugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const idSlug = slugify(identifier);
  const titleSlug = slugify(titleText).split("-").slice(0, 8).join("-");
  const branch = [idSlug, titleSlug].filter(Boolean).join("-").slice(0, 60).replace(/-+$/g, "")
    || generateBranchPrefix();

  // Seed prompt: identifier + title + description + link, so the first agent
  // turn has the full issue context without the user re-typing it.
  const lines = [`You are working on issue ${identifier}: ${titleText}`];
  if (issueRef.description?.trim()) {
    lines.push("", issueRef.description.trim());
  }
  if (issueRef.url?.trim()) {
    lines.push("", `Issue link: ${issueRef.url.trim()}`);
  }
  return { prompt: lines.join("\n"), branch, title: `${identifier}: ${titleText}` };
}

export interface CreateHeadlessSessionOptions {
  repoUrl: string;
  /** Required unless `issueRef` is supplied (then the prompt is seeded from it). */
  prompt?: string;
  /**
   * docs/170 — when present, the branch, title, and (absent an explicit
   * `prompt`) the first agent prompt are derived from the issue. Explicit
   * `prompt`/`branch`/`title` still win so callers can override.
   */
  issueRef?: IssueRef;
  title?: string;
  branch?: string;
  agent?: AgentId;
  model?: string;
  /**
   * docs/217 — per-session reasoning effort (Control B) for the first turn.
   * Validated against the resolved agent's options below and persisted to the
   * session row before dispatch, so the server-dispatched first turn picks it
   * up (the `?reasoning=` WS connect param only reaches WS-driven turns).
   */
  reasoning?: string;
  /**
   * Raw files uploaded alongside the prompt (multipart). Saved into the new
   * session's uploads dir before the agent turn is dispatched, so the
   * resulting `UploadRef[]` rides along with `runner.dispatch({ text, uploads })`
   * and the first turn sees the attachments. See docs/145.
   */
  uploads?: HeadlessUploadInput[];
  /**
   * docs/175 — arm auto-merge for the new session at creation time, before any
   * PR exists. Seeds the SAME per-session armed state the pre-PR overflow
   * toggle sets (`toggleAutoMerge` with no PR present); when the first turn
   * opens a PR, `activatePendingAutoMergeForPr` / `PrStatusPoller` pick it up
   * and merge on green. Per decision #1 it is transient — never persisted to
   * the session row or DB.
   */
  armAutoMerge?: boolean;
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
): Promise<CreateHeadlessSessionResult> {
  const repoUrl = opts.repoUrl?.trim();
  if (!repoUrl) throw new ServiceError(400, "Add a repo first.");

  // docs/170 — derive branch/title/prompt from a tracker issue when supplied.
  // Explicit options still win (a caller may pre-fill the prompt or branch).
  const seed = opts.issueRef ? seedFromIssueRef(opts.issueRef) : undefined;

  const trimmedPrompt = (opts.prompt?.trim() || seed?.prompt)?.trim();
  if (!trimmedPrompt) throw new ServiceError(400, "prompt is required");
  if (trimmedPrompt.length > 50_000) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  const explicitBranch = opts.branch?.trim() || seed?.branch;
  const explicitTitle = opts.title?.trim() || seed?.title;
  const branchName = explicitBranch || generateBranchPrefix();
  assertValidBranchName(branchName);

  // `skipReuse: true` — a headless session is always a *new* session for the
  // requested work (quick-capture, issue-seeded "Start session", webhooks),
  // never a recycle of an existing draft. Without it, the claim reuse path
  // (`findUngraduatedWarm`) could hand back an ungraduated `/{repo}/new` draft
  // the user is actively typing in for the same repo — graduating it and
  // dispatching this headless prompt into the session they're viewing (a
  // message appearing from nowhere mid-compose). Mirrors `spawnChildSession`.
  const claimed = await claimService.claim(repoUrl, { skipReuse: true });
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

  // Workspace-side branch identity must be set before graduateSession so the
  // session row matches what's on disk.
  sessionManager.setBranch(newSessionId, branchName);

  // Defense-in-depth: the model is the single source of truth (docs/142,
  // Problem C). When a recognized model is supplied, derive the agent from it
  // and prefer that over a conflicting `opts.agent` — this protects any caller
  // (a stale `vibe-agent-id` in the quick-capture overlay, a legacy client)
  // that sends an agent which disagrees with the model from pinning the new
  // session to the wrong agent (the pin is write-once). Fall back to the
  // explicit agent only when no model is given or the model is unrecognized.
  // See docs/166-quick-capture-agent-pin.
  const agentId = agentIdForModel(opts.model) ?? opts.agent ?? defaultAgentId;

  // docs/217 — validate the requested reasoning effort against the resolved
  // agent's options; drop silently if invalid (mirrors the WS connect-param
  // path in route-registry.ts). Persisted onto the session row by
  // graduateSession so the first dispatched turn runs with it.
  const reasoningOpts = getAgentCapabilities(agentId)?.reasoning?.options;
  const reasoning =
    opts.reasoning && reasoningOpts?.some((o) => o.value === opts.reasoning)
      ? opts.reasoning
      : undefined;

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
    ...(reasoning ? { reasoning } : {}),
  });

  // docs/175 — arm auto-merge for the new session via the SAME pre-PR arm path
  // the overflow toggle uses. With no PR yet, `toggleAutoMerge` falls through to
  // `prStatusPoller.setAutoMergeEnabled`, seeding the in-memory armed state;
  // `activatePendingAutoMergeForPr` applies it once the first turn opens a PR.
  // No new merge logic, no persistence (decision #1). Best-effort: a failure to
  // arm (e.g. GitHub not authenticated) must not abort session creation.
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
