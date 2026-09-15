import {
  addressesARepository,
  findSetting,
  formatSetting,
  joinRendered,
  projectSetting,
  refusalSentence,
  renderLine,
  renderOwn,
  renderValue,
} from "../../shared/settings-catalogue/index.js";
import type { AnySettingDeclaration, Rendered } from "../../shared/settings-catalogue/index.js";
import type {
  SettingsProposalCard,
  SettingsProposalTarget,
  SettingsProposalTextChange,
} from "../../shared/types.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SettingsProposalStore } from "../settings-proposal-store.js";
import { settingBaseline } from "./settings-baseline.js";
import type { SettingBaseline, SettingBaselineDeps } from "./settings-baseline.js";
import { withConflictDomains } from "./settings-conflict-domain.js";
import {
  echoSupplied,
  findOperation,
  operationsFor,
  proposableFieldsOf,
} from "./settings-operations.js";
import type {
  SettingsOperation,
  SettingsOperationDeps,
  SettingsOperationKind,
} from "./settings-operations.js";
import { getSettingForAgent } from "./settings-read.js";
import type { SettingDetailEntry, SettingItemView, SettingsReadDeps } from "./settings-read.js";
import {
  buildTextChange,
  CARD_TEXT_LINES_MAX,
  CARD_TEXT_MAX,
  summarizeText,
  unshowableCharacter,
} from "./settings-text-change.js";
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

/**
 * A refusal the agent reads, never a failure: nothing was written.
 *
 * {@link Rendered} rather than rendering here, because a refusal names the key,
 * the address and the value the call carried, and each of those has a mint that
 * says what it is — quoting a stored value, flattening ShipIt's own prose. A
 * `renderOwn` inside this function would take all of them undifferentiated, and
 * leave the next message free to be written with no mint at all (planning#537).
 */
function refuse(message: Rendered): never {
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
 * How much of a value one chip can show.
 *
 * A change nobody can check by looking is not a change the user can approve, so
 * a value too long for the card is refused rather than shown truncated — the
 * same test as an operation whose full effect the card cannot display
 * (plan.md → Collections are patched, never replaced).
 *
 * Past it a PROSE setting is not refused but shown differently, as a
 * full-context diff up to {@link CARD_TEXT_MAX} (req 9): the chip is what cannot
 * carry the change, and the refusal was never meant to say that the user's own
 * instructions are unproposable.
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
      renderLine(
        `No ShipIt setting is called "${echoSupplied(input.key)}". `
          + "List them with `shipit settings list`.",
      ),
    );
  }
  if (declaration.propose.kind === "no") {
    const { reason } = declaration.propose;
    refuse(renderOwn(`${declaration.key} cannot be changed on your behalf (${reason}). ${refusalSentence(reason)}`));
  }
  const kind = input.operation ?? "set";
  const operation = findOperation(declaration, kind);
  if (!operation) {
    const available = operationsFor(declaration.key);
    // A collection declaration is the list itself, and a card changes one entry
    // of it — so the refusal names the entry fields rather than reading as a
    // capability ShipIt has not built (plan.md → Collections are patched, never
    // replaced).
    const fields = available.length === 0 ? proposableFieldsOf(declaration.key) : [];
    if (fields.length > 0) {
      refuse(renderOwn(
        `${declaration.key} is the whole list, and a proposal changes one entry of it. Propose `
          + `${fields.join(" or ")} instead, naming the entry with --item.`,
      ));
    }
    const alternatives = available.length > 0 ? `; it can ${available.join(" and ")} this setting` : "";
    refuse(renderOwn(
      `ShipIt cannot ${kind} ${declaration.key} from a proposal card yet${alternatives}. `
        + "Tell the user which setting it is, what it is set to, and what it has to become.",
    ));
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
    refuse(renderOwn(
      `${declaration.key} exists once per item, so a proposal has to name which: pass --item with `
        + `${noun}. \`shipit settings get ${declaration.key}\` lists the ones that exist.`,
    ));
  }
  if (!needsItem && supplied) {
    refuse(renderOwn(`${declaration.key} exists once, so there is no item to name.`));
  }
  const item = supplied && operation.normalizeItem ? operation.normalizeItem(supplied) : supplied;

  let repoUrl: string | undefined;
  if (declaration.scope === "project" || addressesARepository(declaration.address)) {
    repoUrl = deps.read.sessionManager.get(sessionId)?.remoteUrl || undefined;
    if (!repoUrl) {
      refuse(renderOwn(
        `${declaration.key} is a per-repository setting and this session binds no repository, so `
          + "there is nothing to change it on.",
      ));
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
  display: Rendered;
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
    refuse(renderOwn(
      `ShipIt cannot read ${declaration.key} right now (${entry.unreadableReason ?? "read_failed"}), `
        + "so a card cannot show what would change.",
    ));
  }
  if (!target.item) return { display: entry.display, value: entry.value, entry };
  const item = entry.items?.find((candidate) => candidate.address === target.item);
  return item
    ? { display: item.display, value: item.value, entry, item }
    : { display: renderValue(null), value: null, entry };
}

function knownAddresses(entry: SettingDetailEntry): string {
  const addresses = (entry.items ?? []).map((item) => item.address);
  return addresses.length > 0 ? joinRendered(addresses) : "none";
}

/**
 * A value the card cannot show truthfully, whatever its size — a bidi override
 * reorders the text on screen without changing a byte of what Apply writes.
 *
 * Only the PROSE path needs it. Everywhere else the card carries a
 * {@link Rendered} string, whose mint already escapes every format character
 * (planning#577); a diff's lines are the raw value, because the card renders
 * them as their own elements rather than on one line of the agent's output, and
 * escaping there would show the user something other than their instructions.
 */
function requireDisplayable(declaration: AnySettingDeclaration, side: string, text: string): void {
  const unshowable = unshowableCharacter(text);
  if (!unshowable) return;
  refuse(renderOwn(
    `The ${side} value of ${declaration.key} contains ${unshowable}, so the card would show `
      + "something other than what Apply would write. It is not offered as one click; tell the "
      + "user what to change instead.",
  ));
}

/**
 * Neither side of a chip may be longer than a chip can show.
 *
 * Measured over the RENDERED text, which is what the card carries: a value is
 * quoted and its line breaks escaped on the way out (planning#577), so a short
 * value made mostly of newlines needs more room than its own length. The message
 * says "needs N characters to show in full" rather than "is N characters",
 * because those two numbers are not the same one.
 */
function requireShowable(declaration: AnySettingDeclaration, side: string, text: Rendered): void {
  if (text.length <= CARD_VALUE_MAX) return;
  refuse(renderOwn(
    `The ${side} value of ${declaration.key} needs ${text.length} characters to show in full, and `
      + `a proposal card shows at most ${CARD_VALUE_MAX}. A change the user cannot check by looking `
      + "at the card is not offered as one click; tell them what to change instead.",
  ));
}

/**
 * The card's change body: two chips, or — for a prose setting whose text has
 * outgrown a chip — a full-context diff and a one-line summary in its place
 * (req 9).
 *
 * Only a `text` declaration takes the diff path. A diff is a prose
 * representation, and a collection whose formatted join runs long is a list
 * rather than a document; those keep the chip and its refusal.
 */
function showableChange(
  declaration: AnySettingDeclaration,
  change: ProposedChange,
): { from: Rendered; to: Rendered; textChange?: SettingsProposalTextChange } {
  // The RAW strings, not the rendered ones: a text setting with no value renders
  // as "not set", which is ShipIt's own words and not a document to diff or to
  // count. What DECIDES between the two shapes is the rendered length, because
  // that is what a chip would have to carry — a value is quoted and its line
  // breaks escaped on the way out (planning#577), so the chip runs out of room
  // on prose the raw measure would call short enough. Deciding on the raw length
  // would refuse a 150-character instructions rewrite for having newlines in it,
  // which is req 9's own failure one notch smaller.
  const before = typeof change.fromValue === "string" ? change.fromValue : "";
  const after = typeof change.proposedValue === "string" ? change.proposedValue : "";
  const prose = declaration.type.kind === "text"
    && (change.from.length > CARD_VALUE_MAX || change.to.length > CARD_VALUE_MAX);
  if (!prose) {
    requireShowable(declaration, "current", change.from);
    requireShowable(declaration, "proposed", change.to);
    return { from: change.from, to: change.to };
  }
  for (const [side, text] of [["current", before], ["proposed", after]] as const) {
    requireDisplayable(declaration, side, text);
    if (text.length > CARD_TEXT_MAX) {
      // Which side is over decides what the agent can do about it: a proposal it
      // wrote can be made smaller, and a value the user already has cannot.
      refuse(renderOwn(
        `The ${side} value of ${declaration.key} is ${text.length.toLocaleString("en-US")} `
          + `characters, and a proposal card carries at most ${CARD_TEXT_MAX.toLocaleString("en-US")} `
          + `of them. Past that the click is not an approval, ${side === "proposed"
            ? "so propose a smaller edit or tell the user what to change."
            : "and this is the value the user already has — this setting has to be edited by hand."}`,
      ));
    }
  }
  const textChange = buildTextChange(before, after);
  const lines = textChange.before.lines + textChange.after.lines;
  if (lines > CARD_TEXT_LINES_MAX) {
    refuse(renderOwn(
      `The change to ${declaration.key} comes to ${lines.toLocaleString("en-US")} lines between the `
        + `two versions, and a proposal card carries at most `
        + `${CARD_TEXT_LINES_MAX.toLocaleString("en-US")}. Nobody checks that many before clicking; `
        + "tell the user what to change instead.",
    ));
  }
  // The prose moves into the diff and out of `from`/`to`, which keep ShipIt's
  // own summary — what the collapsed line, `lastProposal` and the CLI's echo all
  // want, and what stops the text being persisted three times over. A count is
  // ShipIt's own words about a value rather than the value, so it is minted as
  // such and never quoted.
  return {
    from: renderOwn(summarizeText(before)),
    to: renderOwn(summarizeText(after)),
    textChange,
  };
}

/**
 * A value the declaration's own projection would not emit.
 *
 * A projection that drops a value formats it as "not set", so the card would say
 * the setting becomes nothing while the write stored what was typed — a role
 * renamed to `https://user:token@host/` is the worked case, since
 * `userNameProjection` names no URL back. It is the same test `hostPreflight`
 * makes of an allowlist entry (plan.md → an operation whose full effect cannot
 * be displayed is refused), and for the same second reason: the value is NOT
 * quoted back, because what was typed can carry a credential and this message
 * reaches the transcript as tool output.
 */
function requireEmittable(declaration: AnySettingDeclaration, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  const outcome = projectSetting(declaration, value);
  if (!outcome.readable || outcome.value !== null) return;
  const shape = declaration.emits.kind === "user_name"
    ? " A name is letters, digits, spaces and . _ + ( ) [ ] - ; anything URL-shaped is named by nothing."
    : "";
  refuse(renderOwn(
    `ShipIt would not read that value back for ${declaration.key}, so a card would show the setting `
      + `becoming "not set" while the write stored something else.${shape}`,
  ));
}

interface ProposedChange {
  /** Both through the catalogue's rendering door, so neither can start a line. */
  from: Rendered;
  fromValue: unknown;
  to: Rendered;
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
    refuse(renderLine(`"${echoSupplied(target.item ?? "")}" is already ${wording.to}, so there is nothing to change.`));
  }
  return {
    from: renderOwn(wording.from),
    fromValue: present,
    to: renderOwn(wording.to),
    proposedValue: kind === "add",
  };
}

/**
 * The value the card would write, decided BEFORE the lock.
 *
 * Validation is pure — the declared type reads the agent's text and says whether
 * it is one — so it needs no lock, and the target's conflict domains can depend
 * on the answer: renaming a role writes the stored object under the NEW name as
 * well as the old one's, and the lock has to hold both before either is read.
 */
function proposedValueOf(declaration: AnySettingDeclaration, input: SettingsProposeInput): unknown {
  const raw = input.value !== undefined
    ? input.value
    : readProposedValue(declaration, input.valueText ?? "");
  const checked = declaration.type.validate(raw, declaration.label);
  if (!checked.ok) refuse(checked.message);
  return checked.value;
}

function valueChange(
  declaration: AnySettingDeclaration,
  proposedValue: unknown,
  current: CurrentValue,
  target: SettingsProposalTarget,
): ProposedChange {
  if (target.item && current.item === undefined) {
    refuse(renderLine(
      `${declaration.key} has no instance called "${echoSupplied(target.item)}". It exists for: `
        + `${knownAddresses(current.entry)}.`,
    ));
  }
  requireEmittable(declaration, proposedValue);
  // Through the catalogue's own door, exactly as the read's value was: the card
  // must show `from` and `to` in one another's terms.
  const to = formatSetting(declaration, projectSetting(declaration, proposedValue));
  if (to === current.display) {
    refuse(renderLine(`${declaration.key} is already ${to}, so there is nothing to change.`));
  }
  return { from: current.display, fromValue: current.value, to, proposedValue };
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
    refuse(renderOwn(
      `ShipIt cannot read ${resolved.declaration.key}'s stored value, so it could not tell whether `
        + `the setting moved before the user clicked. ${baseline.reason}`,
    ));
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
  const proposedValue = kind === "set" ? proposedValueOf(declaration, input) : kind === "add";
  const { change, shown, alsoChanges, baseline } = await withConflictDomains(
    operation.domains(target, deps.operations, proposedValue),
    async () => {
      const current = await readCurrent(deps, sessionId, resolved);
      const computed = kind === "set"
        ? valueChange(declaration, proposedValue, current, target)
        : membershipChange(operation, kind, current, target);
      // After the read, so a setting whose instance does not exist is refused by
      // the read — which can name the instances that DO — rather than by the
      // operation, which only knows the one it was asked about. The apply runs
      // it the other way round, where there is no card to name anything on.
      const refusal = operation.preflight?.(deps.operations, target, computed.proposedValue);
      if (refusal) refuse(refusal);
      const shown = showableChange(declaration, computed);
      // The rest of what this one operation writes, in the same snapshot and
      // under the same lock as `from`: a role's model re-derives the harness and
      // the level, and the card names both rather than leaving the user to
      // approve what it does not display.
      const alsoChanges = operation.alsoChanges?.(deps.operations, target, computed.proposedValue) ?? [];
      for (const side of alsoChanges) {
        requireShowable(declaration, `current ${side.label}`, side.from);
        requireShowable(declaration, `proposed ${side.label}`, side.to);
      }
      return {
        change: computed,
        shown,
        alsoChanges,
        baseline: await requireBaseline(deps, resolved),
      };
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
      from: shown.from,
      to: shown.to,
      ...(shown.textChange ? { textChange: shown.textChange } : {}),
      alsoChanges,
      fromValue: change.fromValue,
      proposedValue: change.proposedValue,
      baseline,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  );
}
