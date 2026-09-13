import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { EgressEnforcementStatus } from "../../shared/types.js";
import { GLOBAL_SETTINGS, isPayloadDeclaration } from "../../shared/settings-catalogue/index.js";
import type {
  AnySettingDeclaration,
  ProposeRefusal,
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
 * Its VALUE is too, where the settings payload stores it. A declaration whose
 * store is `own-route` names only the route that writes it, so reading one back
 * needs an adapter below; without one the entry says it cannot be read rather
 * than reporting a default as the live value. That is the deliberate limit of
 * the derivation, not a place a setting can be forgotten.
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

/** Why ShipIt cannot show the agent this setting's value. */
export type SettingUnreadableReason =
  /** The value is in the user's browser, not on ShipIt's server. */
  | "browser_local"
  /** A per-repository setting read from a session that binds no repository. */
  | "no_repository"
  /** Written by a route of its own that this install cannot read back. */
  | "no_reader";

export interface SettingProposeView {
  allowed: boolean;
  refusal?: ProposeRefusal;
  explanation?: string;
}

export interface SettingIndexEntry {
  key: string;
  label: string;
  /** The declared description's first sentence; `get` carries it whole (req 7). */
  summary: string;
  tab: SettingTab;
  scope: SettingScope;
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
 * Every declaration the read projects. `GLOBAL_SETTINGS` is the whole catalogue
 * today; the project and browser scopes land as further declaration records and
 * join here, so nothing in this file depends on which scope a setting is in.
 */
function allDeclarations(): AnySettingDeclaration[] {
  return Object.values(GLOBAL_SETTINGS);
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

const PROPOSE_EXPLANATIONS: Record<ProposeRefusal, string> = {
  secret: "This holds credential material. ShipIt never shows the agent the value and never changes it on the agent's behalf — the user enters it in Settings.",
  external_flow: "Changing this needs a sign-in flow on the provider's own site, which only the user can complete.",
  browser_local: "This value is set in the user's browser; ShipIt's server does not hold it.",
  unsafe_to_display: "ShipIt cannot show the full effect of this change, so it is not one the agent can ask the user to approve.",
};

function proposeView(declaration: AnySettingDeclaration): SettingProposeView {
  if (declaration.propose.kind === "yes") return { allowed: true };
  const { reason } = declaration.propose;
  return { allowed: false, refusal: reason, explanation: PROPOSE_EXPLANATIONS[reason] };
}

function isConfigured(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === false) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  if (Array.isArray(raw)) return raw.length > 0;
  return true;
}

function formatPlain(raw: unknown, declaration: Pick<AnySettingDeclaration, "type">): string {
  if (raw === null || raw === undefined) return "not set";
  if (typeof raw === "boolean" || typeof raw === "number") {
    const unit = declaration.type.shape.unit;
    return typeof unit === "string" && typeof raw === "number" ? `${raw} ${unit}` : String(raw);
  }
  if (typeof raw === "string") return raw.length === 0 ? "empty" : raw;
  return JSON.stringify(raw);
}

export interface ProjectedValue {
  value: unknown;
  display: string;
  notes: string[];
}

/**
 * The only output a setting may produce (plan.md → `emits` is an allowlist of
 * derived values). `detail` carries the user's own prose whole; the index caps
 * it, because an index is for scanning.
 */
export function projectSettingValue(
  declaration: Pick<AnySettingDeclaration, "emits" | "type">,
  raw: unknown,
  detail: boolean,
): ProjectedValue {
  switch (declaration.emits.kind) {
    case "configured_only": {
      const configured = isConfigured(raw);
      return {
        value: { configured },
        display: configured ? "configured" : "not configured",
        notes: ["ShipIt reports only whether this is configured, never its value."],
      };
    }
    case "user_text": {
      const notes = [declaration.emits.reason];
      // A `user_text` setting need not be one string: a git identity is the
      // user's own name and email, and shortening only applies to the prose.
      if (typeof raw !== "string") {
        return { value: raw ?? null, display: formatPlain(raw, declaration), notes };
      }
      const text = raw;
      if (detail || text.length <= LIST_TEXT_MAX) {
        return { value: text, display: text.length === 0 ? "empty" : oneLine(text), notes };
      }
      const truncated = `${text.slice(0, LIST_TEXT_MAX).trimEnd()}…`;
      return {
        value: truncated,
        display: oneLine(truncated),
        notes: [...notes, `Shortened to ${LIST_TEXT_MAX} characters here; the whole value is ${text.length} characters and comes back from a read of this one setting.`],
      };
    }
    case "plain":
      return { value: raw ?? null, display: formatPlain(raw, declaration), notes: [] };
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

const UNREADABLE_NOTES: Record<SettingUnreadableReason, string> = {
  browser_local: "Set in the browser; ShipIt's server does not hold this value, so it cannot be read here.",
  no_repository: "This is a per-repository setting and this session binds no repository.",
  no_reader: "ShipIt cannot read this setting's stored value on this install.",
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
 * Whether a setting's SCOPE puts it out of the server's reach, before anything
 * is read. Browser settings are named and explained and nothing more; a
 * per-repository setting degrades to an entry in a session that binds no
 * repository, so `list` still returns every global setting beside it.
 */
export function scopeUnreadableReason(
  declaration: Pick<AnySettingDeclaration, "scope">,
  repoBound: boolean,
): SettingUnreadableReason | null {
  if (declaration.scope === "browser") return "browser_local";
  if (declaration.scope === "project" && !repoBound) return "no_repository";
  return null;
}

async function readValue(
  declaration: AnySettingDeclaration,
  deps: SettingsReadDeps,
  state: ReadState,
): Promise<ReadOutcome> {
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
      note: `${UNREADABLE_NOTES.no_reader} It is written by ${declaration.store.kind === "own-route" ? declaration.store.route : "a route of its own"}.`,
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
    propose: proposeView(declaration),
  };
  if (!outcome.ok) {
    return {
      ...base,
      value: null,
      display: "unknown",
      readable: false,
      unreadableReason: outcome.reason,
      // An unreadable value cannot carry an effect claim; saying so is the point.
      effect: { state: "uncertain", detail: outcome.note },
      notes: [outcome.note],
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
    notes: projected.notes,
  };
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
  const declaration = allDeclarations().find((d) => d.key === key);
  if (!declaration) {
    throw new ServiceError(404, `No ShipIt setting is called "${key}". List them with \`shipit settings list\`.`);
  }
  const state = await readState(deps, sessionId);
  const entry = await buildEntry(declaration, deps, state, true);
  const live = entry.readable ? resolveLiveDetail(declaration.key, deps, entry) : undefined;
  return {
    ...entry,
    description: oneLine(declaration.description),
    valueType: declaration.type.kind,
    shape: declaration.type.shape,
    ...(live ? { live } : {}),
  };
}
