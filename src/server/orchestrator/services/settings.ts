/**
 * Settings services — reads (agents, global settings) and mutations
 * (git identity, global settings, agents, API key).
 */

import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import { isAllowedAgentEnvKey } from "../../shared/agent-registry.js";
import type { AccountSelectionMode, AgentId, CredentialRoute, FailoverCutoffs } from "../../shared/types.js";
import { credentialModeKey, DEFAULT_FAILOVER_CUTOFF, DEFAULT_SELECTION_MODE, parseCredentialModeKey } from "../../shared/types.js";
import { allServices, credentialModeForStorageEnv, getMode, getModel, getService, nativeServiceForHarness } from "../../shared/catalogue/index.js";
import { harnessForNonTurnSelection, resolveNonTurnModel } from "../non-turn-model.js";
import { listConfiguredCredentials } from "../service-routing.js";
import { listCredentialRoutes, upsertSingleStringCredential } from "./credential-routes.js";
import type { VoiceDeliveryMode } from "../../shared/types/voice-note-types.js";
import { getGitIdentity, setGitIdentity as writeGitIdentity } from "../git-config.js";
import { buildAgentSystemInstructions } from "../agent-instructions.js";
import { readGlobalSystemPrompt, writeGlobalSystemPrompt } from "../global-system-prompt.js";
import { ServiceError } from "./types.js";
import type { AgentInfo, GlobalSettings, NonTurnModelResolved, NonTurnModelSelection, ReviewerPinPatch, ReviewerSlotView } from "./types.js";
import type { ReviewerPin, ReviewerSlot } from "../../shared/types/agent-types.js";
import {
  buildReviewerSettings,
  parseReviewerPinPatch,
  requireReviewerSlot,
  resolveReviewerPinPatch,
} from "./reviewer-settings.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import { readSessionAccountMarker } from "../session-credentials.js";
import { revokeSessionProviderCredentials } from "../session-agent-credentials.js";

// ---- Read operations ----

/**
 * docs/257 req 8 — "the install can actually run something".
 *
 * **One implementation, one owner.** Three consumers read this fact (the
 * composer's disabled state, the starter-prompts gate, and — from phase 2 — the
 * onboarding panel's completion stamp), and the failure this prevents is a flow
 * that says it is finished above a composer that is still, correctly, disabled.
 * They agree because they all read the same server-computed field, not because
 * three derivations happen to match.
 *
 * **This body is the pre-docs/252-phase-3 form** and is exactly today's
 * `noAgentReady` inverted (`App.tsx`): at least one agent installed *and*
 * authenticated. After docs/252 phase 3 it becomes "at least one installed
 * harness has at least one eligible model", i.e. the existential over the
 * picker's own eligibility predicate. **This function is where the decision
 * lives, and it is the only place that decides.**
 *
 * The precise guarantee, because cross-backend review was right to press on it:
 * the *wire field* and all three *consumers* are unchanged by the swap — that is
 * what makes phase 1 shippable ahead of the docs/252 sequencing decision. What
 * is NOT promised is that the swap touches no other line: post-252 eligibility
 * is keyed on `(service, billing mode)` credentials that the agent registry does
 * not own, so this signature may need to widen. If it does, the compiler names
 * every producer, because they all go through `buildAgentListPayload`.
 *
 * It is an install-level fact and deliberately NOT per-session turn admission
 * (`agent-auth-gate.ts`), which answers a different question about the
 * session's *own* harness. The two can legitimately disagree — an install with a
 * working Claude credential and a Codex-pinned session whose Codex credential
 * was removed can run *something* while that session's next turn is refused.
 *
 * **What it must NOT disagree with is the ingredients of turn admission**, and
 * it does not, because both read the same two registry fields. docs/252 phase 9
 * adds an installed-before-authenticated check to `agentAdmissionError`, gated
 * on `AgentInfo.installed` — and redefines what that field MEANS inside
 * `AgentRegistry`: the harness set the deployment declared
 * (`installed-harnesses.ts`), with a `$PATH` probe only as the fallback where no
 * image build declared one. Since this predicate reads the same field from the
 * same registry, it follows that redefinition with no change here. Verified
 * against `agent-auth-gate.ts` and `agent-registry.ts` on phase 9's branch
 * rather than inferred: a harness present on `$PATH` but undeclared reads
 * `installed: false` to BOTH, so the composer cannot offer a turn the gate then
 * refuses.
 *
 * The predicate is written out rather than delegated to
 * `AgentRegistry.available()` (which is today the same filter) so it stays
 * legible at the point docs/252 phase 3 replaces it, and so the tests below pin
 * the semantics instead of a stand-in's.
 */
export function computeCanRunTurns(agentRegistry: AgentRegistry): boolean {
  return agentRegistry.list().some((a) => a.installed && a.hasRunnableModels);
}

/**
 * docs/257 req 9 (phase 2) — `canRunTurns` **and** the historical
 * "has this install ever been set up?" stamp, resolved together.
 *
 * The stamp is written here, on the READ path, rather than at each
 * credential-mutation site. That is a deliberate impurity and it buys two
 * things a mutation-site stamp does not:
 *
 *  - **The migration case.** An install that was already configured before this
 *    field existed has no stamp and will never mutate a credential again. The
 *    first settings read after the upgrade finds the flag absent, finds
 *    `canRunTurns` true, and stamps — so it is "completed" before it renders a
 *    frame, with no separate migration step. An install upgraded with *no*
 *    credentials is not stamped and does see the panel; req 9 records that as an
 *    accepted one-off, because disconnecting deletes the record and so
 *    "completed, then removed everything" is indistinguishable from "never
 *    configured" on an install that predates the flag.
 *  - **It cannot silently un-cover itself.** A mutation-site stamp is a list
 *    that a newly-added credential path quietly falls off.
 *
 * There is deliberately **no second stamp condition** — "also stamp if any
 * credential record exists" was an agent inference and is withdrawn: req 8 says
 * onboarding finishes when the install can actually RUN something, not when a
 * credential has been stored.
 */
export function resolveHarnessOnboarding(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore | undefined,
): { canRunTurns: boolean; harnessOnboardingCompletedAt?: string } {
  const canRunTurns = computeCanRunTurns(agentRegistry);
  const existing = credentialStore?.getHarnessOnboardingCompletedAt();
  if (existing) return { canRunTurns, harnessOnboardingCompletedAt: existing };
  if (!canRunTurns || !credentialStore) return { canRunTurns };
  // `undefined` when the write failed — reported as not-yet-completed, so the
  // panel repeats a correct ask rather than a lost stamp silently returning it
  // months later. See `CredentialStore.stampHarnessOnboardingCompleted`.
  const stamped = credentialStore.stampHarnessOnboardingCompleted(new Date().toISOString());
  return stamped ? { canRunTurns, harnessOnboardingCompletedAt: stamped } : { canRunTurns };
}

/**
 * The canonical `agent_list` SSE payload (docs/257).
 *
 * Every producer of that event goes through here so `canRunTurns` cannot be
 * omitted by one of them — an omission is not a missing field on the client, it
 * is a *stale truthy* one: sign out of the last provider and a hand-rolled
 * `{ agents }` would leave the composer enabled over an install that can no
 * longer run anything. Hand-rolling the agent array had already caused the
 * matching bug once (a drifted inline copy dropped `reasoning`, see
 * `route-registry.ts`), which is why the array comes from `listAgents` too.
 *
 * `credentialStore` is a **required** parameter, `undefined` and all — phase 2
 * puts `harnessOnboardingCompletedAt` on this payload as well, and the site
 * that matters most is the one where the LAST credential is removed. Requiring
 * the argument means no producer can *forget* the store: adding one is a
 * compile error until it is passed, which is what surfaced the two opts-bag
 * helpers in `app-lifecycle.ts` that the design's emit-site list never named.
 *
 * **What it does not catch**, because the parameter type admits `undefined`
 * (several callers hold an optional store): a producer that passes a variable
 * which happens to be `undefined`. That is a real hole, not a theoretical one,
 * and it is why the guard test in `can-run-turns.test.ts` scans for the store
 * being *named* at each call site rather than trusting the type. The pair is
 * the guarantee; neither half is it alone.
 *
 * docs/261 phase 3 (req 8) — `providerAccountManager` is required for the same
 * reason and with the same shape (`| undefined` rather than optional). This
 * payload now carries the **reviewer resolution**, which is what makes an open
 * Reviewer tab follow a credential change instead of showing the answer from
 * before it — and a route the account manager owns is most of what "can this
 * reviewer actually run" means. Omitting it does not produce a missing field:
 * it produces a *confidently wrong* one, reporting every subscription-served
 * reviewer as unavailable on the install where that is least true. Making it
 * optional would let exactly the sites that add and remove credentials forget
 * it, so it is a compile error instead, and the same guard scan checks it is
 * named.
 */
export function buildAgentListPayload(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore | undefined,
  providerAccountManager: ProviderAccountManager | undefined,
): {
  agents: AgentInfo[];
  canRunTurns: boolean;
  harnessOnboardingCompletedAt?: string;
  reviewers: ReviewerSlotView[];
} {
  return {
    agents: listAgents(agentRegistry),
    ...resolveHarnessOnboarding(agentRegistry, credentialStore),
    reviewers: buildReviewerSettings({ credentialStore, providerAccountManager }),
  };
}

/** Map agent registry entries to the client-facing agent info shape. */
export function listAgents(agentRegistry: AgentRegistry): AgentInfo[] {
  return agentRegistry.list().map((a) => ({
    id: a.id,
    name: a.name,
    installed: a.installed,
    hasRunnableModels: a.hasRunnableModels,
    models: a.capabilities.models,
    eligibleModels: a.eligibleModels,
    supportsReview: a.capabilities.supportsReview,
    supportsSteering: a.capabilities.supportsSteering,
    supportsCompaction: a.capabilities.supportsCompaction,
    supportedPermissionModes: a.capabilities.supportedPermissionModes,
    skillInvocationPrefix: a.capabilities.skillInvocationPrefix,
    ...(a.capabilities.reasoning ? { reasoning: a.capabilities.reasoning } : {}),
  }));
}

/**
 * Get global settings (git identity, system prompt, agents, resource limits).
 *
 * `appWorkspaceDir` is the orchestrator's own workspace root, not a session
 * clone — it is where the GLOBAL system prompt lives (see
 * `global-system-prompt.ts`).
 */
export async function getGlobalSettings(
  agentRegistry: AgentRegistry,
  appWorkspaceDir: string,
  credentialStore?: CredentialStore,
  providerAccountManager?: ProviderAccountManager,
): Promise<GlobalSettings> {
  const stored = getGitIdentity();
  const gitIdentity = stored
    ? { name: stored.name, email: stored.email }
    : { name: "", email: "" };

  const systemPrompt = (await readGlobalSystemPrompt(appWorkspaceDir)) ?? "";

  const agents = listAgents(agentRegistry);
  const maxIdleContainers = credentialStore?.getMaxIdleContainers() ?? 5;
  const agentSystemInstructionsEnabled = credentialStore?.getAgentSystemInstructionsEnabled() ?? true;
  const autoCreatePr = credentialStore?.getAutoCreatePr() ?? false;
  const liveSteering = credentialStore?.getLiveSteering() ?? true;
  const autoResolveConflicts = credentialStore?.getAutoResolveConflicts() ?? false;
  const autoFixCi = credentialStore?.getAutoFixCi() ?? false;
  const autoResetMergedBranch = credentialStore?.getAutoResetMergedBranch() ?? true;
  const enableSubAgents = credentialStore?.getEnableSubAgents() ?? false;
  // Settings page renders the per-agent "Parallel sessions" guidance as a
  // preview. Pick the first installed-and-authed agent so a Codex-only host
  // shows Codex's variant, not Claude's. Fall back to the first registered
  // agent so the preview is never empty.
  const previewAgent = agentRegistry.available()[0] ?? agentRegistry.list()[0];
  const agentSystemInstructions = previewAgent
    ? buildAgentSystemInstructions({ agentId: previewAgent.id })
    : "";
  // The account-delivered credentials, in selection order. This used to fall
  // back to a store-level projection when no manager was wired; planning#342
  // deleted that projection, and the fallback with it. Nothing loses a payload:
  // `ApiDeps.providerAccountManager` is required, so the only caller that can
  // omit one is a test seam (`services/misc.ts`), where the honest answer to
  // "which accounts?" with no router is none.
  const providerAccounts = providerAccountManager?.list() ?? [];
  const voiceDeliveryMode = credentialStore?.getVoiceDeliveryMode() ?? "native";
  const voiceWebhookConfigured = !!credentialStore?.getVoiceWebhook();
  // docs/150 reqs 4-6 / req 21, re-keyed by docs/252 phase 2 — the routing
  // settings, one entry per **subscription mode in the catalogue** rather than
  // one per registered agent. Both settings answer "which of these credentials
  // next?", which only exists where there is a group to choose from, and req 12
  // says that group is a subscription mode. A `key` mode gets no entry at all —
  // not an empty one — because keys do not fail over.
  //
  // Emitted for every such mode, credentialed or not, so the client can render
  // the control without knowing the default. The client keys these maps with
  // `credentialModeKey(serviceId, billingMode)`.
  const failoverCutoffs: Record<string, FailoverCutoffs> = {};
  const accountSelectionMode: Record<string, AccountSelectionMode> = {};
  for (const service of allServices()) {
    for (const mode of service.modes) {
      if (mode.kind !== "sub") continue;
      const key = credentialModeKey(service.id, mode.kind);
      failoverCutoffs[key] = credentialStore?.getFailoverCutoffs(service.id, mode.kind)
        ?? { session: DEFAULT_FAILOVER_CUTOFF, weekly: DEFAULT_FAILOVER_CUTOFF };
      accountSelectionMode[key] = credentialStore?.getSelectionMode(service.id, mode.kind)
        ?? DEFAULT_SELECTION_MODE;
    }
  }
  // docs/257 reqs 8 + 9 — the install-level "can run something" signal and the
  // historical onboarding stamp, computed here rather than re-derived in the
  // browser from `agents` (see `resolveHarnessOnboarding`).
  const { canRunTurns, harnessOnboardingCompletedAt } =
    resolveHarnessOnboarding(agentRegistry, credentialStore);
  // docs/252 phase 2 — every credential the user holds, in selection order per
  // group. Safe to return verbatim: `CredentialRoute` carries no secret.
  const credentialRoutes = credentialStore ? listCredentialRoutes(credentialStore) : [];
  // docs/252 phase 7 (req 9) — the pin AND what it resolves to. Both, because
  // they are different facts: the setting is visibly unset until the user picks
  // something, and what runs today is what the resolver says now.
  const nonTurnModel = credentialStore?.getNonTurnModel();
  const nonTurnResolution = credentialStore
    ? resolveNonTurnModel({
        credentialStore,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      })
    : undefined;
  const nonTurnModelResolved: NonTurnModelResolved | undefined =
    nonTurnResolution?.ok
      ? {
          serviceId: nonTurnResolution.target.selection.serviceId,
          billingMode: nonTurnResolution.target.selection.billingMode,
          modelId: nonTurnResolution.target.selection.modelId,
          serviceName: nonTurnResolution.target.serviceName,
          label: getModel(nonTurnResolution.target.selection)?.label
            ?? nonTurnResolution.target.selection.modelId,
          harnessId: nonTurnResolution.target.harnessId,
          source: nonTurnResolution.target.source,
        }
      : undefined;
  // docs/261 phase 3 (req 8) — both reviewer slots, each labelled pinned or
  // auto-configured and carrying what it resolves to. The same array rides the
  // `agent_list` SSE (see `buildAgentListPayload`), which is what makes an open
  // Reviewer tab follow a credential change instead of showing the stale answer.
  const reviewers = buildReviewerSettings({ credentialStore, providerAccountManager });
  return { canRunTurns, harnessOnboardingCompletedAt, failoverCutoffs, accountSelectionMode, gitIdentity, systemPrompt, agents, maxIdleContainers, agentSystemInstructionsEnabled, agentSystemInstructions, autoCreatePr, liveSteering, autoResolveConflicts, autoFixCi, autoResetMergedBranch, enableSubAgents, voiceDeliveryMode, voiceWebhookConfigured, providerAccounts, credentialRoutes, reviewers,
    ...(nonTurnModel ? { nonTurnModel } : {}),
    ...(nonTurnModelResolved ? { nonTurnModelResolved } : {}) };
}

// ---- Mutation operations ----

/** Set git identity (global git config). */
export function setGitIdentityService(
  name: string,
  email: string,
): { name: string; email: string } {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  if (!trimmedName) throw new ServiceError(400, "Git user name cannot be empty");
  if (!trimmedEmail) throw new ServiceError(400, "Git email cannot be empty");
  if (trimmedName.length > 200) throw new ServiceError(400, "Git user name is too long (max 200 characters)");
  if (trimmedEmail.length > 200) throw new ServiceError(400, "Git email is too long (max 200 characters)");
  writeGitIdentity(trimmedName, trimmedEmail);
  return { name: trimmedName, email: trimmedEmail };
}

/**
 * Save global settings.
 *
 * docs/146 — the parameter shape is an options object rather than the legacy
 * 11-positional-list. Each per-feature toggle (autoCreatePr, liveSteering,
 * autoResolveConflicts, agentSystemInstructionsEnabled, …) is opt-in: omit
 * the field to leave it unchanged. Adding a new toggle is a single named
 * field instead of "what's the 12th positional argument?".
 */
export interface SaveGlobalSettingsOptions {
  agentRegistry: AgentRegistry;
  /**
   * The orchestrator's own workspace root, not a session clone — the GLOBAL
   * system prompt lives under it (see `global-system-prompt.ts`).
   */
  appWorkspaceDir: string;
  credentialStore: CredentialStore;
  providerAccountManager?: ProviderAccountManager;
  /** docs/146 — fired exactly when `autoResolveConflicts` transitions false → true. */
  onAutoResolveConflictsEnabled?: () => void;
  /** docs/169 — fired exactly when `autoFixCi` transitions false → true. */
  onAutoFixCiEnabled?: () => void;
  gitIdentity?: { name: string; email: string };
  systemPrompt?: string;
  maxIdleContainers?: number;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;
  liveSteering?: boolean;
  /**
   * docs/146 — when true, the PR poller's auto-resolve loop fires on
   * CONFLICTING transitions while the agent is idle.
   */
  autoResolveConflicts?: boolean;
  /** docs/169 — when true, the PR poller's auto-fix-CI loop fires on FAILURE while the agent is idle. */
  autoFixCi?: boolean;
  /** docs/218 — when true, resuming a merged, untouched session resets its branch to the latest base before the turn. */
  autoResetMergedBranch?: boolean;
  /** docs/144 — global gate for sub-agent spawning. */
  enableSubAgents?: boolean;
  /** docs/150 reqs 4-6 — per-provider proactive failover cutoffs (1-100). */
  failoverCutoffs?: Record<string, Partial<FailoverCutoffs>>;
  /** docs/150 req 21 — per-provider account selection mode. */
  accountSelectionMode?: Record<string, AccountSelectionMode>;
  /** docs/163 — voice-note delivery mode (native / external / both). */
  voiceDeliveryMode?: VoiceDeliveryMode;
  /**
   * docs/252 phase 7 (req 9) — pin non-turn work to a `(service, billing mode,
   * model)` triple, or `null` to clear the pin and follow the install again.
   *
   * A whole triple rather than a bare id, for the reason every other selection
   * in this feature is: the same model id is reachable through two services and
   * two modes at different prices, so an id alone cannot say who is billed.
   */
  nonTurnModel?: NonTurnModelSelection | null;
  /**
   * docs/261 phase 3 (reqs 1, 5, 8) — pin one or both reviewer slots, or return
   * a slot to auto-configuration with `null` (*Reset to auto*).
   *
   * A **whole tuple per slot**, because pinning is atomic (req 8): editing any
   * field of an auto-configured slot pins everything it resolved to, so a
   * half-pinned slot — a pinned level over a still-derived model — is not
   * expressible. The one omission the wire allows is `reasoningEffort`, which
   * means "the model changed, give me the derived harness's own review level";
   * the stored pin is complete either way. See `resolveReviewerPinPatch`.
   *
   * Typed as `unknown` at this boundary rather than as the parsed shape: it
   * arrives straight off an HTTP body, and `parseReviewerPinPatch` is where a
   * malformed slot becomes a 400 naming the field instead of a coerced value.
   */
  reviewers?: Record<string, unknown>;
}

export async function saveGlobalSettings(
  opts: SaveGlobalSettingsOptions,
): Promise<GlobalSettings> {
  const {
    agentRegistry, appWorkspaceDir, credentialStore, providerAccountManager,
    onAutoResolveConflictsEnabled,
    gitIdentity, systemPrompt, maxIdleContainers,
    agentSystemInstructionsEnabled, autoCreatePr, liveSteering,
    autoResolveConflicts, autoFixCi, autoResetMergedBranch, enableSubAgents, voiceDeliveryMode,
    failoverCutoffs, accountSelectionMode, nonTurnModel, reviewers,
  } = opts;

  // Save git identity if provided
  if (gitIdentity) {
    const name = typeof gitIdentity.name === "string" ? gitIdentity.name.trim() : "";
    const email = typeof gitIdentity.email === "string" ? gitIdentity.email.trim() : "";
    if (!name) throw new ServiceError(400, "Git user name cannot be empty");
    if (!email) throw new ServiceError(400, "Git email cannot be empty");
    if (name.length > 200) throw new ServiceError(400, "Git user name is too long (max 200 characters)");
    if (email.length > 200) throw new ServiceError(400, "Git email is too long (max 200 characters)");
    writeGitIdentity(name, email);
  }

  // Save system prompt if provided
  if (systemPrompt !== undefined) {
    const content = typeof systemPrompt === "string" ? systemPrompt : "";
    if (content.length > 50_000) throw new ServiceError(400, "System prompt too long (max 50,000 characters)");
    await writeGlobalSystemPrompt(appWorkspaceDir, content);
  }

  // Save max idle containers if provided
  if (maxIdleContainers !== undefined) {
    const n = Math.max(0, Math.floor(maxIdleContainers));
    credentialStore.setMaxIdleContainers(n);
  }

  // Save agent system instructions toggle if provided
  if (agentSystemInstructionsEnabled !== undefined) {
    credentialStore.setAgentSystemInstructionsEnabled(agentSystemInstructionsEnabled);
  }

  // Save auto-create PR toggle if provided
  if (autoCreatePr !== undefined) {
    credentialStore.setAutoCreatePr(autoCreatePr);
  }

  // Save live steering toggle if provided
  if (liveSteering !== undefined) {
    credentialStore.setLiveSteering(liveSteering);
  }

  // docs/144 — save sub-agent spawning gate if provided
  if (enableSubAgents !== undefined) {
    credentialStore.setEnableSubAgents(enableSubAgents);
  }

  // docs/150 reqs 4-6 — validate rather than clamp at the API edge: a request
  // carrying 0 or 150 is a caller bug, and silently accepting it as 1 or 100
  // would hide it. The store still clamps on read, which covers a config file
  // edited by hand.
  //
  // docs/252 phase 2 — keys are `serviceId:billingMode`, and the mode must be a
  // subscription: a cutoff on a `key` mode is meaningless (keys do not fail
  // over), so accepting one would persist a setting nothing can ever read.
  if (failoverCutoffs !== undefined) {
    for (const [key, patch] of Object.entries(failoverCutoffs)) {
      const target = requireSubscriptionModeKey(key);
      for (const window of ["session", "weekly"] as const) {
        const value = patch[window];
        if (value === undefined) continue;
        if (!Number.isInteger(value) || value < 1 || value > 100) {
          throw new ServiceError(400, `${window} failover cutoff must be an integer between 1 and 100`);
        }
      }
      credentialStore.setFailoverCutoffs(target.serviceId, target.billingMode, patch);
    }
  }

  // docs/150 req 21 — validated the same way as the cutoffs above: reject an
  // unknown group or an unrecognized mode rather than coercing it. The store
  // falls back to the default on *read*, which covers a hand-edited config
  // file; a bad value arriving through the API is a caller bug and should say
  // so.
  if (accountSelectionMode !== undefined) {
    for (const [key, mode] of Object.entries(accountSelectionMode)) {
      const target = requireSubscriptionModeKey(key);
      if (mode !== "strict" && mode !== "balanced") {
        throw new ServiceError(400, `Account selection mode must be "strict" or "balanced"`);
      }
      credentialStore.setSelectionMode(target.serviceId, target.billingMode, mode);
    }
  }

  // docs/252 phase 7 (req 9) — pin (or unpin) the model non-turn work runs on.
  // Validated against ELIGIBILITY, not merely against the catalogue: a triple
  // whose mode has no credential, or whose model no installed harness offers,
  // would be a pin that fails on every session and fires the notice each time —
  // and the UI only ever offers eligible rows, so this guards API misuse.
  if (nonTurnModel !== undefined) {
    if (nonTurnModel === null) {
      credentialStore.setNonTurnModel(null);
    } else {
      const runnable = harnessForNonTurnSelection(
        nonTurnModel,
        listConfiguredCredentials(credentialStore),
      );
      if (!runnable) {
        throw new ServiceError(
          400,
          `No installed harness can run ${nonTurnModel.serviceId}/${nonTurnModel.billingMode}/${nonTurnModel.modelId} with the credentials configured`,
        );
      }
      credentialStore.setNonTurnModel(nonTurnModel);
    }
  }

  // docs/261 phase 3 (reqs 1, 5, 8) — pin or reset the reviewer slots.
  //
  // Validated rather than coerced, exactly as `nonTurnModel` above and for the
  // same reason: the tab only ever offers a runnable triple and a level the
  // derived harness declares, so anything else is API misuse. The one thing
  // that is NOT an error is an omitted level — that is the model-changed case,
  // and `resolveReviewerPinPatch` completes the tuple from the derived harness
  // so the stored pin stays atomic (req 8).
  //
  // **Every slot is validated before ANY slot is written**, in two passes.
  // Validating and writing in one loop makes `{ first: valid, second: invalid }`
  // persist `first` and then answer 400 — a caller told the write failed while
  // half of it landed, and a Settings tab that then re-renders from a response
  // it never received. Cross-backend review found it. The two slots are one
  // edit here for the same reason they are one resolution everywhere else in
  // this feature: slot 2 is ranked against slot 1.
  if (reviewers !== undefined) {
    // The container itself, before its entries: `null` is an object to
    // `typeof` and would reach `Object.entries` as a 500, and a scalar would
    // iterate to nothing and be accepted as a silent no-op. Both are caller
    // bugs and both should say so.
    if (reviewers === null || typeof reviewers !== "object" || Array.isArray(reviewers)) {
      throw new ServiceError(400, "reviewers must be an object keyed by reviewer slot");
    }
    const resolved: [ReviewerSlot, ReviewerPin | null][] = Object.entries(reviewers).map(
      ([slot, raw]) => {
        const patch: ReviewerPinPatch | null = parseReviewerPinPatch(raw, slot);
        return [
          requireReviewerSlot(slot),
          patch === null ? null : resolveReviewerPinPatch(patch, credentialStore),
        ];
      },
    );
    for (const [slot, pin] of resolved) credentialStore.setReviewerPin(slot, pin);
  }

  // docs/163 — save voice-note delivery mode if provided
  if (voiceDeliveryMode !== undefined) {
    credentialStore.setVoiceDeliveryMode(voiceDeliveryMode);
  }

  // docs/146 — save auto-resolve toggle. On a false → true edge, fire the
  // re-broadcast hook so existing tracked sessions get their now-ungated
  // `autoResolve` block onto the next SSE snapshot without waiting for a
  // genuine PR-status change (which can take tens of minutes on a sticky
  // conflict).
  if (autoResolveConflicts !== undefined) {
    const prev = credentialStore.getAutoResolveConflicts();
    credentialStore.setAutoResolveConflicts(autoResolveConflicts);
    if (!prev && autoResolveConflicts) onAutoResolveConflictsEnabled?.();
  }

  // docs/169 — save auto-fix-CI toggle. On a false → true edge, re-broadcast
  // snapshots so existing tracked sessions reflect the now-active loop without
  // waiting for a genuine PR-status change.
  if (autoFixCi !== undefined) {
    const prev = credentialStore.getAutoFixCi();
    credentialStore.setAutoFixCi(autoFixCi);
    if (!prev && autoFixCi) opts.onAutoFixCiEnabled?.();
  }

  // docs/218 — save the auto-reset-merged-branch toggle. No re-broadcast hook:
  // the `reset_eligible` signal is recomputed on each session activation and
  // post-turn, so a flipped setting takes effect the next time the user opens or
  // acts in a merged session (the client ANDs the setting with the signal).
  if (autoResetMergedBranch !== undefined) {
    credentialStore.setAutoResetMergedBranch(autoResetMergedBranch);
  }

  return getGlobalSettings(agentRegistry, appWorkspaceDir, credentialStore, providerAccountManager);
}

/** Validate and set the active agent. Returns the agent ID or throws. */
export function setAgent(
  agentRegistry: AgentRegistry,
  agentId: AgentId,
): { agentId: AgentId } {
  const info = agentRegistry.get(agentId);
  if (!info) throw new ServiceError(400, `Unknown agent: ${agentId}`);
  if (!info.installed) throw new ServiceError(400, `${info.name} CLI is not installed in this environment`);
  // docs/252 phase 3 — the gate is "this harness has at least one model it can
  // run" (req 8), so the message names that condition rather than one vendor's
  // environment variable: on an install whose only credential is a DeepSeek key,
  // "OPENAI_API_KEY is not set" would be both true and beside the point.
  if (!info.hasRunnableModels) {
    throw new ServiceError(
      400,
      `${info.name} has no models available. Add a credential for a service it can reach in Settings → Services.`,
    );
  }
  return { agentId };
}

/** Set an agent environment variable. */
export function setAgentEnv(
  agentRegistry: AgentRegistry,
  credentialStore: CredentialStore,
  agentId: AgentId,
  key: string,
  value: string,
): { agentId: AgentId; key: string; agents: AgentInfo[] } {
  if (!agentId || !key || typeof value !== "string") {
    throw new ServiceError(400, "Invalid set_agent_env request");
  }
  if (!isAllowedAgentEnvKey(key)) {
    throw new ServiceError(400, `Environment variable ${key} is not in the allowlist`);
  }
  if (value.trim().length === 0) {
    throw new ServiceError(400, "Value cannot be empty");
  }
  process.env[key] = value;
  // docs/252 phase 2 — a name the catalogue claims as a mode's `storageEnv` is
  // that mode's credential, so it goes to the credential-route store rather
  // than to `agentEnv`'s single slot. Without this branch `set_agent_env`
  // (Codex's `OPENAI_API_KEY`, and the Settings control behind it) would be a
  // second writer for the same fact, and the boot migration would keep moving
  // its writes across. Everything else — every `mcp__*` secret — is unchanged.
  const owner = credentialModeForStorageEnv(key);
  if (owner) upsertSingleStringCredential(credentialStore, owner.serviceId, owner.billingMode, value);
  else credentialStore.setAgentEnv(key, value);
  agentRegistry.refreshAuth(agentId);
  return { agentId, key, agents: listAgents(agentRegistry) };
}

// docs/150 req 19 — `startAuth` / `submitAuthCode` are gone with the singleton
// endpoints that were their only callers. The account-scoped equivalents live
// in `provider-accounts.ts` (`startProviderAccountLogin`,
// `submitProviderAccountCode`), which take the account whose credentials the
// flow will write.

/**
 * Store the Anthropic API key.
 *
 * docs/252 phase 2 — **this used to persist nothing.** It assigned
 * `process.env.ANTHROPIC_API_KEY` and returned, so the key survived exactly as
 * long as the orchestrator process, while Codex's equivalent went into
 * `CredentialData.agentEnv` and outlived a restart. That asymmetry is what the
 * catalogue's `storageEnv` names away: the key is now a credential of
 * `(anthropic, key)` like any other, written through the same service the
 * Settings → Services surface uses.
 *
 * `process.env` is still assigned, and has to be: `reservedRouteFor` and
 * `AgentRegistry.deriveHasRunnableModels` probe the environment, so skipping it would
 * persist the key and simultaneously report the provider as unauthenticated.
 * `app-di` does the same seeding at boot from the stored routes.
 */
export function setApiKey(credentialStore: CredentialStore, key: string): void {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) throw new ServiceError(400, "API key cannot be empty");
  if (!trimmed.startsWith("sk-ant-")) throw new ServiceError(400, "Invalid API key format");
  upsertSingleStringCredential(credentialStore, "anthropic", "key", trimmed);
  process.env.ANTHROPIC_API_KEY = trimmed;
}

/** Remove the stored Anthropic API key, from persistence and the environment. */
export function clearApiKey(credentialStore: CredentialStore): void {
  for (const route of credentialStore.listCredentialRoutes("anthropic", "key")) {
    if (route.via === "string") credentialStore.deleteCredentialRoute(route.id);
  }
  delete process.env.ANTHROPIC_API_KEY;
}

// ---- Provider account management (docs/150) ----

export function listProviderAccounts(providerAccountManager: ProviderAccountManager): { accounts: CredentialRoute[] } {
  return { accounts: providerAccountManager.list() };
}

export function createProviderAccount(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  label?: string,
): { account: CredentialRoute; accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  const account = providerAccountManager.create(serviceId, label);
  return { account, accounts: providerAccountManager.list() };
}

export function renameProviderAccount(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
  label: string,
): { account: CredentialRoute; accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.rename(serviceId, accountId, label);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/**
 * docs/150 req 2 — persist the user's fallback order for a provider.
 *
 * `accountIds` must be the complete set: a partial list is rejected rather than
 * interpreted, so a stale client (one whose account list predates an account
 * added in another tab) gets a 400 instead of silently demoting that account to
 * the end of the order.
 */
export function reorderProviderAccounts(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountIds: unknown,
): { accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string" || !id)) {
    throw new ServiceError(400, "accountIds must be an array of account ids");
  }
  for (const id of accountIds as string[]) validateAccountId(id);
  try {
    providerAccountManager.reorder(serviceId, accountIds as string[]);
    return { accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

// ---- Disconnect / sign-out (docs/260 §6, reqs 2, 3, 13) ----
//
// There is no session→account pin (req 2): between turns a session's on-disk
// token copy is inert residue, and after an account goes away each session's
// next turn simply routes among the accounts that remain (req 3). So taking an
// account away never enumerates "pinned sessions", never asks where they should
// move, and is scoped to live processes and recorded copies only:
//
//   1. **Refuse while a live process is spending the account** (req 7's
//      2026-08-03 running-turn decision plus req 13, now process-scoped): a
//      runner on the account that is mid-turn OR holds in-progress background
//      work (a sub-agent review, an agent-started background process) blocks
//      the operation with a 409. Killing such a process would lose the tokens
//      already spent on that work, and rewriting credentials under a running
//      turn turns it into a mid-turn 401 — the user is asked to wait instead.
//   2. **Kill idle resident processes on the account.** A live CLI holds the
//      token in memory, where no on-disk change can reach it.
//   3. **Revoke per-session credential copies by RECORDED IDENTITY.** The
//      per-session subtree marker (`readSessionAccountMarker`) is the
//      authoritative record of whose copy a session holds — token bytes rotate
//      under the CLI, and the session row records no route. Copies whose marker
//      names a different account are left alone, and so is an unmarked pre-260
//      copy (the next turn's identity check converges it, docs/260 §4).
//      Conversation state survives the revoke, so a reconnected account
//      resumes rather than restarts. Archived sessions are swept too: their
//      subtree survives archival, so leaving the copy is the same leak on a
//      delay.

/** docs/260 req 13 — busy means a running turn OR tracked background work. */
function runnerBusy(runner: SessionRunnerInterface): boolean {
  return runner.running || runner.backgroundWorkDescriptions.length > 0;
}

/**
 * Is this runner's live process on one of `accountIds`? Process-scoped by
 * design: `residentRoute` (typed at spawn from the turn route) is authoritative
 * when present; the session's credential-subtree marker covers a process
 * re-adopted after an orchestrator restart before its stamp is recovered. A
 * session with no runner never reaches here — idle residue is inert.
 */
function runnerOnAccount(
  runner: SessionRunnerInterface,
  provider: AgentId,
  accountIds: ReadonlySet<string>,
  credentialsDir: string | undefined,
): boolean {
  if (runner.residentRoute) {
    return runner.residentRoute.kind === "account" && accountIds.has(runner.residentRoute.id);
  }
  if (!credentialsDir) return false;
  const recorded = readSessionAccountMarker(credentialsDir, runner.sessionId)[provider];
  return recorded !== undefined && accountIds.has(recorded);
}

/** Session ids whose live process is on one of `accountIds` AND busy (req 13). */
function busySessionsOnAccounts(
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  accountIds: ReadonlySet<string>,
  credentialsDir: string | undefined,
): string[] {
  return runnerRegistry.ids().filter((sessionId) => {
    const runner = runnerRegistry.get(sessionId);
    return !!runner && runnerBusy(runner) && runnerOnAccount(runner, provider, accountIds, credentialsDir);
  });
}

/**
 * Kill every resident process on one of `accountIds`, in the order that
 * matters: **in memory first, then on disk** — the reverse leaves a live CLI
 * spending the account it was just cut off from. Callers run the busy guard
 * first, so everything killed here is idle (no turn, no background work).
 */
function retireResidentProcessesOnAccounts(
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  accountIds: ReadonlySet<string>,
  credentialsDir: string | undefined,
): void {
  for (const sessionId of runnerRegistry.ids()) {
    const runner = runnerRegistry.get(sessionId);
    if (!runner || !runnerOnAccount(runner, provider, accountIds, credentialsDir)) continue;
    const agent = runner.getAgent();
    if (!agent) continue;
    try {
      agent.kill();
    } catch {
      // Already dead is the state we wanted; the revoke that follows is what
      // matters and must not be skipped because a stale handle threw.
    }
    runner.setAgent(null);
  }
}

/**
 * Remove every session's copy of the deleted accounts' credentials, identified
 * by the session's own recorded marker — never by a session row, and never by
 * comparing token bytes (the CLI rotates them). `context` names the operation
 * for the no-`credentialsDir` warning, the one case where copies survive (a
 * caller with no credentials root — tests and legacy wiring only).
 */
function revokeRecordedAccountCopies(
  sessionManager: SessionManager,
  provider: AgentId,
  accountIds: ReadonlySet<string>,
  credentialsDir: string | undefined,
  context: string,
): void {
  if (!credentialsDir) {
    console.warn(`[provider-accounts] no credentialsDir: sessions keep their copies of ${context}`);
    return;
  }
  for (const session of sessionManager.listAll()) {
    const recorded = readSessionAccountMarker(credentialsDir, session.id)[provider];
    if (recorded !== undefined && accountIds.has(recorded)) {
      // Also clears the marker, so the next turn's identity check reprovisions.
      revokeSessionProviderCredentials(credentialsDir, session.id, provider);
    }
  }
}

/**
 * planning#285 / docs/260 §6 — sign out of a provider entirely: every connected
 * account's row and source credentials, plus every session's own recorded copy
 * of a signed-out account's token (`ProviderAccountManager.signOutProvider`
 * deletes rows and source subtrees but never reaches the per-session copies the
 * CLIs actually read).
 *
 * The busy-process guard runs here rather than at the call site so the
 * invariant travels with the operation: nothing rewrites credentials under a
 * live turn or in-progress background work (reqs 7, 13). Callers do their own
 * provider-specific teardown (clearing the stored API key, cancelling an
 * in-flight device flow) *after* this returns, so a 409 refusal leaves all of
 * it untouched.
 */
export function signOutProvider(
  providerAccountManager: ProviderAccountManager,
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  opts: { credentialsDir?: string } = {},
): void {
  const serviceId = requireAccountService(provider);
  const signedOut = new Set(
    providerAccountManager.list(serviceId).map((account) => account.id),
  );

  const busy = busySessionsOnAccounts(runnerRegistry, provider, signedOut, opts.credentialsDir);
  if (busy.length > 0) {
    throw new ServiceError(
      409,
      `Cannot sign out of ${provider} while ${busy.length} session(s) are mid-turn or running background work on a connected account.`,
    );
  }

  retireResidentProcessesOnAccounts(runnerRegistry, provider, signedOut, opts.credentialsDir);
  revokeRecordedAccountCopies(
    sessionManager,
    provider,
    signedOut,
    opts.credentialsDir,
    `signed-out ${provider} accounts`,
  );

  providerAccountManager.signOutProvider(provider);
}

/**
 * Disconnect one provider account (docs/260 §6, req 3): the busy-process 409,
 * the idle-process kill, the marker-based revoke (see the section comment
 * above), then the row and the account's source credential root. No session
 * moves anywhere and none is reported "stranded" — the next turn of any
 * session that was running on this account routes normally among the accounts
 * that remain.
 */
export function deleteProviderAccount(
  providerAccountManager: ProviderAccountManager,
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  provider: AgentId,
  accountId: string,
  opts: { credentialsDir?: string } = {},
): { accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  const { credentialsDir } = opts;
  const accountIds = new Set([accountId]);

  const busy = busySessionsOnAccounts(runnerRegistry, provider, accountIds, credentialsDir);
  if (busy.length > 0) {
    // Name them: this refusal is a wait, and the user can only wait for
    // something they can identify. Cap the list so a mass-busy install gets a
    // message rather than a paragraph.
    const named = busy
      .slice(0, 3)
      .map((sessionId) => `"${sessionManager.get(sessionId)?.title || sessionId}"`)
      .join(", ");
    const rest = busy.length - Math.min(busy.length, 3);
    throw new ServiceError(
      409,
      `Cannot disconnect this account while sessions are still working on it: ${named}${rest > 0 ? ` and ${rest} more` : ""}. `
        + "Wait for them to finish or stop them, then disconnect.",
    );
  }

  retireResidentProcessesOnAccounts(runnerRegistry, provider, accountIds, credentialsDir);
  revokeRecordedAccountCopies(
    sessionManager,
    provider,
    accountIds,
    credentialsDir,
    `disconnected ${provider} account ${accountId}`,
  );

  try {
    providerAccountManager.delete(serviceId, accountId);
    return { accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/**
 * Start an account-scoped provider login (docs/150). The provider CLI is
 * spawned with HOME pointed at the account's credential root; pending URL/code
 * and completion stream over the existing `agent_auth_*` SSE family, now
 * carrying the `accountId`. Returns the refreshed account list so the row's
 * `authenticating` status renders immediately.
 */
export function startProviderAccountLogin(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
): { account: CredentialRoute; accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.startAccountAuth(serviceId, accountId);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/** Cancel an in-flight account-scoped login (docs/150). */
export function cancelProviderAccountLogin(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
): { account: CredentialRoute; accounts: CredentialRoute[] } {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  try {
    const account = providerAccountManager.cancelAccountAuth(serviceId, accountId);
    return { account, accounts: providerAccountManager.list() };
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/** Submit an OAuth code into an in-flight scoped Claude login (docs/150). */
export function submitProviderAccountCode(
  providerAccountManager: ProviderAccountManager,
  provider: AgentId,
  accountId: string,
  code: string,
): void {
  const serviceId = requireAccountService(provider);
  validateAccountId(accountId);
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) throw new ServiceError(400, "Authorization code cannot be empty");
  try {
    providerAccountManager.submitAccountCode(serviceId, accountId, trimmed);
  } catch (err) {
    throw providerAccountServiceError(err);
  }
}

/**
 * docs/252 phase 2 — resolve a routing-settings key to the `(service,
 * subscription mode)` it names, or reject it.
 *
 * Three ways to be wrong and each gets its own message, because they are three
 * different mistakes: a malformed key, a service the catalogue does not carry,
 * and a `key` mode — which is well-formed and real and still has no routing
 * settings, since keys never fail over (req 12).
 */
function requireSubscriptionModeKey(key: string): { serviceId: string; billingMode: "sub" } {
  const parsed = parseCredentialModeKey(key);
  if (!parsed) throw new ServiceError(400, `Malformed credential mode key: ${key}`);
  if (!getService(parsed.serviceId)) throw new ServiceError(400, `Unknown service: ${parsed.serviceId}`);
  if (parsed.billingMode !== "sub") {
    throw new ServiceError(400, `Routing settings apply to subscriptions only, not to ${key}`);
  }
  if (!getMode(parsed.serviceId, "sub")) {
    throw new ServiceError(400, `${parsed.serviceId} has no subscription mode`);
  }
  return { serviceId: parsed.serviceId, billingMode: "sub" };
}

/**
 * Validate the `:provider` path segment **and** convert it to the service the
 * account rows are keyed by (planning#342).
 *
 * The two steps are one function so no call site can do the first and forget
 * the second: `ProviderAccountManager`'s row verbs take a `serviceId` string,
 * and a harness id passed there compiles and silently matches nothing.
 */
function requireAccountService(provider: AgentId): string {
  if (provider !== "claude" && provider !== "codex") {
    throw new ServiceError(400, "Unknown provider");
  }
  const serviceId = nativeServiceForHarness(provider);
  if (!serviceId) throw new ServiceError(400, "Unknown provider");
  return serviceId;
}

function validateAccountId(accountId: string): void {
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new ServiceError(400, "Provider account id is required");
  }
}

function providerAccountServiceError(err: unknown): ServiceError {
  const message = err instanceof Error ? err.message : "Provider account operation failed";
  if (/not found/i.test(message)) return new ServiceError(404, message);
  if (/empty|too long/i.test(message)) return new ServiceError(400, message);
  // docs/150 — one CLI process per provider, so a sign-in started on another
  // account blocks this one. That's a conflict the user resolves (finish or
  // cancel the other row), not a server fault.
  if (/already signing in|no longer running/i.test(message)) return new ServiceError(409, message);
  return new ServiceError(500, message);
}
