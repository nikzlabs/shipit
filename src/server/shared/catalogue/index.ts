/**
 * docs/252 phase 1 — the derived view over the catalogue.
 *
 * Nothing here decides policy; it answers the questions the rest of the product
 * asks of the rows. The service×harness **join** lives here (an intersection of
 * style sets, per req 6), as does the resolution of a bare model id into the
 * `(serviceId, billingMode, modelId)` triple that replaces it.
 *
 * Phase 1 boundary, stated once so it is not mistaken for an oversight:
 * **eligibility is not here.** Whether a mode has a usable credential is req 8's
 * question and phase 3's code. Everything below is the catalogue's own view —
 * what exists, not what this install can run.
 */

import type { AgentId } from "../types/agent-types.js";
import { HARNESSES } from "./harnesses.js";
import { SERVICES, type ServiceId } from "./services.js";
import type {
  ApiStyle,
  BillingMode,
  BillingModeDef,
  CredentialTarget,
  CredentialTargets,
  HarnessDef,
  LoginIntegrationId,
  ModeCredential,
  ModelDef,
  ModelSelection,
  QuotaIntegrationId,
  ServiceDef,
} from "./types.js";
import type { ModelIdentity } from "./model-identity.js";

export * from "./types.js";
export * from "./model-identity.js";
export { HARNESSES } from "./harnesses.js";
export { SERVICES, type ServiceId } from "./services.js";

/**
 * Compile-time proof that `ServiceId` really is the union of the shipped rows.
 * If a row's id changes and a consumer still names the old one, this stops being
 * assignable — which is the whole benefit of deriving the union from the data.
 */
const _SERVICE_IDS_ARE_LITERAL: readonly ServiceId[] = SERVICES.map((s) => s.id);
void _SERVICE_IDS_ARE_LITERAL;

/** Every service, in catalogue order. Order is load-bearing: it decides defaults. */
export function allServices(): readonly ServiceDef[] {
  return SERVICES;
}

/** Every harness ShipIt knows how to drive, in catalogue order. */
export function allHarnesses(): readonly HarnessDef[] {
  return HARNESSES;
}

export function getService(serviceId: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === serviceId);
}

export function getHarness(harnessId: AgentId): HarnessDef | undefined {
  return HARNESSES.find((h) => h.id === harnessId);
}

/**
 * The service a harness's own vendor provides, when there is one. The bias a
 * caller holding only a model id should pass to {@link resolveModelSelection}:
 * before this feature a harness could reach nothing else, so a legacy id from a
 * `claude` session is an Anthropic id even though a gateway may list the same
 * string.
 */
export function nativeServiceForHarness(harnessId: AgentId | undefined): string | undefined {
  return harnessId ? getHarness(harnessId)?.nativeService : undefined;
}

/**
 * The harness whose own vendor provides this service — the inverse of
 * {@link nativeServiceForHarness}.
 *
 * It exists for exactly one job and should not grow others: bridging the
 * docs/150 account machinery, which is still keyed by `AgentId`, to the
 * `(service, billing mode)` key credentials are now stored under. Anthropic's
 * subscription accounts are Claude Code's `claude` accounts and OpenAI's are
 * Codex's `codex` accounts, and that correspondence is exactly what phase 3
 * removes when eligibility and routing stop asking "which vendor's agent is
 * this?". A caller reaching for this to answer anything else is reintroducing
 * the conflation.
 */
export function harnessForNativeService(serviceId: string): AgentId | undefined {
  return HARNESSES.find((h) => h.nativeService === serviceId)?.id;
}

// ---- Login integrations (docs/252 phase 2's deferred re-key) ----
//
// `LoginIntegrationId` is what a login FLOW is keyed by: which sign-in
// implementation runs, and whose credentials it writes. It replaces `AgentId`
// for that job, because a harness is not a vendor — the same reasoning
// `LimitsProvider` already applies to quota.
//
// Deliberately NOT re-keyed, and both are load-bearing:
//
//   - **The credential root on disk** stays keyed by harness
//     (`provider-accounts/<AgentId>/<accountId>`). Its *contents* are the CLI's
//     own home directory — `<root>/.claude` + `.claude.json`, `<root>/.codex` —
//     so the directory is genuinely harness-shaped. Re-keying it would orphan
//     every connected account's tokens and force every user to sign in again,
//     while the old directories sat on disk still holding live credentials.
//   - **`AgentRegistry.refreshAuth`** stays keyed by harness, because "can this
//     CLI run a model now" is a question about the CLI. What changes is that a
//     completed login no longer implies ONE harness — see
//     {@link harnessesForLoginIntegration}.

/**
 * The login flow that authenticates this service, when it has one.
 *
 * A service has a login integration when any of its modes accepts an
 * account-delivered credential. A service authenticated only by a supplied
 * string (DeepSeek, the gateways) has none, which is why this returns
 * `undefined` rather than throwing.
 */
export function loginIntegrationForService(
  serviceId: string | undefined,
): LoginIntegrationId | undefined {
  if (!serviceId) return undefined;
  for (const mode of getService(serviceId)?.modes ?? []) {
    for (const credential of mode.credentials) {
      if (credential.via === "account") return credential.login;
    }
  }
  return undefined;
}

/** The service a login flow authenticates — the inverse of {@link loginIntegrationForService}. */
export function serviceForLoginIntegration(
  loginId: LoginIntegrationId,
): ServiceId | undefined {
  return SERVICES.find((service) =>
    service.modes.some((mode) =>
      mode.credentials.some((c) => c.via === "account" && c.login === loginId),
    ),
  )?.id;
}

/** Every login flow the catalogue declares, in service order. */
export function allLoginIntegrations(): LoginIntegrationId[] {
  const seen: LoginIntegrationId[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const credential of mode.credentials) {
        if (credential.via === "account" && !seen.includes(credential.login)) {
          seen.push(credential.login);
        }
      }
    }
  }
  return seen;
}

/**
 * The harnesses a completed sign-in on this login flow can change the answer
 * for — the fan-out set for `AgentRegistry.refreshAuth`.
 *
 * **This is the assumption the re-key exists to break, so it is computed rather
 * than assumed.** While every login serves exactly one harness, "refresh the
 * harness that owns this flow" and "refresh every harness this credential could
 * run" are the same set, and the distinction is invisible. They stop being the
 * same set for the first provider-neutral harness: an OpenCode signed in
 * against Anthropic draws on the same credential Claude Code does, so a
 * completed Anthropic login must make BOTH harnesses re-evaluate what they can
 * run. A `refreshAuth(agentId)` written against the 1:1 shape would silently
 * refresh one of them, and nothing would fail until that harness shipped.
 *
 * The set is the catalogue's own join: every harness sharing an API style with
 * a mode of this login's service. It yields exactly `["claude"]` and
 * `["codex"]` today — asserted in `catalogue.test.ts`, so a future row that
 * widens it does so visibly.
 */
/**
 * The harness whose CLI this login flow actually drives, and whose home
 * directory the resulting credentials land in.
 *
 * The deliberate counterpart to {@link harnessesForLoginIntegration}, and the
 * distinction is the whole point of the re-key:
 *
 *   - ONE harness *runs* the sign-in and owns the files it writes — this
 *     function. Reading those files back (duplicate detection, pushing the
 *     token to pinned sessions) is a question about that CLI's own layout.
 *   - MANY harnesses may *consume* the credential afterwards — that function.
 *
 * Today both answers name the same single harness, which is exactly why the old
 * `AgentId` key looked adequate.
 */
export function credentialHarnessForLogin(loginId: LoginIntegrationId): AgentId | undefined {
  const serviceId = serviceForLoginIntegration(loginId);
  return serviceId ? harnessForNativeService(serviceId) : undefined;
}

export function harnessesForLoginIntegration(loginId: LoginIntegrationId): AgentId[] {
  const serviceId = serviceForLoginIntegration(loginId);
  const service = serviceId ? getService(serviceId) : undefined;
  if (!service) return [];
  // Only the modes that actually accept THIS login. A service can hold a
  // subscription and a metered key, and the key mode's models say nothing about
  // who can use the account credential this login produces.
  const modes = service.modes.filter((mode) =>
    mode.credentials.some((c) => c.via === "account" && c.login === loginId),
  );
  // Joined on the MODELS' styles via `resolveStyle`, exactly as
  // `catalogueEntriesForHarness` does — not on the mode's endpoint keys. The
  // catalogue only guarantees model style ⊆ endpoint styles, so an endpoint
  // declared for a style no model uses would include a harness whose eligible
  // set this login can never change. Two answers to "can this harness run
  // something here" must not be computed two ways.
  //
  // A shared style is still not enough, and there are TWO ways it isn't.
  //
  // First, the credential is account-delivered, so a harness declaring no
  // account destination could never carry it however well the wire formats
  // line up.
  //
  // Second — and this is what a shared style actively gets wrong — the mode may
  // name its `carriers`. An OAuth account is a login to one vendor's account
  // system, so speaking the same wire format says nothing about being able to
  // present it: Grok speaks `openai-responses` and carries an account target,
  // yet cannot authenticate against ChatGPT (planning#435). Without this
  // clause a ChatGPT sign-in would fan out to Grok and re-evaluate an eligible
  // set it can never change.
  return HARNESSES.filter(
    (harness) =>
      harness.spawn.credential.account !== undefined
      && modes.some(
        (mode) =>
          mode.credentials.some(
            (c) =>
              c.via === "account"
              && c.login === loginId
              && (!c.carriers || c.carriers.includes(harness.id)),
          )
          && mode.models.some((model) => resolveStyle(harness.id, model) !== undefined),
      ),
  ).map((harness) => harness.id);
}

export function getMode(serviceId: string, billingMode: BillingMode): BillingModeDef | undefined {
  return getService(serviceId)?.modes.find((m) => m.kind === billingMode);
}

/** The model a selection names, or `undefined` when the triple names no row. */
export function getModel(selection: ModelSelection): ModelDef | undefined {
  return getMode(selection.serviceId, selection.billingMode)?.models.find(
    (m) => m.id === selection.modelId,
  );
}

/** True when the catalogue contains the row this triple names. */
export function selectionExists(selection: ModelSelection): boolean {
  return getModel(selection) !== undefined;
}

/**
 * docs/261 req 4 — **who** a selection resolves to: its canonical model and its
 * training lineage. `undefined` for a triple naming no row.
 *
 * The one entry point for both fields, so no caller reads one without the other
 * and re-derives the distinction the two exist to keep apart (`model-identity.ts`).
 */
export function modelIdentityFor(selection: ModelSelection): ModelIdentity | undefined {
  const model = getModel(selection);
  if (!model) return undefined;
  return { canonicalModelKey: model.canonicalModelKey, family: model.family };
}

/**
 * The API style a turn on this `(harness, model)` pair would use: **the first
 * entry of the harness's `styles` that the model also declares**.
 *
 * The harness's array is therefore ordered by preference, not incidentally.
 * Returns `undefined` when the sets do not intersect, which is exactly "this
 * harness cannot run this model" (req 6).
 *
 * Both shipped harnesses declare one style, so this is a no-op today. It exists
 * because the alternative — discovering the ambiguity in phase 3 with an
 * implementer picking arbitrarily — is how a silent per-turn inconsistency gets
 * built.
 */
export function resolveStyle(harnessId: AgentId, model: ModelDef): ApiStyle | undefined {
  const harness = getHarness(harnessId);
  if (!harness) return undefined;
  return harness.styles.find((style) => model.styles.includes(style));
}

/** The endpoint a turn on this selection and harness would be sent to. */
export function resolveEndpoint(harnessId: AgentId, selection: ModelSelection): string | undefined {
  const mode = getMode(selection.serviceId, selection.billingMode);
  const model = mode?.models.find((m) => m.id === selection.modelId);
  if (!mode || !model) return undefined;
  const style = resolveStyle(harnessId, model);
  return style ? mode.endpoints[style] : undefined;
}

// ---- Credentials (phase 2) -------------------------------------------------

/**
 * Every environment-variable name the catalogue names as a credential's
 * `storageEnv`, de-duplicated, in catalogue order.
 *
 * This is the "compile-time env-key name per `(service, billing mode)`" phase 2
 * owes: `ALLOWED_ENV_KEYS` derives from it, so adding a service to the
 * catalogue is the *only* edit its key name needs. Per mode and not per
 * service, deliberately — GLM declares one name for its coding plan and another
 * for its ordinary key, and a per-service name could not say that.
 */
export function credentialStorageEnvNames(): string[] {
  const out: string[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const credential of mode.credentials) {
        if (credential.via !== "string") continue;
        if (!out.includes(credential.storageEnv)) out.push(credential.storageEnv);
      }
    }
  }
  return out;
}

/** The credential shape a mode accepts for a given delivery, if it accepts one. */
export function modeCredentialFor(
  serviceId: string,
  billingMode: BillingMode,
  via: "account" | "string",
): ModeCredential | undefined {
  return getMode(serviceId, billingMode)?.credentials.find((c) => c.via === via);
}

/**
 * The variable a credential of this mode is materialized into at spawn, before
 * any per-harness `targetOverride`. `undefined` when the mode accepts no
 * string-delivered credential at all (an OAuth-only subscription).
 */
export function storageEnvFor(serviceId: string, billingMode: BillingMode): string | undefined {
  const credential = modeCredentialFor(serviceId, billingMode, "string");
  return credential?.via === "string" ? credential.storageEnv : undefined;
}

/**
 * The `(service, billing mode)` that claims an environment-variable name as its
 * credential's `storageEnv`, if any. The inverse of {@link storageEnvFor}.
 *
 * First match wins in catalogue order. The catalogue does not currently reuse a
 * name across two modes, and it should not: the same variable meaning two
 * different credentials is the single-slot collision this design removes. It is
 * not expressible as a type constraint, so `catalogue.test.ts` asserts it.
 */
export function credentialModeForStorageEnv(
  envName: string,
): { serviceId: ServiceId; billingMode: BillingMode } | undefined {
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const credential of mode.credentials) {
        if (credential.via === "string" && credential.storageEnv === envName) {
          return { serviceId: service.id, billingMode: mode.kind };
        }
      }
    }
  }
  return undefined;
}

/**
 * May this mode hold more than one credential?
 *
 * **Yes exactly when it is a subscription**, and the rule keys on billing and
 * not on delivery for the reason the whole design exists: req 12 fails over
 * between subscriptions of one service and never between keys, so a `key` mode
 * can only ever use one credential — a second would be dead storage that no
 * routing rule can reach. A `sub` mode needs several whether its credentials
 * arrive as accounts (Anthropic, OpenAI) or as strings (GLM's coding plan).
 */
export function modeAllowsMultipleCredentials(billingMode: BillingMode): boolean {
  return billingMode === "sub";
}

/**
 * The quota integrations this build actually implements.
 *
 * Every `sub` mode DECLARES one, but declaring is not implementing, so this is
 * the list that decides what a user sees. `zai-plan-usage` joined it in
 * planning#339, when `ZaiLimitsProvider` gave GLM's coding plan a reader; until
 * then GLM declared an id nothing read and reported nothing.
 *
 * `opencode-go-usage` is the other kind of absence, and the distinction is worth
 * keeping: it is missing **by decision, not by backlog** (docs/272 req 6). GLM's
 * id was waiting for a reader somebody could write; OpenCode publishes no
 * per-key usage API for a reader to read, so Go reports nothing and ShipIt
 * reacts to the service's own 429 instead. It joins this list if the vendor ever
 * ships a usage endpoint.
 *
 * One list, because "does this mode report a quota" is asked in two places that
 * must agree: whether to offer failover CUTOFFS (a percentage of a number
 * nobody reports can never fire — the dishonesty req 10 refuses a surface
 * over), and whether a credential row shows a usage read-out at all.
 */
const IMPLEMENTED_QUOTA_INTEGRATIONS = new Set<QuotaIntegrationId>([
  "anthropic-oauth-usage",
  "openai-chatgpt-usage",
  "zai-plan-usage",
]);

/**
 * The quota integrations that can be re-read **on demand**, which is what puts
 * a refresh button beside a credential's usage read-out.
 *
 * A narrower question than {@link modeReportsQuota} and deliberately its own
 * list: Codex reports a quota it can only ever *receive*. Its numbers are
 * pushed by the app-server during a turn, so a button there would spin and
 * change nothing. Anthropic has `/api/oauth/usage` and GLM has Z.ai's quota
 * endpoint, so both have something to press.
 *
 * This lives in the catalogue because three client surfaces ask it — the header
 * badge, the account rows and the credential rows — and each of them used to
 * answer it with `serviceId === "anthropic"` written out by hand. Three copies
 * of one fact is three places to forget when a fourth reader lands.
 */
const ON_DEMAND_QUOTA_INTEGRATIONS = new Set<QuotaIntegrationId>([
  "anthropic-oauth-usage",
  "zai-plan-usage",
]);

/**
 * Does this `(service, billing mode)` report a quota ShipIt can read?
 *
 * A property of the MODE, never of the delivery shape. An Anthropic plan
 * reports its 5h and 7d windows whether it arrives as an OAuth account or as a
 * supplied token — the snapshot is recorded per route and gated only on the
 * mode being a subscription (`credentialOwnerForRouteId`). Reading "quota" as
 * "account" is what left a supplied subscription credential with no read-out
 * and no cutoffs while an account beside it had both.
 */
export function modeReportsQuota(serviceId: string, billingMode: BillingMode): boolean {
  const mode = getMode(serviceId, billingMode);
  // `quota: null` is the declared no-reader subscription (docs/274 req 16 —
  // xAI's, whose every usage route 404s). It is not a lookup miss and must not
  // be treated as one: the answer is "nothing to read", arrived at on purpose.
  return mode?.kind === "sub" && mode.quota !== null && IMPLEMENTED_QUOTA_INTEGRATIONS.has(mode.quota);
}

/**
 * Can this service's subscription quota be re-read on demand — i.e. is there a
 * refresh button to show? See {@link ON_DEMAND_QUOTA_INTEGRATIONS}.
 *
 * Takes only a service id because the question is only ever asked about a
 * subscription: a key has no allowance, so there is no read-out to refresh.
 */
export function subQuotaRefreshable(serviceId: string): boolean {
  const mode = getMode(serviceId, "sub");
  return mode?.kind === "sub"
    && mode.quota !== null
    && IMPLEMENTED_QUOTA_INTEGRATIONS.has(mode.quota)
    && ON_DEMAND_QUOTA_INTEGRATIONS.has(mode.quota);
}

/**
 * docs/274 req 14 — the reasoning-effort levels a SELECTION offers.
 *
 * The one entry point for "what goes in the reasoning picker", and the reason
 * it exists: `capabilities.reasoning.options` is per-harness and, for at least
 * one harness, over-promises. Grok's key-billed selections silently discard
 * `--reasoning-effort` while its subscription ones honour it, so a UI reading
 * the harness list directly would put four dead controls on screen for a
 * key-mode session — the exact dishonesty req 14 forbids.
 *
 * The narrowing is intersect-and-preserve-order, not replace: the harness owns
 * the vocabulary and its LABELS, a row only says which of them it honours. An
 * entry a row names that the harness does not declare is dropped rather than
 * rendered label-less (`catalogue.test.ts` also fails the build on one, so this
 * is belt-and-braces for a row authored while the test is red).
 *
 * `undefined` on the row means "the harness's list, unchanged" — every
 * pre-existing row, so nothing outside grok changes behaviour. An EMPTY array
 * means "this row honours none", which returns `[]` and hides the control.
 * Those two must not be conflated, which is why this reads `?? options` rather
 * than testing truthiness.
 *
 * **Three facts compose here, and the middle one is the reason this function
 * exists at all** (docs/274 req 14):
 *
 *   | fact | lives on | grok |
 *   |---|---|---|
 *   | the vocabulary and its labels | harness | xhigh/high/medium/low |
 *   | which billing modes honour it | `capabilities.reasoning.billingModes` | `sub` only |
 *   | which of them a row offers | `ModelDef.reasoningEfforts` | 4.5 lacks `xhigh` |
 *
 * The mode gate is applied BEFORE the row narrowing and independently of it, so
 * a key-billed row that names no `reasoningEfforts` — every gateway row grok
 * shares with the other three harnesses — still answers `[]` for grok and the
 * full vocabulary for them. Doing it the other way round (making each shared
 * row declare a list) has no value that is right for all four harnesses at
 * once; see {@link AgentReasoningCapability.billingModes}.
 */
export function reasoningOptionsFor(
  harnessId: AgentId,
  selection: ModelSelection | undefined,
): { value: string; label: string }[] {
  const reasoning = getHarness(harnessId)?.capabilities.reasoning;
  const options = reasoning?.options ?? [];
  if (!selection) return [...options];
  // The harness×mode gate. A selection whose billing mode this harness does not
  // send the flag under offers NOTHING, whatever the row says — the row cannot
  // know which harness is asking.
  if (reasoning?.billingModes && !reasoning.billingModes.includes(selection.billingMode)) {
    return [];
  }
  const honoured = getModel(selection)?.reasoningEfforts;
  if (!honoured) return [...options];
  const allowed = new Set(honoured);
  return options.filter((o) => allowed.has(o.value));
}

/**
 * Does this harness put `--reasoning-effort` on the wire under this billing
 * mode **at all** — the harness×mode gate on its own, with no model named.
 *
 * The coarser sibling of {@link reasoningOptionsFor}, and it exists for one real
 * caller: an explicit `shipit agent run` is validated flag by flag, so the parse
 * has to say whether `--effort` is part of a complete call *before* it knows
 * there is a valid model. Falling back to the harness vocabulary there would
 * demand a level on a key-billed grok call — a flag whose value the CLI
 * discards — and the caller would be sent to add it.
 *
 * Answers the mode question only. Whether a given ROW then narrows the list (a
 * subscription `grok-4.5` has no `xhigh`) still belongs to `reasoningOptionsFor`,
 * which is what runs once the model is known.
 */
export function harnessSendsReasoningEffort(harnessId: AgentId, billingMode: BillingMode): boolean {
  const reasoning = getHarness(harnessId)?.capabilities.reasoning;
  if (!reasoning || reasoning.options.length === 0) return false;
  return reasoning.billingModes === undefined || reasoning.billingModes.includes(billingMode);
}

/**
 * Is `effort` a level this selection actually honours? The refusal side of
 * {@link reasoningOptionsFor}, for the places that validate a stored or
 * caller-supplied value rather than render a list — a role's pinned level, an
 * explicit `--effort`, a rehydrated session preference.
 */
export function selectionHonoursEffort(
  harnessId: AgentId,
  selection: ModelSelection | undefined,
  effort: string,
): boolean {
  return reasoningOptionsFor(harnessId, selection).some((o) => o.value === effort);
}

/** A catalogue row paired with the identity that names it. */
export interface CatalogueEntry {
  selection: ModelSelection & { serviceId: ServiceId };
  service: ServiceDef;
  mode: BillingModeDef;
  model: ModelDef;
}

/**
 * Every `(service, mode, model)` the catalogue declares under a style
 * `harnessId` shares — the join, in catalogue order.
 *
 * This is the *catalogue's* answer, not the install's: it says nothing about
 * credentials (req 8) or about whether the harness is installed (req 14).
 * Phase 3 filters it; phase 1 only derives it.
 */
export function catalogueEntriesForHarness(harnessId: AgentId): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (resolveStyle(harnessId, model) === undefined) continue;
        out.push({
          selection: { serviceId: service.id, billingMode: mode.kind, modelId: model.id },
          service,
          mode,
          model,
        });
      }
    }
  }
  return out;
}

/**
 * Every model id a harness can speak to **anywhere in the catalogue**,
 * de-duplicated in catalogue order.
 *
 * This is the catalogue's answer and not the install's: it says nothing about
 * credentials. It replaces phase 1's `nativeModelIdsForHarness`, which narrowed
 * the same join to the harness's own vendor because nothing could yet give a
 * custom service a credential or route a turn to one. Phase 3 can, so the
 * narrowing goes.
 *
 * The eligible list — what the picker offers — is
 * {@link eligibleEntriesForHarness}, which filters this by the credentials the
 * user actually configured (req 8).
 */
export function catalogueModelIdsForHarness(harnessId: AgentId): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of catalogueEntriesForHarness(harnessId)) {
    if (seen.has(entry.model.id)) continue;
    seen.add(entry.model.id);
    out.push(entry.model.id);
  }
  return out;
}

// ---- Eligibility and spawn shaping (phase 3, reqs 6 and 8) -----------------
//
// Phase 1 stopped here deliberately: "eligibility is not here". It is now.
// Everything below still takes the user's configured routes as an ARGUMENT —
// this module never reads a store — so the rules stay one pure, testable place
// and the orchestrator only supplies the facts.

/**
 * A credential the user has configured, reduced to what eligibility needs.
 *
 * Deliberately not `CredentialRoute`: that type lives in the orchestrator's
 * domain types and carries storage concerns (status, priority, timestamps) this
 * layer must not depend on. What the rules need is the `(service, mode)` the
 * credential belongs to and **how it is delivered**.
 */
export interface ConfiguredCredential {
  serviceId: string;
  billingMode: BillingMode;
  /** Delivery, never billing — see {@link ModeCredential}. */
  via: "account" | "string";
}

/**
 * Where a credential of shape `via` lands for this harness, before any
 * service-specific override. `undefined` means the harness cannot carry that
 * shape at all — an OAuth-only CLI has no `string` target, a key-only CLI no
 * `account` one.
 */
export function harnessCredentialTarget(
  harnessId: AgentId,
  via: "account" | "string",
): CredentialTargets["string"] | CredentialTargets["account"] | undefined {
  const spawn = getHarness(harnessId)?.spawn;
  return via === "string" ? spawn?.credential.string : spawn?.credential.account;
}

/**
 * **The eligibility predicate, stated over a configured route rather than over
 * a mode.** Writing it as two independent tests — "the mode has a credential"
 * AND "the harness supports one of the shapes this mode accepts" — is a real
 * bug, because the two can be satisfied by *different* credentials.
 *
 * The concrete case: Anthropic's subscription accepts both an OAuth account and
 * an env-supplied token, the user has connected only the account, and the
 * harness can carry only strings. Both independent tests pass; the model is
 * offered and cannot authenticate — a ShipIt-imposed failure of exactly the
 * kind reqs 1 and 8 rule out.
 */
export function harnessCanCarry(harnessId: AgentId, credential: ConfiguredCredential): boolean {
  if (harnessCredentialTarget(harnessId, credential.via) === undefined) return false;
  // The mode must also *accept* this shape. A stored route whose shape the
  // catalogue no longer declares (a row edited under a live install) is not a
  // usable credential, and inventing a destination for it is how a secret ends
  // up delivered under a name nothing reads.
  const declared = modeCredentialFor(credential.serviceId, credential.billingMode, credential.via);
  if (!declared) return false;
  // A credential may be restricted to the harnesses that can actually
  // authenticate with it (`carriers` — see the type's docstring). Without this
  // check an Anthropic-subscription OAuth token would make subscription models
  // eligible on OpenCode (docs/268), and — once a second harness carried an
  // `account` target while speaking OpenAI's style — a ChatGPT subscription
  // would do the same on Grok (planning#435). Both 401 at the wire.
  //
  // Checked for BOTH `via` shapes deliberately: the restriction was
  // string-only while every account-bearing service had exactly one harness
  // speaking its style, and Grok is where that stopped being true.
  if (declared.carriers && !declared.carriers.includes(harnessId)) {
    return false;
  }
  return true;
}

/**
 * The *Add a service* table's per-cell answer, now that one service's modes can
 * genuinely disagree per harness (docs/268 — OpenCode runs Anthropic/OpenAI in
 * key mode but never their subscription modes): **"all"** when every mode of
 * the service would run on this harness, **"some"** when only part of them
 * would, **"none"** when nothing would. The old boolean cell collapsed this to
 * an existential tick, which promised subscription pairings the picker then
 * refused — the exact promise `catalogue.test.ts` forbids.
 */
export function harnessServiceSupport(
  harnessId: AgentId,
  serviceId: string,
): "all" | "some" | "none" {
  const service = getService(serviceId);
  if (!service) return "none";
  const answers = service.modes.map((mode) => harnessSupportsMode(harnessId, serviceId, mode.kind));
  if (answers.every(Boolean)) return "all";
  return answers.some(Boolean) ? "some" : "none";
}

/** The `(service, mode)` keys `harnessId` can authenticate with, given these routes. */
function usableModeKeys(harnessId: AgentId, credentials: readonly ConfiguredCredential[]): Set<string> {
  const out = new Set<string>();
  for (const credential of credentials) {
    if (!harnessCanCarry(harnessId, credential)) continue;
    out.add(`${credential.serviceId}:${credential.billingMode}`);
  }
  return out;
}

/**
 * The models this harness may offer on this install: the catalogue join
 * (req 6), narrowed to the modes holding a credential this harness can carry
 * (req 8), in catalogue order.
 *
 * Says nothing about whether the harness is *installed* — that is req 14's
 * separate gate and the caller's conjunction to make. And nothing about whether
 * the model then works well, which is req 1's best-effort territory.
 */
export function eligibleEntriesForHarness(
  harnessId: AgentId,
  credentials: readonly ConfiguredCredential[],
): CatalogueEntry[] {
  const usable = usableModeKeys(harnessId, credentials);
  return catalogueEntriesForHarness(harnessId).filter((entry) =>
    usable.has(`${entry.selection.serviceId}:${entry.selection.billingMode}`),
  );
}

/**
 * **Could this harness run this mode at all, if it held a credential?** The
 * question the *Add a service* dialog asks, one step before there is anything to
 * ask it about: the user is choosing a service and has configured nothing.
 *
 * Deliberately expressed as {@link eligibleEntriesForHarness} over a
 * *hypothetical* credential of each shape the mode accepts, rather than as its
 * own pair of tests. The two clauses — the style join (req 6) and the
 * credential-shape check (req 8) — must be satisfied by the SAME credential, and
 * writing them independently is the exact bug `harnessCanCarry`'s docstring
 * records. Asking the real predicate about a credential that does not exist yet
 * cannot drift from it.
 */
export function harnessSupportsMode(
  harnessId: AgentId,
  serviceId: string,
  billingMode: BillingMode,
): boolean {
  const mode = getMode(serviceId, billingMode);
  if (!mode) return false;
  return mode.credentials.some(
    (credential) =>
      eligibleEntriesForHarness(harnessId, [{ serviceId, billingMode, via: credential.via }])
        .length > 0,
  );
}

/**
 * Whether ANY of this service's modes would be runnable on this harness — the
 * service-level answer the dialog's support table shows per cell.
 *
 * Says nothing about whether the harness is *installed*: that is req 14's
 * separate gate, and the caller's conjunction to make, exactly as for
 * {@link eligibleEntriesForHarness}.
 */
export function harnessSupportsService(harnessId: AgentId, serviceId: string): boolean {
  const service = getService(serviceId);
  if (!service) return false;
  return service.modes.some((mode) => harnessSupportsMode(harnessId, serviceId, mode.kind));
}

/** Whether this exact triple is offered on this harness with these credentials. */
export function isSelectionEligible(
  harnessId: AgentId,
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
): boolean {
  return eligibleEntriesForHarness(harnessId, credentials).some((entry) =>
    sameSelection(entry.selection, selection),
  );
}

/**
 * Where a `via: "string"` credential of this mode must land for this harness —
 * the harness's own default, unless the mode overrides it.
 *
 * The override exists because `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`
 * are not interchangeable at the wire (an `x-api-key` header versus a bearer
 * token, confirmed against the CLI in phase 3), so which one an
 * Anthropic-compatible third party wants is a fact about that service.
 */
export function spawnCredentialTarget(
  harnessId: AgentId,
  serviceId: string,
  billingMode: BillingMode,
): CredentialTarget | undefined {
  const credential = modeCredentialFor(serviceId, billingMode, "string");
  if (credential?.via !== "string") return undefined;
  const override = credential.targetOverride?.[harnessId];
  if (override) return override;
  const target = harnessCredentialTarget(harnessId, "string");
  return target && target.kind !== "scoped-home" ? target : undefined;
}

/**
 * How a turn on `(harness, selection)` is pointed at its service: the resolved
 * style, the endpoint that style lives at, and — for a string-delivered
 * credential — which variable holds the secret and where it must land.
 *
 * `undefined` for a selection this harness cannot run (no shared style, or the
 * catalogue has no such row), which callers treat as "nothing to shape" rather
 * than as an error: a session with no selection at all still runs, on the CLI's
 * own vendor, exactly as it did before this feature.
 */
export interface SpawnShaping {
  serviceId: string;
  billingMode: BillingMode;
  style: ApiStyle;
  /** Base URL for the resolved style, and where this harness takes it. */
  endpoint: { url: string; target: HarnessDef["spawn"]["endpoint"] };
  /**
   * Set only for a string-delivered credential. `sourceEnv` is the variable the
   * secret is *stored and delivered* under; `target` is where the CLI reads it.
   * The two are kept apart deliberately — a service's storage name must never
   * be a harness's own variable name, or the route works or fails depending on
   * how the install happens to be signed in (Appendix A).
   */
  credential?: { sourceEnv: string; target: CredentialTarget };
}

export function resolveSpawnShaping(
  harnessId: AgentId,
  selection: ModelSelection,
): SpawnShaping | undefined {
  const harness = getHarness(harnessId);
  const mode = getMode(selection.serviceId, selection.billingMode);
  const model = mode?.models.find((m) => m.id === selection.modelId);
  if (!harness || !mode || !model) return undefined;
  const style = resolveStyle(harnessId, model);
  const url = style ? mode.endpoints[style] : undefined;
  if (!style || !url) return undefined;
  const sourceEnv = storageEnvFor(selection.serviceId, selection.billingMode);
  const target = spawnCredentialTarget(harnessId, selection.serviceId, selection.billingMode);
  return {
    serviceId: selection.serviceId,
    billingMode: selection.billingMode,
    style,
    endpoint: { url, target: harness.spawn.endpoint },
    ...(sourceEnv && target ? { credential: { sourceEnv, target } } : {}),
  };
}

/**
 * Every `(service, mode)` pair that declares this exact model id, in catalogue
 * order. The basis for resolving a stored bare id — and for the session
 * migration's "prefer `sub`, but only among the modes that actually offer this
 * model" rule.
 */
export function modesOfferingModel(modelId: string): { serviceId: ServiceId; billingMode: BillingMode }[] {
  const out: { serviceId: ServiceId; billingMode: BillingMode }[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      if (mode.models.some((m) => m.id === modelId)) {
        out.push({ serviceId: service.id, billingMode: mode.kind });
      }
    }
  }
  return out;
}

/**
 * Resolve a bare model id to a full selection, by the first-eligible rule: the
 * first service, then the first billing mode, that declares it.
 *
 * `preferredServiceId` biases the search without constraining it, which is what
 * lets a caller that knows the harness (and therefore its native service) keep
 * a legacy id on the vendor it plainly came from instead of on whichever
 * gateway happens to list the same string.
 *
 * Returns `undefined` for an id the catalogue does not carry at all — a real
 * case (a versioned id the picker never surfaced, or a model since retired), and
 * one every caller must handle rather than fabricate a triple for.
 */
export function resolveModelSelection(
  modelId: string | undefined,
  preferredServiceId?: string,
): ModelSelection | undefined {
  if (!modelId) return undefined;
  const candidates = modesOfferingModel(modelId);
  if (candidates.length === 0) return undefined;
  const preferred = preferredServiceId
    ? candidates.find((c) => c.serviceId === preferredServiceId)
    : undefined;
  const chosen = preferred ?? candidates[0];
  return { serviceId: chosen.serviceId, billingMode: chosen.billingMode, modelId };
}

// ---- Retirement (req 13) ---------------------------------------------------
//
// Curation (req 6) makes removal routine, so a model leaving the catalogue must
// not strand the sessions pinned to it. Each `(service, billing mode)` records
// the models it retired — their ids, the styles they were declared under, and a
// successor per style — and a pinned session resolves through that record.
//
// The three axes req 13 fixes are all held by construction here rather than
// checked: the record lives INSIDE a `(service, mode)`, so a successor can
// cross neither, and the style is resolved against the harness's own styles, so
// it can only land on a model the session's harness can speak to.

/**
 * Every `(service, mode)` whose retirement record names this model id, in
 * catalogue order — the mirror of {@link modesOfferingModel} for a model that
 * has left. Internal: the exported entry points below all take a harness, so no
 * caller has to decide what to do with a bare list.
 */
function modesRetiringModel(modelId: string): { serviceId: ServiceId; billingMode: BillingMode }[] {
  const out: { serviceId: ServiceId; billingMode: BillingMode }[] = [];
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      if (mode.retired.some((r) => r.id === modelId)) {
        out.push({ serviceId: service.id, billingMode: mode.kind });
      }
    }
  }
  return out;
}

/**
 * The successor a session pinned to `selection` moves onto, or `undefined` when
 * there is nothing to move it to: the selection's `(service, mode)` never
 * retired that id, or `harnessId` speaks none of the styles the retired model
 * was declared under.
 *
 * The style is resolved by the same rule as {@link resolveStyle} — the first of
 * the harness's styles the model declares — except that it reads the *record's*
 * styles, because the model itself is gone from `models` and its styles went
 * with it. That is the whole reason `RetiredModel` carries them.
 *
 * `undefined` for a still-current model falls out of the lookup: a mode may not
 * hold one id as both current and retired (`catalogue.test.ts` enforces it), so
 * a current selection is never found in `retired`.
 *
 * A retirement with no successor for this harness is a **catalogue mistake**,
 * not a runtime case req 13 asks us to fall back from — falling back to the
 * other mode is the silent shift onto metered billing req 12 refuses, and
 * falling back to another service changes the credential the session needs. So
 * this returns nothing and the caller leaves the session where it is, which is
 * the state a catalogue fix repairs.
 */
export function retirementSuccessor(
  harnessId: AgentId,
  selection: ModelSelection,
): ModelSelection | undefined {
  const mode = getMode(selection.serviceId, selection.billingMode);
  const retired = mode?.retired.find((r) => r.id === selection.modelId);
  const harness = getHarness(harnessId);
  if (!mode || !retired || !harness) return undefined;
  const style = harness.styles.find((s) => retired.styles.includes(s));
  if (!style) return undefined;
  const successorId = retired.successors[style];
  if (!successorId) return undefined;
  // Defence in depth. `catalogue.test.ts` already asserts that every successor
  // is a current model of the same mode declared under that style, so this can
  // only fire on a row that shipped with the test disabled — in which case
  // returning nothing beats returning a triple that names no row.
  const successor = mode.models.find((m) => m.id === successorId);
  if (!successor?.styles.includes(style)) return undefined;
  return {
    serviceId: selection.serviceId,
    billingMode: selection.billingMode,
    modelId: successorId,
  };
}

/**
 * The bare-id form, for a caller holding a model id and no service — a session
 * row written before the triple existed, or the turn boundary inside a session
 * container, which is handed a model id and nothing else.
 *
 * Candidate `(service, mode)` pairs are tried in catalogue order, biased by
 * `preferredServiceId` exactly as {@link resolveModelSelection} biases a current
 * id, and the first that yields a successor for this harness wins. Iterating
 * rather than committing to the first candidate matters because two modes of one
 * service can retire the same id while only one of them declares it under a
 * style this harness speaks.
 */
export function resolveRetiredModelId(
  harnessId: AgentId,
  modelId: string | undefined,
  preferredServiceId?: string,
): ModelSelection | undefined {
  if (!modelId) return undefined;
  const candidates = modesRetiringModel(modelId);
  const ordered = preferredServiceId
    ? [
        ...candidates.filter((c) => c.serviceId === preferredServiceId),
        ...candidates.filter((c) => c.serviceId !== preferredServiceId),
      ]
    : candidates;
  for (const candidate of ordered) {
    const successor = retirementSuccessor(harnessId, { ...candidate, modelId });
    if (successor) return successor;
  }
  return undefined;
}

// There is deliberately NO harness-and-bare-id-only "normalize this model"
// helper for a spawn boundary to call. Phase 8's first cut had one, generalizing
// the old `normalizeCodexModelId` shim in place, and cross-backend review found
// it unsound: req 5 lets two services offer the same model id, so an id one
// service has retired while another still offers it would be rewritten to the
// FIRST service's successor — overriding a correctly resolved selection with a
// model the session's actual service does not serve, at its endpoint, on its
// credential (req 11). A boundary holding only an id cannot tell those apart.
//
// It is also unnecessary: `AgentRunParams.model` has exactly two producers
// (`buildAgentRunParams` and `buildSubAgentRunParams`), and both read a session
// or a sub-agent default that resolves through `applyModelRetirement` first. So
// resolution happens once, where the service and mode are known.

/** Whether two selections name the same catalogue row. */
export function sameSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
  if (!a || !b) return a === b;
  return a.serviceId === b.serviceId && a.billingMode === b.billingMode && a.modelId === b.modelId;
}

/**
 * Whether two selections share a `(service, mode)` owner. This is the question
 * a persisted credential route has to answer: the route belongs to a
 * `(service, billing mode)`, so a selection change that crosses either must
 * invalidate it, while a plain model change within one mode must not.
 */
export function sameCredentialOwner(
  a: ModelSelection | undefined,
  b: ModelSelection | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.serviceId === b.serviceId && a.billingMode === b.billingMode;
}

/**
 * Display labels for every model id the catalogue carries, first-seen wins.
 * Absorbs what the client's hand-kept `MODEL_DISPLAY_NAMES` record held for
 * catalogue models; ids the catalogue does not carry (historical/versioned ones)
 * still need their own entries there.
 */
export function catalogueModelLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (!(model.id in out)) out[model.id] = model.label;
      }
    }
  }
  return out;
}

/**
 * Context windows for every model id the catalogue carries, first-seen wins.
 * Absorbs what `MODEL_CONTEXT_WINDOWS` held for catalogue models.
 *
 * A `byHarness` override is deliberately NOT flattened here — this map is keyed
 * by model id alone, which is what the existing first-frame lookup takes. A
 * caller that knows the harness should use {@link contextWindowFor}.
 */
export function catalogueContextWindows(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const service of SERVICES) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        if (!(model.id in out)) out[model.id] = model.contextWindow.default;
      }
    }
  }
  return out;
}

/** The context window for a selection on a given harness, honouring `byHarness`. */
export function contextWindowFor(
  selection: ModelSelection,
  harnessId?: AgentId,
): number | undefined {
  const model = getModel(selection);
  if (!model) return undefined;
  const override = harnessId ? model.contextWindow.byHarness?.[harnessId] : undefined;
  return override ?? model.contextWindow.default;
}

// ---- Wire form -------------------------------------------------------------

/**
 * The selection as one string, for the few places that can only hold a scalar —
 * notably the browser's `vibe-model-id` slot, which seeds every new session.
 *
 * `service:mode:model` rather than JSON: a model id can contain `/`, `.`, `[`
 * and `]` (see `glm-5.2[1m]` and the gateways' `provider/model` ids) but never a
 * colon in any row the catalogue carries, and the parse splits on the FIRST TWO
 * colons only so a future id containing one still round-trips.
 */
export function serializeSelection(selection: ModelSelection): string {
  return `${selection.serviceId}:${selection.billingMode}:${selection.modelId}`;
}

/**
 * Parse {@link serializeSelection}'s form. Returns `undefined` for anything that
 * is not that form — including a **bare model id**, which is exactly what the
 * legacy value in storage is, so callers can tell "legacy, migrate it" from
 * "well-formed" rather than guessing.
 */
export function parseSelection(raw: string | undefined): ModelSelection | undefined {
  if (!raw) return undefined;
  const first = raw.indexOf(":");
  if (first <= 0) return undefined;
  const second = raw.indexOf(":", first + 1);
  if (second <= first + 1) return undefined;
  const serviceId = raw.slice(0, first);
  const billingMode = raw.slice(first + 1, second);
  const modelId = raw.slice(second + 1);
  if (billingMode !== "sub" && billingMode !== "key") return undefined;
  if (!modelId) return undefined;
  return { serviceId, billingMode, modelId };
}
