/**
 * docs/252 phase 7 (req 9) — **which model the work outside a turn runs on**.
 *
 * Naming a session and writing a pull-request description are ShipIt's own
 * work, not the session's, so they get their own `(service, billing mode,
 * model)` selection — chosen the same way every other model is (req 3) and
 * independently of whatever any session is running. The failure this exists to
 * prevent is on record: a lapsed Claude subscription broke session naming for a
 * user who had already moved to Codex, because naming silently assumed a
 * credential nobody had chosen for it.
 *
 * Three rules live here and nothing else:
 *
 *  - **The harness is derived, never chosen.** Running a model means spawning a
 *    CLI, and a model can be offered on more than one installed harness. Taking
 *    the first one in catalogue order keeps this a *model* setting rather than
 *    growing a second control that exists nowhere else in the product. The rule
 *    is arbitrary and that is acceptable here: the work is a session title and a
 *    PR description, every harness that can run a model runs it, and req 9's
 *    notice already covers the failure.
 *  - **The default is a rule, not a stored value.** Unset means *the first
 *    eligible model in the picker's own ordering* — first service, first billing
 *    mode, first model — resolved at the point the work runs. A named default
 *    would point at a vendor the install may have no credential for, which is
 *    exactly the install this feature exists to create (a user whose only
 *    credential is a DeepSeek key), and every session title would fail from day
 *    one. A derived default removes the failure by construction instead of
 *    reporting it, and it self-heals the original incident: when a subscription
 *    lapses, an unset default moves to whatever the install still has.
 *  - **Set and unset are different states.** Unset follows the install; set is a
 *    pin ShipIt does not move. Only the second can go stale, and it is the one
 *    req 9's failure notice reports on.
 *
 * Eligibility is the same conjunction the picker uses — an installed harness
 * (req 14) whose service holds a credential for that billing mode (req 8) — and
 * it is asked of `catalogue/index.ts` rather than reimplemented, so the setting
 * can never offer something the picker would not.
 */

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

/** Which piece of non-turn work is running — what the failure notice names. */
export type NonTurnPurpose = "session-naming" | "pr-description";

/** Human-facing label for a purpose, used in the failure notice's prose. */
export const NON_TURN_PURPOSE_LABEL: Record<NonTurnPurpose, string> = {
  "session-naming": "Session naming",
  "pr-description": "Pull-request description",
};

/**
 * The signature every text-generating feature in the orchestrator is threaded
 * with (`generateText`).
 *
 * `opts.sessionId` is what makes a call non-turn *work* rather than an
 * unattributed prompt: it names the session the failure notice lands in and the
 * usage row is attributed to. A caller with no session — the post-interrupt
 * commit message — omits it and keeps the previous behaviour exactly.
 *
 * Lives here rather than beside the implementation so the many modules that
 * only need the *type* do not have to import the service that spawns agents.
 */
export type GenerateText = (
  prompt: string,
  cwd: string,
  opts?: { sessionId?: string; purpose?: NonTurnPurpose },
) => Promise<string>;

/** Everything a non-turn spawn needs, once the setting has been resolved. */
export interface NonTurnTarget {
  /** Derived (req 9), never stored: the first installed harness offering `selection`. */
  harnessId: AgentId;
  selection: ModelSelection;
  /** The service's display name — what the failure notice tells the user broke. */
  serviceName: string;
  /** Whether this came from the user's pin or from the derived default. */
  source: "pinned" | "default";
  /** The credential route a spawn authenticates with, when one resolved. */
  route: ProviderRoute | null;
  /**
   * Endpoint + credential shaping for a string-delivered credential, or
   * `undefined` when there is nothing to shape (the harness on its own vendor
   * through a login account — which must stay byte-identical to today's spawn).
   */
  serviceRouting?: ServiceRouting;
  /**
   * The secret for `serviceRouting.credentialSourceEnv`, for a caller that has
   * to build the process environment itself. Absent for an account-delivered
   * credential, which is the CLI's own login and carries no secret to place.
   */
  credentialSecret?: string;
}

export type NonTurnResolution =
  | { ok: true; target: NonTurnTarget }
  /** A pin the install can no longer run — the one case req 9's notice reports. */
  | { ok: false; reason: "pin_unavailable"; serviceName: string; selection: ModelSelection }
  /**
   * Nothing at all is runnable: no installed harness has a credentialed model.
   * Not a *failure* of a service — there is no service to name — so callers fall
   * back silently, exactly as an install with no credentials already does
   * everywhere else.
   */
  | { ok: false; reason: "nothing_eligible" };

export interface NonTurnModelDeps {
  credentialStore: Pick<CredentialStore, "getNonTurnModel"> & ServiceRoutingCredentialSource;
  /**
   * Both members: `subscriptionLimitsFor` is what lets the string-delivered
   * walk apply the same quota tiers the account walk does. Narrowing this to
   * `selectAccountForTurn` alone would silently drop a failover tier for a
   * supplied subscription credential.
   */
  providerAccountManager?:
    | Pick<ProviderAccountManager, "selectAccountForTurn" | "subscriptionLimitsFor">
    | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * The first installed harness that can run `selection` with these credentials,
 * in catalogue order — or `undefined` when none can.
 *
 * A retired model resolves through its successor here rather than being
 * refused. The setting is a fourth persisted selection (after the session's,
 * the browser slot's and the sub-agent defaults'), and it strands the same way:
 * a pin the catalogue has retired would fail on every session forever and fire
 * req 9's notice each time, when req 13 already says what to do. Resolved at
 * read time and NOT written back — unlike a session, nothing displays this
 * selection as "what is running right now", so there is no second precedence
 * rule to keep honest, and the user's pin stays the thing they typed.
 */
export function harnessForNonTurnSelection(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
): { harnessId: AgentId; selection: ModelSelection } | undefined {
  return harnessForSelection(selection, credentials);
}

/**
 * The generic behind {@link harnessForNonTurnSelection}: the first **installed**
 * harness that can run `selection` with these credentials, resolving a retired
 * model through its successor (req 13).
 *
 * `opts.avoidHarnessId` moves one harness to the back of the search without
 * removing it — docs/261's reviewer derivation, where the harness is a ranking
 * axis rather than an arbitrary choice: if a reviewer's model runs on both
 * installed harnesses, catalogue order could hand it the implementer's own and
 * drop the reviewer a tier for no reason. It stays a *preference*, so a model
 * only the implementer's harness can run is still resolved rather than refused.
 *
 * Extracted rather than copied: eligibility plus retirement-successor handling
 * is the part a second implementation would get subtly wrong, and there is now a
 * second caller.
 */
export function harnessForSelection(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  opts: { avoidHarnessId?: AgentId } = {},
): { harnessId: AgentId; selection: ModelSelection } | undefined {
  return harnessesForSelection(selection, credentials, opts)[0];
}

/**
 * Every harness in catalogue order, with `avoidHarnessId` moved to the **back**
 * rather than removed.
 *
 * Exported for its own test. It cannot be exercised through
 * {@link harnessesForSelection} against today's rows — no shipped model runs on
 * both harnesses, so every selection has exactly one eligible harness and there
 * is nothing to order — which means a test at that level would pass just as
 * happily against an implementation that ignored the option entirely. Reviewing
 * this branch is what found that; the preference is load-bearing for docs/261's
 * ranking, so it gets a test that fails when it is removed.
 */
export function harnessesPreferring(avoidHarnessId?: AgentId): readonly HarnessDef[] {
  const harnesses = allHarnesses();
  if (!avoidHarnessId) return harnesses;
  return [
    ...harnesses.filter((h) => h.id !== avoidHarnessId),
    ...harnesses.filter((h) => h.id === avoidHarnessId),
  ];
}

/**
 * Every installed harness that can run `selection`, in preference order — the
 * list {@link harnessForSelection} takes the head of.
 *
 * The list form exists for docs/261: a reviewer is ranked only if it has a
 * usable **route**, and "eligible" is not "runnable" (a subscription whose
 * accounts are all spent is eligible and returns `all_exhausted`). So the
 * reviewer resolver has to try the next harness rather than give up on the
 * first, and doing that by re-asking a single-answer function would mean
 * reproducing the eligibility and retirement-successor rules at the call site.
 */
export function harnessesForSelection(
  selection: ModelSelection,
  credentials: readonly ConfiguredCredential[],
  opts: { avoidHarnessId?: AgentId } = {},
): { harnessId: AgentId; selection: ModelSelection }[] {
  const out: { harnessId: AgentId; selection: ModelSelection }[] = [];
  for (const harness of harnessesPreferring(opts.avoidHarnessId)) {
    if (!isHarnessInstalled(harness.id)) continue;
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

/**
 * Req 9's derived default: the first model this install can actually run, in
 * the picker's own ordering — first service, first billing mode, first model.
 *
 * Iterates the SERVICE catalogue rather than one harness's eligible list,
 * because the ordering the requirement names is the service one; the harness is
 * whatever that model turns out to be offered on.
 */
export function firstEligibleNonTurnSelection(
  credentials: readonly ConfiguredCredential[],
): { harnessId: AgentId; selection: ModelSelection } | undefined {
  for (const service of allServices()) {
    for (const mode of service.modes) {
      for (const model of mode.models) {
        const found = harnessForNonTurnSelection(
          { serviceId: service.id, billingMode: mode.kind, modelId: model.id },
          credentials,
        );
        if (found) return found;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the setting into something runnable: the triple, the derived harness,
 * the credential route and the spawn shaping.
 *
 * Pure with respect to the session — non-turn work belongs to ShipIt, not to
 * whichever session happens to be in front of the user — so nothing here reads
 * a session row.
 */
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
  const secret = serviceRouting
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
