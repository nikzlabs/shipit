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
 * the catalogue, so a setting declared today is readable today with no edit here.
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

function formatPlain(raw: unknown, declaration: AnySettingDeclaration): string {
  if (raw === null || raw === undefined) return "not set";
  if (typeof raw === "boolean" || typeof raw === "number") {
    const unit = declaration.type.shape.unit;
    return typeof unit === "string" && typeof raw === "number" ? `${raw} ${unit}` : String(raw);
  }
  if (typeof raw === "string") return raw.length === 0 ? "empty" : raw;
  return JSON.stringify(raw);
}

interface ProjectedValue {
  value: unknown;
  display: string;
  notes: string[];
}

/**
 * The only output a setting may produce (plan.md → `emits` is an allowlist of
 * derived values). `detail` carries the user's own prose whole; the index caps
 * it, because an index is for scanning.
 */
function project(
  declaration: AnySettingDeclaration,
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
  const override = store.getSessionOverride(sessionId);
  if (override !== null) {
    return {
      state: "excluded",
      detail: `This session sets its own network mode (${override ? "contained" : "open"}), which wins over the global setting. Changing the global one does not change this session.`,
    };
  }
  const container = deps.containerManager?.get(sessionId);
  const startedContained = container?.status === "running" ? container.egressContainedAtStart : undefined;
  const resolved = store.resolveContained(sessionId);
  if (startedContained !== undefined && startedContained !== resolved) {
    return {
      state: "restart-dependent",
      detail: `This session's container started ${startedContained ? "contained" : "open"} and stays that way until it is restarted.`,
    };
  }
  return { state: "live" };
}

/**
 * Settings whose stored value and live effect can differ. A setting with no
 * entry reads `live`, which is the honest default: its value is read from the
 * store on the path that uses it, so the next use is the stored value. An entry
 * belongs here when something already fixed — a container's start-time
 * topology, a per-session override — decides instead.
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
  sessionId: string;
  repoBound: boolean;
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
  const outcome = await readValue(declaration, deps, state);
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
  const projected = project(declaration, outcome.value, detail);
  const effect = (EFFECT_PROBES[declaration.key] ?? (() => ({ state: "live" as const })))(
    deps,
    state.sessionId,
  );
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
  const stored = await readStoredGlobalSettings({
    appWorkspaceDir: deps.appWorkspaceDir,
    ...(deps.credentialStore ? { credentialStore: deps.credentialStore } : {}),
  });
  return {
    stored: stored as unknown as Record<string, unknown>,
    sessionId,
    repoBound: !!session.remoteUrl,
  };
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
  const live = entry.readable ? LIVE_DETAILS[declaration.key]?.(deps) : undefined;
  return {
    ...entry,
    description: oneLine(declaration.description),
    valueType: declaration.type.kind,
    shape: declaration.type.shape,
    ...(live ? { live } : {}),
  };
}
