import type { AgentId, ServiceRouting } from "../shared/types.js";
import type { ProviderAccountManager, ProviderRoute } from "./provider-account-manager.js";
import type { CredentialStore } from "./credential-store.js";
import {
  allHarnesses,
  allServices,
  getMode,
  getService,
  isSelectionEligible,
  resolveDirectCall,
  retirementSuccessor,
  type ConfiguredCredential,
  type DirectCallTarget,
  type HarnessDef,
  type ModelSelection,
} from "../shared/catalogue/index.js";
import { isHarnessInstalled } from "../shared/installed-harnesses.js";
import { toolsOffRefusal } from "../shared/agent-tools-off.js";
import type { EligibleModel } from "../shared/agent-registry.js";
import {
  credentialSecretForRoute,
  listConfiguredCredentials,
  selectRouteForSelection,
  serviceRoutingForSelection,
  stringRouteForSelection,
  type ServiceRoutingCredentialSource,
} from "./service-routing.js";

/** The purposes that report a failure as a chat card, mirroring `NonTurnFailureCard`. */
export type NonTurnCardPurpose = "session-naming" | "pr-description";

/**
 * Voice cleanup is background work too, and is deliberately not a card purpose:
 * a dictation is not an operation the user is watching, so its failure inserts
 * the raw transcript and writes nothing to the transcript
 * (docs/299-direct-provider-calls req 6).
 */
export type NonTurnPurpose = NonTurnCardPurpose | "voice-cleanup";

export type GenerateText = (
  prompt: string,
  cwd: string,
  opts?: { sessionId?: string; purpose?: NonTurnCardPurpose },
) => Promise<string>;

interface NonTurnTargetCommon {
  selection: ModelSelection;
  serviceName: string;
  source: "pinned" | "default";
}

export interface NonTurnHarnessTarget extends NonTurnTargetCommon {
  execution: "harness";
  harnessId: AgentId;
  route: ProviderRoute | null;
  serviceRouting?: ServiceRouting;
  credentialSecret?: string;
}

/** No harness and no container: the orchestrator calls the provider's API itself. */
export interface NonTurnDirectTarget extends NonTurnTargetCommon {
  execution: "direct";
  call: DirectCallTarget;
  apiKey: string;
}

/**
 * A union on `execution` rather than an always-present `harnessId`, so the
 * compiler names every consumer that assumed a harness ran the work (docs/299
 * req 2). A direct target carries no harness id at all, which is also what
 * keeps usage honest: "ran directly" must not collapse into "metered".
 */
export type NonTurnTarget = NonTurnHarnessTarget | NonTurnDirectTarget;

export type NonTurnResolution =
  | { ok: true; target: NonTurnTarget }
  | { ok: false; reason: "pin_unavailable"; serviceName: string; selection: ModelSelection }
  | { ok: false; reason: "nothing_eligible" };

export interface NonTurnModelDeps {
  credentialStore: Pick<CredentialStore, "getNonTurnModel"> & ServiceRoutingCredentialSource;
  providerAccountManager?:
    | Pick<ProviderAccountManager, "selectAccountForTurn" | "subscriptionLimitsFor">
    | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface HarnessSearchOpts {
  avoidHarnessId?: AgentId;
  // Seeding uses the probed registry; the default allows all harnesses when no install report exists.
  isInstalled?: (harnessId: AgentId) => boolean;
}

export interface NonTurnSearchOpts extends HarnessSearchOpts {
  /**
   * Session naming still runs a CLI straight from the orchestrator, so it asks
   * for a harness it can actually run. docs/299 phase 3 moves it onto the
   * direct executor and this option goes with it.
   */
  harnessOnly?: boolean;
  /**
   * Reads the credential a direct call would send. A caller that supplies one
   * offers a direct call only where the key is readable, so the runner it gets
   * back is one it can run; a caller asking about eligibility alone (seeding,
   * the option list) omits it.
   */
  directKeyFor?: (selection: ModelSelection, call: DirectCallTarget) => string | undefined;
}

export type NonTurnRunner =
  | { execution: "harness"; harnessId: AgentId; selection: ModelSelection }
  | { execution: "direct"; selection: ModelSelection; call: DirectCallTarget; apiKey?: string };

/**
 * A direct call where the credential permits one, and no harness row for the
 * same model (docs/299-direct-provider-calls req 3). A harness can reach that model too, but for
 * background work it is slower, needs a container and arrives at the same
 * place. The capability itself is the catalogue's answer — `resolveDirectCall`
 * — never re-derived from the billing mode or from how the credential arrived.
 */
export function runnerForNonTurnSelection(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  opts: NonTurnSearchOpts = {},
): NonTurnRunner | undefined {
  if (!opts.harnessOnly) {
    const direct = directRunnerFor(selection, credentials, opts.directKeyFor);
    if (direct) return direct;
  }
  const harness = backgroundWorkHarnessFor(selection, credentials, opts);
  return harness ? { execution: "harness", ...harness } : undefined;
}

/**
 * Background work runs a harness one-shot with its tools off, so a harness with
 * no measured way to do that cannot carry it — and must not be offered, rather
 * than refused once the user has chosen it (`agent-tools-off.ts`).
 *
 * Filtered here and NOT in `harnessesForSelection`, which the reviewer and the
 * role resolver share: those run an ordinary turn with tools live, where the
 * refusal says nothing about whether the harness can do the work.
 */
function backgroundWorkHarnessFor(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  opts: HarnessSearchOpts,
): { harnessId: AgentId; selection: ModelSelection } | undefined {
  return harnessesForSelection(selection, credentials, opts)
    .find((candidate) => !toolsOffRefusal(candidate.harnessId));
}

function directRunnerFor(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  readKey: NonTurnSearchOpts["directKeyFor"],
): NonTurnRunner | undefined {
  const configured = credentials.some(
    (c) =>
      c.via === "string"
      && c.serviceId === selection.serviceId
      && c.billingMode === selection.billingMode,
  );
  if (!configured) return undefined;
  for (const candidate of [selection, ...directSuccessorsOf(selection)]) {
    const call = resolveDirectCall(candidate);
    if (!call) continue;
    if (!readKey) return { execution: "direct", selection: candidate, call };
    const apiKey = readKey(candidate, call);
    if (apiKey) return { execution: "direct", selection: candidate, call, apiKey };
  }
  return undefined;
}

// Retirement has no harness here to pick the successor's style, so any declared
// successor that is itself directly callable is the replacement.
function directSuccessorsOf(selection: ModelSelection): ModelSelection[] {
  const retired = getMode(selection.serviceId, selection.billingMode)
    ?.retired.find((r) => r.id === selection.modelId);
  if (!retired) return [];
  return [...new Set(Object.values(retired.successors))].map((modelId) => ({
    ...selection,
    modelId,
  }));
}

export function harnessForNonTurnSelection(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  opts: HarnessSearchOpts = {},
): { harnessId: AgentId; selection: ModelSelection } | undefined {
  return harnessForSelection(selection, credentials, opts);
}

export function harnessForSelection(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  opts: HarnessSearchOpts = {},
): { harnessId: AgentId; selection: ModelSelection } | undefined {
  return harnessesForSelection(selection, credentials, opts)[0];
}

export function harnessesPreferring(avoidHarnessId?: AgentId): readonly HarnessDef[] {
  const harnesses = allHarnesses();
  if (!avoidHarnessId) return harnesses;
  return [
    ...harnesses.filter((h) => h.id !== avoidHarnessId),
    ...harnesses.filter((h) => h.id === avoidHarnessId),
  ];
}

// Eligibility does not guarantee remaining quota; callers may need to try another returned route.
export function harnessesForSelection(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  opts: HarnessSearchOpts = {},
): { harnessId: AgentId; selection: ModelSelection }[] {
  const installed = opts.isInstalled ?? isHarnessInstalled;
  const out: { harnessId: AgentId; selection: ModelSelection }[] = [];
  for (const harness of harnessesPreferring(opts.avoidHarnessId)) {
    if (!installed(harness.id)) continue;
    if (isSelectionEligible(harness.id, selection, credentials)) {
      out.push({ harnessId: harness.id, selection });
      continue;
    }
    const successor = retirementSuccessor(harness.id, selection);
    if (successor && isSelectionEligible(harness.id, successor, credentials)) {
      out.push({ harnessId: harness.id, selection: successor });
    }
  }
  return out;
}

export function firstEligibleNonTurnSelection(
  credentials: readonly ConfiguredCredential[],
  opts: NonTurnSearchOpts = {},
): NonTurnRunner | undefined {
  for (const service of allServices()) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        const found = runnerForNonTurnSelection(
          { serviceId: service.id, billingMode: mode.kind, modelId: model.id },
          credentials,
          opts,
        );
        if (found) return found;
      }
    }
  }
  return undefined;
}

/**
 * Every triple background work can run on this install — a direct call where
 * the credential permits one, a harness where it does not (docs/299 req 3).
 *
 * The selector cannot reuse `eligibleModelsOf(agentList)`: that is the union
 * over INSTALLED harnesses, so a model provider reachable only by a direct call
 * is invisible there however well the resolver answers. Built from the same
 * `runnerForNonTurnSelection` the resolver uses, so the options offered and the
 * thing that runs cannot disagree — including req 3's "only that call": one
 * triple is one row, and which execution it gets is the resolver's answer, not
 * a second row for the user to choose between.
 *
 * Eligibility only: no `directKeyFor`, so a provider whose key is configured is
 * offered without reading the secret.
 */
export function backgroundWorkOptions(
  credentials: readonly ConfiguredCredential[],
  opts: HarnessSearchOpts = {},
): EligibleModel[] {
  const out: EligibleModel[] = [];
  for (const service of allServices()) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        const selection = { serviceId: service.id, billingMode: mode.kind, modelId: model.id };
        if (!runnerForNonTurnSelection(selection, credentials, opts)) continue;
        out.push({
          serviceId: service.id,
          serviceName: service.name,
          billingMode: mode.kind,
          modelId: model.id,
          label: model.label,
          canonicalModelKey: model.canonicalModelKey,
        });
      }
    }
  }
  return out;
}

export function resolveNonTurnModel(
  deps: NonTurnModelDeps,
  opts: Pick<NonTurnSearchOpts, "harnessOnly"> = {},
): NonTurnResolution {
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  const pinned = deps.credentialStore.getNonTurnModel();
  const routeDeps = {
    credentialStore: deps.credentialStore,
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  };
  const search: NonTurnSearchOpts = {
    ...opts,
    directKeyFor: (selection, call) => directCallKey(deps, routeDeps, selection, call),
  };
  const resolved = pinned
    ? runnerForNonTurnSelection(pinned, credentials, search)
    : firstEligibleNonTurnSelection(credentials, search);

  if (!resolved) {
    if (!pinned) return { ok: false, reason: "nothing_eligible" };
    return {
      ok: false,
      reason: "pin_unavailable",
      serviceName: getService(pinned.serviceId)?.name ?? pinned.serviceId,
      selection: pinned,
    };
  }

  const { selection } = resolved;
  const common: NonTurnTargetCommon = {
    selection,
    serviceName: getService(selection.serviceId)?.name ?? selection.serviceId,
    source: pinned ? "pinned" : "default",
  };

  if (resolved.execution === "direct" && resolved.apiKey) {
    return {
      ok: true,
      target: { execution: "direct", ...common, call: resolved.call, apiKey: resolved.apiKey },
    };
  }

  // A direct runner with no key means the credential went away between being
  // listed and being read; a harness on the same selection still answers.
  const harnessId = resolved.execution === "harness"
    ? resolved.harnessId
    : backgroundWorkHarnessFor(selection, credentials, {})?.harnessId;
  if (!harnessId) {
    return pinned
      ? { ok: false, reason: "pin_unavailable", serviceName: common.serviceName, selection }
      : { ok: false, reason: "nothing_eligible" };
  }

  const account = selectRouteForSelection(harnessId, selection, routeDeps);
  const route = account.ok ? account.route : null;
  const serviceRouting = serviceRoutingForSelection(harnessId, selection, route, deps.credentialStore);
  const secret = serviceRouting?.credentialSourceEnv
    ? credentialSecretForRoute(deps, selection, serviceRouting.credentialSourceEnv, route)
    : undefined;

  return {
    ok: true,
    target: {
      execution: "harness",
      harnessId,
      ...common,
      route,
      ...(serviceRouting ? { serviceRouting } : {}),
      ...(secret ? { credentialSecret: secret } : {}),
    },
  };
}

// Optimistic: a benched subscription key is still the credential this call must
// send, and a direct call has no second route to fail over to.
function directCallKey(
  deps: NonTurnModelDeps,
  routeDeps: Parameters<typeof stringRouteForSelection>[1],
  selection: ModelSelection,
  call: DirectCallTarget,
): string | undefined {
  const route = stringRouteForSelection(selection, routeDeps, { optimistic: true });
  return credentialSecretForRoute(deps, selection, call.storageEnv, route.ok ? route.route : null);
}
