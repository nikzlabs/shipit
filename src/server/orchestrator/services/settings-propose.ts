import {
  addressesARepository,
  findSetting,
  formatSetting,
  projectSetting,
  refusalSentence,
} from "../../shared/settings-catalogue/index.js";
import type { AnySettingDeclaration } from "../../shared/settings-catalogue/index.js";
import type { SettingsProposalCard, SettingsProposalTarget } from "../../shared/types.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SettingsProposalStore } from "../settings-proposal-store.js";
import { settingBaseline } from "./settings-baseline.js";
import type { SettingBaseline, SettingBaselineDeps } from "./settings-baseline.js";
import { withConflictDomains } from "./settings-conflict-domain.js";
import { findOperation, operationsFor } from "./settings-operations.js";
import type {
  SettingsOperation,
  SettingsOperationDeps,
  SettingsOperationKind,
} from "./settings-operations.js";
import { getSettingForAgent } from "./settings-read.js";
import type { SettingDetailEntry, SettingItemView, SettingsReadDeps } from "./settings-read.js";
import { postSettingsProposal } from "./settings-proposal.js";
import type { SettingsProposalPersister } from "./settings-proposal.js";
import { ServiceError } from "./types.js";

/**
 * `shipit settings propose` — the agent's only write path
 * (docs/299-agent-settings-access req 4).
 *
 * It posts one card carrying one change and returns its id. It does not wait,
 * and nothing moves until the user clicks.
 *
 * **The server takes the snapshot.** The current value and the private baseline
 * are read HERE, in one read, rather than carried from the agent's earlier
 * `shipit settings get`. A value that moved in between would otherwise give the
 * card a `from` the baseline never saw — the card would tell the user it is
 * changing one thing while the apply compares against another.
 *
 * **Validated twice.** Everything below runs again at apply time
 * (`settings-decision.ts`), because a card outlives its turn: a model can leave
 * the catalogue and a harness be uninstalled between the card being written and
 * the button being pressed. One qualification, and it is deliberate: a role save
 * validates with purpose `"save"`, which skips credential eligibility so
 * disconnected roles stay editable, so a proposal does not refuse a role whose
 * credential was removed — it saves, and the read reports the role as not
 * runnable.
 *
 * The agent contributes the key, the address, the value and a `reason`. Every
 * word the card asserts about the change — the label, the description, the
 * breadcrumb, `from` and `to` — comes from the registry and from this read.
 */

/** A refusal the agent reads, never a failure: nothing was written. */
function refuse(message: string): never {
  throw new ServiceError(400, message);
}

export interface SettingsProposeInput {
  key: string;
  /** `set` unless the setting's declared operation is joining or leaving a list. */
  operation?: SettingsOperationKind;
  /** One instance of an item-addressed setting, as `shipit settings get` prints it. */
  item?: string | undefined;
  /** The value to write, already typed. */
  value?: unknown;
  /** The value as the agent typed it; read against the declared type. */
  valueText?: string | undefined;
  reason?: string | undefined;
}

export interface SettingsProposeDeps {
  read: SettingsReadDeps;
  baseline: SettingBaselineDeps;
  operations: SettingsOperationDeps;
  proposals: SettingsProposalStore;
  chatHistoryManager: SettingsProposalPersister;
  getRunnerRegistry: () => SessionRunnerRegistry | undefined;
}

/**
 * How much of a value a card can show.
 *
 * A change nobody can check by looking is not a change the user can approve, so
 * a value too long for the card is refused rather than shown truncated —
 * the same test as an operation whose full effect the card cannot display
 * (plan.md → Collections are patched, never replaced). It is what keeps a 50,000
 * character instructions rewrite out of a one-click card.
 */
export const CARD_VALUE_MAX = 200;

/**
 * The agent supplies text; the declaration says what that text means. Reading it
 * here rather than in the shim keeps the CLI from having to know a setting's
 * type — and stops `roles[].description=true` from arriving as a boolean.
 */
export function readProposedValue(declaration: AnySettingDeclaration, text: string): unknown {
  switch (declaration.type.kind) {
    case "bool":
      if (text === "true" || text === "on") return true;
      if (text === "false" || text === "off") return false;
      return text;
    case "number": {
      if (text === "null" || text === "") return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : text;
    }
    case "enum":
    case "text":
      // Text is text: a setting whose value happens to look like JSON is still
      // the string the user would have typed into the box.
      return text;
    default:
      if (text === "null" || text === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
  }
}

interface ResolvedTarget {
  declaration: AnySettingDeclaration;
  operation: SettingsOperation;
  target: SettingsProposalTarget;
}

/**
 * The setting, the operation and the concrete address — every refusal that can
 * be decided before anything is read.
 *
 * A per-repository setting's repository is the SESSION's own binding and never
 * anything the agent supplies, which is what keeps one session from proposing a
 * change to another repository.
 */
function resolveTarget(
  deps: SettingsProposeDeps,
  sessionId: string,
  input: SettingsProposeInput,
): ResolvedTarget {
  const declaration = findSetting(input.key);
  if (!declaration) {
    throw new ServiceError(
      404,
      `No ShipIt setting is called "${input.key}". List them with \`shipit settings list\`.`,
    );
  }
  if (declaration.propose.kind === "no") {
    const { reason } = declaration.propose;
    refuse(`${declaration.key} cannot be changed on your behalf (${reason}). ${refusalSentence(reason)}`);
  }
  const kind = input.operation ?? "set";
  const operation = findOperation(declaration, kind);
  if (!operation) {
    const available = operationsFor(declaration.key);
    const alternatives = available.length > 0 ? `; it can ${available.join(" and ")} this setting` : "";
    refuse(
      `ShipIt cannot ${kind} ${declaration.key} from a proposal card yet${alternatives}. `
        + "Tell the user which setting it is, what it is set to, and what it has to become.",
    );
  }

  const itemAddressed = declaration.address?.kind === "item"
    || declaration.address?.kind === "repository-item";
  // A list operation names the entry it is about, whether or not the
  // declaration itself is addressed per item.
  const needsItem = itemAddressed || kind !== "set";
  const supplied = input.item?.trim();
  if (needsItem && !supplied) {
    const noun = declaration.address && "noun" in declaration.address
      ? declaration.address.noun
      : "the entry";
    refuse(
      `${declaration.key} exists once per item, so a proposal has to name which: pass --item with `
        + `${noun}. \`shipit settings get ${declaration.key}\` lists the ones that exist.`,
    );
  }
  if (!needsItem && supplied) {
    refuse(`${declaration.key} exists once, so there is no item to name.`);
  }
  const item = supplied && operation.normalizeItem ? operation.normalizeItem(supplied) : supplied;

  let repoUrl: string | undefined;
  if (declaration.scope === "project" || addressesARepository(declaration.address)) {
    repoUrl = deps.read.sessionManager.get(sessionId)?.remoteUrl || undefined;
    if (!repoUrl) {
      refuse(
        `${declaration.key} is a per-repository setting and this session binds no repository, so `
          + "there is nothing to change it on.",
      );
    }
  }

  return {
    declaration,
    operation,
    target: { key: declaration.key, ...(item ? { item } : {}), ...(repoUrl ? { repoUrl } : {}) },
  };
}

/** The baseline is over the stored object, which for a project setting is its row. */
export function baselineTargetOf(
  declaration: AnySettingDeclaration,
  target: SettingsProposalTarget,
): { key: string; item?: string | undefined } {
  const perRepository = declaration.scope === "project" || addressesARepository(declaration.address);
  return { key: target.key, item: perRepository ? target.repoUrl : target.item };
}

interface CurrentValue {
  display: string;
  value: unknown;
  entry: SettingDetailEntry;
  /** Present for an item-addressed setting whose instance exists. */
  item?: SettingItemView;
}

/**
 * What the setting is now, through the read surface and nothing else — so the
 * card's `from` is the same projection the agent and the user already read, and
 * a value ShipIt will not emit cannot reach the card by another door.
 */
async function readCurrent(
  deps: SettingsProposeDeps,
  sessionId: string,
  { declaration, target }: ResolvedTarget,
): Promise<CurrentValue> {
  const entry = await getSettingForAgent(deps.read, sessionId, declaration.key);
  if (!entry.readable) {
    refuse(
      `ShipIt cannot read ${declaration.key} right now (${entry.unreadableReason ?? "read_failed"}), `
        + "so a card cannot show what would change.",
    );
  }
  if (!target.item) return { display: entry.display, value: entry.value, entry };
  const item = entry.items?.find((candidate) => candidate.address === target.item);
  return item
    ? { display: item.display, value: item.value, entry, item }
    : { display: "not set", value: null, entry };
}

function knownAddresses(entry: SettingDetailEntry): string {
  const addresses = (entry.items ?? []).map((item) => item.address);
  return addresses.length > 0 ? addresses.join(", ") : "none";
}

/** Neither side of the card may be longer than the card can show. */
function requireShowable(declaration: AnySettingDeclaration, side: string, text: string): void {
  if (text.length <= CARD_VALUE_MAX) return;
  refuse(
    `The ${side} value of ${declaration.key} is ${text.length} characters, and a proposal card `
      + `shows at most ${CARD_VALUE_MAX}. A change the user cannot check by looking at the card is `
      + "not offered as one click; tell them what to change instead.",
  );
}

interface ProposedChange {
  from: string;
  fromValue: unknown;
  to: string;
  proposedValue: unknown;
}

/**
 * A list operation's card. `from` and `to` are membership rather than values,
 * and the entry itself is the card's subject — so proposing a host that is
 * already allowed is refused here rather than becoming a card that changes
 * nothing.
 */
function membershipChange(
  operation: SettingsOperation,
  kind: SettingsOperationKind,
  current: CurrentValue,
  target: SettingsProposalTarget,
): ProposedChange {
  const present = current.item !== undefined;
  const wording = operation.wording ?? { from: "not set", to: "set" };
  // Both refusals say the same thing — the entry is already in the state this
  // operation would move it to — so both quote `to` and never `from`.
  if (present === (kind === "add")) {
    refuse(`"${target.item ?? ""}" is already ${wording.to}, so there is nothing to change.`);
  }
  return {
    from: wording.from,
    fromValue: present,
    to: wording.to,
    proposedValue: kind === "add",
  };
}

function valueChange(
  declaration: AnySettingDeclaration,
  input: SettingsProposeInput,
  current: CurrentValue,
  target: SettingsProposalTarget,
): ProposedChange {
  if (target.item && current.item === undefined) {
    refuse(
      `${declaration.key} has no instance called "${target.item}". It exists for: `
        + `${knownAddresses(current.entry)}.`,
    );
  }
  const raw = input.value !== undefined
    ? input.value
    : readProposedValue(declaration, input.valueText ?? "");
  const checked = declaration.type.validate(raw, declaration.label);
  if (!checked.ok) refuse(checked.message);

  // Through the catalogue's own door, exactly as the read's value was: the card
  // must show `from` and `to` in one another's terms.
  const to = formatSetting(declaration, projectSetting(declaration, checked.value));
  if (to === current.display) {
    refuse(`${declaration.key} is already ${to}, so there is nothing to change.`);
  }
  return { from: current.display, fromValue: current.value, to, proposedValue: checked.value };
}

/**
 * Take the private baseline, refusing rather than writing a card whose apply
 * could never tell whether the value moved. A card with no baseline would go
 * `stale` on every click, which reads to the user as ShipIt refusing their own
 * button.
 */
async function requireBaseline(
  deps: SettingsProposeDeps,
  resolved: ResolvedTarget,
): Promise<SettingBaseline> {
  const baseline = await settingBaseline(
    deps.baseline,
    baselineTargetOf(resolved.declaration, resolved.target),
  );
  if (baseline.kind !== "revision") {
    refuse(
      `ShipIt cannot read ${resolved.declaration.key}'s stored value, so it could not tell whether `
        + `the setting moved before the user clicked. ${baseline.reason}`,
    );
  }
  return baseline;
}

export async function proposeSettingChange(
  deps: SettingsProposeDeps,
  sessionId: string,
  input: SettingsProposeInput,
): Promise<SettingsProposalCard> {
  const resolved = resolveTarget(deps, sessionId, input);
  const { declaration, operation, target } = resolved;
  const kind = input.operation ?? "set";

  // The displayed value and the private baseline are ONE snapshot, taken under
  // the target's own lock. Reading them separately lets a write land in
  // between, which gives the card a `from` the baseline never saw: the user
  // approves what the card shows, and the apply compares against something else
  // and overwrites it (plan.md → Proposing: "the server takes the snapshot").
  const { change, baseline } = await withConflictDomains(
    operation.domains(target),
    async () => {
      const current = await readCurrent(deps, sessionId, resolved);
      const computed = kind === "set"
        ? valueChange(declaration, input, current, target)
        : membershipChange(operation, kind, current, target);
      // After the read, so a setting whose instance does not exist is refused by
      // the read — which can name the instances that DO — rather than by the
      // operation, which only knows the one it was asked about. The apply runs
      // it the other way round, where there is no card to name anything on.
      const refusal = operation.preflight?.(deps.operations, target, computed.proposedValue);
      if (refusal) refuse(refusal);
      requireShowable(declaration, "current", computed.from);
      requireShowable(declaration, "proposed", computed.to);
      return { change: computed, baseline: await requireBaseline(deps, resolved) };
    },
  );

  const runner = deps.getRunnerRegistry()?.get(sessionId);
  if (!runner) {
    // Unreachable from a session container, which is the only caller: the
    // runner is what the container belongs to.
    throw new ServiceError(409, "This session is not running, so a card cannot be posted to it.");
  }
  return postSettingsProposal(
    { chatHistoryManager: deps.chatHistoryManager, proposals: deps.proposals },
    runner,
    {
      sessionId,
      target,
      operation: kind,
      from: change.from,
      to: change.to,
      fromValue: change.fromValue,
      proposedValue: change.proposedValue,
      baseline,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  );
}
