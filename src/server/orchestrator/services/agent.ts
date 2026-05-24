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
import type { AuthManager } from "../auth.js";
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
import { ServiceError } from "./types.js";

const PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "auto",
  "plan",
  "guarded",
]);

const MAX_TEXT_LEN = 50_000;
const MAX_ACTIVITY_LEN = 200;

export interface DispatchAgentMessageInput {
  text: string;
  activity?: string;
  permissionMode?: PermissionMode;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
  reviewFilePath?: string;
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
}

/**
 * Dispatch a system-initiated agent message via HTTP. Mirrors the gates the
 * WS `send_message` handler runs before reaching `runner.dispatch`:
 *
 *   1. Input validation (text non-empty + bounded, permission mode known).
 *   2. Runner resolution (404 if no runner is registered for this session).
 *   3. Auth gate (401 if the active agent isn't authenticated).
 *   4. Attachment resolution (read files / uploads from disk, validate sizes).
 *   5. `runner.dispatch(...)` — the funnel owns the send-vs-queue decision.
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
  if (input.images && input.images.length > 0) {
    const imageError = validateImages(input.images);
    if (imageError) throw new ServiceError(400, imageError);
  }

  // 2. Runner resolution. The registry returns `undefined` for missing or
  //    already-disposed runners (see `SessionRunnerRegistry.get`), so the
  //    second `disposed` check is defensive against the brief window where
  //    a runner may still be referenced before the dispose event lands.
  const runner = deps.runnerRegistry.get(sessionId);
  if (!runner || runner.disposed) {
    throw new ServiceError(404, "Session is not active");
  }

  // 3. Auth gate — mirror ensureActiveAgentAuthenticated from the WS handler.
  //    Without this, the dispatched run would hang the same way an
  //    unauthenticated `send_message` would.
  const activeAgentId = runner.agentId;
  if (activeAgentId === "claude") {
    if (!deps.authManager.authenticated) {
      deps.authManager.checkCredentials();
    }
    if (!deps.authManager.authenticated) {
      throw new ServiceError(401, "Claude is not authenticated. Sign in to continue.");
    }
  } else if (activeAgentId === "codex") {
    deps.agentRegistry.refreshAuth("codex");
    const info = deps.agentRegistry.get("codex");
    if (!info?.authConfigured) {
      throw new ServiceError(
        401,
        "Codex is not authenticated. Sign in to Codex or add OPENAI_API_KEY in Settings.",
      );
    }
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

  // 5. Dispatch — the funnel decides send vs enqueue and broadcasts
  //    message_queued via the runner if it enqueued.
  const wasRunning = runner.running;
  runner.dispatch({
    text,
    ...(input.activity !== undefined ? { activity: input.activity } : {}),
    ...(allImages !== undefined ? { images: allImages } : {}),
    ...(validatedFiles.length > 0 ? { files: validatedFiles.map(asFileContextRef) } : {}),
    ...(input.uploads !== undefined ? { uploads: input.uploads } : {}),
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.reviewFilePath !== undefined ? { reviewFilePath: input.reviewFilePath } : {}),
  });

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
