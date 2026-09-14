import type { AgentRegistry } from "../../shared/agent-registry.js";
import {
  allHarnesses,
  harnessForNativeService,
  reasoningOptionsFor,
} from "../../shared/catalogue/index.js";
import type { ModelSelection } from "../../shared/catalogue/types.js";
import {
  ALL_SETTINGS,
  collectionKeyOf,
  findSetting,
  formatSetting,
  hostEntryProjection,
  isPayloadDeclaration,
  projectSetting,
  userNameProjection,
} from "../../shared/settings-catalogue/index.js";
import type { AnySettingDeclaration, ApplyOutcome } from "../../shared/settings-catalogue/index.js";
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";
import type { AgentRole, AgentId, RolePinnedParams } from "../../shared/types/agent-types.js";
import type {
  SettingsProposalOperation,
  SettingsProposalSideChange,
  SettingsProposalTarget,
} from "../../shared/types.js";
import type { ChatHistoryManager } from "../chat-history.js";
import { MAX_CREDENTIAL_LABEL_LENGTH } from "../credential-store.js";
import type { CredentialStore } from "../credential-store.js";
import { EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { AgentMergeClaimStore } from "../agent-merge-claims.js";
import { harnessesForSelection } from "../non-turn-model.js";
import { resolveReviewerPinPatch } from "./reviewer-settings.js";
import { checkRolePinnedParams } from "./roles.js";
import type { RoleValidatorDeps } from "./roles.js";
import type { ReviewerPinPatch } from "./types.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { RepoStore } from "../repo-store.js";
import type { ServiceManager } from "../service-manager.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { listConfiguredCredentials } from "../service-routing.js";
import { listCredentialRoutes } from "./credential-routes.js";
import { buildEffectiveAllowlist } from "../egress-allowlist.js";
import { MAX_ENABLED_MCP_SERVERS } from "./mcp.js";
import {
  applyCredentialLabel,
  applyEgressGlobalEnabled,
  applyEgressHostAdd,
  applyEgressHostRemove,
  applyGlobalSettings,
  applyMcpServerEnabled,
  applyProviderAccountLabel,
  applyReleaseChannel,
  applyRepoSettings,
  credentialLabelDomains,
  domainsForSettingsSave,
  providerAccountDomains,
} from "./settings-apply.js";
import type { SaveGlobalSettingsOptions } from "./settings.js";
import {
  egressScopeDomain,
  mcpServerDomain,
  releaseChannelDomain,
  repositoryDomain,
} from "./settings-conflict-domain.js";
import type { ConflictDomain } from "./settings-conflict-domain.js";
import { ServiceError } from "./types.js";

/**
 * What a proposal card's Apply button actually runs
 * (docs/299-agent-settings-access req 4).
 *
 * A declaration says a setting MAY be proposed; this says what changing it
 * means. The two are deliberately separate, because a field-level declaration
 * is for **discovery** and is not the mutation unit (plan.md → The unit of a
 * change is the declared operation): picking a role's model rewrites the
 * service, the billing mode and the model id together and re-derives the
 * harness, so the operation is that whole tuple and a field-by-field write
 * would need invalid intermediate states.
 *
 * Three rules hold for every entry here.
 *
 * **The write is the shared layer's, never the store's.** Each operation ends in
 * a `settings-apply.ts` call, so a proposal does the whole act a route does —
 * the durable write, the broadcast, the live refresh — rather than a subset
 * somebody has to remember to complete.
 *
 * **A collection is patched, never replaced.** The agent supplies one field; the
 * current stored object is read here and merged, because the agent cannot see
 * the credential fields inside one and a whole-object write would drop or echo
 * them.
 *
 * **`domains` is a superset of what the write takes.** The decision handler
 * holds them across its baseline check and the write, so the nested acquisition
 * inside `settings-apply.ts` has to be the same set — which is why the payload
 * operations build their options once and derive both from them.
 *
 * A declared-proposable setting with no operation here is refused at propose
 * time, by name. That is the honest answer — the read works, the change does not
 * yet — and it is deliberately not one of the catalogue's four refusal reasons,
 * which describe settings nobody can propose at all.
 */

export type SettingsOperationKind = SettingsProposalOperation;

/** The card's subject: a declaration key plus a concrete address, or nothing. */
export type SettingsOperationTarget = SettingsProposalTarget;

export interface SettingsOperationDeps {
  sseBroadcast: (event: string, data: unknown) => void;
  appWorkspaceDir: string;
  agentRegistry: AgentRegistry;
  credentialStore?: CredentialStore | undefined;
  providerAccountManager?: ProviderAccountManager | undefined;
  egressAllowlistStore?: EgressAllowlistStore | undefined;
  repoStore?: RepoStore | undefined;
  chatHistoryManager?: ChatHistoryManager | undefined;
  runnerRegistry?: SessionRunnerRegistry | undefined;
  agentMergeClaims?: AgentMergeClaimStore | undefined;
  serviceManagers?: Map<string, ServiceManager> | undefined;
  containerManager?: { reloadEgress(sessionId: string): Promise<boolean> } | undefined;
  /** The two enable hooks the settings route supplies; a proposal does the same. */
  prStatusPoller?: { broadcastAllSnapshots(): void } | undefined;
}

export interface SettingsOperation {
  /**
   * Every stored object this operation writes.
   *
   * Answered BEFORE the lock is taken, from three things that are all settled by
   * then: the target, the stores (a credential id names a row whose service and
   * billing mode are fixed for its life), and the already-validated value a
   * rename needs — it writes the stored object under the new name as well as the
   * old one's.
   */
  domains(
    target: SettingsOperationTarget,
    deps: SettingsOperationDeps,
    value: unknown,
  ): ConflictDomain[];
  /**
   * Refuse before anything is written, in words the card can show. Runs at
   * propose time AND again inside the lock, because a card outlives its turn.
   */
  preflight?(deps: SettingsOperationDeps, target: SettingsOperationTarget, value: unknown): string | null;
  apply(
    deps: SettingsOperationDeps,
    target: SettingsOperationTarget,
    value: unknown,
  ): Promise<ApplyOutcome>;
  /**
   * Everything ELSE this one operation would rewrite, for the card to show; the
   * user approves what the card displays. Re-derived at apply time and compared
   * with the card, because the derivation reads live state the baseline does not
   * cover — a harness can be uninstalled between the two.
   */
  alsoChanges?(
    deps: SettingsOperationDeps,
    target: SettingsOperationTarget,
    value: unknown,
  ): SettingsProposalSideChange[];
  /**
   * How the card words a change that is not a new value — joining or leaving a
   * collection. Absent for a `set`, where the values themselves are the wording.
   */
  wording?: { from: string; to: string };
  /**
   * The stored form of an address the agent typed, so the card names the entry
   * the write will actually make rather than the spelling it arrived in.
   */
  normalizeItem?(item: string): string;
  /** ShipIt's own account of what the click did, for the resolved card. */
  applied(target: SettingsOperationTarget, display: string, declaration: AnySettingDeclaration): string;
}

function requireCredentialStore(deps: SettingsOperationDeps): CredentialStore {
  if (!deps.credentialStore) {
    throw new ServiceError(503, "This install has no credential store, so nothing can be written to it.");
  }
  return deps.credentialStore;
}

function egressDeps(deps: SettingsOperationDeps) {
  if (!deps.egressAllowlistStore) {
    throw new ServiceError(503, "This install has no egress allowlist store, so nothing can be written to it.");
  }
  return {
    sseBroadcast: deps.sseBroadcast,
    egressAllowlistStore: deps.egressAllowlistStore,
    credentialStore: deps.credentialStore,
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
  };
}

/**
 * A text setting's value. Validation has already established it is a string, so
 * anything else is a caller that skipped it — and stringifying an object here
 * would write "[object Object]" into a role's own words.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * One neighbouring field, through the same door `from` and `to` go through. A
 * field whose declaration has gone throws rather than being dropped: showing
 * less than the operation writes is what this exists to prevent.
 */
function sideChange(key: string, from: unknown, to: unknown): SettingsProposalSideChange | null {
  const declaration = findSetting(key);
  if (!declaration) {
    throw new ServiceError(
      400,
      `Applying this would also change ${key}, which ShipIt no longer declares, so a card cannot `
        + "show its whole effect.",
    );
  }
  const show = (raw: unknown): string => formatSetting(declaration, projectSetting(declaration, raw ?? null));
  const before = show(from);
  const after = show(to);
  return before === after ? null : { label: declaration.label, from: before, to: after };
}

function sideChanges(changes: (SettingsProposalSideChange | null)[]): SettingsProposalSideChange[] {
  return changes.filter((change): change is SettingsProposalSideChange => change !== null);
}

function settingIs(
  target: SettingsOperationTarget,
  display: string,
  declaration: AnySettingDeclaration,
): string {
  const instance = target.item ? ` · ${echoSupplied(target.item)}` : "";
  return `${declaration.label}${instance} is ${display}`;
}

/**
 * An address the CALLER supplied, echoed back so the refusal says which one it
 * means. Reflected input rather than a stored value, so this is presentation
 * hygiene and not req 2's defence — the same treatment `settings-read.ts` gives
 * a key it does not know (plan.md → Reflected input is not this rule's business).
 */
const SUPPLIED_ECHO_MAX = 80;

export function echoSupplied(supplied: string): string {
  const flat = supplied.replace(/\s+/g, " ").trim();
  return flat.length > SUPPLIED_ECHO_MAX ? `${flat.slice(0, SUPPLIED_ECHO_MAX)}…` : flat;
}

/**
 * Stored names an error message may repeat, and how many it may not: no message
 * interpolates a stored value that did not come through the projection door
 * (req 2, plan.md → `emits` is an allowlist of derived values). A role name is
 * arbitrary user text, and the read emits no item at all for one shaped like a
 * URL.
 */
function namesForMessage(names: string[]): string {
  const shown = names
    .map(userNameProjection)
    .filter((name): name is string => name !== null);
  const withheld = names.length - shown.length;
  const rest = withheld > 0
    ? `${shown.length > 0 ? ", and " : ""}${withheld} ShipIt does not name back`
    : "";
  if (shown.length === 0 && withheld === 0) return "none";
  return `${shown.join(", ")}${rest}`;
}

// ---------------------------------------------------------------------------
// The global settings payload, and the panels that save through it
// ---------------------------------------------------------------------------

function saveOptions(
  deps: SettingsOperationDeps,
  patch: Partial<SaveGlobalSettingsOptions>,
): SaveGlobalSettingsOptions {
  return {
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
    // The two hooks the settings route supplies. A proposal that turns auto-fix
    // CI on has to do what the dialog does, or the feature stays asleep until
    // something else broadcasts.
    ...(deps.prStatusPoller
      ? {
          onAutoResolveConflictsEnabled: () => deps.prStatusPoller?.broadcastAllSnapshots(),
          onAutoFixCiEnabled: () => deps.prStatusPoller?.broadcastAllSnapshots(),
        }
      : {}),
    ...patch,
    // Last, so a built patch cannot displace what the write runs against.
    agentRegistry: deps.agentRegistry,
    appWorkspaceDir: deps.appWorkspaceDir,
    credentialStore: requireCredentialStore(deps),
  };
}

/**
 * A save built from the target, used for BOTH the domains and the write.
 *
 * One function rather than two because the lock the decision handler holds has
 * to be the set `applyGlobalSettings` will ask for: deriving them from separate
 * code is how the two drift and the nested acquisition throws.
 */
type SaveBuilder = (
  deps: SettingsOperationDeps,
  target: SettingsOperationTarget,
  value: unknown,
) => Partial<SaveGlobalSettingsOptions>;

/**
 * The domains a save of this shape takes. `domainsForSettingsSave` reads the
 * option KEYS and the role names and never touches a store, so the same patch
 * shape answers before the write is built and after.
 */
function domainsOfSave(patch: Partial<SaveGlobalSettingsOptions>): ConflictDomain[] {
  return domainsForSettingsSave(patch as SaveGlobalSettingsOptions);
}

function savingOperation(
  build: SaveBuilder,
  domainsOf: SettingsOperation["domains"],
  opts: { preflight?: SettingsOperation["preflight"] } = {},
): SettingsOperation {
  return {
    domains: domainsOf,
    ...(opts.preflight ? { preflight: opts.preflight } : {}),
    async apply(deps, target, value) {
      const { outcome } = await applyGlobalSettings(deps, saveOptions(deps, build(deps, target, value)));
      return outcome;
    },
    applied: settingIs,
  };
}

// Roles ---------------------------------------------------------------------

function storedRole(deps: SettingsOperationDeps, name: string | undefined): AgentRole | undefined {
  if (!name) return undefined;
  return requireCredentialStore(deps).getRole(name);
}

/**
 * The whole role, with one field replaced — the server-side merge that keeps a
 * proposal from having to send a role object it cannot see all of. `params` is
 * required by the write, and carrying the stored one through is what keeps the
 * reserved `reviewer` role automatic and every other role pinned.
 */
function roleWrite(role: AgentRole, patch: Partial<AgentRole>): Record<string, unknown> {
  return {
    previousName: role.name,
    description: role.description ?? "",
    prompt: role.prompt ?? "",
    params: role.params,
    ...patch,
  };
}

type RolePatch = (role: AgentRole, value: unknown, deps: SettingsOperationDeps) => Partial<AgentRole>;

/**
 * Refuse what the write would refuse, BEFORE the card is posted.
 *
 * It runs the same patch the apply runs and puts the params it produces through
 * the role validator with purpose `"save"` — the check the dialog's own save
 * does. That is what keeps a card from being posted for a harness that does not
 * exist or a level the selection does not offer, and it is deliberately the
 * `"save"` purpose: credential eligibility is skipped there so a disconnected
 * role stays editable (`services/role-settings.ts`).
 */
function rolePreflight(patch: RolePatch): NonNullable<SettingsOperation["preflight"]> {
  return (deps, target, value) => {
    const role = storedRole(deps, target.item);
    if (!role) {
      const known = namesForMessage(deps.credentialStore?.getRoles().map((r) => r.name) ?? []);
      return `No role named "${echoSupplied(target.item ?? "")}" — roles on this install: ${known}.`;
    }
    let params: AgentRole["params"];
    try {
      params = { ...role, ...patch(role, value, deps) }.params;
    } catch (err) {
      if (err instanceof ServiceError) return err.message;
      throw err;
    }
    if (params.kind !== "pinned") return null;
    const checked = checkRolePinnedParams(params, roleValidatorDeps(deps), "save");
    return checked.ok ? null : checked.message;
  };
}

function roleValidatorDeps(deps: SettingsOperationDeps): RoleValidatorDeps {
  return { credentialStore: requireCredentialStore(deps) };
}

function rolePatchOperation(patch: RolePatch): SettingsOperation {
  const build: SaveBuilder = (deps, target, value) => {
    const role = storedRole(deps, target.item);
    if (!role) throw new ServiceError(400, `No role named "${echoSupplied(target.item ?? "")}".`);
    return { roles: { [role.name]: roleWrite(role, patch(role, value, deps)) } };
  };
  return savingOperation(
    build,
    (target) => domainsOfSave({ roles: { [target.item ?? ""]: {} } }),
    { preflight: rolePreflight(patch) },
  );
}

function pinnedParams(role: AgentRole, target: SettingsOperationTarget): RolePinnedParams {
  if (role.params.kind !== "pinned") {
    throw new ServiceError(
      400,
      `The "${echoSupplied(target.item ?? role.name)}" role resolves its model itself and pins nothing, so there `
        + "is no model, harness or level on it to change.",
    );
  }
  return role.params;
}

/** A pinned params object with no `reasoningEffort` key at all when there is none. */
function pinned(
  harnessId: AgentId,
  selection: ModelSelection,
  reasoningEffort: string | undefined,
): RolePinnedParams {
  return {
    kind: "pinned",
    harnessId,
    ...selection,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

/** The levels the selection honours; a level it does not is dropped rather than refused. */
function keptEffort(
  harnessId: AgentId,
  selection: ModelSelection,
  effort: string | undefined,
): string | undefined {
  const options = reasoningOptionsFor(harnessId, selection);
  if (options.length === 0) return undefined;
  return effort !== undefined && options.some((o) => o.value === effort) ? effort : undefined;
}

/**
 * The harness a selection runs on, keeping the role's own where it still can —
 * the move the role editor makes when the user picks a model
 * (`Settings/roles/RoleEditor.tsx` → `moveTo`).
 *
 * Credentials are the LAST word here, not the first. A harness that can speak to
 * the model is preferred whether or not a credential for it is connected, so a
 * disconnected role stays editable exactly as the dialog's own save keeps it
 * (`services/role-settings.ts`) — and where nothing can speak to it, the role's
 * own harness is kept and the validator refuses with the reason, rather than
 * this silently choosing a harness on credential grounds.
 */
function harnessForSelection(
  deps: SettingsOperationDeps,
  selection: ModelSelection,
  current: AgentId,
): AgentId {
  const validator = roleValidatorDeps(deps);
  const speaks = (harnessId: AgentId): boolean =>
    checkRolePinnedParams(pinned(harnessId, selection, undefined), validator, "save").ok;
  if (speaks(current)) return current;
  const connected = harnessesForSelection(
    selection,
    listConfiguredCredentials(requireCredentialStore(deps)),
  ).find((h) => speaks(h.harnessId));
  if (connected) return connected.harnessId;
  return allHarnesses().map((h) => h.id).find(speaks) ?? current;
}

function requireSelection(value: unknown): ModelSelection {
  const row = value as Partial<ModelSelection> | null;
  if (!row || typeof row.serviceId !== "string" || typeof row.modelId !== "string"
    || (row.billingMode !== "sub" && row.billingMode !== "key")) {
    throw new ServiceError(400, "A model names a serviceId, a billingMode and a modelId.");
  }
  return { serviceId: row.serviceId, billingMode: row.billingMode, modelId: row.modelId };
}

/** One function, so the card and the write cannot derive the tuple differently. */
function roleModelParams(
  role: AgentRole,
  value: unknown,
  deps: SettingsOperationDeps,
): RolePinnedParams {
  const params = pinnedParams(role, { key: "roles[].model", item: role.name });
  const selection = requireSelection(value);
  const harnessId = harnessForSelection(deps, selection, params.harnessId);
  return pinned(harnessId, selection, keptEffort(harnessId, selection, params.reasoningEffort));
}

/**
 * Picking a model moves two more fields, and the card says so: the harness when
 * the role's own cannot speak to the new model, and a level the new selection
 * does not offer.
 */
const roleModelOperation: SettingsOperation = {
  ...rolePatchOperation((role, value, deps) => ({ params: roleModelParams(role, value, deps) })),
  alsoChanges: (deps, target, value) => {
    const role = storedRole(deps, target.item);
    if (role?.params.kind !== "pinned") return [];
    const next = roleModelParams(role, value, deps);
    return sideChanges([
      sideChange("roles[].harness", role.params.harnessId, next.harnessId),
      sideChange("roles[].reasoningEffort", role.params.reasoningEffort, next.reasoningEffort),
    ]);
  },
};

/**
 * A level the new harness does not honour is dropped rather than carried over —
 * the role editor's own move, since `validateRoleParams` refuses one the
 * selection does not offer — so the card names it.
 */
function roleHarnessParams(role: AgentRole, value: unknown): RolePinnedParams {
  const params = pinnedParams(role, { key: "roles[].harness", item: role.name });
  const harnessId = asText(value) as AgentId;
  const selection = {
    serviceId: params.serviceId,
    billingMode: params.billingMode,
    modelId: params.modelId,
  };
  return pinned(harnessId, selection, keptEffort(harnessId, selection, params.reasoningEffort));
}

const roleHarnessOperation: SettingsOperation = {
  ...rolePatchOperation((role, value) => ({ params: roleHarnessParams(role, value) })),
  alsoChanges: (deps, target, value) => {
    const role = storedRole(deps, target.item);
    if (role?.params.kind !== "pinned") return [];
    return sideChanges([
      sideChange(
        "roles[].reasoningEffort",
        role.params.reasoningEffort,
        roleHarnessParams(role, value).reasoningEffort,
      ),
    ]);
  },
};

// Reviewer slots ------------------------------------------------------------

function reviewerPin(deps: SettingsOperationDeps, slot: string): Record<string, unknown> | null {
  const pin = requireCredentialStore(deps).getReviewerPin(slot as "first" | "second");
  return pin ? { ...pin } : null;
}

/**
 * Why a reviewer slot cannot take this level, if it cannot.
 *
 * `resolveReviewerPinPatch` is the shipped writer's own resolver, and it
 * SUBSTITUTES a default for a level the selection does not offer rather than
 * refusing one. That is right for the dialog, whose picker only offers real
 * levels, and wrong for a card: the card would say "is banana" and the store
 * would hold "high". So the resolver is run here first and its answer compared
 * with what was asked for — the write is refused when the two differ, rather
 * than applied as something the card did not describe.
 */
function reviewerLevelRefusal(
  deps: SettingsOperationDeps,
  patch: Record<string, unknown>,
  requested: string | undefined,
): string | null {
  const credentialStore = requireCredentialStore(deps);
  let resolved;
  try {
    resolved = resolveReviewerPinPatch(patch as unknown as ReviewerPinPatch, credentialStore);
  } catch (err) {
    if (err instanceof ServiceError) return err.message;
    throw err;
  }
  if (requested === undefined || resolved.reasoningEffort === requested) return null;
  const selection = {
    serviceId: resolved.serviceId,
    billingMode: resolved.billingMode,
    modelId: resolved.modelId,
  };
  const [runnable] = harnessesForSelection(selection, listConfiguredCredentials(credentialStore));
  const offered = runnable
    ? reasoningOptionsFor(runnable.harnessId, selection).map((o) => o.value)
    : [];
  return offered.length > 0
    ? `"${requested}" is not a reasoning level this model offers. It offers: ${offered.join(", ")}.`
    : "This model offers no reasoning levels, so a reviewer slot on it cannot name one.";
}

function reviewerOperation(
  patch: (pin: Record<string, unknown> | null, value: unknown) => Record<string, unknown> | null,
  preflight?: SettingsOperation["preflight"],
): SettingsOperation {
  return savingOperation(
    (deps, target, value) => ({
      reviewers: { [target.item ?? ""]: patch(reviewerPin(deps, target.item ?? ""), value) },
    }),
    () => domainsOfSave({ reviewers: {} }),
    {
      preflight: (deps, target, value) => {
        if (target.item !== "first" && target.item !== "second") {
          return `A reviewer slot is "first" or "second", not "${echoSupplied(target.item ?? "")}".`;
        }
        return preflight ? preflight(deps, target, value) : null;
      },
    },
  );
}

/**
 * A slot's model, and the level that rides on it. `resolveReviewerPinPatch`
 * SUBSTITUTES the slot's default for a level the new model does not offer, which
 * is right — the dialog's picker does the same — and has to be on the card.
 */
function reviewerModelOperation(): SettingsOperation {
  const resolvedEffort = (
    deps: SettingsOperationDeps,
    pin: Record<string, unknown> | null,
    value: unknown,
  ): string | undefined => {
    const selection = requireSelection(value);
    const patch = { ...selection, ...(pin?.reasoningEffort ? { reasoningEffort: pin.reasoningEffort } : {}) };
    return resolveReviewerPinPatch(patch as unknown as ReviewerPinPatch, requireCredentialStore(deps))
      .reasoningEffort;
  };
  return {
    ...reviewerOperation(
      (pin, value) => {
        if (value === null) return null;
        const selection = requireSelection(value);
        return { ...selection, ...(pin?.reasoningEffort ? { reasoningEffort: pin.reasoningEffort } : {}) };
      },
      (deps, target, value) => {
        if (value === null) return null;
        const pin = reviewerPin(deps, target.item ?? "");
        const selection = value as Partial<ModelSelection>;
        if (typeof selection?.serviceId !== "string") {
          return "A model names a serviceId, a billingMode and a modelId.";
        }
        // The selection has to be one this install can run a reviewer on — that
        // is what the writer refuses. The level the pin carries is NOT compared:
        // it is re-derived exactly as the dialog's own picker re-derives it, and
        // `alsoChanges` is what puts the result on the card.
        return reviewerLevelRefusal(
          deps,
          { ...selection, ...(pin?.reasoningEffort ? { reasoningEffort: pin.reasoningEffort } : {}) },
          undefined,
        );
      },
    ),
    alsoChanges: (deps, target, value) => {
      const pin = reviewerPin(deps, target.item ?? "");
      const before = pin?.reasoningEffort;
      // Clearing the pin takes the level with it; there is no pin left to hold one.
      const after = value === null ? undefined : resolvedEffort(deps, pin, value);
      return sideChanges([sideChange("reviewers[].reasoningEffort", before, after)]);
    },
  };
}

// Services ------------------------------------------------------------------

/** The `service:mode` key the Services panel stores these under. */
function modeKey(target: SettingsOperationTarget): string {
  if (!target.item?.includes(":")) {
    throw new ServiceError(400, `A service setting is addressed by "service:billingMode", not "${echoSupplied(target.item ?? "")}".`);
  }
  return target.item;
}

function modeAddressed(preflight?: SettingsOperation["preflight"]): SettingsOperation["preflight"] {
  return (deps, target, value) => {
    if (!target.item?.includes(":")) {
      return `This setting is addressed by "service:billingMode" — `
        + "`shipit settings get` lists the ones this install has.";
    }
    return preflight ? preflight(deps, target, value) : null;
  };
}

/**
 * A label the writer would refuse. The declaration's own limit is wider than
 * what `updateStringCredential` and `ProviderAccountManager.rename` store, and a
 * card that could only ever resolve `refused` is not a change the user makes
 * with one click.
 */
function labelRefusal(label: string): string | null {
  return label.length > MAX_CREDENTIAL_LABEL_LENGTH
    ? `A name is at most ${MAX_CREDENTIAL_LABEL_LENGTH} characters, and this one is ${label.length}.`
    : null;
}

/** A stored credential's display name, addressed by the route id the read emits. */
const credentialLabelOperation: SettingsOperation = {
  domains: (target, deps) => credentialLabelDomains(requireCredentialStore(deps), target.item ?? ""),
  preflight: (deps, target, value) => {
    const routeId = target.item ?? "";
    if (requireCredentialStore(deps).getCredentialRoute(routeId)) return labelRefusal(asText(value));
    // Through the collection's own projection, like every other message that
    // names stored values (plan.md → `emits` is an allowlist of derived values).
    const collection = findSetting("services.credentials")!;
    const stored = listCredentialRoutes(requireCredentialStore(deps))
      .filter((route) => route.via === "string");
    const outcome = projectSetting(collection, stored);
    const known = outcome.readable && Array.isArray(outcome.value) ? outcome.value : [];
    return `No credential with id "${echoSupplied(routeId)}" — ids on this install: `
      + `${known.length > 0 ? known.join(", ") : "none"}.`;
  },
  apply: async (deps, target, value) => {
    const { outcome } = await applyCredentialLabel(
      { sseBroadcast: deps.sseBroadcast, credentialStore: requireCredentialStore(deps) },
      target.item ?? "",
      asText(value),
    );
    return outcome;
  },
  applied: settingIs,
};

/**
 * The `serviceId:accountId` the read emits, as the writer's own arguments.
 *
 * The two halves are not the same vocabulary: an address names the SERVICE the
 * account belongs to, and `renameProviderAccount` takes the HARNESS whose
 * sign-in owns that service (`requireAccountService`). Passing the address's
 * half straight through refused every rename with "Unknown provider", at the
 * click rather than at the proposal.
 */
function accountAddress(item: string | undefined): { harnessId: AgentId; accountId: string } | null {
  const at = item?.indexOf(":") ?? -1;
  if (!item || at <= 0 || at === item.length - 1) return null;
  const harnessId = harnessForNativeService(item.slice(0, at));
  return harnessId ? { harnessId, accountId: item.slice(at + 1) } : null;
}

/** A connected account's display name. Connecting one is a sign-in and stays unproposable. */
const providerAccountLabelOperation: SettingsOperation = {
  domains: (target) => providerAccountDomains(accountAddress(target.item)?.harnessId ?? ""),
  preflight: (deps, target, value) => {
    const address = accountAddress(target.item);
    if (!address) {
      return `No provider account is addressed by "${echoSupplied(target.item ?? "")}" — `
        + "`shipit settings get services.providerAccounts[].label` lists the ones this install has.";
    }
    if (!deps.providerAccountManager) {
      return "This install has no provider accounts, so there is none to rename.";
    }
    return labelRefusal(asText(value));
  },
  apply: async (deps, target, value) => {
    const address = accountAddress(target.item);
    if (!address || !deps.providerAccountManager) {
      throw new ServiceError(400, "This card names no provider account that still exists.");
    }
    const { outcome } = await applyProviderAccountLabel(
      {
        sseBroadcast: deps.sseBroadcast,
        credentialStore: requireCredentialStore(deps),
        providerAccountManager: deps.providerAccountManager,
        broadcastProviderAccounts: (accounts) => deps.sseBroadcast("provider_accounts", { accounts }),
      },
      address.harnessId,
      address.accountId,
      asText(value),
    );
    return outcome;
  },
  applied: settingIs,
};

/**
 * Renaming a role, expressed by the KEY of the roles map with the old name as
 * `previousName` rather than by a `name` field.
 */
const roleNameOperation: SettingsOperation = savingOperation(
  (deps, target, value) => {
    const role = storedRole(deps, target.item);
    if (!role) throw new ServiceError(400, `No role named "${echoSupplied(target.item ?? "")}".`);
    return { roles: { [asText(value)]: roleWrite(role, {}) } };
  },
  (target, _deps, value) => domainsOfSave({
    roles: { [asText(value)]: { previousName: target.item ?? "" } },
  }),
  {
    preflight: (deps, target, value) => {
      const role = storedRole(deps, target.item);
      if (!role) {
        const known = namesForMessage(deps.credentialStore?.getRoles().map((r) => r.name) ?? []);
        return `No role named "${echoSupplied(target.item ?? "")}" — roles on this install: ${known}.`;
      }
      const next = asText(value);
      if (role.name === RESERVED_ROLE_NAME) {
        return `The "${RESERVED_ROLE_NAME}" role cannot be renamed: "review this" has to keep resolving `
          + "to something. Its description and standing instructions are editable.";
      }
      if (next === RESERVED_ROLE_NAME) {
        return `"${RESERVED_ROLE_NAME}" is the name of the role ShipIt ships, so another role cannot take it.`;
      }
      if (storedRole(deps, next)) {
        return `A role called "${echoSupplied(next)}" already exists, and a rename would replace it.`;
      }
      // The write validates the whole role, not the name — a role pinned to a
      // retired model or an uninstalled harness is refused at the click — so the
      // rename runs the same check every other role edit runs.
      return rolePreflight(() => ({}))(deps, target, value);
    },
  },
);

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const OPERATIONS: Record<string, SettingsOperation> = {
  // Roles. A field is merged into the stored role; the role's own params ride
  // through untouched, which is what keeps the reserved role automatic.
  "roles[].description::set": rolePatchOperation((_role, value) => ({ description: asText(value) })),
  "roles[].prompt::set": rolePatchOperation((_role, value) => ({ prompt: asText(value) })),
  "roles[].model::set": roleModelOperation,
  "roles[].name::set": roleNameOperation,
  "roles[].harness::set": roleHarnessOperation,
  "roles[].reasoningEffort::set": rolePatchOperation((role, value) => {
    const params = pinnedParams(role, { key: "roles[].reasoningEffort", item: role.name });
    const effort = asText(value);
    return {
      params: pinned(
        params.harnessId,
        { serviceId: params.serviceId, billingMode: params.billingMode, modelId: params.modelId },
        effort || undefined,
      ),
    };
  }),

  // Reviewer slots. A slot's model is the pin; its level rides on the pin, so
  // there has to be one to put it on.
  "reviewers[].model::set": reviewerModelOperation(),
  "reviewers[].reasoningEffort::set": reviewerOperation(
    (pin, value) => (pin ? { ...pin, reasoningEffort: asText(value) } : null),
    (deps, target, value) => {
      const pin = reviewerPin(deps, target.item ?? "");
      if (!pin) {
        return `The "${echoSupplied(target.item ?? "")}" reviewer slot pins no model, so it has no level of its own. `
          + "Pin a model on the slot first.";
      }
      return reviewerLevelRefusal(deps, { ...pin, reasoningEffort: asText(value) }, asText(value));
    },
  ),

  // Credential routing, addressed by service and billing mode.
  "services.credentials[].label::set": credentialLabelOperation,
  "services.providerAccounts[].label::set": providerAccountLabelOperation,
  "services.accountSelectionMode::set": savingOperation(
    (_deps, target, value) => ({ accountSelectionMode: { [modeKey(target)]: value as "strict" | "balanced" } }),
    () => domainsOfSave({ accountSelectionMode: {} }),
    { preflight: modeAddressed() },
  ),
  "services.failoverCutoff.session::set": savingOperation(
    (_deps, target, value) => ({ failoverCutoffs: { [modeKey(target)]: { session: value as number } } }),
    () => domainsOfSave({ failoverCutoffs: {} }),
    { preflight: modeAddressed() },
  ),
  "services.failoverCutoff.weekly::set": savingOperation(
    (_deps, target, value) => ({ failoverCutoffs: { [modeKey(target)]: { weekly: value as number } } }),
    () => domainsOfSave({ failoverCutoffs: {} }),
    { preflight: modeAddressed() },
  ),

  // The release channel writes through its own route. `applyReleaseChannel`
  // keeps the write apart from the update check that follows it, so what throws
  // here is the write — a refusal that stored nothing — and a failed check
  // arrives as an applied outcome saying what it could not confirm.
  "advanced.releaseChannel::set": {
    domains: () => [releaseChannelDomain],
    async apply(deps, _target, value) {
      const { outcome } = await applyReleaseChannel(deps, value as "stable" | "edge");
      return outcome;
    },
    applied: settingIs,
  },

  // Egress.
  "network.egressContained::set": {
    domains: () => [egressScopeDomain(EGRESS_GLOBAL_SCOPE)],
    apply: (deps, _target, value) => applyEgressGlobalEnabled(egressDeps(deps), value === true),
    applied: settingIs,
  },
  "network.egress.hosts[].host::add": {
    domains: () => [egressScopeDomain(EGRESS_GLOBAL_SCOPE)],
    preflight: (_deps, target) => hostPreflight(target.item),
    apply: async (deps, target) =>
      (await applyEgressHostAdd(egressDeps(deps), EGRESS_GLOBAL_SCOPE, target.item ?? "")).outcome,
    wording: { from: "not allowed", to: "allowed" },
    normalizeItem: normalizeHostEntry,
    applied: (target) => `${target.item ?? "the host"} is on the global allowlist`,
  },
  "network.egress.hosts[].host::remove": {
    domains: () => [egressScopeDomain(EGRESS_GLOBAL_SCOPE)],
    preflight: (deps, target) => hostPreflight(target.item) ?? removableRefusal(deps, target.item ?? ""),
    apply: (deps, target) => applyEgressHostRemove(egressDeps(deps), EGRESS_GLOBAL_SCOPE, target.item ?? ""),
    // Membership, not reachability. Entries are patterns, so taking
    // `api.github.com` off leaves the shipped `.github.com` matching it — a card
    // reading "not allowed" would promise, before the click, something the
    // removal cannot deliver.
    wording: { from: "on the list", to: "off the list" },
    normalizeItem: normalizeHostEntry,
    applied: (target) => `${target.item ?? "the host"} is off the global allowlist`,
  },

  // MCP. One boolean, which is the whole of what the card shows — every other
  // field of a server is refused by its declaration.
  "mcp.servers[].enabled::set": {
    domains: (target) => [mcpServerDomain(target.item ?? "")],
    preflight: (deps, target, value) => {
      const server = deps.credentialStore?.getMcpServer(target.item ?? "");
      if (!server) return `No MCP server named "${echoSupplied(target.item ?? "")}".`;
      if (value !== true || server.enabled) return null;
      // The writer refuses the eleventh, so a card offering it would only ever
      // resolve `refused` (`services/mcp.ts` → MAX_ENABLED_MCP_SERVERS).
      const enabled = Object.values(deps.credentialStore?.getAllMcpServers() ?? {})
        .filter((s) => s.enabled && s.name !== server.name).length;
      return enabled + 1 > MAX_ENABLED_MCP_SERVERS
        ? `${MAX_ENABLED_MCP_SERVERS} MCP servers are already enabled, which is the limit. `
          + "Turning another one off is what makes room for this."
        : null;
    },
    async apply(deps, target, value) {
      const credentialStore = requireCredentialStore(deps);
      // One field, through a write that touches one field: an update carrying
      // the stored server reconciles its secrets and deletes the ones the
      // config does not reference (`services/mcp.ts` → `setMcpServerEnabled`).
      const { outcome } = await applyMcpServerEnabled(
        {
          sseBroadcast: deps.sseBroadcast,
          credentialStore,
          serviceManagers: deps.serviceManagers ?? new Map<string, ServiceManager>(),
        },
        target.item ?? "",
        value === true,
      );
      return outcome;
    },
    applied: (target, display) => `the ${echoSupplied(target.item ?? "")} MCP server is ${display}`,
  },

  // Project settings. The repository is the session's own binding, frozen on
  // the card, and re-verified before the write.
  "project.allowAgentMerge::set": repoOperation("allowAgentMerge"),
  "project.colorIndex::set": repoOperation("colorIndex"),
};

/** The allowlist stores a trimmed, lowercased host, and so does the card. */
function normalizeHostEntry(host: string): string {
  return hostEntryProjection(host) ?? host;
}

function hostPreflight(host: string | undefined): string | null {
  if (!host) return "Name the host to add or remove.";
  // The allowlist's own projection drops anything not shaped like a host, so an
  // entry shaped otherwise is one the card could not show back (plan.md → an
  // operation whose full effect cannot be displayed is refused). The entry is
  // NOT quoted back: what was typed can be a URL carrying a token, and this
  // message reaches the transcript as tool output.
  return hostEntryProjection(host) !== null
    ? null
    : "That entry is not shaped like a host name, so a card could not show what it would allow. "
      + "Name a host such as registry.npmjs.org, or .example.com for a whole subtree.";
}

/**
 * Whether the allowlist can actually drop this entry.
 *
 * The list the read shows is the EFFECTIVE one: ShipIt's built-in defaults, the
 * hosts an operator set in the environment, and the hosts the configured MCP
 * servers need, on top of the user's own. Only the user's own and the built-in
 * defaults can be removed — `applyEgressHostRemove` deletes a row or suppresses
 * a default, and neither reaches the other two — so removing one of those would
 * report "off the allowlist" about a host that is still on it.
 */
function removableRefusal(deps: SettingsOperationDeps, host: string): string | null {
  const store = deps.egressAllowlistStore;
  if (!store) return null;
  const entry = buildEffectiveAllowlist({
    ...(deps.credentialStore ? { credentialStore: deps.credentialStore } : {}),
    globalHosts: store.listHosts(EGRESS_GLOBAL_SCOPE),
    suppressedDefaults: store.listSuppressedDefaults(),
  }).find((candidate) => candidate.host === host);
  if (!entry || entry.removable) return null;
  return entry.source === "mcp"
    ? `${host} is on the allowlist because a configured MCP server needs it, so removing it here `
      + "would not take it off. Removing the server is what removes the host."
    : `${host} is on the allowlist because this deployment's operator put it there, so ShipIt `
      + "cannot take it off.";
}

function repoOperation(field: "allowAgentMerge" | "colorIndex"): SettingsOperation {
  return {
    domains: (target) => [repositoryDomain(target.repoUrl ?? "")],
    preflight: (deps, target) => {
      if (!target.repoUrl) return "This is a per-repository setting and this session binds no repository.";
      return deps.repoStore?.get(target.repoUrl)
        ? null
        : "ShipIt has no record of this session's repository any more.";
    },
    async apply(deps, target, value) {
      if (!deps.repoStore || !deps.chatHistoryManager) {
        throw new ServiceError(503, "This install has no repository store, so nothing can be written to it.");
      }
      const { outcome, notFound } = await applyRepoSettings(
        {
          sseBroadcast: deps.sseBroadcast,
          repoStore: deps.repoStore,
          chatHistoryManager: deps.chatHistoryManager,
          ...(deps.runnerRegistry ? { runnerRegistry: deps.runnerRegistry } : {}),
          ...(deps.agentMergeClaims ? { agentMergeClaims: deps.agentMergeClaims } : {}),
        },
        target.repoUrl ?? "",
        field === "allowAgentMerge"
          ? { allowAgentMerge: value === true }
          : { colorIndex: value as number },
      );
      if (notFound) throw new ServiceError(400, "ShipIt has no record of this session's repository any more.");
      return outcome;
    },
    applied: settingIs,
  };
}

/**
 * Every declared scalar the global settings payload stores, with no entry of its
 * own: a setting declared tomorrow is proposable the same day, which is req 7
 * holding structurally rather than by a list somebody maintains.
 */
function payloadOperation(declaration: AnySettingDeclaration): SettingsOperation {
  const wire = declaration.wire!;
  return savingOperation(
    (_deps, _target, value) => ({ [wire]: value }),
    // Null only names the field: the domains follow from which option is
    // present, and the git identity is the one payload field with a stored
    // object — and so a domain — of its own.
    () => domainsOfSave({ [wire]: null }),
  );
}

/**
 * The registry's own keys, exactly as written. A test that enumerates
 * declarations instead cannot see a MISSPELLED key — it simply drops out of the
 * enumeration and everything passes, while the operation it names is one propose
 * can never reach.
 */
export function registeredOperationKeys(): string[] {
  return Object.keys(OPERATIONS);
}

export function findOperation(
  declaration: AnySettingDeclaration,
  kind: SettingsOperationKind,
): SettingsOperation | undefined {
  const named = OPERATIONS[`${declaration.key}::${kind}`];
  if (named) return named;
  if (kind === "set" && isPayloadDeclaration(declaration)) return payloadOperation(declaration);
  return undefined;
}

/**
 * The entry fields of a collection that a proposal CAN reach.
 *
 * A collection declaration is the aggregate — `roles`, `mcp.servers`,
 * `network.egress.hosts` — and a card never replaces a whole list, so the
 * aggregate carries no operation of its own while its entry fields do. Naming
 * them is what keeps `propose.allowed: true` on the aggregate honest: there is
 * somewhere for a proposal about it to go, and the refusal says where rather
 * than leaving the agent to discover it by attempting the change
 * (docs/299-agent-settings-access req 4).
 */
export function proposableFieldsOf(collectionKey: string): string[] {
  return ALL_SETTINGS
    .filter((declaration) => collectionKeyOf(declaration.key) === collectionKey)
    .filter((declaration) => operationsFor(declaration.key).length > 0)
    .map((declaration) => declaration.key);
}

/** What a `shipit settings propose` refusal says about a setting nothing can write yet. */
export function operationsFor(key: string): SettingsOperationKind[] {
  const declaration = findSetting(key);
  if (!declaration) return [];
  const kinds: SettingsOperationKind[] = ["set", "add", "remove"];
  return kinds.filter((kind) => findOperation(declaration, kind) !== undefined);
}
