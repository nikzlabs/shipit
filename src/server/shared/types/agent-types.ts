import type { EventEmitter } from "node:events";
import type { ImageAttachment, PermissionMode } from "./attachment-types.js";
import type { ApiStyle, BillingMode, CredentialTarget } from "../catalogue/types.js";
import type { McpServerConfig, McpServerStatus } from "./mcp-types.js";

export type AgentId = "claude" | "codex" | "opencode" | "grok";

export const CLAUDE_PERMISSION_MODES: PermissionMode[] = ["auto", "plan", "guarded"];

export const GROK_PERMISSION_MODES: PermissionMode[] = ["auto", "plan", "guarded"];

export interface AgentReasoningCapability {
  label: string;
  /** CLI vocabulary; intersect with billing modes and model efforts for the picker. */
  options: { value: string; label: string }[];
  /** Modes that transmit effort. Absent means all; Grok drops it under API keys. */
  billingModes?: BillingMode[];
}

export interface RoleOverrides {
  harnessId?: AgentId | undefined;
  serviceId?: string | undefined;
  billingMode?: BillingMode | undefined;
  modelId?: string | undefined;
  reasoningEffort?: string | undefined;
}

export type SpawnTarget =
  | {
      kind: "role";
      role: string;
      overrides: RoleOverrides;
    }
  | {
      kind: "explicit";
      harnessId: AgentId;
      serviceId: string;
      billingMode: BillingMode;
      modelId: string;
      /** Required exactly when the harness offers levels. */
      reasoningEffort?: string;
    }
  | {
      kind: "inherit";
      overrides: RoleOverrides;
      /** Keep parent parameters but omit its role name and instructions. */
      noRole?: boolean;
    };

export type SubAgentSpawnTarget = Extract<SpawnTarget, { kind: "role" | "explicit" }>;

/** Order breaks distance ties; second can rank ahead of first. */
export type ReviewerSlot = "first" | "second";

export const REVIEWER_SLOTS: readonly ReviewerSlot[] = ["first", "second"];

/** Harness is derived per review, never pinned. */
export interface ReviewerPin {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  /** Absent only when the derived harness offers no levels. */
  reasoningEffort?: string;
}

export interface ReviewerResolved {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  serviceName: string;
  label: string;
  harnessId: AgentId;
  harnessName: string;
  reasoningEffort?: string;
  reasoningLabel?: string;
  /** All eligible harnesses that substitute for this pin's level, not just the displayed one. */
  effortSubstitutions?: ReviewerEffortElsewhere[];
}

export interface ReviewerEffortElsewhere {
  harnessId: AgentId;
  harnessName: string;
  reasoningEffort?: string;
  reasoningLabel?: string;
}

export interface ReviewerSlotView {
  slot: ReviewerSlot;
  source: "pinned" | "auto";
  pin?: ReviewerPin;
  resolved?: ReviewerResolved;
  unavailableReason?: "pin_unavailable" | "nothing_eligible";
}

export interface ReviewerPinPatch {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  /** Omission asks the server to derive the level for the new selection. */
  reasoningEffort?: string;
}

/** Exact, case-sensitive reservation. */
export const RESERVED_ROLE_NAME = "reviewer";

export interface RolePinnedParams {
  kind: "pinned";
  harnessId: AgentId;
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
  /** Absent means pass no flag; legal on every harness. */
  reasoningEffort?: string;
}

/** Only the reserved reviewer can derive its parameters per run. */
export interface RoleAutoParams {
  kind: "auto";
}

export type RoleParams = RolePinnedParams | RoleAutoParams;

export interface AgentRole {
  name: string;
  description?: string;
  prompt?: string;
  params: RoleParams;
}

/** Edit stranded roles; reconnect disconnected services; wait for exhausted quota. */
export type RoleUnavailableReason = "stranded" | "disconnected" | "quota_exhausted";

export interface RoleResolved {
  harnessId: AgentId;
  harnessName: string;
  serviceId: string;
  billingMode: BillingMode;
  serviceName: string;
  modelId: string;
  label: string;
  reasoningEffort?: string;
  reasoningLabel?: string;
}

export interface RoleView {
  name: string;
  description?: string;
  prompt?: string;
  params: RoleParams;
  reserved: boolean;
  /** Absent for unavailable roles and the reviewer, whose two slots resolve separately. */
  resolved?: RoleResolved;
  unavailableReason?: RoleUnavailableReason;
  invalidField?: "harnessId" | "service" | "billingMode" | "model" | "reasoningEffort";
  earliestResetAt?: string | null;
}

export interface RoleWrite {
  /** Absent creates; different from the key renames. */
  previousName?: string;
  description?: string;
  prompt?: string;
  params: RoleParams;
}

export interface AgentCapabilities {
  supportsResume: boolean;
  supportsImages: boolean;
  supportsSystemPrompt: boolean;
  supportsPermissionModes: boolean;
  supportedPermissionModes: PermissionMode[];
  toolNames: string[];
  models: string[];
  reasoning?: AgentReasoningCapability;
  supportsReview: boolean;
  supportsSteering: boolean;
  /** Resolve through the registry, not proxy defaults. Absent is false; late output alone is not a new turn. */
  startsOwnTurns?: boolean;
  supportsCompaction: boolean;
  skillsDirName: string;
  skillInvocationPrefix: string;
}

export interface AgentInitEvent {
  type: "agent_init";
  agentId: AgentId;
  sessionId: string;
  model?: string;
  tools?: string[];
  /** Actual CLI mode: Claude's auto confirms guarded mode. */
  permissionMode?: string;
}

export interface AgentAssistantEvent {
  type: "agent_assistant";
  content: AgentContentBlock[];
  parentToolUseId?: string;
  /** Full final text for the summary; do not append again after streamed deltas. */
  isStreamCompletion?: boolean;
}

export interface AgentToolResultEvent {
  type: "agent_tool_result";
  content: unknown[];
  parentToolUseId?: string;
}

export interface AgentResultEvent {
  type: "agent_result";
  status: "success" | "error";
  sessionId: string;
  cost?: { totalUsd: number };
  /** Turn-wide sums for billing, not context occupancy. */
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Last call's input plus cache reads and writes. */
  contextTokens?: number;
  /** Prefer the reported window to the static fallback. */
  contextWindow?: number;
  durationMs?: number;
  error?: string;
  /** Classifier denials only, not model self-refusals. */
  permissionDenials?: { toolName: string; toolUseId?: string; toolInput?: unknown }[];
}

/** Percentages are 0–100; null usage means unreported, not zero. */
export interface AgentRateLimitsEvent {
  type: "agent_rate_limits";
  session: { usedPct: number | null; resetAt: string } | null;
  weekly: { usedPct: number | null; resetAt: string } | null;
}

export interface AgentSteerRejectedEvent {
  type: "agent_steer_rejected";
  text: string;
}

/** Delivery ack, not proof of application in this turn; the CLI may start its own next turn. */
export interface AgentUserReplayEvent {
  type: "agent_user_replay";
  text: string;
}

export interface AgentCompactionStartedEvent {
  type: "agent_compaction_started";
  trigger?: "manual" | "auto";
}

export interface AgentCompactedEvent {
  type: "agent_compacted";
  trigger?: "manual" | "auto";
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
}

export interface AgentPermissionRequestEvent {
  type: "agent_permission_request";
  requestId: string;
  toolName: string;
  path?: string;
  summary?: string;
  details?: string;
  agentId?: AgentId;
}

/** Only the user's answer settles a request; no timeout or expiry. */
export interface AgentPermissionResolvedEvent {
  type: "agent_permission_resolved";
  requestId: string;
  behavior: "allow" | "deny";
  remembered?: boolean;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  remember?: boolean;
  message?: string;
}

export interface PermissionRequestInput {
  toolName: string;
  input?: Record<string, unknown>;
  path?: string;
  summary?: string;
  agentId?: AgentId;
  /** Broker idempotency key; retries share one pending card. */
  toolUseId?: string;
}

export type PermissionRequester = (input: PermissionRequestInput) => Promise<PermissionDecision>;

export interface AgentBackgroundTasksEvent {
  type: "agent_background_tasks";
  /** Complete list; empty means drained. */
  tasks: { id: string; type?: string; description?: string }[];
}

export interface AgentSelfWakeEvent {
  type: "agent_self_wake";
  taskId?: string;
  /** Shell status or full subagent report; distinguish by toolUseId, not text. */
  summary?: string;
  status?: string;
  toolUseId?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
}

export type AgentEvent =
  | AgentInitEvent
  | AgentAssistantEvent
  | AgentToolResultEvent
  | AgentResultEvent
  | AgentRateLimitsEvent
  | AgentSteerRejectedEvent
  | AgentUserReplayEvent
  | AgentCompactionStartedEvent
  | AgentCompactedEvent
  | AgentPermissionRequestEvent
  | AgentPermissionResolvedEvent
  | AgentBackgroundTasksEvent
  | AgentSelfWakeEvent;

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** Names a worker env variable, never carries the secret itself. */
export interface StringServiceRouting {
  serviceId: string;
  serviceName: string;
  billingMode: BillingMode;
  style: ApiStyle;
  baseUrl: string;
  credentialSourceEnv: string;
  credentialTarget: CredentialTarget;
}

export interface OpenAIAccountRouting {
  serviceId: "openai";
  serviceName: string;
  billingMode: "sub";
  style: "openai-responses";
  baseUrl: string;
  credentialSourceEnv?: never;
  credentialTarget: { kind: "openai-chatgpt"; accountId: string };
}

export type ServiceRouting = StringServiceRouting | OpenAIAccountRouting;

export interface AgentRunParams {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: ImageAttachment[];
  cwd: string;
  permissionMode?: PermissionMode;
  mcpConfigPath?: string;
  /** Unresolved secret placeholders; the adapter resolves against its environment. */
  mcpServers?: McpServerConfig[];
  model?: string;
  serviceRouting?: ServiceRouting;
  /** Per-spawn isolation overrides the adapter's home resolver. */
  homeDir?: string;
  reasoningEffort?: string;
  settingsPath?: string;
  autoCreatePr?: boolean;
  sandbox?: boolean;
  guardDestructiveGit?: boolean;
  useStreaming?: boolean;
  compact?: boolean;
}

export interface AgentMcpBridge {
  /** node for compiled bundles, tsx for source. */
  tsxBin: string;
  bridgePath: string;
}

export interface AgentMcpWriteContext {
  /** Unresolved placeholders. */
  servers: McpServerConfig[];
  /** null omits the bridge without failing agent start. */
  shipitBridge: AgentMcpBridge | null;
  onServerFailed: (name: string, reason: string) => void;
}

export interface AgentMcpWriteResult {
  mcpConfigPath?: string;
  /** Pass secrets at spawn instead of storing them in config. */
  runtimeEnv?: Record<string, string>;
  cleanup?: () => void;
}

export interface AgentProcessEvents {
  event: [AgentEvent];
  done: [exitCode: number];
  error: [Error];
  auth_required: [];
  log: [source: string, text: string];
  mcp_status: [McpServerStatus[]];
  /** Settle only: the newer spawn owns teardown, queue drain, and commit. */
  superseded: [];
}

export interface AgentProcess extends EventEmitter<AgentProcessEvents> {
  readonly agentId: AgentId;
  readonly capabilities: AgentCapabilities;

  run(params: AgentRunParams): void;
  writeStdin(data: string): void;
  sendUserMessage(text: string, opts?: { images?: ImageAttachment[] }): void;
  /** done fires on process exit, not on each turn's end. */
  readonly isStreaming: boolean;
  interrupt(): void;
  kill(): void;
  setPermissionMode?(mode: PermissionMode | undefined): void;
  /** Resident process only; without one, spawn run({ compact: true }). */
  compact?(instructions?: string): void;
  resolvePermission?(requestId: string, decision: PermissionDecision): void;
  setPermissionRequester?(requester: PermissionRequester): void;
  /** Correlates a surviving worker turn after orchestrator restart. */
  setDeliveryId?(deliveryId: string): void;
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult;
}

/** Keep additive: old workers survive orchestrator deploys. */
export interface WorkerAgentStartBody {
  agentId: AgentId;
  params: AgentRunParams;
  runToken?: string;
  deliveryId?: string;
}

export interface WorkerAgentKillBody {
  /** Ignore delayed kills for a different spawn; absent is an unconditional legacy kill. */
  runToken?: string;
}

export interface WorkerAgentStatus {
  /** Process exists, including idle-resident. */
  running: boolean;
  latestSseSeq: number;
  oldestSseSeq?: number;
  /** Orchestrator-started turn is active; absent means unknown on legacy workers. */
  turnActive?: boolean;
  turnStartSseSeq?: number;
  runToken?: string;
  deliveryId?: string;
  agentId?: AgentId;
  streaming?: boolean;
  backgroundTaskCount?: number;
  /** Busy, but does not assert replayability from turnStartSseSeq. */
  selfWakeActive?: boolean;
  /** A PTY exists; does not imply it is doing work. */
  terminalActive?: boolean;
  installRunning?: boolean;
}
