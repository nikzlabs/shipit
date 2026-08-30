import path from "node:path";
import { catalogueModelLabels, type BillingMode } from "../../shared/catalogue/index.js";
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

/**
 * The stable, issue-derived half of an issue-seeded branch name: the pointer,
 * lowercased and kebabbed. `""` when the pointer slugifies to nothing.
 *
 * This function is also what makes the result a valid git ref: it keeps only
 * `[a-z0-9]` and single interior dashes, so no space, `~^:?*[\`, or `..` can
 * survive an identifier however a tracker spells it. That is now the ONLY
 * source of a derived branch name besides `generateBranchPrefix`, which is why
 * the route's old `assertValidBranchName` check went away with the
 * caller-supplied `branch` option it existed to police (planning#413).
 *
 * docs/248-declared-issue-trackers req 22 — the issue title is deliberately NOT in the branch name. A
 * branch gets pushed to a public remote, so a title from a private planning
 * issue would be published there. The rule is unconditional rather than scoped
 * to "private" issues because ShipIt has no signal for which repositories are
 * private: a declared planning repo may be public and a session's own code
 * repo may be private, so any narrower rule would be a guess. The cost — a
 * less readable branch for Linear and code-repo issues too — was accepted
 * explicitly (see the requirements doc's resolved questions).
 *
 * Capped at 50 chars so the uniqueness suffix `seedFromIssueRef` appends keeps
 * the whole ref inside the ~60 chars the old cap allowed.
 */
export function issueBranchBase(identifier: string): string {
  return identifier
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

/** Does `branch` look like an issue-seeded branch for this pointer? */
export function isIssueSeededBranch(branch: string, identifier: string): boolean {
  const base = issueBranchBase(identifier);
  return base !== "" && (branch === base || branch.startsWith(`${base}-`));
}

/**
 * docs/170 — turn a fetched tracker issue into a branch slug + seed prompt.
 * Shared seeding primitive: the in-app "Start session" path (pull, docs/170)
 * and the future webhook trigger (push, docs/156) both build an `IssueRef` and
 * route through here, so the branch/prompt derivation stays in one place.
 *
 * **The branch is issue-derived but never issue-determined (planning#413).** It
 * carries a random `generateBranchSlug()` suffix, so `SHI-304` seeds
 * `shi-304-k7p2qz` and the next session on the same issue gets a different one.
 * The pointer alone used to be the whole name, which made the branch a pure
 * function of the issue — and sessions on one issue are routinely *sequential*
 * (a follow-up, a re-run after a merge, a second attempt), not just concurrent.
 * The second session then inherited the first's remote branch. What went wrong
 * there is a branch-name identity problem, so it is not confined to the push:
 * `quickCreatePr` resolves the branch's existing OPEN PR (`findPullRequest`)
 * before pushing and returns it, so the new session's card points at the other
 * session's PR; and where that PR already MERGED, `verifyMissingPr` finds it by
 * branch name alone and promotes THIS session to terminal-merged, archiving it
 * and re-firing the merge→issue effects under a second session id. The rejected
 * non-fast-forward push is the least of it. Nothing reads the branch to recover
 * the issue — the pointer travels in persisted chat history, the seed prompt and
 * the PR body's `Closes` line — so the suffix costs only readability.
 *
 * Only a DERIVED branch is guaranteed unique: an explicit `opts.branch` still
 * wins over the seed, so a caller that supplies one owns its collisions.
 */
export function seedFromIssueRef(issueRef: IssueRef): {
  prompt: string;
  branch: string;
  title: string;
} {
  const identifier = issueRef.identifier.trim();
  const titleText = issueRef.title.trim();

  const base = issueBranchBase(identifier);
  const branch = base ? `${base}-${generateBranchSlug()}` : generateBranchPrefix();

  // Seed prompt: the pointer only — see `buildIssueSeedPrompt`. The issue's
  // description is deliberately NOT pasted in; the agent fetches it.
  return {
    prompt: buildIssueSeedPrompt({ identifier, title: titleText }),
    branch,
    title: `${identifier}: ${titleText}`,
  };
}

export interface CreateHeadlessSessionOptions {
  repoUrl: string;
  /** Required unless `issueRef` is supplied (then the prompt is seeded from it). */
  prompt?: string;
  /**
   * docs/170 — when present, the branch, title, and (absent an explicit
   * `prompt`) the first agent prompt are derived from the issue. An explicit
   * `prompt`/`title` still wins so callers can override.
   *
   * There is deliberately NO `branch` override (planning#413): a supplied name
   * is used verbatim, so two calls carrying one name collide on a single remote
   * branch — the failure the issue seed's uniqueness suffix exists to prevent.
   * The branch is always derived here, from the pointer or generated.
   */
  issueRef?: IssueRef;
  title?: string;
  agent?: AgentId;
  model?: string;
  /** docs/252 — the rest of the selection triple, when the caller knows it. */
  serviceId?: string;
  billingMode?: BillingMode;
  /**
   * docs/217 — per-session reasoning effort (Control B) for the first turn.
   * Validated against the resolved agent's options below and persisted to the
   * session row before dispatch, so the server-dispatched first turn picks it
   * up (the `?reasoning=` WS connect param only reaches WS-driven turns).
   */
  reasoning?: string;
  /**
   * docs/272-user-selectable-roles reqs 1, 11 — the role the user picked in the quick-capture
   * overlay.
   *
   * **It replaces `agent` / `model` / `serviceId` / `billingMode` / `reasoning`
   * outright** rather than filling their gaps, because a role *is* those five
   * values and the composer hid the controls that produce them: whatever the
   * browser's seed slots still hold describes a choice the user has handed over.
   * Resolved before anything touches disk, so an unknown, reserved or unrunnable
   * role costs no claimed warm session and no container (req 8 — nothing is ever
   * substituted).
   */
  role?: string;
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
  /**
   * docs/144 — the prompt was dictated by voice (the quick-capture overlay's
   * Mode B: hold the hotkey, speak a task, it spawns a session). The first
   * turn's prompt gets the `<dictated_input>` block so the agent reads
   * mis-heard terms as transcription artifacts. Never set for a
   * server-composed prompt (issue seeds, API callers that didn't ask for it).
   */
  dictated?: boolean;
  /**
   * docs/285 reqs 2, 3 — the network mode picked in the Quick Capture composer,
   * in force from this session's first turn. `true` = Contained, `false` = Open,
   * `null`/absent = inherit the workspace setting (the default; req 8 says the
   * pick never carries over, so the overlay sends nothing unless the user
   * changed it).
   */
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
  /**
   * docs/285 — what it takes to honour `opts.networkMode`: somewhere to persist
   * the override, and the reconciliation that rebuilds the claimed session's
   * container when it was created under a different mode. Optional — a runtime
   * without egress simply ignores the field, exactly as it does today.
   */
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

  // docs/170 — derive branch/title/prompt from a tracker issue when supplied.
  // An explicit prompt/title still wins; the branch is never caller-supplied.
  const seed = opts.issueRef ? seedFromIssueRef(opts.issueRef) : undefined;

  const trimmedPrompt = (opts.prompt?.trim() || seed?.prompt)?.trim();
  if (!trimmedPrompt) throw new ServiceError(400, "prompt is required");
  if (trimmedPrompt.length > 50_000) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  // Both branch sources are unique by construction (planning#413) and both are
  // valid refs by construction, which is why nothing validates the result: the
  // seed is `issueBranchBase` + a random slug, the fallback is generated.
  const explicitBranch = seed?.branch;
  const explicitTitle = opts.title?.trim() || seed?.title;
  const branchName = explicitBranch || generateBranchPrefix();

  // docs/272 reqs 1, 8, 11 — a role, when the overlay carried one, decided the
  // five parameters below. Resolved FIRST and substituted over the request, so
  // every check downstream asks its questions of the role's tuple: the role was
  // validated when it was saved and again just now, so those checks pass, and
  // the ones that would have fired on a stale browser seed no longer see one.
  //
  // A refusal here is the whole of the role's failure handling on this path. It
  // happens before the claim, which is the ordering this function already
  // states: "a selection the server is going to refuse should cost no claimed
  // warm session, no branch rename, and no container".
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

  // Defense-in-depth: the model is the single source of truth (docs/142,
  // Problem C). When a recognized model is supplied, derive the agent from it
  // and prefer that over a conflicting `opts.agent` — this protects any caller
  // (a stale `vibe-agent-id` in the quick-capture overlay, a legacy client)
  // that sends an agent which disagrees with the model from pinning the new
  // session to the wrong agent (the pin is write-once). Fall back to the
  // explicit agent only when no model is given or the model is unrecognized.
  // See docs/166-quick-capture-agent-pin.
  //
  // …EXCEPT when the two do not disagree at all. docs/252 ended "each model
  // belongs to exactly one harness": `deepseek-v4-flash` and `deepseek-v4-pro`
  // are in BOTH harnesses' model lists today, and `agentIdForModel` answers
  // with whichever `AGENT_DEFS` sorts first (claude). Treating that as a
  // mismatch overrode a harness the caller explicitly asked for and could
  // actually run — so Quick Capture's harness pick was discarded here, write-
  // once, after the client had already honoured it. A caller naming a harness
  // that runs the model is not the stale-key case this guard is for.
  //
  // …and EXCEPT when the harness cannot speak the model's API style at all,
  // which is now a refusal rather than a substitution (planning#389 — see below).
  // What survives of the derivation is the case it is unambiguously right for: a
  // caller who named a model and NO harness, or one whose harness this build does
  // not know.
  const explicitAgent = opts.agent;
  // An id no harness in this build has. `agent` reaches here as free text — the
  // route casts the JSON field and the multipart part without checking either —
  // so a typo lands here, and `spawnChildSession` names LLM-written harness ids as
  // a known source of them.
  //
  // Refused rather than repaired, and refused whether or not a model came with it.
  // The alternative is the same silent substitution planning#389 is about, one
  // step further out: with a model present the fall-through below resolves to the
  // MODEL's harness, so `agent: "codexx"` would create a session on Claude, pin it
  // write-once and bill its first turn — and the installed-harness gate below
  // cannot catch that, because the id it is finally asked about is a real
  // installed one.
  //
  // This is NOT the req 14 case immediately below it: that one is an id this
  // deployment merely lacks, which is a real harness a stale picker could
  // legitimately be holding, so it still falls back. Nothing legitimately holds an
  // id no build ever declared.
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

  // planning#389 — the remaining case is the one this guard used to answer
  // WRONG: an explicit harness that does NOT list the model. `capabilities.models`
  // is the catalogue join (`catalogueModelIdsForHarness`), which is the API-style
  // question asked of every service at once — so "not listed, and some other
  // harness does list it" is exactly `resolveStyle(harness, model) === undefined`.
  // Rerouting there sent the turn to the OTHER harness, pinned the session to it
  // write-once, and billed it, while `pending_agent_notice` stayed NULL: a user
  // asked for Codex, got Claude, and was told nothing (measured 2026-08-15 in the
  // docs/252 pair sweep — `codex × openrouter:key × anthropic/claude-opus-5` ran
  // on Claude for $0.14).
  //
  // The other two spawn paths already refuse the same pair, and their reasons are
  // this one's too: `assertHarnessCanRunSelection` / `resolveSpawnTarget`
  // (docs/261 req 7 — "the call is taken literally, so a harness pointed at
  // another vendor's model is an error rather than something to reroute") and
  // `spawnChildSession`'s `--agent`/`--model` check (planning#304). Headless
  // creation was the odd one out.
  //
  // This DOES narrow docs/166's server-side guard, deliberately: the stale
  // `vibe-agent-id` case it was written for ("agent codex + a Claude model") is
  // the *same input* as a caller who means it, so no rule can repair one without
  // rerouting the other. What docs/166 set out to prevent — a session pinned
  // write-once to a harness the user did not choose — a refusal prevents too, and
  // without spending the user's money to do it. The client half of docs/166 (the
  // overlay derives the harness from the model, `newSessionAgentId`) is untouched
  // and still keeps that pair from being sent in the first place.
  //
  // Membership, not `agentIdForModel`'s single "owner" (planning#304): a model
  // BOTH harnesses list is not a mismatch, and an explicit harness that can run it
  // is honoured above. `agentIdForModel` survives here as the "is this id known to
  // any harness at all" test — an id no harness lists is passed through unchanged,
  // the same forward-compat rule the child-session and role validators apply.
  //
  // Asked of the model ID across the whole catalogue, not of the `(service, mode)`
  // row `opts.serviceId`/`billingMode` may also name — the same scope
  // `spawnChildSession` uses. Both shipped harnesses declare exactly ONE style, so
  // the two answers cannot differ today; if a future catalogue offers one id in a
  // style a harness speaks through one service and not another, the narrower
  // question is turn-time routing's (`resolveEndpoint`), which fails loudly rather
  // than billing the wrong harness — which is the failure this check exists for.
  const modelOwner = agentIdForModel(opts.model);
  if (explicitAgent && explicitCapabilities && opts.model && !explicitAgentRunsModel && modelOwner) {
    const harnessName = getAgentDisplayName(explicitAgent);
    const label = catalogueModelLabels()[opts.model] ?? opts.model;
    // Worded for both readers this path has: an HTTP caller reading a 400 body,
    // and a user reading it as a toast (`startQuickSessionInBackground` surfaces
    // the server's message verbatim, the overlay having already closed). Hence
    // both remedies in plain words rather than the name of a request field.
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

  // docs/252 phase 9 (req 14) — and the same defense one step further: the model
  // above is matched against the whole catalogue, and `opts.agent` is whatever
  // the caller sent, so either can name a harness this deployment did not
  // install. Nothing offers one, so reaching here means a stale browser
  // selection — pinning it would create a session whose first turn cannot run,
  // and the pin is write-once. Fall back to the install's default rather than
  // rejecting a capture the user cannot re-aim from here.
  const agentId = isHarnessInstalled(requestedAgentId) ? requestedAgentId : defaultAgentId;
  if (agentId !== requestedAgentId) {
    console.warn(
      `[headless] requested agent '${requestedAgentId}' is not installed in this deployment; using '${agentId}'`,
    );
  }

  // docs/217 — validate the requested reasoning effort against the resolved
  // agent's options; drop silently if invalid (mirrors the WS connect-param
  // path in route-registry.ts). Persisted onto the session row by
  // graduateSession so the first dispatched turn runs with it.
  const reasoningOpts = getAgentCapabilities(agentId)?.reasoning?.options;
  const reasoning =
    opts.reasoning && reasoningOpts?.some((o) => o.value === opts.reasoning)
      ? opts.reasoning
      : undefined;

  // Everything above is a pure question about the request; everything below
  // touches disk. The order is deliberate (and the same one `spawnChildSession`
  // gives its `--agent`/`--model` validation): a selection the server is going to
  // refuse should cost no claimed warm session, no branch rename, and no
  // container — planning#389's refusal in particular runs before a single
  // side effect.
  //
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
    const currentBranch = (await safeSimpleGit(newWorkspaceDir).raw(["branch", "--show-current"])).trim();
    if (currentBranch && currentBranch !== branchName) {
      await safeSimpleGit(newWorkspaceDir).raw(["branch", "-m", currentBranch, branchName]);
    }
  } catch (err) {
    throw new ServiceError(400, `Failed to rename branch to '${branchName}': ${String(err)}`);
  }

  // Workspace-side branch identity must be set before graduateSession so the
  // session row matches what's on disk.
  sessionManager.setBranch(newSessionId, branchName);

  // docs/272 req 5 — the role is in force from creation, so the composer of the
  // session the user lands in names it. Written BEFORE the dispatch below,
  // because that first turn is what collects the role's standing instructions
  // (req 2) — `takeRoleInstructions` reads this row.
  if (userRole) sessionManager.setRoleName(newSessionId, userRole.role.name);

  // docs/285 reqs 2, 3 — the network mode the overlay carried, in force from
  // this session's FIRST turn.
  //
  // Quick Capture creates and dispatches in one server-side act, so the whole
  // first-Send reconciliation collapses to these few lines — and they have to
  // land **before `getOrCreate`**, not merely before `dispatch`: the reconcile
  // destroys the claimed container and builds the replacement runner itself, and
  // a runner made here first would be returned unchanged by that later call.
  //
  // `agentSeed: agentId` is why the harness survives. The requested agent has
  // been RESOLVED above but deliberately not persisted (warm-up env preparation
  // owns that), so `session.agentId` is still undefined and the replacement
  // runner would otherwise be seeded with the deployment default — picking Codex
  // *and* changing the network mode would dispatch this turn to Claude.
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
  }));

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
    ...(opts.serviceId ? { serviceId: opts.serviceId } : {}),
    ...(opts.billingMode ? { billingMode: opts.billingMode } : {}),
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
