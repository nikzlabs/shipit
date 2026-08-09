/**
 * Agent dispatch service (docs/150).
 *
 * `dispatchAgentMessage` is the HTTP-side counterpart to the WS `send_message`
 * handler — it routes system-initiated client buttons (Create PR, Send compose
 * errors, Auto-fix preview errors, etc.) through the same `runner.dispatch`
 * funnel that Fix CI and the child-session spawn already use. The funnel
 * owns the "send-if-idle, enqueue-if-running" rule; this service handles
 * the cross-cutting work that has to happen before the dispatch lands
 * (input validation, runner resolution, auth gate, attachment resolution).
 */

import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type {
  PermissionMode,
  ImageAttachment,
  FileContextRef,
  UploadRef,
  FileAttachment,
} from "../../shared/types.js";
import {
  validateImages,
  resolveFileAttachments,
  resolveUploadRefs,
} from "../validation.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import type { MaterializeRunnerOutcome } from "./materialize-runner.js";
import { ServiceError } from "./types.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import type { AgentInterfaceProvenance } from "../../shared/agent-interface-sdk/protocol.js";
import { agentAdmissionError } from "./agent-auth-gate.js";

const PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "auto",
  "plan",
  "guarded",
]);

const MAX_TEXT_LEN = 50_000;
const MAX_ACTIVITY_LEN = 200;

export interface DispatchAgentMessageInput {
  text: string;
  agentInterface?: AgentInterfaceProvenance;
  activity?: string;
  permissionMode?: PermissionMode;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
}

export interface DispatchAgentMessageResult {
  ok: true;
  /** True when the runner was already running and the dispatch was queued. */
  queued: boolean;
}

export interface DispatchAgentMessageDeps {
  runnerRegistry: SessionRunnerRegistry;
  agentRegistry: AgentRegistry;
  credentialStore: CredentialStore;
  authManager: AuthManager;
  sessionManager: SessionManager;
  /**
   * Everything `graduateSession` needs, minus the `runnerRegistry` this
   * service already has. Warm-graduation is not optional — a dispatch is a
   * first message like any other (see step 5 below).
   */
  graduation: Omit<GraduateSessionDeps, "runnerRegistry" | "sessionManager">;
  /**
   * Refill the warm pool after a warm session is consumed. Like the WS
   * `send_message` path, this surface reaches graduation without going through
   * `claimSessionService.claim`, so nothing else re-warms. Optional — runtimes
   * without a pool (tests, local mode) omit it.
   */
  warmSessionForRepo?: (repoUrl: string) => Promise<void>;
  /**
   * docs/131 (reqs 8–10) — bring up a session that has no runner, the way a WS
   * connect does. Without it this service can only reach sessions someone
   * currently has open, because only the WS path calls `getOrCreate`. The outer
   * agent driving the inner dogfood ShipIt has no WS, and a session from an
   * earlier boot (or one that went idle) is exactly the case it needs.
   *
   * Optional: runtimes that omit it keep the old 404-on-no-runner behavior.
   */
  wakeSession?: (sessionId: string) => Promise<MaterializeRunnerOutcome>;
}

/**
 * Dispatch a system-initiated agent message via HTTP. Mirrors the gates the
 * WS `send_message` handler runs before reaching `runner.dispatch`:
 *
 *   1. Input validation (text non-empty + bounded, permission mode known).
 *   2. Runner resolution (404 if no runner is registered for this session).
 *   3. Auth gate (401 if the active agent isn't authenticated).
 *   4. Attachment resolution (read files / uploads from disk, validate sizes).
 *   5. Warm-session graduation (docs/156) — a dispatch is a first message.
 *   6. `runner.dispatch(...)` — the funnel owns the send-vs-queue decision.
 */
export async function dispatchAgentMessage(
  deps: DispatchAgentMessageDeps,
  sessionId: string,
  input: DispatchAgentMessageInput,
): Promise<DispatchAgentMessageResult> {
  // 1. Input validation.
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new ServiceError(400, "Message text is required");
  if (text.length > MAX_TEXT_LEN) {
    throw new ServiceError(400, `Message text exceeds ${MAX_TEXT_LEN} characters`);
  }
  if (input.activity !== undefined) {
    if (typeof input.activity !== "string") {
      throw new ServiceError(400, "Activity must be a string");
    }
    if (input.activity.length > MAX_ACTIVITY_LEN) {
      throw new ServiceError(400, `Activity exceeds ${MAX_ACTIVITY_LEN} characters`);
    }
  }
  if (input.permissionMode !== undefined && !PERMISSION_MODES.has(input.permissionMode)) {
    throw new ServiceError(400, `Unknown permission mode: ${input.permissionMode}`);
  }
  if (input.agentInterface !== undefined && (
    input.agentInterface.source !== "agent_interface_sdk"
    || (input.agentInterface.surface !== "preview" && input.agentInterface.surface !== "present")
  )) {
    throw new ServiceError(400, "Invalid agent interface provenance");
  }
  if (input.images && input.images.length > 0) {
    const imageError = validateImages(input.images);
    if (imageError) throw new ServiceError(400, imageError);
  }

  // 2. Runner resolution. The registry returns `undefined` for missing or
  //    already-disposed runners (see `SessionRunnerRegistry.get`), so the
  //    second `disposed` check is defensive against the brief window where
  //    a runner may still be referenced before the dispose event lands.
  //
  //    No runner is not, by itself, an error: a session nobody has open still
  //    exists and can be woken (docs/131 req 8). `wakeSession` is the same
  //    materialization a WS connect runs, so an archived session stays
  //    unreachable and a lost checkout is restored before a container boots.
  let runner = deps.runnerRegistry.get(sessionId);
  if (!runner || runner.disposed) {
    if (!deps.wakeSession) throw new ServiceError(404, "Session is not active");
    const outcome = await deps.wakeSession(sessionId);
    if (outcome.status === "restore-failed") {
      throw new ServiceError(
        503,
        `Session workspace could not be restored: ${outcome.message}`,
      );
    }
    // "archived" and "no-workspace" are both "there is nothing to dispatch at",
    // and both keep the pre-existing 404 wording that clients already match on.
    if (outcome.status !== "ready") throw new ServiceError(404, "Session is not active");
    runner = outcome.runner;
  }
  // docs/243 — reject before auth refresh, attachment reads, warm graduation,
  // persistence, queueing, or process start. dispatch() repeats this check at
  // the shared boundary to cover races and every non-HTTP ingress.
  runner.assertCanDispatch();

  // 3. Auth gate — mirror ensureActiveAgentAuthenticated from the WS handler.
  //    Without this, the dispatched run would hang the same way an
  //    unauthenticated `send_message` would.
  //
  const activeAgentId = runner.agentId;
  // docs/252 phase 9 — also refuses a harness this deployment did not install
  // (req 14), which is how a dispatched turn on a session pinned to a since-
  // removed harness fails with a reason instead of a missing binary.
  const refusal = agentAdmissionError(deps.agentRegistry, activeAgentId);
  if (refusal) {
    throw new ServiceError(401, refusal);
  }

  // 4. Resolve file attachments + upload refs against the runner's session dir
  //    so the runner receives ready-to-use FileAttachments + ImageAttachments.
  //    The runner.dispatch enqueue branch carries these through any drain.
  let validatedFiles: FileAttachment[] = [];
  let allImages = input.images;
  if (input.files && input.files.length > 0) {
    const result = await resolveFileAttachments(input.files, runner.sessionDir);
    if (result.error) throw new ServiceError(400, result.error);
    validatedFiles = result.files;
  }
  if (input.uploads && input.uploads.length > 0) {
    const uploadResult = await resolveUploadRefs(input.uploads, runner.sessionDir);
    if (uploadResult.error) throw new ServiceError(400, uploadResult.error);
    validatedFiles = [...validatedFiles, ...uploadResult.files];
    if (uploadResult.images.length > 0) {
      allImages = [...(allImages ?? []), ...uploadResult.images];
    }
  }

  // 5. Graduate a warm session — a dispatched button press is a first message
  //    like any other. Without this the session row stays `warm: true`: it
  //    never appears in the session list, keeps its placeholder title and
  //    `shipit/<random>` branch, and the next "New Session" for the repo
  //    recycles it out from under the running turn (findUngraduatedWarm).
  //    graduate-session.ts owns the whole warm → active transition (docs/156) —
  //    do not inline setWarm / track / rename / repoStore.touch / sseBroadcast.
  const session = deps.sessionManager.get(sessionId);
  if (session?.warm) {
    graduateSession(
      { ...deps.graduation, sessionManager: deps.sessionManager, runnerRegistry: deps.runnerRegistry },
      { sessionId, userText: text, agentId: session.agentId ?? activeAgentId },
    );
    // Same reasoning as ws-handlers/send-message.ts: warm-graduation is the one
    // path that doesn't reach graduation via `claimSessionService.claim`, so
    // the consumed warm clone would otherwise never be replaced.
    if (session.remoteUrl && deps.warmSessionForRepo) {
      void deps.warmSessionForRepo(session.remoteUrl);
    }
  }

  // 6. Dispatch — the funnel decides send vs enqueue and broadcasts
  //    message_queued via the runner if it enqueued.
  const wasRunning = runner.running;
  runner.dispatch(prepareDispatch({
    text,
    agentInterface: input.agentInterface,
    activity: input.activity,
    images: allImages,
    files: validatedFiles.length > 0 ? validatedFiles.map(asFileContextRef) : undefined,
    uploads: input.uploads,
    permissionMode: input.permissionMode,
    execution: undefined,
    postTurn: undefined,
    systemTurn: undefined,
    onTurnComplete: undefined,
    deliveryId: undefined,
    dictated: undefined,
  }));

  return { ok: true, queued: wasRunning };
}

/**
 * Convert a validated `FileAttachment` back to a `FileContextRef` for the
 * dispatch funnel. The HTTP service resolves attachments up front so it can
 * surface 400s for invalid paths before queueing — but the queue + runner
 * funnel carries `FileContextRef[]`, and the per-turn resolver (in the WS-side
 * drain path) re-reads the content from disk at turn-start time. We pass the
 * reference through so the up-front resolution still does its validation job
 * without forcing a queued attachment to carry possibly-stale file content.
 */
function asFileContextRef(file: FileAttachment): FileContextRef {
  return { path: file.path };
}
