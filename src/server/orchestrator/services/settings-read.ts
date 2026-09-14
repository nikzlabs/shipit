import type {
  EgressEnforcementStatus,
  SettingsEffectState,
  SettingsProposalOperation,
  SettingsProposalPhase,
  SettingsProposalTarget,
} from "../../shared/types.js";
import {
  ALL_SETTINGS,
  addressesARepository,
  collectionKeyOf,
  findSetting,
  formatSetting,
  isPayloadDeclaration,
  projectSetting,
  refusalSentence,
} from "../../shared/settings-catalogue/index.js";
import type {
  AnySettingDeclaration,
  OwnRouteSettingKey,
  RefusalReason,
  SettingAddress,
  SettingScope,
  SettingTab,
  SettingValueKind,
} from "../../shared/settings-catalogue/index.js";
import { providerSpeeds, providerVoices, ttsProviders } from "../../shared/voice-catalog.js";
import { backgroundWorkOptions, resolveNonTurnModel } from "../non-turn-model.js";
import { readChannelOutcome } from "../release-channel.js";
import { listConfiguredCredentials } from "../service-routing.js";
import { readStoredGlobalSettings } from "./settings-derivation.js";
import { StoreReadCache, bespokeReader } from "./settings-store-readers.js";
import type { ItemName, StoreReadContext, StoredItem } from "./settings-store-readers.js";
import type { SettingsReadDeps } from "./settings-read-deps.js";
import type { SettingsProposalRow } from "../settings-proposal-store.js";
import { ServiceError } from "./types.js";

export type { SettingsReadDeps };

/**
 * The agent's read surface, projected from the declarations
 * (docs/299-agent-settings-access req 1, 3, 5, 7). It is a projection and never
 * a second description of ShipIt's settings: every entry it returns comes from
 * the catalogue, and a newly declared setting is INDEXED here — key, label,
 * description, shape, refusal — with no edit to this file.
 *
 * Its VALUE comes from wherever that setting is stored. The payload settings
 * read as one bulk read of the stored half; everything else needs a reader —
 * two `own-route` ones below, and one per owner in `settings-store-readers.ts`
 * for the panels that own their own storage. A declaration with no reader
 * reports that ShipIt could not read it rather than passing off the declared
 * default as the live value, which is the one failure worth a whole guard test:
 * a made-up default is stated to the user as fact.
 *
 * **Every emitted value goes through `projectSetting` / `formatSetting`
 * (`settings-catalogue/projection.ts`), and nothing here formats a stored value
 * directly** (req 2). An MCP entry takes arbitrary `args`, `env`, `headers` and
 * a URL, so a token lives in a field called `args`; a second formatter beside
 * that door is exactly how one escapes in the output path nobody re-checks.
 * An item's ADDRESS goes through the same door — see `itemAddress`.
 *
 * Two steps by ROLE, never by size: `list` is the index — what a setting is and
 * what it is set to — and `get` is the detail, carrying the value's shape, the
 * instances of an item-addressed setting, and whatever has to be resolved live.
 * A size threshold would make the response shape depend on how many models
 * happen to be installed.
 */

/** The proposal card reports the same four answers, so the two cannot drift. */
export type SettingEffectState = SettingsEffectState;

/**
 * Whether the stored value is what ShipIt actually uses. `live` means the next
 * use of this setting reads the stored value — not that a process already
 * running re-reads it.
 */
export interface SettingEffect {
  state: SettingEffectState;
  /**
   * Why it is not live — or, where the stored value IS what the next use reads
   * and that use fails, what being live costs. Both are words the agent repeats
   * to the user, which is the point of req 3.
   */
  detail?: string;
}

/**
 * Why ShipIt cannot show the agent this setting's value. The catalogue's four
 * refusal reasons carry through from a `withheld` projection; the two below them
 * are this read's own.
 *
 * There is deliberately no "ShipIt has no reader for this" reason. Every
 * declaration has one, `settings-store-readers.test.ts` fails if a new one
 * arrives without, and a reason for it would only ever be read as a
 * placeholder someone can leave in place.
 */
export type SettingUnreadableReason =
  | RefusalReason
  /** A per-repository setting read from a session that binds no repository. */
  | "no_repository"
  /**
   * ShipIt tried and has no value to report: a store this install does not
   * have, a repository it has no record of, or a read that threw. The note
   * carries which — and never the declared default in place of the value.
   */
  | "read_failed";

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
  /** Projected through the declaration's `emits`, exactly as a scalar value is. */
  value: unknown;
  display: string;
  /** What ShipIt already computes about this instance, so the agent says why (req 3). */
  notes?: string[];
  /** The last proposal about THIS instance; a sibling item's says nothing about it. */
  lastProposal?: SettingProposalSummary;
}

export interface SettingIndexEntry {
  key: string;
  label: string;
  /** The declared description's first sentence; `get` carries it whole (req 7). */
  summary: string;
  tab: SettingTab;
  scope: SettingScope;
  address: SettingAddressView;
  /**
   * Projected through the declaration's `emits`. Null when the setting has no
   * one value: unreadable, or addressed per item — where the index names the
   * instances in `display` and `get` carries what each is set to.
   */
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

/**
 * What the user last did about this setting, from any session
 * (docs/299-agent-settings-access req 8, plan.md → How the agent learns the
 * outcome). What somebody did about a setting is a fact about the setting, not
 * about the session that asked.
 *
 * It is ONE record, deliberately: a dismissal followed by another session's
 * proposal leaves only the latter, so this is not a durable veto and must not be
 * read as one. A `pending` card does not stop a second proposal either —
 * reporting it is enough, because a card nothing expires would otherwise be an
 * indefinite veto from a session the user has forgotten.
 */
export interface SettingProposalSummary {
  cardId: string;
  phase: SettingsProposalPhase;
  operation: SettingsProposalOperation;
  /** The instance it was about, where the setting has more than one. */
  item?: string;
  /** Both as the proposal recorded them: the projected value, never the stored one. */
  from: unknown;
  proposed: unknown;
  proposedAt: string;
  resolvedAt?: string;
  /** The session the card is in, which may not be the one reading this. */
  sessionId: string;
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
  /** The last proposal about this setting, or about this repository's copy of it. */
  lastProposal?: SettingProposalSummary;
}

export interface SettingsIndex {
  settings: SettingIndexEntry[];
  /** Every tab carrying at least one declared setting. */
  tabs: SettingTab[];
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
 * A key or tab name the CALLER supplied, echoed back so its error says which
 * one it means.
 *
 * This is reflected input, not a stored value: `key` and `tab` arrive on the
 * agent's own query string, so nothing ShipIt persists can reach here and req 2
 * — "reading a setting never exposes secret material" — is not engaged. What it
 * is engaged by is presentation: an unbounded echo with newlines in it garbles
 * the CLI output and the transcript. So it is flattened and capped, exactly as
 * a proposal's `--reason` is (plan.md → `--reason` is untrusted), and for the
 * same reason: hygiene, not a secret defence. The projections are that.
 */
const SUPPLIED_ECHO_MAX = 80;

function echoSupplied(supplied: string): string {
  const flat = oneLine(supplied);
  return flat.length > SUPPLIED_ECHO_MAX ? `${flat.slice(0, SUPPLIED_ECHO_MAX)}…` : flat;
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
  | { ok: true; kind: "value"; value: unknown }
  | { ok: true; kind: "items"; items: StoredItem[] }
  | { ok: false; reason: SettingUnreadableReason; note: string };

type OwnRouteReader = (deps: SettingsReadDeps) => Promise<ReadOutcome> | ReadOutcome;

/**
 * A declaration names the route that WRITES an own-route setting, not how to
 * read one back, so the read is supplied here.
 *
 * Keyed by `OwnRouteSettingKey`, derived from the catalogue: a declaration
 * added with an `own-route` store and no reader here is a compile error, not a
 * setting that reports itself unreadable forever (req 7). Same contract as
 * `BESPOKE_READERS`.
 */
export const OWN_ROUTE_READERS: Record<OwnRouteSettingKey, OwnRouteReader> = {
  "advanced.releaseChannel": async (deps) => {
    if (deps.readReleaseChannel) {
      return { ok: true, kind: "value", value: await deps.readReleaseChannel() };
    }
    // `readChannel` answers the DEFAULT channel for an unreadable file, and that
    // is a real channel — an install tracking `stable` would read as `edge`.
    const read = await readChannelOutcome();
    if (!read.ok) {
      return {
        ok: false,
        reason: "read_failed",
        note: readFailureNote("advanced.releaseChannel", read.error),
      };
    }
    return { ok: true, kind: "value", value: read.channel };
  },
  "network.egressContained": (deps) =>
    deps.egressAllowlistStore
      ? { ok: true, kind: "value", value: deps.egressAllowlistStore.getGlobalEnabled() }
      : { ok: false, reason: "read_failed", note: "This install has no egress allowlist store, so the containment setting cannot be read." },
};

/** The reader for a key held as a plain string; present for every own-route one. */
function ownRouteReader(key: string): OwnRouteReader | undefined {
  return (OWN_ROUTE_READERS as Record<string, OwnRouteReader | undefined>)[key];
}

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
    case "user_name":
      return [declaration.emits.reason];
    case "derived":
      return [
        `ShipIt emits ${declaration.emits.describes}, and nothing else of this value.`,
        // The `user_text` mark on a derived projection, said out loud: what the
        // function emits is the user's own words, not something ShipIt computed.
        ...(declaration.emits.userText ? [declaration.emits.userText] : []),
      ];
    default:
      return [];
  }
}

type EffectProbe = (deps: SettingsReadDeps, sessionId: string) => SettingEffect;

function enforcementStatus(deps: SettingsReadDeps): EgressEnforcementStatus {
  return deps.egressEnforcementStatus ?? (deps.egressEnforcementActive ? "active" : "no-sidecar");
}

/**
 * What an install-wide enforcement status does to a containment question, or
 * `null` when it decides nothing and the session's own state does.
 *
 * The two statuses are NOT interchangeable, and treating them as one was wrong
 * in the case req 3 exists for. `disabled` (`SESSION_EGRESS_ENFORCE=0`) means
 * `container-lifecycle.ts` never installs a firewall, so nothing is contained
 * whatever the setting says. `no-sidecar` means enforcement is ON with no
 * sidecar image, and a session that resolves contained **throws and refuses to
 * start** (`container-lifecycle.ts:747`) — so the setting is not irrelevant, it
 * is the thing blocking the container, and turning it off is what unblocks it.
 */
function enforcementDisabledEffect(
  deps: SettingsReadDeps,
  restricts: string,
): SettingEffect | null {
  return enforcementStatus(deps) === "disabled"
    ? {
        state: "excluded",
        detail: `Egress enforcement is switched off on this install (SESSION_EGRESS_ENFORCE=0), so no session is contained and ${restricts}.`,
      }
    : null;
}

/** The sentence a `no-sidecar` install owes a session that resolves contained. */
const NO_SIDECAR_REFUSAL =
  "Egress enforcement is on but this install has no egress sidecar image "
  + "(SESSION_EGRESS_SIDECAR_IMAGE is unset), so ShipIt refuses to start a contained session at "
  + "all. Turning containment off, or the install providing the sidecar image, is what lets this "
  + "session run.";

/**
 * The refusal, as a suffix on whatever else is true.
 *
 * It is a suffix and never a branch of its own because it answers a DIFFERENT
 * question from the rest of the probe: those say what is true of the session
 * now — a container's start-time topology, a per-session override, a capability
 * it cannot change — and this says what its next start does. Both can be true at
 * once, and the first version of this fix returned early on the refusal and so
 * dropped the sandbox, override and running-container answers.
 */
function startupRefusal(deps: SettingsReadDeps, contained: boolean): string {
  return contained && enforcementStatus(deps) === "no-sidecar" ? NO_SIDECAR_REFUSAL : "";
}

/**
 * A second true fact about the same session, appended rather than replacing the
 * first. Every "what the next start does" answer here rides an answer about what
 * is in force now, because both are true and the user is looking at the
 * container the second one describes.
 */
function alsoSay(effect: SettingEffect, sentence: string): SettingEffect {
  if (!sentence) return effect;
  return { state: effect.state, detail: `${effect.detail ?? ""} ${sentence}`.trim() };
}

/**
 * What the RUNNING container is doing about containment, or null when it agrees
 * with the resolved policy and there is nothing extra to say. Computed once and
 * carried by the branches above it: a capability or a per-session override
 * decides what the NEXT start does and says nothing about a container that
 * started before the change.
 */
function runningContainmentEffect(
  deps: SettingsReadDeps,
  sessionId: string,
  resolved: boolean,
): SettingEffect | null {
  const container = deps.containerManager?.get(sessionId);
  if (container?.status !== "running") return null;
  const startedContained = container.egressContainedAtStart;
  // A rediscovered container has no recorded boot policy, which
  // `session-container.ts` treats as unknown rather than as the current one.
  if (startedContained === undefined) {
    return {
      state: "uncertain",
      // "…what settles it", not "…what makes the stored value certain": this
      // sentence is carried by the branches that have just said the stored value
      // will never apply to this session, and the two must not contradict.
      detail: "This session's container was rediscovered after a ShipIt restart, so ShipIt does not know which network mode it started under. Restarting the session is what settles it.",
    };
  }
  if (startedContained === resolved) return null;
  return {
    state: "restart-dependent",
    detail: `This session's container started ${startedContained ? "contained" : "open"} and stays that way until it is restarted.`,
  };
}

/**
 * "Saved, applies after a restart" is a false promise for a sandbox whose
 * containment is already fixed, which is exactly the case the user is
 * unblocking — so containment is resolved against what is running rather than
 * inferred from whether a reload ran (plan.md → Saved is not effective).
 *
 * **Which setting DECIDES this session's containment is a question about the
 * stored capability**, and that is why this probe reads it from `resolveEgress`:
 * `sandboxLifelineEgressConfig` intercepts a network-off sandbox at every
 * resolution, so the global setting is irrelevant to it now and at every future
 * start. What the stored capability cannot answer is what the container in front
 * of the user is doing, so that answer rides along instead of being dropped.
 */
function egressContainmentEffect(deps: SettingsReadDeps, sessionId: string): SettingEffect {
  const disabled = enforcementDisabledEffect(deps, "this setting changes nothing");
  if (disabled) return disabled;
  const store = deps.egressAllowlistStore;
  if (!store) {
    return { state: "uncertain", detail: "This install has no egress allowlist store to resolve containment against." };
  }
  // The shipped resolver, not a re-derivation: a sandbox whose network
  // capability is off is contained by `sandboxLifelineEgressConfig` no matter
  // what the global setting says, and it marks that with `userHostsExcluded`.
  const config = deps.containerManager?.resolveEgress(sessionId);
  const resolved = config?.contained ?? store.resolveContained(sessionId);
  const blocked = startupRefusal(deps, resolved);
  const running = runningContainmentEffect(deps, sessionId, resolved);
  if (config?.userHostsExcluded) {
    // Blocked still rides this one: granting the capability leaves global
    // containment on, so the start is refused for the second reason too.
    return alsoSay(alsoSay({
      state: "excluded",
      detail: "This session's own network capability decides its containment, and no restart makes the global setting apply to it. The session's network capability is what has to change.",
    }, running?.detail ?? ""), blocked);
  }
  const override = store.getSessionOverride(sessionId);
  if (override !== null) {
    return alsoSay(alsoSay({
      state: "excluded",
      detail: `This session sets its own network mode (${override ? "contained" : "open"}), which wins over the global setting. Changing the global one does not change this session.`,
    }, running?.detail ?? ""), blocked);
  }
  if (running) return alsoSay(running, blocked);
  return alsoSay({ state: "live" }, blocked);
}

/**
 * The allowlist is read once, when a session's container is built, so a
 * running container keeps the list it started with — and a session nothing
 * contains is not restricted by it at all. Saying `live` here would promise the
 * user their newly added host is reachable from the session they are asking
 * about, which is the case they are asking about.
 *
 * **Whether the allowlist applies is a fact about the RUNNING container**, and
 * `resolveEgress` answers for the next start (plan.md → Saved is not effective).
 * Reading containment off the resolver alone told a session that switched global
 * containment off mid-life that *its network access does not depend on the
 * allowlist* — while its container was still contained and still enforcing it.
 * That is req 3's exact failure: the surface that exists to explain a blocker
 * describing a state that is not the one blocking. So containment is resolved
 * the way the adjacent probe resolves it, against what is running.
 *
 * **The session's network capability splits into two questions here, and they
 * have two different sources.** Whether a change to this list can EVER reach the
 * session is the next start's capability, because a global host add reloads
 * nothing live (`services/settings-apply.ts` → `applyEgressHostAdd`) and the
 * next container start resolves the capability afresh. Whether the list is
 * shutting the session out NOW is `egressUserHostsExcluded`, the exclusion the
 * container's applied egress config carries: revoking a sandbox's network
 * capability leaves the container as it was, so the resolver says a session is
 * sealed while it is still reaching every host it started with.
 *
 * That record, and not the session's stored capabilities, because the two
 * diverge twice over: `app-lifecycle.ts` snapshots the capabilities BEFORE
 * creation resolves egress, and `reloadEgress` re-applies the current policy to
 * a running container afterwards. It is written at both of those moments, so it
 * describes what the container is enforcing rather than what someone asked for.
 */
function egressAllowlistEffect(deps: SettingsReadDeps, sessionId: string): SettingEffect {
  const disabled = enforcementDisabledEffect(deps, "the allowlist restricts nothing");
  if (disabled) return disabled;
  const store = deps.egressAllowlistStore;
  if (!store) {
    return { state: "uncertain", detail: "This install has no egress allowlist store to resolve containment against." };
  }
  const config = deps.containerManager?.resolveEgress(sessionId);
  const contained = config?.contained ?? store.resolveContained(sessionId);
  /*
    The refusal is a suffix here for the same reason it is on the containment
    probe: it answers what the NEXT start does, and a container that was already
    running when the sidecar image went away keeps the firewall and the
    allowlist it started with. `container-lifecycle.ts:747` governs creation,
    not an existing container, so "this changes nothing until it can run" would
    be wrong for exactly that session.
  */
  const blocked = startupRefusal(deps, contained);
  const container = deps.containerManager?.get(sessionId);
  const running = container?.status === "running";
  // Only a running container shuts anything out; with none, the resolved policy
  // answers both halves. Undefined is UNKNOWN and never `false`: a container
  // rediscovered after a ShipIt restart recorded nothing.
  const excludedNow = running ? container?.egressUserHostsExcluded : undefined;
  if (config?.userHostsExcluded) {
    if (excludedNow === true || !running) {
      return alsoSay({
        state: "excluded",
        detail: "This session's own network capability excludes it from the allowlist, and no restart makes a host here reachable from it. The session's network capability is what has to change.",
      }, blocked);
    }
    // A container ShipIt has no record for gets no history invented for it: the
    // capability may have been off all along.
    return alsoSay({
      state: "excluded",
      detail: excludedNow === undefined
        ? `${allowlistInForce(container)} This session's network capability is off, so no restart makes a host here reachable from it either.`
        : `${allowlistInForce(container)} This session's network capability has been switched off since, so restarting it seals the session and no restart makes a host here reachable from it.`,
    }, blocked);
  }
  if (excludedNow === true) {
    // The mirror image: the capability was granted after this container's policy
    // was applied, so it is still sealed to ShipIt's own lifeline hosts. The list
    // is not empty to it — a lifeline host is on the list too — it just adds
    // nothing, which is the claim the user can act on.
    const now = "This session's container is running under its network capability switched off, so this list adds nothing to what it can reach: only ShipIt's own lifeline hosts, and any SSH destination granted to it.";
    return alsoSay(
      contained
        ? {
            state: "restart-dependent",
            detail: `${now} The capability is on again now, and the allowlist applies to the session from its next start.`,
          }
        : {
            state: "excluded",
            detail: `${now} The capability is on again now and its next start is open, so the allowlist will not restrict it then either.`,
          },
      blocked,
    );
  }
  if (running) {
    const startedContained = container?.egressContainedAtStart;
    // A rediscovered container has no recorded boot policy, which
    // `session-container.ts` treats as unknown rather than as the current one.
    if (startedContained === undefined) {
      return alsoSay({
        state: "uncertain",
        detail: "This session's container was rediscovered after a ShipIt restart, so ShipIt does not know whether it is enforcing the allowlist. Restarting the session is what settles it.",
      }, blocked);
    }
    if (!startedContained) {
      return alsoSay(
        contained
          ? {
              state: "restart-dependent",
              detail: "This session's container started open, so the allowlist does not restrict it. It starts contained next time, and the allowlist applies from then on.",
            }
          : {
              state: "excluded",
              detail: "This session is not contained, so its network access does not depend on the allowlist.",
            },
        blocked,
      );
    }
    return alsoSay({
      state: "restart-dependent",
      detail: contained
        ? "This session's container took its allowlist when it started; a change here applies the next time it starts."
        : "This session's container started contained and is still enforcing the allowlist it took then. It starts open next time, and the allowlist stops applying to it.",
    }, blocked);
  }
  if (!contained) {
    return {
      state: "excluded",
      detail: "This session is not contained, so its network access does not depend on the allowlist.",
    };
  }
  return alsoSay({ state: "live" }, blocked);
}

/** What the RUNNING container is doing about the allowlist, in one sentence. */
function allowlistInForce(container: { egressContainedAtStart?: boolean } | undefined): string {
  const startedContained = container?.egressContainedAtStart;
  if (startedContained === undefined) {
    return "This session's container was rediscovered after a ShipIt restart, so ShipIt does not know whether it is enforcing the allowlist.";
  }
  return startedContained
    ? "This session's container started contained and is still enforcing the allowlist it took then."
    : "This session's container started open, so the allowlist does not restrict it.";
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
  "network.egress.hosts": egressAllowlistEffect,
  "network.egress.hosts[].host": egressAllowlistEffect,
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
 * What a role or a reviewer slot can be pointed at on THIS install. A
 * declaration's `type` holds the shape of a model selection and cannot hold
 * which ones exist, so req 3's "what it has to become" is resolved here — from
 * the registry the dialog's own pickers offer, so the agent proposes from the
 * same list the user would pick from.
 */
function runnableTargetsDetail(deps: SettingsReadDeps): Record<string, unknown> {
  return {
    harnesses: deps.agentRegistry
      .list()
      .filter((agent) => agent.installed && agent.hasRunnableModels)
      .map((agent) => ({
        harnessId: agent.id,
        harnessName: agent.name,
        models: agent.eligibleModels,
        ...(agent.capabilities.reasoning
          ? { reasoningLevels: agent.capabilities.reasoning.options }
          : {}),
      })),
  };
}

/**
 * What a voice note can be spoken as. The provider is browser-local so the
 * server cannot read which one is SELECTED, but the voices and speeds are
 * ShipIt's own catalogue and differ per provider — including the speed range,
 * which the declaration holds as one pair of bounds for all of them.
 */
function ttsChoicesDetail(): Record<string, unknown> {
  return {
    providers: ttsProviders().map((provider) => ({
      providerId: provider.id,
      providerName: provider.label,
      voices: providerVoices(provider.id),
      speeds: providerSpeeds(provider.id),
      ...(provider.speedRange ? { speedRange: provider.speedRange } : {}),
    })),
  };
}

/**
 * Live facts a declaration's `type` cannot hold — which models this install can
 * actually run, what a pin resolves to today, which voices a provider offers.
 * Keyed by setting: a setting with no entry still lists, gets, and carries its
 * declared shape, so this is extra detail and never a second place to register a
 * setting.
 *
 * **Resolved even for a setting whose VALUE is withheld**, so each function here
 * is a req 2 surface in its own right: `deps` reaches every store, and what
 * makes one safe is what it RETURNS — catalogue and registry data only.
 */
const LIVE_DETAILS: Record<string, LiveDetail> = {
  "services.nonTurnModel": nonTurnModelDetail,
  "roles[].model": runnableTargetsDetail,
  "roles[].harness": runnableTargetsDetail,
  "roles[].reasoningEffort": runnableTargetsDetail,
  "reviewers[].model": runnableTargetsDetail,
  "reviewers[].reasoningEffort": runnableTargetsDetail,
  "voice.ttsVoice": ttsChoicesDetail,
  "voice.ttsSpeed": ttsChoicesDetail,
};

// Only this read's own two reasons; the catalogue's four come from
// `refusalSentence`, so a withheld setting says the same thing everywhere.
const UNREADABLE_NOTES: Record<"no_repository" | "read_failed", string> = {
  no_repository: "This is a per-repository setting and this session binds no repository.",
  read_failed: "ShipIt could not read this setting's stored value.",
};

interface ReadState {
  stored: Record<string, unknown>;
  /** The bulk read of the stored half failed, so no payload setting has a value. */
  storedFailed: boolean;
  /** Payload settings whose own reader could not tell, reported one by one. */
  storedUnreadable: ReadonlySet<string>;
  sessionId: string;
  /** The session's own repository binding, and the only one a project read uses. */
  repoUrl: string | null;
  cache: StoreReadCache;
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

/** Where a value lives, for a reader following an entry that has no value. */
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
  // this read would infer: a browser-local value is not "ShipIt could not read
  // it", it is a value ShipIt's server never holds.
  if (declaration.emits.kind === "withheld") {
    const { reason } = declaration.emits;
    return { ok: false, reason, note: refusalSentence(reason) };
  }
  const scoped = scopeUnreadableReason(declaration, state.repoUrl !== null);
  if (scoped) return { ok: false, reason: scoped, note: UNREADABLE_NOTES[scoped] };
  if (isPayloadDeclaration(declaration)) {
    // The stored half is one bulk read, so its failure is per entry for every
    // payload setting — and everything with a reader of its own still reads.
    if (state.storedFailed || state.storedUnreadable.has(declaration.wire)) {
      return { ok: false, reason: "read_failed", note: UNREADABLE_NOTES.read_failed };
    }
    const raw = state.stored[declaration.wire];
    // `omitWhenNull` drops the field rather than sending null; the pin is unset.
    return { ok: true, kind: "value", value: raw === undefined ? declaration.type.defaultValue : raw };
  }
  const ownRoute = ownRouteReader(declaration.key);
  if (ownRoute) return ownRoute(deps);
  const bespoke = bespokeReader(declaration.key);
  if (!bespoke) {
    // Unreachable: both reader tables are keyed by a type derived from the
    // catalogue, so every non-payload declaration has one. Kept so a
    // declaration that slipped through says so instead of reporting a default.
    return {
      ok: false,
      reason: "read_failed",
      note: `${UNREADABLE_NOTES.read_failed} It is ${storeLocation(declaration)}.`,
    };
  }
  const ctx: StoreReadContext = { deps, sessionId: state.sessionId, repoUrl: state.repoUrl };
  const read = bespoke(ctx, state.cache);
  if (read.kind === "unreadable") return { ok: false, reason: "read_failed", note: read.note };
  return read.kind === "items"
    ? { ok: true, kind: "items", items: read.items }
    : { ok: true, kind: "value", value: read.raw };
}

/**
 * How ONE instance is named in the agent's output — through the same door its
 * value leaves by (req 2). A name ShipIt derived itself is its own; a name the
 * user wrote is projected through the collection declaration that owns the key,
 * which is where emitting that text was decided and reasoned. An entry that
 * collection's projection refuses to name — a URL pasted into the allowlist
 * box, whose userinfo and query are where a token travels — is named by
 * nothing, so it produces no item at all.
 */
function itemAddress(declarationKey: string, name: ItemName): string | null {
  if (name.kind === "shipit") return name.address;
  const collectionKey = collectionKeyOf(declarationKey);
  const collection = collectionKey ? findSetting(collectionKey) : undefined;
  if (!collection) return null;
  const outcome = projectSetting(collection, [name.item]);
  if (!outcome.readable || !Array.isArray(outcome.value)) return null;
  const [emitted] = outcome.value as unknown[];
  if (typeof emitted !== "string" || emitted.length === 0) return null;
  return name.prefix ? `${name.prefix}:${emitted}` : emitted;
}

/** Up to this many addresses are named in the index; `get` carries them all. */
const ADDRESSES_IN_INDEX = 8;

function itemsDisplay(addresses: string[]): string {
  if (addresses.length === 0) return "no items";
  const shown = addresses.slice(0, ADDRESSES_IN_INDEX);
  const rest = addresses.length - shown.length;
  const more = rest > 0 ? `, … (+${rest} more)` : "";
  return `${addresses.length} item${addresses.length === 1 ? "" : "s"}: ${shown.join(", ")}${more}`;
}

interface ProjectedItems {
  items: SettingItemView[];
  display: string;
  notes: string[];
}

/**
 * The instances of an item-addressed setting. Each one's value goes through
 * `projectSettingValue`, exactly as a scalar's does — `raw` here is the one
 * field of the one item, which is what `projectSetting` documents itself to
 * take.
 */
function projectItems(
  declaration: AnySettingDeclaration,
  read: StoredItem[],
  detail: boolean,
): ProjectedItems {
  const items: SettingItemView[] = [];
  let unnamed = 0;
  for (const item of read) {
    const address = itemAddress(declaration.key, item.name);
    if (address === null) {
      unnamed++;
      continue;
    }
    const projected = projectSettingValue(declaration, item.raw, detail);
    items.push({
      address,
      value: projected.value,
      display: projected.display,
      ...(item.notes && item.notes.length > 0 ? { notes: item.notes } : {}),
    });
  }
  const notes = unnamed > 0
    ? [
        `${unnamed} stored ${unnamed === 1 ? "instance is" : "instances are"} not listed: what `
          + "identifies each is not an address this setting can emit as it is stored, so ShipIt "
          + "does not repeat it back.",
      ]
    : [];
  return { items, display: itemsDisplay(items.map((i) => i.address)), notes };
}

/** An entry plus, for an item-addressed setting, the instances `get` carries. */
interface BuiltEntry {
  entry: SettingIndexEntry;
  items?: SettingItemView[];
}

function resolveEffect(
  declaration: AnySettingDeclaration,
  deps: SettingsReadDeps,
  sessionId: string,
): SettingEffect {
  const probe = EFFECT_PROBES[declaration.key];
  if (!probe) return { state: "live" };
  try {
    return probe(deps, sessionId);
  } catch (err) {
    return { state: "uncertain", detail: readFailureNote(declaration.key, err) };
  }
}

/**
 * Degrade per entry, never abort: one setting that throws must not cost the
 * agent the index of every other setting. The PROJECTION is inside the guard
 * with the read, because a declaration supplies its own `derived` function and
 * a throw there would otherwise fail the whole call.
 */
async function buildEntry(
  declaration: AnySettingDeclaration,
  deps: SettingsReadDeps,
  state: ReadState,
  detail: boolean,
): Promise<BuiltEntry> {
  try {
    return await buildReadableEntry(declaration, deps, state, detail);
  } catch (err) {
    return unreadableEntry(declaration, detail, "read_failed", readFailureNote(declaration.key, err));
  }
}

function unreadableEntry(
  declaration: AnySettingDeclaration,
  detail: boolean,
  reason: SettingUnreadableReason,
  note: string,
): BuiltEntry {
  return {
    entry: {
      ...entryBase(declaration),
      value: null,
      display: "unknown",
      readable: false,
      unreadableReason: reason,
      // An unreadable value cannot carry an effect claim. The reason is in
      // `notes` and must not be repeated here — it is one fact, not three.
      effect: { state: "uncertain" },
      notes: [note, ...listOnlyNotes(declaration, detail)],
    },
  };
}

function entryBase(declaration: AnySettingDeclaration) {
  return {
    key: declaration.key,
    label: declaration.label,
    summary: firstSentence(declaration.description),
    tab: declaration.tab,
    scope: declaration.scope,
    address: addressView(declaration),
    propose: proposeView(declaration),
  };
}

/** `get` says the same thing with the items themselves, so this is list-only. */
function listOnlyNotes(declaration: AnySettingDeclaration, detail: boolean): string[] {
  return detail ? [] : [itemNote(declaration)].filter((n): n is string => !!n);
}

async function buildReadableEntry(
  declaration: AnySettingDeclaration,
  deps: SettingsReadDeps,
  state: ReadState,
  detail: boolean,
): Promise<BuiltEntry> {
  const outcome = await readValue(declaration, deps, state);
  if (!outcome.ok) return unreadableEntry(declaration, detail, outcome.reason, outcome.note);
  const base = entryBase(declaration);
  const indexNotes = listOnlyNotes(declaration, detail);
  const effect = resolveEffect(declaration, deps, state.sessionId);
  if (outcome.kind === "items") {
    // The index names the instances and stops there; what each is set to is the
    // detail, for the same reason an option set is (req 1).
    const projected = projectItems(declaration, outcome.items, detail);
    return {
      entry: {
        ...base,
        value: null,
        display: projected.display,
        readable: true,
        effect,
        notes: [...projectionNotes(declaration), ...projected.notes, ...indexNotes],
      },
      items: projected.items,
    };
  }
  const projected = projectSettingValue(declaration, outcome.value, detail);
  return {
    entry: {
      ...base,
      value: projected.value,
      display: projected.display,
      readable: true,
      effect,
      notes: [...projected.notes, ...indexNotes],
    },
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
  let storedUnreadable: ReadonlySet<string> = new Set();
  let storedFailed = false;
  try {
    const read = await readStoredGlobalSettings({
      appWorkspaceDir: deps.appWorkspaceDir,
      ...(deps.credentialStore ? { credentialStore: deps.credentialStore } : {}),
    });
    stored = read.values;
    storedUnreadable = read.unreadable;
  } catch (err) {
    storedFailed = true;
    console.error("[settings-read] reading the stored settings failed:", err);
  }
  const repoUrl = session.remoteUrl || null;
  return {
    stored,
    storedFailed,
    storedUnreadable,
    sessionId,
    repoUrl,
    cache: new StoreReadCache({ deps, sessionId, repoUrl }),
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
    throw new ServiceError(
      400,
      `Unknown settings tab: ${echoSupplied(opts.tab)}. Tabs with settings: ${tabs.join(", ")}`,
    );
  }
  const state = await readState(deps, sessionId);
  const wanted = opts.tab ? declarations.filter((d) => d.tab === opts.tab) : declarations;
  const built = await Promise.all(
    wanted.map((declaration) => buildEntry(declaration, deps, state, false)),
  );
  return { settings: built.map((b) => b.entry), tabs };
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

/**
 * The last proposal about one target, in the words `lastProposal` reports. The
 * store answers per target, so an item-addressed setting looks one up per
 * instance: a card about the `reviewer` role says nothing about `deep-dive`.
 */
function lastProposalFor(
  deps: SettingsReadDeps,
  target: SettingsProposalTarget,
): SettingProposalSummary | undefined {
  return summarize(deps.proposals?.latestForTarget(target) ?? null);
}

function summarize(row: SettingsProposalRow | null): SettingProposalSummary | undefined {
  if (!row) return undefined;
  return {
    cardId: row.cardId,
    phase: row.phase,
    operation: row.operation,
    ...(row.target.item ? { item: row.target.item } : {}),
    from: row.from,
    proposed: row.proposed,
    proposedAt: row.createdAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    sessionId: row.sessionId,
  };
}

/** The detail of one setting: its whole description, its value's shape, and what resolves live. */
export async function getSettingForAgent(
  deps: SettingsReadDeps,
  sessionId: string,
  key: string,
): Promise<SettingDetailEntry> {
  const declaration = findSetting(key);
  if (!declaration) {
    throw new ServiceError(
      404,
      `No ShipIt setting is called "${echoSupplied(key)}". List them with \`shipit settings list\`.`,
    );
  }
  const state = await readState(deps, sessionId);
  const { entry, items } = await buildEntry(declaration, deps, state, true);
  // Not gated on `readable`: the options are a different question from the
  // value, and a withheld setting is exactly one whose options the agent still
  // has to name (req 1). `LIVE_DETAILS` carries what that costs.
  const live = resolveLiveDetail(declaration.key, deps, entry);
  // A per-repository setting's proposals are addressed by repository, and the
  // repository is the session's own binding — never anything a caller supplies.
  const perRepository = declaration.scope === "project" || addressesARepository(declaration.address);
  const base: SettingsProposalTarget = {
    key: declaration.key,
    ...(perRepository && state.repoUrl ? { repoUrl: state.repoUrl } : {}),
  };
  // Keyed by SETTING rather than by target: an item-addressed lookup answers
  // nothing for an entry that does not exist yet (a pending host addition) or no
  // longer does (one a card removed), and those are exactly the cards an agent
  // told to read before proposing has to see.
  const last = summarize(deps.proposals?.latestForKey(base.key, base.repoUrl) ?? null);
  const withProposals = items?.map((item) => {
    const proposal = lastProposalFor(deps, { ...base, item: item.address });
    return proposal ? { ...item, lastProposal: proposal } : item;
  });
  return {
    ...entry,
    description: oneLine(declaration.description),
    valueType: declaration.type.kind,
    shape: declaration.type.shape,
    ...(live ? { live } : {}),
    ...(withProposals ? { items: withProposals } : {}),
    ...(last ? { lastProposal: last } : {}),
  };
}
