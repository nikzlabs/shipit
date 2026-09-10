import type { AgentId, ServiceRouting } from "../shared/types.js";
import type { ProviderAccountManager, ProviderRoute } from "./provider-account-manager.js";
import type { CredentialStore } from "./credential-store.js";
import {
  allHarnesses,
  allServices,
  getService,
  isSelectionEligible,
  retirementSuccessor,
  type ConfiguredCredential,
  type HarnessDef,
  type ModelSelection,
} from "../shared/catalogue/index.js";
import { isHarnessInstalled } from "../shared/installed-harnesses.js";
import {
  credentialSecretForRoute,
  listConfiguredCredentials,
  selectRouteForSelection,
  serviceRoutingForSelection,
  type ServiceRoutingCredentialSource,
} from "./service-routing.js";

export type NonTurnPurpose = "session-naming" | "pr-description";

export type GenerateText = (
  prompt: string,
  cwd: string,
  opts?: { sessionId?: string; purpose?: NonTurnPurpose },
) => Promise<string>;

export interface NonTurnTarget {
  harnessId: AgentId;
  selection: ModelSelection;
  serviceName: string;
  source: "pinned" | "default";
  route: ProviderRoute | null;
  serviceRouting?: ServiceRouting;
  credentialSecret?: string;
}

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
  opts: HarnessSearchOpts = {},
): { harnessId: AgentId; selection: ModelSelection } | undefined {
  for (const service of allServices()) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        const found = harnessForNonTurnSelection(
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

export function resolveNonTurnModel(deps: NonTurnModelDeps): NonTurnResolution {
  const credentials = listConfiguredCredentials(deps.credentialStore, deps.env ?? process.env);
  const pinned = deps.credentialStore.getNonTurnModel();
  const resolved = pinned
    ? harnessForNonTurnSelection(pinned, credentials)
    : firstEligibleNonTurnSelection(credentials);

  if (!resolved) {
    if (!pinned) return { ok: false, reason: "nothing_eligible" };
    return {
      ok: false,
      reason: "pin_unavailable",
      serviceName: getService(pinned.serviceId)?.name ?? pinned.serviceId,
      selection: pinned,
    };
  }

  const { harnessId, selection } = resolved;
  const routeDeps = {
    credentialStore: deps.credentialStore,
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  };
  const account = selectRouteForSelection(harnessId, selection, routeDeps);
  const route = account.ok ? account.route : null;
  const serviceRouting = serviceRoutingForSelection(harnessId, selection, route, deps.credentialStore);
  const secret = serviceRouting?.credentialSourceEnv
    ? credentialSecretForRoute(deps, selection, serviceRouting.credentialSourceEnv, route)
    : undefined;

  return {
    ok: true,
    target: {
      harnessId,
      selection,
      serviceName: getService(selection.serviceId)?.name ?? selection.serviceId,
      source: pinned ? "pinned" : "default",
      route,
      ...(serviceRouting ? { serviceRouting } : {}),
      ...(secret ? { credentialSecret: secret } : {}),
    },
  };
}
