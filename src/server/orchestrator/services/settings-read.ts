import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { EgressEnforcementStatus } from "../../shared/types.js";
import {
  ALL_SETTINGS,
  addressesARepository,
  findSetting,
  formatSetting,
  isPayloadDeclaration,
  projectSetting,
  refusalSentence,
} from "../../shared/settings-catalogue/index.js";
import type {
  AnySettingDeclaration,
  RefusalReason,
  SettingAddress,
  SettingScope,
  SettingTab,
  SettingValueKind,
} from "../../shared/settings-catalogue/index.js";
import type { CredentialStore } from "../credential-store.js";
import type { EgressAllowlistStore } from "../egress-allowlist-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionManager } from "../sessions.js";
import { backgroundWorkOptions, resolveNonTurnModel } from "../non-turn-model.js";
import { readChannel } from "../release-channel.js";
import { listConfiguredCredentials } from "../service-routing.js";
import { readStoredGlobalSettings } from "./settings-derivation.js";
import { ServiceError } from "./types.js";

/**
 * The agent's read surface, projected from the declarations
 * (docs/299-agent-settings-access req 1, 3, 5, 7). It is a projection and never
 * a second description of ShipIt's settings: every entry it returns comes from
 * the catalogue, and a newly declared setting is INDEXED here — key, label,
 * description, shape, refusal — with no edit to this file.
 *
 * Its VALUE comes from the catalogue too, where the settings payload stores it.
 * A declaration whose store is NOT the payload names only where the value lives,
 * so reading one back needs a reader: `own-route` has two below, and the 42
 * `bespoke` declarations have none yet, so they report that ShipIt cannot read
 * the value rather than passing off a default as the live one. Req 5 and req 7
 * hold — every setting is named, described and refusal-tagged — and req 3 is
 * what degrades until the bespoke readers land in the next slice.
 *
 * **Every emitted value goes through `projectSetting` / `formatSetting`
 * (`settings-catalogue/projection.ts`), and nothing here formats a stored value
 * directly** (req 2). An MCP entry takes arbitrary `args`, `env`, `headers` and
 * a URL, so a token lives in a field called `args`; a second formatter beside
 * that door is exactly how one escapes in the output path nobody re-checks.
 *
 * Two steps by ROLE, never by size: `list` is the index — what a setting is and
 * what it is set to — and `get` is the detail, carrying the value's shape and
 * whatever has to be resolved live. A size threshold would make the response
 * shape depend on how many models happen to be installed.
 */

export type SettingEffectState = "live" | "restart-dependent" | "excluded" | "uncertain";

/**
 * Whether the stored value is what ShipIt actually uses. `live` means the next
 * use of this setting reads the stored value — not that a process already
 * running re-reads it.
 */
export interface SettingEffect {
  state: SettingEffectState;
  /** Why it is not live, in words the agent can repeat to the user. */
  detail?: string;
}

/**
 * Why ShipIt cannot show the agent this setting's value. The catalogue's four
 * refusal reasons carry through from a `withheld` projection; the two below them
 * are this read's own.
 */
export type SettingUnreadableReason =
  | RefusalReason
  /** A per-repository setting read from a session that binds no repository. */
  | "no_repository"
  /** Stored somewhere this read has no reader for yet. */
  | "no_reader";

export interface SettingProposeView {
  allowed: boolean;
  refusal?: RefusalReason;
  explanation?: string;
}

/**
 * What identifies one instance of a setting. `list` says a setting is per-item;
 * `get` is where the items themselves belong (req 1: the index, then the detail
 * of one). The index never grows an entry per item — its length must not depend
 * on how many roles or MCP servers someone happens to have.
 */
export interface SettingAddressView {
  kind: SettingAddress["kind"];
  /** What names one instance, e.g. "a role name". */
  noun?: string;
}

/** One addressed instance of an item-addressed setting, in `get` only. */
export interface SettingItemView {
  /** How a change names this instance. */
  address: string;
  value: unknown;
  display: string;
}

export interface SettingIndexEntry {
  key: string;
  label: string;
  /** The declared description's first sentence; `get` carries it whole (req 7). */
  summary: string;
  tab: SettingTab;
  scope: SettingScope;
  address: SettingAddressView;
  /** Projected through the declaration's `emits`; null when unreadable. */
  value: unknown;
  /** The value on one line, in the form a change to it would name. */
  display: string;
  readable: boolean;
  unreadableReason?: SettingUnreadableReason;
  propose: SettingProposeView;
  effect: SettingEffect;
  /** What the existing views already compute, so the agent says why (req 3). */
  notes: string[];
}

export interface SettingDetailEntry extends SettingIndexEntry {
  /** The declared description, whole — the same words the dialog shows (req 7). */
  description: string;
  valueType: SettingValueKind;
  /** Options, bounds, units, fields — whatever the declared `type` holds. */
  shape: Record<string, unknown>;
  /** Facts a declaration cannot hold, resolved at read time. */
  live?: Record<string, unknown>;
  /** Present for an item-addressed setting: one entry per instance. */
  items?: SettingItemView[];
}

export interface SettingsIndex {
  settings: SettingIndexEntry[];
  /** Every tab carrying at least one declared setting. */
  tabs: SettingTab[];
}

export interface SettingsReadDeps {
  agentRegistry: Pick<AgentRegistry, "list">;
  appWorkspaceDir: string;
  sessionManager: Pick<SessionManager, "get">;
  credentialStore?: CredentialStore | undefined;
  providerAccountManager?: ProviderAccountManager | undefined;
  egressAllowlistStore?: EgressAllowlistStore | undefined;
  egressEnforcementStatus?: EgressEnforcementStatus | undefined;
  egressEnforcementActive?: boolean | undefined;
  containerManager?: {
    get(sessionId: string): { status?: string; egressContainedAtStart?: boolean } | undefined;
    /** The shipped resolver, so sandbox capabilities are honoured, not re-derived. */
    resolveEgress(sessionId: string): { contained: boolean; userHostsExcluded?: boolean } | undefined;
  } | undefined;
  /** Injected by tests; the release channel otherwise comes off the host checkout. */
  readReleaseChannel?: (() => Promise<string>) | undefined;
}

/**
 * Every declaration the read projects — the registry, which is every source the
 * catalogue has. NOT `GLOBAL_SETTINGS`, which is only the 13 settings the global
 * payload stores: sourcing the index from it returns a fifth of what req 5 names
 * and looks correct in every test that restates the same source.
 */
function allDeclarations(): readonly AnySettingDeclaration[] {
  return ALL_SETTINGS;
}

const SUMMARY_MAX = 200;
const LIST_TEXT_MAX = 200;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The first sentence of the declared description. A period is a sentence end
 * only before a capital or the string's end, so "(e.g. a second opinion)" does
 * not cut the summary in half.
 */
function firstSentence(description: string): string {
  const flat = oneLine(description);
  const end = /[.!?](?:\s+(?=[A-Z])|$)/.exec(flat);
  const sentence = end ? flat.slice(0, end.index + 1) : flat;
  return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX).trimEnd()}…` : sentence;
}

type ReadOutcome =
  | { ok: true; value: unknown }
  | { ok: false; reason: SettingUnreadableReason; note: string };

type OwnRouteReader = (deps: SettingsReadDeps) => Promise<ReadOutcome> | ReadOutcome;

/**
 * A declaration names the route that WRITES an own-route setting, not how to
 * read one back, so the read is supplied here. A setting with no reader is
 * reported unreadable rather than defaulted: reporting a made-up default as the
 * live value is worse than saying ShipIt cannot see it.
 */
const OWN_ROUTE_READERS: Record<string, OwnRouteReader> = {
  "advanced.releaseChannel": async (deps) => ({
    ok: true,
    value: await (deps.readReleaseChannel ?? readChannel)(),
  }),
  "network.egressContained": (deps) =>
    deps.egressAllowlistStore
      ? { ok: true, value: deps.egressAllowlistStore.getGlobalEnabled() }
      : { ok: false, reason: "no_reader", note: "This install has no egress allowlist store, so the containment setting cannot be read." },
};

function proposeView(declaration: AnySettingDeclaration): SettingProposeView {
  if (declaration.propose.kind === "yes") return { allowed: true };
  const { reason } = declaration.propose;
  // The catalogue owns the sentence, so a refused read and a refused change say
  // the same thing about the same setting.
  return { allowed: false, refusal: reason, explanation: refusalSentence(reason) };
}

export interface ProjectedValue {
  value: unknown;
  display: string;
  notes: string[];
  /** A `withheld` projection: the declaration gives the read no value at all. */
  withheld?: RefusalReason;
}

/**
 * The emitted value for one setting — ALWAYS through the catalogue's door
 * (`projectSetting`, then `formatSetting` on the outcome rather than on the
 * stored value). Nothing here touches `raw` again afterwards except to shorten
 * an already-projected string.
 */
export function projectSettingValue(
  declaration: AnySettingDeclaration,
  raw: unknown,
  detail: boolean,
): ProjectedValue {
  const outcome = projectSetting(declaration, raw);
  const display = formatSetting(declaration, outcome);
  if (!outcome.readable) {
    return { value: null, display, notes: [outcome.explanation], withheld: outcome.reason };
  }
  const notes = projectionNotes(declaration);
  // Shortening applies to what the door emitted, never to the stored value, and
  // only to prose: a git identity is a `user_text` value that is not one string.
  if (detail || typeof outcome.value !== "string" || outcome.value.length <= LIST_TEXT_MAX) {
    return { value: outcome.value, display, notes };
  }
  const shortened = `${outcome.value.slice(0, LIST_TEXT_MAX).trimEnd()}…`;
  return {
    value: shortened,
    display: oneLine(shortened),
    notes: [
      ...notes,
      `Shortened to ${LIST_TEXT_MAX} characters here; the whole value is ${outcome.value.length} characters and comes back from a read of this one setting.`,
    ],
  };
}

/** What the declaration says about its own output, for a reader checking it. */
function projectionNotes(declaration: AnySettingDeclaration): string[] {
  switch (declaration.emits.kind) {
    case "configured_only":
      return ["ShipIt reports only whether this is configured, never its value."];
    case "user_text":
      return [declaration.emits.reason];
    case "derived":
      return [`ShipIt emits ${declaration.emits.describes}, and nothing else of this value.`];
    default:
      return [];
  }
}

type EffectProbe = (deps: SettingsReadDeps, sessionId: string) => SettingEffect;

function enforcementStatus(deps: SettingsReadDeps): EgressEnforcementStatus {
  return deps.egressEnforcementStatus ?? (deps.egressEnforcementActive ? "active" : "no-sidecar");
}

/**
 * "Saved, applies after a restart" is a false promise for a sandbox whose
 * containment is already fixed, which is exactly the case the user is
 * unblocking — so containment is resolved against what is running rather than
 * inferred from whether a reload ran (plan.md → Saved is not effective).
 */
function egressContainmentEffect(deps: SettingsReadDeps, sessionId: string): SettingEffect {
  const status = enforcementStatus(deps);
  if (status !== "active") {
    return {
      state: "excluded",
      detail: `Egress enforcement is not running on this install (${status}), so no session is contained whatever this is set to.`,
    };
  }
  const store = deps.egressAllowlistStore;
  if (!store) {
    return { state: "uncertain", detail: "This install has no egress allowlist store to resolve containment against." };
  }
  // The shipped resolver, not a re-derivation: a sandbox whose network
  // capability is off is contained by `sandboxLifelineEgressConfig` no matter
  // what the global setting says, and it marks that with `userHostsExcluded`.
  const config = deps.containerManager?.resolveEgress(sessionId);
  if (config?.userHostsExcluded) {
    return {
      state: "excluded",
      detail: "This session's own network capability decides its containment, and no restart makes the global setting apply to it. The session's network capability is what has to change.",
    };
  }
  const override = store.getSessionOverride(sessionId);
  if (override !== null) {
    return {
      state: "excluded",
      detail: `This session sets its own network mode (${override ? "contained" : "open"}), which wins over the global setting. Changing the global one does not change this session.`,
    };
  }
  const container = deps.containerManager?.get(sessionId);
  const resolved = config?.contained ?? store.resolveContained(sessionId);
  if (container?.status === "running") {
    const startedContained = container.egressContainedAtStart;
    // A rediscovered container has no recorded boot policy, which
    // `session-container.ts` treats as unknown rather than as the current one.
    if (startedContained === undefined) {
      return {
        state: "uncertain",
        detail: "This session's container was rediscovered after a ShipIt restart, so ShipIt does not know which network mode it started under. Restarting the session is what makes the stored value certain.",
      };
    }
    if (startedContained !== resolved) {
      return {
        state: "restart-dependent",
        detail: `This session's container started ${startedContained ? "contained" : "open"} and stays that way until it is restarted.`,
      };
    }
  }
  return { state: "live" };
}

/**
 * Settings whose stored value and live effect can differ. A setting with no
 * entry reads `live`, meaning what `SettingEffect` defines it to mean: the next
 * use of the setting reads the stored value. That is not a claim about a
 * process already running, which is why the wording is narrow. An entry belongs
 * here when something already fixed — a container's start-time topology, a
 * per-session override, a capability the session cannot change — decides
 * instead, and a setting consumed once at ShipIt's own startup needs one too.
 */
const EFFECT_PROBES: Record<string, EffectProbe> = {
  "network.egressContained": egressContainmentEffect,
};

type LiveDetail = (deps: SettingsReadDeps) => Record<string, unknown>;

function nonTurnModelDetail(deps: SettingsReadDeps): Record<string, unknown> {
  const credentialStore = deps.credentialStore;
  if (!credentialStore) return { options: [], resolved: null };
  const installed = new Set(
    deps.agentRegistry.list().filter((a) => a.installed).map((a) => a.id),
  );
  const options = backgroundWorkOptions(listConfiguredCredentials(credentialStore), {
    isInstalled: (harnessId) => installed.has(harnessId),
  });
  const resolution = resolveNonTurnModel({
    credentialStore,
    ...(deps.providerAccountManager ? { providerAccountManager: deps.providerAccountManager } : {}),
  });
  return {
    options,
    resolved: resolution.ok
      ? {
          serviceId: resolution.target.selection.serviceId,
          billingMode: resolution.target.selection.billingMode,
          modelId: resolution.target.selection.modelId,
          serviceName: resolution.target.serviceName,
          execution: resolution.target.execution,
          source: resolution.target.source,
        }
      : null,
    ...(resolution.ok ? {} : { unavailableReason: resolution.reason }),
  };
}

/**
 * Live facts a declaration's `type` cannot hold — which models this install can
 * actually run background work on, and which one it resolves to today. Keyed by
 * setting: a setting with no entry still lists, gets, and carries its declared
 * shape, so this is extra detail and never a second place to register a setting.
 */
const LIVE_DETAILS: Record<string, LiveDetail> = {
  "services.nonTurnModel": nonTurnModelDetail,
};

// Only this read's own two reasons; the catalogue's four come from
// `refusalSentence`, so a withheld setting says the same thing everywhere.
const UNREADABLE_NOTES: Record<"no_repository" | "no_reader", string> = {
  no_repository: "This is a per-repository setting and this session binds no repository.",
  no_reader: "ShipIt cannot read this setting's stored value yet.",
};

interface ReadState {
  stored: Record<string, unknown>;
  /** The bulk read of the stored half failed, so no payload setting has a value. */
  storedFailed: boolean;
  sessionId: string;
  repoBound: boolean;
}

/**
 * A failure is reported without its message. An exception raised while reading a
 * setting can carry whatever the failing reader was holding, and this output
 * reaches the agent in text, in `--json` and in a card — so the projection
 * boundary holds here too, and the detail goes to the server log instead.
 */
function readFailureNote(key: string, err: unknown): string {
  console.error(`[settings-read] reading ${key} failed:`, err);
  return "ShipIt could not read this setting's value. The failure is in the server log.";
}

/**
 * Whether a setting's ADDRESS puts it out of this session's reach, before
 * anything is read. A per-repository setting degrades to an entry in a session
 * that binds no repository, so `list` still returns every other setting beside
 * it — and the repository is the session's own binding, never anything the agent
 * supplies. A browser-local value is not decided here: its declaration says so
 * itself with a `withheld` projection, which is the one place that judgement
 * lives.
 */
export function scopeUnreadableReason(
  declaration: Pick<AnySettingDeclaration, "scope" | "address">,
  repoBound: boolean,
): "no_repository" | null {
  const perRepository = declaration.scope === "project" || addressesARepository(declaration.address);
  return perRepository && !repoBound ? "no_repository" : null;
}

/** What `list` says about how a setting is addressed; `get` carries the items. */
function addressView(declaration: AnySettingDeclaration): SettingAddressView {
  const address = declaration.address ?? { kind: "none" as const };
  const noun = "noun" in address ? address.noun : undefined;
  return { kind: address.kind, ...(noun ? { noun } : {}) };
}

function isItemAddressed(declaration: AnySettingDeclaration): boolean {
  const kind = declaration.address?.kind;
  return kind === "item" || kind === "repository-item";
}

/** Where a value lives, for a reader following an entry that has no value yet. */
function storeLocation(declaration: AnySettingDeclaration): string {
  const { store } = declaration;
  if (store.kind === "own-route") return `written by ${store.route}`;
  if (store.kind === "bespoke") return `owned by ${store.ownedBy}`;
  if (store.kind === "browser") return `kept in the browser under ${store.localStorageKey}`;
  return "stored by ShipIt";
}

async function readValue(
  declaration: AnySettingDeclaration,
  deps: SettingsReadDeps,
  state: ReadState,
): Promise<ReadOutcome> {
  // A `withheld` declaration answers for itself, and its reason beats anything
  // this read would infer: a browser-local value is not "ShipIt has no reader
  // yet", it is a value ShipIt's server never holds.
  if (declaration.emits.kind === "withheld") {
    const { reason } = declaration.emits;
    return { ok: false, reason, note: refusalSentence(reason) };
  }
  const scoped = scopeUnreadableReason(declaration, state.repoBound);
  if (scoped) return { ok: false, reason: scoped, note: UNREADABLE_NOTES[scoped] };
  if (isPayloadDeclaration(declaration)) {
    // The stored half is one bulk read, so its failure is per entry for every
    // payload setting — and the own-route ones still read.
    if (state.storedFailed) {
      return { ok: false, reason: "no_reader", note: UNREADABLE_NOTES.no_reader };
    }
    const raw = state.stored[declaration.wire];
    // `omitWhenNull` drops the field rather than sending null; the pin is unset.
    return { ok: true, value: raw === undefined ? declaration.type.defaultValue : raw };
  }
  const reader = OWN_ROUTE_READERS[declaration.key];
  if (!reader) {
    return {
      ok: false,
      reason: "no_reader",
      note: `${UNREADABLE_NOTES.no_reader} It is ${storeLocation(declaration)}.`,
    };
  }
  return reader(deps);
}

async function buildEntry(
  declaration: AnySettingDeclaration,
  deps: SettingsReadDeps,
  state: ReadState,
  detail: boolean,
): Promise<SettingIndexEntry> {
  // Degrade per entry, never abort: one setting whose read throws must not cost
  // the agent the index of every other setting.
  let outcome: ReadOutcome;
  try {
    outcome = await readValue(declaration, deps, state);
  } catch (err) {
    outcome = { ok: false, reason: "no_reader", note: readFailureNote(declaration.key, err) };
  }
  const base = {
    key: declaration.key,
    label: declaration.label,
    summary: firstSentence(declaration.description),
    tab: declaration.tab,
    scope: declaration.scope,
    address: addressView(declaration),
    propose: proposeView(declaration),
  };
  // `get` says the same thing with the items themselves, so this is list-only.
  const indexNotes = detail ? [] : [itemNote(declaration)].filter((n): n is string => !!n);
  if (!outcome.ok) {
    return {
      ...base,
      value: null,
      display: "unknown",
      readable: false,
      unreadableReason: outcome.reason,
      // An unreadable value cannot carry an effect claim. The reason is in
      // `notes` and must not be repeated here — it is one fact, not three.
      effect: { state: "uncertain" },
      notes: [outcome.note, ...indexNotes],
    };
  }
  const projected = projectSettingValue(declaration, outcome.value, detail);
  const probe = EFFECT_PROBES[declaration.key];
  let effect: SettingEffect = { state: "live" };
  if (probe) {
    try {
      effect = probe(deps, state.sessionId);
    } catch (err) {
      effect = { state: "uncertain", detail: readFailureNote(declaration.key, err) };
    }
  }
  return {
    ...base,
    value: projected.value,
    display: projected.display,
    readable: true,
    effect,
    notes: [...projected.notes, ...indexNotes],
  };
}

/**
 * The index says a setting is per-item; it never grows an entry per item
 * (req 1 — the index, then the detail of one). Its length must not depend on how
 * many roles or MCP servers someone has, for the same reason option sets live in
 * `get`.
 */
function itemNote(declaration: AnySettingDeclaration): string | null {
  if (!isItemAddressed(declaration)) return null;
  const noun = "noun" in (declaration.address ?? {})
    ? (declaration.address as { noun: string }).noun
    : "an item";
  return `One of these exists per item, addressed by ${noun}. \`shipit settings get ${declaration.key}\` is where the items are.`;
}

async function readState(deps: SettingsReadDeps, sessionId: string): Promise<ReadState> {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");
  let stored: Record<string, unknown> = {};
  let storedFailed = false;
  try {
    stored = await readStoredGlobalSettings({
      appWorkspaceDir: deps.appWorkspaceDir,
      ...(deps.credentialStore ? { credentialStore: deps.credentialStore } : {}),
    });
  } catch (err) {
    storedFailed = true;
    console.error("[settings-read] reading the stored settings failed:", err);
  }
  return { stored, storedFailed, sessionId, repoBound: !!session.remoteUrl };
}

/**
 * The index: every setting the agent may see, degrading per entry rather than
 * failing the call. With no bound repository the project entries read
 * unavailable and every global setting is still returned.
 */
export async function listSettingsForAgent(
  deps: SettingsReadDeps,
  sessionId: string,
  opts: { tab?: string } = {},
): Promise<SettingsIndex> {
  const declarations = allDeclarations();
  const tabs = [...new Set(declarations.map((d) => d.tab))].sort();
  if (opts.tab !== undefined && !tabs.includes(opts.tab as SettingTab)) {
    throw new ServiceError(400, `Unknown settings tab: ${opts.tab}. Tabs with settings: ${tabs.join(", ")}`);
  }
  const state = await readState(deps, sessionId);
  const wanted = opts.tab ? declarations.filter((d) => d.tab === opts.tab) : declarations;
  const settings = await Promise.all(
    wanted.map((declaration) => buildEntry(declaration, deps, state, false)),
  );
  return { settings, tabs };
}

/**
 * The extra detail, or a note saying it could not be resolved. The declared
 * value and shape are the answer either way, so a failure to resolve live
 * options must not turn the whole read into an error.
 */
function resolveLiveDetail(
  key: string,
  deps: SettingsReadDeps,
  entry: SettingIndexEntry,
): Record<string, unknown> | undefined {
  const detail = LIVE_DETAILS[key];
  if (!detail) return undefined;
  try {
    return detail(deps);
  } catch (err) {
    console.error(`[settings-read] resolving live detail for ${key} failed:`, err);
    entry.notes.push(
      "ShipIt could not resolve this setting's live options. The failure is in the server log.",
    );
    return undefined;
  }
}

/** The detail of one setting: its whole description, its value's shape, and what resolves live. */
export async function getSettingForAgent(
  deps: SettingsReadDeps,
  sessionId: string,
  key: string,
): Promise<SettingDetailEntry> {
  const declaration = findSetting(key);
  if (!declaration) {
    throw new ServiceError(404, `No ShipIt setting is called "${key}". List them with \`shipit settings list\`.`);
  }
  const state = await readState(deps, sessionId);
  const entry = await buildEntry(declaration, deps, state, true);
  const live = entry.readable ? resolveLiveDetail(declaration.key, deps, entry) : undefined;
  const items = itemsFor(declaration, entry);
  return {
    ...entry,
    description: oneLine(declaration.description),
    valueType: declaration.type.kind,
    shape: declaration.type.shape,
    ...(live ? { live } : {}),
    ...(items ? { items } : {}),
  };
}

/**
 * The instances of an item-addressed setting. Enumerating them needs a reader
 * for the panel that owns the items, and the 42 `bespoke` declarations have none
 * yet — so the shape is here and empty, with the reason, and the next slice
 * fills it rather than changing the contract. The address each item is named by
 * is spelled when there are items to spell it for.
 */
function itemsFor(
  declaration: AnySettingDeclaration,
  entry: SettingIndexEntry,
): SettingItemView[] | undefined {
  if (!isItemAddressed(declaration)) return undefined;
  entry.notes.push(
    "This setting exists once per item, and ShipIt cannot enumerate the items yet — "
      + "it can say what the setting is, not what any one item is set to.",
  );
  return [];
}
