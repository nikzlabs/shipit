/**
 * docs/252 phase 1 — the service catalogue's type layer.
 *
 * ShipIt integrates **harnesses** (agent CLIs), not models. A **service** is a
 * credentialed source of models; a **harness** is a CLI that speaks one or more
 * API styles. A model is offered on a harness when the service and the harness
 * share a style AND the catalogue declares that model under that style, under
 * the billing mode in use (requirements.md req 6).
 *
 * These types are the shape `docs/252-custom-models/catalogue.md` settles. The
 * rows themselves are in `services.ts` and `harnesses.ts`.
 *
 * **Node-free by construction.** The client imports this tree for display
 * labels and context windows, so nothing here may reach for `node:*` or for
 * `agent-registry.ts` (which does).
 */

import type { AgentId } from "../types/agent-types.js";
import type { AgentCapabilities } from "../types/agent-types.js";
import type { CanonicalModelKey, ModelFamily } from "./model-identity.js";

/**
 * An API wire format. Both services and harnesses hold a SET of these; the
 * service×harness join is an intersection, not an equality test — a harness
 * that speaks several styles is the shape a multi-provider CLI would need, and
 * a set costs one field now versus a re-cut later (catalogue.md, the survey).
 */
export type ApiStyle =
  | "anthropic-messages" // POST /v1/messages
  | "openai-responses" // POST /v1/responses
  | "openai-chat-completions"; // POST /v1/chat/completions

/**
 * How a service's models are paid for. `sub` is an allowance (a subscription or
 * plan); `key` is metered per token. This is the sole billing discriminator and
 * it is part of what the user *selects* (req 5) — never resolved out of sight.
 */
export type BillingMode = "sub" | "key";

/**
 * A harness is an agent CLI. `HarnessId` is `AgentId`: phase 1's whole point is
 * that `AgentId` keeps meaning *harness* and stops meaning "which credential"
 * or "which models" (plan.md, "The actual problem").
 */
export type HarnessId = AgentId;

/**
 * Selects the login/refresh implementation for a subscription mode delivered as
 * an account. Only `via: "account"` credentials need one.
 *
 * These identifiers are what replaces `AgentId` as the key for the existing
 * `AgentAuthManager` implementations (`agents/index.ts`); the re-keying itself
 * is phase 2's work, so nothing reads this field yet.
 */
export type LoginIntegrationId = "anthropic-oauth" | "openai-chatgpt";

/**
 * Selects the quota-reporting implementation — what fills req 10's indicator.
 * Keyed separately from the login flow because the two do not always come
 * together: GLM's coding plan is a subscription with a quota and no login flow.
 */
export type QuotaIntegrationId =
  | "anthropic-oauth-usage"
  | "openai-chatgpt-usage"
  | "zai-plan-usage";

/**
 * Per-model unit rates, USD per million tokens. **Always the service's API rate
 * for that model — never the incremental cost of a turn.** The billing mode
 * decides what the rate is *used for*: under a key it is what the user paid,
 * under a subscription it is req 16's "would have cost" comparison. That is why
 * a subscription row still carries a non-zero price even though its turns cost
 * nothing extra.
 *
 * Four rates is a deliberate approximation — real published pricing is richer
 * (tiered cache writes, per-request and image dimensions), and ShipIt records a
 * single `cache_create` figure, so the extra dimensions would have no token
 * counts to multiply. Figures derived from these are estimates and must be
 * labelled as such (catalogue.md, Pricing).
 */
export interface ModelPrice {
  /** USD per million uncached input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /**
   * USD per million tokens read from the prompt cache. Required, because ShipIt
   * already records this token class separately (`usage.ts`) and an absent rate
   * would silently price it at zero — the cache-heavy turn is exactly where
   * that is most wrong.
   */
  cacheRead: number;
  /**
   * USD per million tokens written to the prompt cache — ShipIt's
   * `cache_create`. A service with no separate cache-write charge sets this
   * equal to `input`; a service that charges nothing to write sets it to `0`,
   * which is a real answer rather than a missing one (the sentinel is negative
   * precisely so the two cannot be confused).
   */
  cacheWrite: number;
}

/**
 * Context window in tokens. `default` is required so a missing value is a
 * failure rather than an empty object.
 *
 * `byHarness` exists because the window ShipIt reports is per-harness telemetry
 * by construction — it comes from the app-server that ran the turn — and a
 * scalar could not hold two harnesses' answers for one model. Keyed by harness
 * and not by style, because two harnesses can share a style and still impose
 * different windows.
 */
export interface ContextWindow {
  default: number;
  byHarness?: Partial<Record<HarnessId, number>>;
}

export interface ModelDef {
  /** The id the harness forwards to the service, verbatim. */
  id: string;
  /** Human-facing label. Absorbs the client's old `MODEL_DISPLAY_NAMES` record. */
  label: string;
  /**
   * docs/261 req 4 — WHO this model is, across services. Two offerings sharing
   * this key are the same model, so one is not a second opinion on the other.
   *
   * Authored, never derived: `anthropic/claude-opus-5` and `claude-opus-5` are
   * one model under two ids, while `glm-5.2` and `glm-5.2[1m]` are one model
   * under two spellings of one service. Write it by spreading a declaration from
   * `model-identity.ts` (`...MODEL_IDENTITIES.opus5`) rather than typing the two
   * fields — that is what makes a mismatched pair unwritable.
   */
  canonicalModelKey: CanonicalModelKey;
  /**
   * docs/261 req 4 — what this model shares its TRAINING with. Req 4's first
   * ranking axis, and the reason a gateway-served Opus is not a distant reviewer
   * for an Anthropic-served one. Spread it with `canonicalModelKey`.
   */
  family: ModelFamily;
  /**
   * Styles this model is usable under, at this service, under this mode (req 6).
   *
   * INVARIANT: every entry must also be a key of the owning mode's `endpoints`.
   * The types cannot express that — `styles` and `endpoints` are independent —
   * so `catalogue.test.ts` enforces it. Without the check a row type-checks,
   * joins, and appears in the picker, and then cannot be spawned because there
   * is nowhere to send the request: a ShipIt-imposed failure of exactly the kind
   * reqs 1 and 6 exist to prevent.
   */
  styles: ApiStyle[];
  /** ALWAYS the service's API rate. See {@link ModelPrice}. */
  price: ModelPrice;
  /** Absorbs the server's old `MODEL_CONTEXT_WINDOWS` record. */
  contextWindow: ContextWindow;
}

/**
 * A model that has left the catalogue, and where a session pinned to it goes
 * (req 13). The record carries the retired model's own styles precisely because
 * the model is gone from `models` — that is the record the successor check
 * compares against, and a bare `oldId → newId` map could neither express a
 * successor that differs by style nor check the constraint at all.
 *
 * It deliberately carries **no** `canonicalModelKey` or `family` (docs/261): the
 * reviewer ranking is computed against *resolved* selections, and a retired pin
 * resolves through {@link RetiredModel.successors} onto a current model before
 * anything asks who it is. A retired row needs no identity because nothing ever
 * runs on one.
 */
export interface RetiredModel {
  id: string;
  /** The styles the retired model was declared under. */
  styles: ApiStyle[];
  /**
   * Successor per style. Usually one id repeated; occasionally not. Every style
   * in `styles` must appear here, and each successor must be a current model of
   * this same mode declared under that style — `catalogue.test.ts` enforces
   * both, which is what makes req 13's "never left unable to take a turn"
   * checkable at authoring time.
   */
  successors: Partial<Record<ApiStyle, string>>;
}

/**
 * Where a credential of a given shape must land for a CLI to read it.
 * `config-file` is the shape a CLI that reads neither flags nor environment
 * would need; no shipped harness uses it.
 */
export type CredentialTarget =
  | { kind: "env"; name: string }
  | { kind: "config-file"; path: string; pointer: string };

/**
 * SERVICE side: a credential shape a billing mode ACCEPTS — not the user's
 * credentials themselves, which are instances of these shapes and live in
 * storage with their own route ids.
 *
 * `via` is about DELIVERY — what ShipIt holds and how it reaches the CLI —
 * and **never** about billing. Collapsing the two is the mistake this shape
 * exists to prevent: a *subscription* can be delivered as a string in an
 * environment variable. This repository already contains one (`claude-env-oauth`,
 * a quota-bearing OAuth token ranked above the metered API-key route), and GLM's
 * coding plan is a subscription authenticated by an ordinary API key. A rule
 * keyed on "is this a key?" would refuse to fail over for both, turning a plan
 * outage into a stopped session.
 */
export type ModeCredential =
  | { via: "account"; login: LoginIntegrationId }
  | {
      via: "string";
      /**
       * The name of the variable ShipIt materializes this credential into at
       * spawn — NOT the place it is stored. Storage is per credential instance
       * (phase 2).
       */
      storageEnv: string;
      /**
       * Per-harness override of where the secret lands. Exists because
       * `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are not interchangeable
       * at the wire (an `x-api-key` header versus a bearer token), so which one
       * an Anthropic-*compatible* third-party endpoint wants is a fact about
       * that service, not about Claude Code. Most services need no override;
       * the field exists so the one that does is a row edit rather than a
       * special case in spawn code.
       */
      targetOverride?: Partial<Record<HarnessId, CredentialTarget>>;
    };

interface ModeCommon {
  /** Per-style base URL. One base URL per service is wrong for a service whose styles live at different paths. */
  endpoints: Partial<Record<ApiStyle, string>>;
  models: ModelDef[];
  retired: RetiredModel[];
  /**
   * The credential shapes this mode accepts. A list because one mode can accept
   * several: Anthropic's subscription takes both OAuth accounts and an
   * env-supplied token.
   */
  credentials: ModeCredential[];
}

/**
 * `kind` is the sole billing discriminator, and `quota` is required exactly
 * where a quota exists — encoded in the union rather than as an optional field,
 * so "a subscription with nowhere to read its quota from" (req 10) cannot be
 * declared.
 */
export type BillingModeDef =
  | (ModeCommon & { kind: "key" })
  | (ModeCommon & { kind: "sub"; quota: QuotaIntegrationId });

export interface ServiceDef {
  id: string;
  name: string;
  /**
   * One or two modes. INVARIANT: at most one mode per `kind` per service — two
   * would make one {@link ModelSelection} match two rows with no tie-break.
   * Enforced by `catalogue.test.ts`.
   */
  modes: BillingModeDef[];
}

/**
 * HARNESS side: where a credential of each `via` shape lands for THIS CLI, by
 * default. Keyed by `via`, NOT by billing `kind`.
 *
 * Both optional, and the narrowing runs both ways: a key-only CLI would
 * otherwise have to invent a fake account destination, and an account-backed
 * service could be made falsely eligible.
 *
 * INVARIANT: at least one is present, or the harness can authenticate nothing
 * at all. Eligibility (phase 3) must read this — a mode whose credential shapes
 * this harness cannot carry is not offered, rather than offered and failing at
 * spawn.
 */
export interface CredentialTargets {
  /** Absent ⇒ an OAuth-only CLI. */
  string?: CredentialTarget;
  /** Absent ⇒ a key-only CLI. */
  account?: { kind: "scoped-home" } | CredentialTarget;
}

/** How a harness is driven: where the credential, the model and the endpoint go. */
export interface SpawnShape {
  credential: CredentialTargets;
  /**
   * How the model id reaches the process. The two shipped harnesses differ —
   * Claude Code takes a process flag, Codex a JSON-RPC `turn/start` field — so
   * "set the model" is two implementations, not one.
   */
  model: { kind: "flag"; flag: string } | { kind: "turn-payload"; field: string };
  /**
   * How the endpoint is overridden. `none` means the harness offers no way, in
   * which case it can only reach its own vendor.
   *
   * NOTE: neither shipped adapter has any base-URL handling today — no field on
   * `AgentRunParams`, no flag, no provider config written. Phase 3 writes that
   * seam; this declares where it will land.
   */
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
  /**
   * The service this CLI's own vendor provides, when there is one. Declared
   * because the metered-spend column may source from the harness only on this
   * service, and an undeclared "everyone knows Claude Code means Anthropic"
   * mapping is exactly the harness/service conflation this feature removes.
   */
  nativeService?: string;
  /**
   * A SET, not a scalar. When the overlap holds more than one style, the
   * resolved style is the **first entry of this array** the model also
   * declares — so the order is a preference, not incidental. Both shipped
   * harnesses declare one style, so the rule is a no-op today.
   */
  styles: ApiStyle[];
  spawn: SpawnShape;
  /**
   * Everything `AgentCapabilities` holds today **except `models`**. That single
   * removal is the whole type-level content of this feature: which models exist
   * is a property of the service, not of the CLI.
   */
  capabilities: Omit<AgentCapabilities, "models">;
}

/**
 * The identity of a selected model (req 5) — never a bare model id. The same id
 * is reachable through a vendor directly and through a gateway, at different
 * prices and possibly different API styles, and through two modes of one
 * service at different prices; so a bare id cannot say who is billing you.
 *
 * The resolved API style is deliberately NOT part of this: the user picks a
 * service, a mode and a model, and which wire format carries it is ShipIt's
 * business. A fourth element would make the persisted identity depend on a
 * catalogue detail that can be re-ordered later.
 */
export interface ModelSelection {
  serviceId: string;
  billingMode: BillingMode;
  modelId: string;
}

/**
 * Sentinels for values that have not been checked. Phase 1 replaces every one
 * and `catalogue.test.ts` asserts no shipped row still carries either.
 *
 * **Negative rather than zero**, and that is load-bearing in both directions:
 * zero is a legitimate price (OpenAI charges nothing to write the cache on
 * models before the GPT-5.6 family) and a legitimate-looking context window, so
 * a zero sentinel would read as an answer and a forgotten row would ship silently.
 */
export const PRICE_TODO: ModelPrice = { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 };
export const CONTEXT_TODO: ContextWindow = { default: -1 };

/** True when any rate in `price` is a sentinel (or otherwise negative). */
export function isPriceSentinel(price: ModelPrice): boolean {
  return price.input < 0 || price.output < 0 || price.cacheRead < 0 || price.cacheWrite < 0;
}

/** True when the window (or any per-harness override) is a sentinel. */
export function isContextSentinel(window: ContextWindow): boolean {
  if (window.default <= 0) return true;
  return Object.values(window.byHarness ?? {}).some((v) => typeof v === "number" && v <= 0);
}
