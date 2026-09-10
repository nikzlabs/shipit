// This tree is imported by the client; keep Node dependencies out.
import type { AgentId } from "../types/agent-types.js";
import type { AgentCapabilities } from "../types/agent-types.js";
import type { CanonicalModelKey, ModelFamily } from "./model-identity.js";

export type ApiStyle =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat-completions";

/** Allowance versus metered billing; independent of credential delivery. */
export type BillingMode = "sub" | "key";

export type HarnessId = AgentId;

export type LoginIntegrationId =
  | "anthropic-oauth"
  | "openai-chatgpt"
  | "xai-oauth";

export type QuotaIntegrationId =
  | "anthropic-oauth-usage"
  | "openai-chatgpt-usage"
  | "zai-plan-usage"
  // No per-key usage reader; Go reacts to service 429s.
  | "opencode-go-usage"
  | "xai-plan-usage";

/** API rates in USD per million tokens, including subscription cost comparisons. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Use input when writes have no separate rate; zero means free writes. */
  cacheWrite: number;
}

/** Tokens; harness telemetry can impose different limits for the same model. */
export interface ContextWindow {
  default: number;
  byHarness?: Partial<Record<HarnessId, number>>;
}

export interface ModelDef {
  harnesses?: HarnessId[];
  id: string;
  label: string;
  canonicalModelKey: CanonicalModelKey;
  family: ModelFamily;
  /** Each style must have an endpoint in the owning mode. */
  styles: ApiStyle[];
  price: ModelPrice;
  contextWindow: ContextWindow;
  /** Absent inherits harness levels; [] disables them. Values must come from the harness. */
  reasoningEfforts?: string[];
}

export interface RetiredModel {
  id: string;
  styles: ApiStyle[];
  /** Cover every retired style with a current model in the same service and mode. */
  successors: Partial<Record<ApiStyle, string>>;
}

export type CredentialTarget =
  | { kind: "env"; name: string }
  | { kind: "config-file"; path: string; pointer: string };

export type ModeCredential =
  | {
      via: "account";
      login: LoginIntegrationId;
      /** Shared API styles do not imply account compatibility. */
      carriers?: HarnessId[];
    }
  | {
      via: "string";
      /** Spawn delivery variable, not the credential's storage location. */
      storageEnv: string;
      /** API-key and bearer-token variables can produce different headers. */
      targetOverride?: Partial<Record<HarnessId, CredentialTarget>>;
      /** Absent permits any compatible string target; subscription tokens may need restrictions. */
      carriers?: HarnessId[];
    };

interface ModeCommon {
  endpoints: Partial<Record<ApiStyle, string>>;
  models: ModelDef[];
  retired: RetiredModel[];
  credentials: ModeCredential[];
}

// IMPLEMENTED_QUOTA_INTEGRATIONS determines whether a declared quota has a reader.
export type BillingModeDef =
  | (ModeCommon & { kind: "key" })
  | (ModeCommon & { kind: "sub"; quota: QuotaIntegrationId });

export interface ServiceDef {
  id: string;
  name: string;
  /** At most one mode per kind; catalogue.test.ts enforces this. */
  modes: BillingModeDef[];
}

/** At least one destination must exist; absent shapes cannot authenticate. */
export interface CredentialTargets {
  string?: CredentialTarget & { styles?: ApiStyle[] };
  account?: ({ kind: "scoped-home" } | CredentialTarget) & { styles?: ApiStyle[] };
}

export interface SpawnShape {
  credential: CredentialTargets;
  model: { kind: "flag"; flag: string } | { kind: "turn-payload"; field: string };
  endpoint:
    | { kind: "env"; name: string }
    | { kind: "config"; key: string }
    | { kind: "config-file"; path: string; pointer: string }
    | { kind: "none" };
}

export interface HarnessDef {
  id: HarnessId;
  name: string;
  binary: string;
  nativeService?: string;
  /** Ordered by preference when several styles match. */
  styles: ApiStyle[];
  spawn: SpawnShape;
  capabilities: Omit<AgentCapabilities, "models">;
}

// A bare model ID cannot identify the service or billing mode.
export interface ModelSelection {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
}

// Zero is a valid price, so missing rates use a negative sentinel.
export const PRICE_TODO: ModelPrice = { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 };
export const CONTEXT_TODO: ContextWindow = { default: -1 };

export function isPriceSentinel(price: ModelPrice): boolean {
  return price.input < 0 || price.output < 0 || price.cacheRead < 0 || price.cacheWrite < 0;
}

export function isContextSentinel(window: ContextWindow): boolean {
  if (window.default <= 0) return true;
  return Object.values(window.byHarness ?? {}).some((v) => typeof v === "number" && v <= 0);
}
