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
  imageAttachmentRefusal,
  resolveFileAttachments,
  resolveUploadRefs,
} from "../validation.js";
import { modelSelectionOf } from "../session-agent-env.js";
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
  queued: boolean;
}

export interface DispatchAgentMessageDeps {
  runnerRegistry: SessionRunnerRegistry;
  agentRegistry: AgentRegistry;
  credentialStore: CredentialStore;
  authManager: AuthManager;
  sessionManager: SessionManager;
  graduation: Omit<GraduateSessionDeps, "runnerRegistry" | "sessionManager">;
  warmSessionForRepo?: (repoUrl: string) => Promise<void>;
  /** Without this, sessions with no runner return 404. */
  wakeSession?: (sessionId: string) => Promise<MaterializeRunnerOutcome>;
}

export async function dispatchAgentMessage(
  deps: DispatchAgentMessageDeps,
  sessionId: string,
  input: DispatchAgentMessageInput,
): Promise<DispatchAgentMessageResult> {
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
  {
    const session = deps.sessionManager.get(sessionId);
    const visionRefusal = imageAttachmentRefusal(
      session ? modelSelectionOf(session) : undefined,
      input.images,
      input.uploads,
    );
    if (visionRefusal) throw new ServiceError(400, visionRefusal);
  }

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
    if (outcome.status !== "ready") throw new ServiceError(404, "Session is not active");
    runner = outcome.runner;
  }
  // Reject before side effects; dispatch repeats the check to cover races.
  runner.assertCanDispatch();

  const activeAgentId = runner.agentId;
  const refusal = agentAdmissionError(deps.agentRegistry, activeAgentId);
  if (refusal) {
    throw new ServiceError(401, refusal);
  }

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

  // Graduate before dispatch so a new session cannot recycle this warm clone.
  const session = deps.sessionManager.get(sessionId);
  if (session?.warm) {
    graduateSession(
      { ...deps.graduation, sessionManager: deps.sessionManager, runnerRegistry: deps.runnerRegistry },
      { sessionId, userText: text, agentId: session.agentId ?? activeAgentId },
    );
    // This path bypasses claimSessionService, which normally refills the pool.
    if (session.remoteUrl && deps.warmSessionForRepo) {
      void deps.warmSessionForRepo(session.remoteUrl);
    }
  }

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
    resetMergedBranch: undefined,
    compactContext: undefined,
    silent: undefined,
  }));

  return { ok: true, queued: wasRunning };
}

// Validate now, but queue references so turn start reads current file content.
function asFileContextRef(file: FileAttachment): FileContextRef {
  return { path: file.path };
}
