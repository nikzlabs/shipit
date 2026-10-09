import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Schedule,
  ScheduleProposalCard,
  ScheduleProposalValue,
  ScheduleTiming,
  SessionStartParams,
  SessionStartSpec,
  SessionStartTarget,
} from "../../shared/types.js";
import { normalizeCapabilities } from "../../shared/types.js";
import { START_PARAM_LABELS, type StartParamNames } from "../../shared/session-start-labels.js";
import { parseSessionStartSpec } from "../../shared/session-start-spec.js";
import { describeGrants, describeTarget, describeTiming, formatWhen } from "../../shared/schedule-describe.js";
import type { PersistedMessage } from "../chat-history.js";
import { emitChatCard } from "../chat-card-persistence.js";
import type { ScheduleStore } from "../schedule-store.js";
import type {
  ScheduleProposal,
  ScheduleProposalRecord,
  ScheduleProposalStore,
  ScheduleUpdateProposal,
} from "../schedule-proposal-store.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import {
  claimDecisionCard,
  claimDecisionCardWith,
  currentDecisionCard,
  loadDecisionCard,
  type CardClaimDeps,
  type DecisionCardKind,
  type DecisionCardPersister,
} from "./card-claim.js";
import { parseScheduleProposal, type ProposedSchedule, type ProposedTarget } from "./schedule-proposal-yaml.js";
import {
  applyScheduleEnabled,
  applyScheduleUpdate,
  checkScheduleTiming,
  insertSchedule,
  listSchedules,
  readScheduleName,
  readScheduleSpec,
  readScheduleTimeZone,
  type ScheduleQueue,
  type ScheduleSpecDeps,
} from "./schedules.js";
import { ServiceError } from "./types.js";

/**
 * docs/324-scheduled-sessions reqs 8, 9 — the agent proposes a schedule or a change in chat, and
 * the schedule exists only after the user confirms the card. A proposal is checked by the checks
 * create and update use when it is posted, and again on Confirm, because a card outlives its turn.
 */

export interface ScheduleProposalDeps extends ScheduleSpecDeps {
  store: ScheduleStore;
  scheduler: ScheduleQueue;
  proposals: ScheduleProposalStore;
  chatHistoryManager: DecisionCardPersister;
  sessionManager: Pick<SessionManager, "get">;
  getRunnerRegistry: () => SessionRunnerRegistry | undefined;
}

export const SCHEDULE_PROPOSAL_CARD: DecisionCardKind<"scheduleProposal"> = {
  field: "scheduleProposal",
  noun: "schedule proposal",
  updated: (sessionId, cardId, card) => ({ type: "schedule_proposal_update", sessionId, cardId, card }),
};

const NOT_SET = "Not set";
const PARAM_KEYS = Object.keys(START_PARAM_LABELS) as (keyof SessionStartParams)[];

function claimDeps(deps: ScheduleProposalDeps): CardClaimDeps<"scheduleProposal", ScheduleProposalRecord> {
  return {
    chatHistoryManager: deps.chatHistoryManager,
    records: deps.proposals,
    getRunnerRegistry: deps.getRunnerRegistry,
  };
}

function refuse(message: string): never {
  throw new ServiceError(400, message);
}

const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

function paramNames(deps: ScheduleSpecDeps): StartParamNames {
  return { sshHostLabel: (id) => deps.credentialStore.listSshHosts().find((host) => host.id === id)?.label };
}

function describeParam(key: keyof SessionStartParams, value: unknown, names: StartParamNames): string {
  if (value === undefined) return NOT_SET;
  const label = START_PARAM_LABELS[key] as { describe(value: unknown, names?: StartParamNames): string };
  return label.describe(value, names);
}

const stateOf = (enabled: boolean) => (enabled ? "Active" : "Paused");

/** Null means "not set": the key is dropped, on a new schedule as on a change. */
function withParams(base: SessionStartParams, given: Record<string, unknown> | undefined): Record<string, unknown> {
  const unknown = Object.keys(given ?? {}).find((key) => !(PARAM_KEYS as string[]).includes(key));
  if (unknown !== undefined) refuse(`Unknown session-start parameter "${unknown}".`);
  return Object.fromEntries(Object.entries({ ...base, ...given }).filter(([, value]) => value !== null));
}

/** On a change, a sandbox keeps every grant the YAML does not name. */
function withTarget(base: SessionStartTarget | undefined, given: ProposedTarget): SessionStartTarget {
  if (given.kind === "repo") return given;
  const kept = base?.kind === "sandbox" ? base.capabilities : {};
  return { kind: "sandbox", capabilities: normalizeCapabilities({ ...kept, ...given.capabilities }) };
}

function targetValues(before: SessionStartTarget | undefined, after: SessionStartTarget): ScheduleProposalValue[] {
  const values: ScheduleProposalValue[] = [];
  const beforeTarget = before ? describeTarget(before) : undefined;
  if (beforeTarget !== describeTarget(after)) {
    values.push({ label: "Target", ...(beforeTarget ? { before: beforeTarget } : {}), after: describeTarget(after) });
  }
  const grants = (target: SessionStartTarget | undefined) =>
    target?.kind === "sandbox" ? describeGrants(target.capabilities) : undefined;
  const [grantsBefore, grantsAfter] = [grants(before), grants(after)];
  if (grantsAfter !== undefined && grantsBefore !== grantsAfter) {
    values.push({ label: "Sandbox grants", ...(before ? { before: grantsBefore ?? NOT_SET } : {}), after: grantsAfter });
  }
  return values;
}

function paramValues(
  before: SessionStartParams | undefined,
  after: SessionStartParams,
  names: StartParamNames,
): ScheduleProposalValue[] {
  return PARAM_KEYS.flatMap((key) => {
    if (before ? same(before[key], after[key]) : after[key] === undefined) return [];
    return [{
      label: START_PARAM_LABELS[key].label,
      ...(before ? { before: describeParam(key, before[key], names) } : {}),
      after: describeParam(key, after[key], names),
    }];
  });
}

interface BuiltProposal {
  proposal: ScheduleProposal;
  card: Omit<ScheduleProposalCard, "cardId" | "phase" | "createdAt">;
  scheduleId?: string;
  baseUpdatedAt?: string;
}

const REQUIRED_FOR_CREATE = ["name", "when", "target", "prompt"] as const;

function buildCreate(deps: ScheduleProposalDeps, given: ProposedSchedule): BuiltProposal {
  const missing = REQUIRED_FOR_CREATE.filter((field) =>
    field === "when" ? given.timing === undefined : given[field] === undefined);
  if (missing.length > 0) {
    refuse(`A new schedule needs ${REQUIRED_FOR_CREATE.join(", ")}; this proposal has no ${missing.join(", ")}. `
      + "To change an existing schedule, pass --id.");
  }
  const name = readScheduleName(given.name);
  const timeZone = given.timeZone === undefined ? null : readScheduleTimeZone(given.timeZone);
  const timing = given.timing!;
  // With no zone named, Confirm uses the browser's; the one-hour check does not depend on it.
  checkScheduleTiming(timing, timeZone ?? "UTC");
  const spec = readScheduleSpec({
    target: withTarget(undefined, given.target!),
    params: withParams({}, given.params),
    prompt: given.prompt,
  }, deps);
  const enabled = given.enabled ?? true;
  const names = paramNames(deps);
  return {
    proposal: { kind: "create", name, timing, timeZone, spec, enabled },
    card: {
      kind: "create",
      name,
      values: [
        { label: "When", after: describeTiming(timing) },
        ...(timeZone ? [{ label: "Time zone", after: timeZone }] : []),
        ...targetValues(undefined, spec.target),
        ...paramValues(undefined, spec.params, names),
        { label: "State", after: stateOf(enabled) },
      ],
      prompt: { after: spec.prompt },
      timing,
      timeZone,
      enabled,
    },
  };
}

function storedSpec(schedule: Schedule): SessionStartSpec {
  const parsed = parseSessionStartSpec(schedule.spec);
  if ("problem" in parsed) {
    throw new ServiceError(409, `The schedule's stored description no longer reads (${parsed.problem}), `
      + "so a change cannot be shown against it.");
  }
  return parsed.spec;
}

function buildUpdate(deps: ScheduleProposalDeps, id: string, given: ProposedSchedule): BuiltProposal {
  const current = deps.store.get(id);
  if (!current) {
    throw new ServiceError(404, `No schedule has the id ${JSON.stringify(id)}. \`shipit schedule list\` shows the ids.`);
  }
  const before = storedSpec(current);
  const changes: ScheduleUpdateProposal["changes"] = {};
  const values: ScheduleProposalValue[] = [];

  if (given.name !== undefined) {
    const name = readScheduleName(given.name);
    if (name !== current.name) {
      changes.name = name;
      values.push({ label: "Name", before: current.name, after: name });
    }
  }
  if (given.timing !== undefined && !same(given.timing, current.timing)) {
    changes.timing = given.timing;
    values.push({ label: "When", before: describeTiming(current.timing), after: describeTiming(given.timing) });
  }
  if (given.timeZone !== undefined) {
    const timeZone = readScheduleTimeZone(given.timeZone);
    if (timeZone !== current.timeZone) {
      changes.timeZone = timeZone;
      values.push({ label: "Time zone", before: current.timeZone, after: timeZone });
    }
  }
  const timing = changes.timing ?? current.timing;
  const timeZone = changes.timeZone ?? current.timeZone;
  if (changes.timing || changes.timeZone) checkScheduleTiming(timing, timeZone);

  let prompt: ScheduleProposalCard["prompt"];
  if (given.target !== undefined || given.params !== undefined || given.prompt !== undefined) {
    const spec = readScheduleSpec({
      target: given.target ? withTarget(before.target, given.target) : before.target,
      params: withParams(before.params, given.params),
      prompt: given.prompt === undefined ? before.prompt : given.prompt,
    }, deps);
    if (!same(spec, before)) {
      changes.spec = spec;
      values.push(...targetValues(before.target, spec.target), ...paramValues(before.params, spec.params, paramNames(deps)));
      if (spec.prompt !== before.prompt) prompt = { before: before.prompt, after: spec.prompt };
    }
  }
  if (given.enabled !== undefined && given.enabled !== current.enabled) {
    changes.enabled = given.enabled;
    values.push({ label: "State", before: stateOf(current.enabled), after: stateOf(given.enabled) });
  }
  if (Object.keys(changes).length === 0) refuse(`This proposal changes nothing: the schedule already has these values.`);

  return {
    proposal: { kind: "update", changes },
    scheduleId: current.id,
    baseUpdatedAt: current.updatedAt,
    card: {
      kind: "update",
      scheduleId: current.id,
      name: current.name,
      values,
      ...(prompt ? { prompt } : {}),
      timing,
      timeZone,
      enabled: changes.enabled ?? current.enabled,
    },
  };
}

/**
 * `shipit schedule propose`: a valid proposal posts the card, record first so a click never loads
 * nothing; an invalid one is refused by name. Nothing is saved until the user confirms (req 9).
 */
export function proposeSchedule(
  deps: ScheduleProposalDeps,
  sessionId: string,
  input: { id?: string | undefined; text: string },
): ScheduleProposalCard {
  if (!deps.sessionManager.get(sessionId)) throw new ServiceError(404, "Session not found");
  const given = parseScheduleProposal(input.text);
  const built = input.id ? buildUpdate(deps, input.id, given) : buildCreate(deps, given);

  const runner = deps.getRunnerRegistry()?.get(sessionId);
  if (!runner) throw new ServiceError(409, "This session is not running, so a card cannot be posted to it.");

  const createdAt = new Date().toISOString();
  const card: ScheduleProposalCard = { cardId: `sch-${randomUUID()}`, ...built.card, phase: "pending", createdAt };
  deps.proposals.create({
    cardId: card.cardId,
    sessionId,
    ...(built.scheduleId ? { scheduleId: built.scheduleId } : {}),
    ...(built.baseUpdatedAt ? { baseUpdatedAt: built.baseUpdatedAt } : {}),
    proposal: built.proposal,
    phase: "pending",
    createdAt,
  });
  const persisted: PersistedMessage = { role: "assistant", text: "", scheduleProposal: card };
  emitChatCard(
    runner,
    { type: "schedule_proposal_card", sessionId, card },
    persisted,
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
  );
  return card;
}

export interface ScheduleDecisionResult {
  card: ScheduleProposalCard;
  /** False when the click found nothing to do: the card was already decided. */
  acted: boolean;
}

function unchanged(deps: ScheduleProposalDeps, sessionId: string, cardId: string): ScheduleDecisionResult {
  return { card: currentDecisionCard(SCHEDULE_PROPOSAL_CARD, deps, sessionId, cardId), acted: false };
}

function end(
  deps: ScheduleProposalDeps,
  sessionId: string,
  cardId: string,
  phase: "stale" | "refused" | "cancelled",
  outcome?: string,
): ScheduleDecisionResult {
  const card = claimDecisionCard(SCHEDULE_PROPOSAL_CARD, claimDeps(deps), sessionId, cardId, "pending", {
    phase,
    resolvedAt: new Date().toISOString(),
    ...(outcome ? { outcome } : {}),
  });
  return card ? { card, acted: true } : unchanged(deps, sessionId, cardId);
}

/**
 * The write and the claim commit together, inside the schedule's queue: a refusal writes nothing,
 * and of two clicks the second finds the card decided.
 */
function settleConfirm(
  deps: ScheduleProposalDeps,
  sessionId: string,
  cardId: string,
  browserTimeZone: string | undefined,
): ScheduleDecisionResult {
  const { record } = loadDecisionCard(SCHEDULE_PROPOSAL_CARD, claimDeps(deps), sessionId, cardId);
  if (record.phase !== "pending") return unchanged(deps, sessionId, cardId);
  const { proposal } = record;
  if (proposal.kind === "update") {
    const schedule = record.scheduleId ? deps.store.get(record.scheduleId) : null;
    if (!schedule) return end(deps, sessionId, cardId, "refused", "The schedule was deleted after this card was written.");
    // The card's "before" is no longer true.
    if (schedule.updatedAt !== record.baseUpdatedAt) return end(deps, sessionId, cardId, "stale");
  }

  let card: ScheduleProposalCard | null;
  try {
    card = claimDecisionCardWith(
      SCHEDULE_PROPOSAL_CARD,
      claimDeps(deps),
      sessionId,
      cardId,
      "pending",
      { phase: "confirmed", resolvedAt: new Date().toISOString() },
      () => {
        if (proposal.kind === "create") {
          const schedule = insertSchedule(deps, { ...proposal, timeZone: proposal.timeZone ?? browserTimeZone });
          deps.proposals.setScheduleId(sessionId, cardId, schedule.id);
          return { scheduleId: schedule.id, timeZone: schedule.timeZone };
        }
        const scheduleId = record.scheduleId!;
        const { enabled, ...edit } = proposal.changes;
        if (Object.keys(edit).length > 0) applyScheduleUpdate(deps, scheduleId, edit);
        if (enabled !== undefined) applyScheduleEnabled(deps, scheduleId, enabled);
        return {};
      },
    );
  } catch (err) {
    if (err instanceof ServiceError && err.statusCode === 400) return end(deps, sessionId, cardId, "refused", err.message);
    throw err;
  }
  if (!card) return unchanged(deps, sessionId, cardId);
  deps.scheduler.announceSchedules();
  return { card, acted: true };
}

/**
 * The user's Confirm. A new schedule whose proposal names no zone takes the browser's, which the
 * card sends; a change keeps the schedule's zone unless it names one.
 */
export async function confirmScheduleProposal(
  deps: ScheduleProposalDeps,
  sessionId: string,
  cardId: string,
  browserTimeZone?: unknown,
): Promise<ScheduleDecisionResult> {
  const { record } = loadDecisionCard(SCHEDULE_PROPOSAL_CARD, claimDeps(deps), sessionId, cardId);
  if (record.phase !== "pending") return unchanged(deps, sessionId, cardId);
  let timeZone: string | undefined;
  if (record.proposal.kind === "create" && record.proposal.timeZone === null) {
    if (typeof browserTimeZone !== "string") {
      throw new ServiceError(400, "This proposal names no time zone, so Confirm needs the browser's.");
    }
    timeZone = readScheduleTimeZone(browserTimeZone);
  }
  const queue = record.scheduleId ?? `proposal:${cardId}`;
  return deps.scheduler.enqueue(queue, () => settleConfirm(deps, sessionId, cardId, timeZone));
}

export function cancelScheduleProposal(
  deps: ScheduleProposalDeps,
  sessionId: string,
  cardId: string,
): ScheduleDecisionResult {
  loadDecisionCard(SCHEDULE_PROPOSAL_CARD, claimDeps(deps), sessionId, cardId);
  return end(deps, sessionId, cardId, "cancelled");
}

/** One schedule as `shipit schedule list` shows it: the YAML's words, and the raw values for `--json`. */
export interface AgentScheduleEntry {
  id: string;
  name: string;
  enabled: boolean;
  when: string;
  timeZone: string;
  target: string | null;
  grants?: string;
  params: { key: string; label: string; value: string }[];
  prompt: string | null;
  nextRuns: string[];
  needsUserReason?: string;
  timing: ScheduleTiming;
  spec: SessionStartSpec | null;
  updatedAt: string;
}

/**
 * SSH destinations are listed by id: a session may not read the destination registry
 * (docs/305, `integrations.sshHosts`), so their labels stay on the user's card.
 */
export function listSchedulesForAgent(deps: Pick<ScheduleProposalDeps, "store">): AgentScheduleEntry[] {
  const names: StartParamNames = {};
  return listSchedules(deps).map(({ spec, ...schedule }) => ({
    id: schedule.id,
    name: schedule.name,
    enabled: schedule.enabled,
    when: formatWhen(schedule.timing),
    timeZone: schedule.timeZone,
    target: spec ? describeTarget(spec.target) : null,
    ...(spec?.target.kind === "sandbox" ? { grants: describeGrants(spec.target.capabilities) } : {}),
    params: spec
      ? PARAM_KEYS.filter((key) => spec.params[key] !== undefined).map((key) => ({
          key,
          label: START_PARAM_LABELS[key].label,
          value: describeParam(key, spec.params[key], names),
        }))
      : [],
    prompt: spec?.prompt ?? null,
    nextRuns: schedule.nextRuns,
    ...(schedule.needsUserReason ? { needsUserReason: schedule.needsUserReason } : {}),
    timing: schedule.timing,
    spec,
    updatedAt: schedule.updatedAt,
  }));
}
