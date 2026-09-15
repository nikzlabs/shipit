import { asString, fail, parseFlags, readBodyFromFileOrStdin, success } from "./shim-common.js";
import {
  proposalPhaseGuidance,
  proposalPhaseHeadline,
} from "../../shared/settings-proposal-guidance.js";
import { renderOwn, renderValue } from "../../shared/settings-catalogue/rendered.js";
import { REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

// ShipIt's own settings from inside a session (docs/299-agent-settings-access):
// `list` indexes what the agent may see, `get` details one of them (req 1), and
// `propose` posts the card whose click is the only way a setting moves (req 4).

interface SettingEntry {
  key: string;
  label: string;
  summary: string;
  tab: string;
  scope: string;
  display: string;
  readable: boolean;
  unreadableReason?: string;
  propose?: { allowed?: boolean; refusal?: string; explanation?: string };
  effect?: { state?: string; detail?: string };
  address?: { kind?: string; noun?: string };
  notes?: string[];
}

/**
 * What the user last did about this setting, from any session
 * (docs/299-agent-settings-access req 8).
 *
 * Rendered in the TEXT output and not only in `--json`: the next-turn notice
 * deliberately carries no values and sends the agent here, so a phase visible
 * only to `--json` would leave plain `get` unable to answer the one question the
 * notice asked it to — whether the user has already dealt with this change.
 */
interface LastProposal {
  cardId?: string;
  phase?: string;
  operation?: string;
  item?: string;
  /** Both already one line: the read renders them. See {@link proposalValue}. */
  from?: string;
  proposed?: string;
  proposedAt?: string;
  resolvedAt?: string;
  sessionId?: string;
}

/** One addressed instance of a per-item setting; `get` carries them, `list` names them. */
interface SettingItem {
  address?: string;
  display?: string;
  notes?: string[];
  lastProposal?: LastProposal;
}

/**
 * A value the read has already rendered, or a note that it recorded none.
 *
 * Every field of a settings response that becomes a LINE here — `display`, an
 * item's `address`, a proposal's `from` and `proposed`, a card's `from` and
 * `to`, and every note, label, summary, description and effect detail — leaves
 * the orchestrator as `Rendered` (planning#577), so re-rendering it here would
 * quote what is already quoted. The rule this shim follows is: **it renders what
 * it composes itself, and trusts what the read sent.** What it composes itself
 * is the `--item` echo below and the two JSON blobs in `get`, which arrive as
 * objects the read did not put on a line.
 */
function proposalValue(value: string | undefined): string {
  return value ? value : "(not recorded)";
}

/**
 * The last proposal about one target, indented under whatever it belongs to.
 * Empty when there is none — a setting nobody has proposed a change to says
 * nothing about proposals.
 */
function proposalLines(proposal: LastProposal | undefined, indent: string): string[] {
  if (!proposal) return [];
  const phase = asString(proposal.phase);
  const card = asString(proposal.cardId);
  const lines = [
    `${indent}Last proposal: ${proposalPhaseHeadline(phase)}${card ? ` (card ${card})` : ""}`,
  ];
  const change = `${proposalValue(proposal.from)} → ${proposalValue(proposal.proposed)}`;
  const when = proposal.proposedAt ? ` on ${asString(proposal.proposedAt)}` : "";
  const resolved = proposal.resolvedAt ? `, resolved ${asString(proposal.resolvedAt)}` : "";
  const operation = proposal.operation ? `${asString(proposal.operation)}: ` : "";
  lines.push(`${indent}  ${operation}${change}${when}${resolved}`);
  const guidance = proposalPhaseGuidance(phase);
  if (guidance) lines.push(`${indent}  ${guidance}`);
  return lines;
}

function itemLines(entry: SettingEntry & { items?: SettingItem[] }): string[] {
  const items = entry.items;
  if (!items) return [];
  const noun = asString(entry.address?.noun) || "an item";
  if (items.length === 0) return ["", `No instances of this setting exist (one per ${noun}).`];
  const lines = ["", `${items.length} instance${items.length === 1 ? "" : "s"}, addressed by ${noun}:`];
  for (const item of items) {
    lines.push(`  ${asString(item.address)} = ${asString(item.display)}`);
    for (const note of item.notes ?? []) lines.push(`      ${note}`);
    lines.push(...proposalLines(item.lastProposal, "      "));
  }
  return lines;
}

function effectMarker(entry: SettingEntry): string {
  const state = entry.effect?.state;
  if (!state) return "";
  // An unreadable entry already says why on the value line; repeating it as an
  // effect marker makes the index unreadable for the reader, not just for ShipIt.
  if (!entry.readable) return "";
  const detail = entry.effect?.detail ? ` — ${entry.effect.detail}` : "";
  // A `live` setting normally has nothing to add, and marking every one of them
  // would bury the settings that do. But `live` WITH a detail means the stored
  // value is what the next use reads and that use fails — an install refusing to
  // start a contained session is the case — so the detail is the whole point and
  // dropping it left the text output saying the opposite of the JSON.
  if (state === "live") return detail ? `  [${entry.effect?.detail}]` : "";
  return `  [${state}${detail}]`;
}

function refusalLine(entry: SettingEntry): string | null {
  const refusal = entry.propose?.refusal;
  if (!refusal) return null;
  const explanation = entry.propose?.explanation ? ` ${entry.propose.explanation}` : "";
  return `Cannot be changed on your behalf (${refusal}).${explanation}`;
}

export async function handleSettingsList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tab": "tab" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit settings list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const tab = parsed.values.tab;
  const query = tab ? `?tab=${encodeURIComponent(tab)}` : "";
  const res = await deps.call("GET", `/agent-ops/settings/list${query}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list ShipIt settings"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }

  const settings = (res.body.settings as SettingEntry[] | undefined) ?? [];
  const tabs = (res.body.tabs as string[] | undefined) ?? [];
  if (settings.length === 0) {
    success(deps.io, `No ShipIt settings matched. Tabs with settings: ${tabs.join(", ") || "none"}.`);
    return;
  }

  const lines: string[] = [];
  let currentTab = "";
  for (const entry of settings) {
    if (entry.tab !== currentTab) {
      currentTab = entry.tab;
      if (lines.length > 0) lines.push("");
      lines.push(`${currentTab}:`);
    }
    const value = entry.readable ? entry.display : `unreadable (${asString(entry.unreadableReason)})`;
    lines.push(`  ${entry.key} = ${value}${effectMarker(entry)}`);
    lines.push(`      ${entry.label} — ${entry.summary}`);
  }

  success(
    deps.io,
    [
      ...lines,
      "",
      `Tabs: ${tabs.join(", ")}. Narrow with --tab NAME.`,
      "Read one in full — its whole description, the values it accepts, and what it",
      "resolves to right now — with: shipit settings get <key>",
    ].join("\n"),
  );
}

/**
 * `propose` — one card, one change, and the user's click is what moves the
 * setting (docs/299-agent-settings-access req 4).
 *
 * The value is sent as TEXT and read against the setting's declared type on the
 * server. The shim deliberately does not guess: `roles[].description=true` is
 * the word "true" for a text setting and a boolean for a toggle, and only the
 * declaration knows which.
 */
export async function handleSettingsPropose(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--item": "item",
      "--reason": "reason",
      "--add": "add",
      "--remove": "remove",
      "--value-file": "valueFile",
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit settings propose: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const add = parsed.values.add;
  const remove = parsed.values.remove;
  if (add !== undefined && remove !== undefined) {
    fail(deps.io, "shipit settings propose: --add and --remove are one change each, so pass one of them.");
  }
  const valueFile = parsed.values.valueFile;
  const first = parsed.positional[0] ?? "";
  const eq = first.indexOf("=");
  const key = eq === -1 ? first : first.slice(0, eq);
  if (!key) {
    fail(
      deps.io,
      "shipit settings propose: name the setting and the value, e.g.\n"
        + "  shipit settings propose advanced.enableSubAgents=true --reason \"why this unblocks the work\"\n"
        + "  shipit settings propose network.egress.hosts[].host --add registry.npmjs.org --reason \"…\"\n"
        + "  shipit settings propose instructions.userInstructions --value-file - --reason \"…\" <<'EOF'\n"
        + "`shipit settings get <key>` is where the values it accepts are.",
    );
  }
  const list = add ?? remove;
  // Prose does not fit in one shell word, so a long value arrives the way every
  // other body in this CLI does — on stdin or from a file
  // (docs/299-agent-settings-access req 9).
  if (valueFile !== undefined && (eq !== -1 || list !== undefined)) {
    fail(
      deps.io,
      "shipit settings propose: --value-file is the value, so pass the key on its own and no "
        + "--add/--remove.",
    );
  }
  if (eq === -1 && list === undefined && valueFile === undefined) {
    fail(
      deps.io,
      `shipit settings propose: ${key} needs a value — pass ${key}=<value>, `
        + `${key} --value-file - for prose, or --add/--remove for a list entry.`,
    );
  }
  const fromFile = valueFile === undefined
    ? undefined
    : await readBodyFromFileOrStdin(valueFile, deps.io, "shipit settings propose", "value file");
  if (!parsed.values.reason) {
    fail(
      deps.io,
      "shipit settings propose: --reason is required. The user sees it on the card, in your words, "
        + "so say what the change unblocks.",
    );
  }

  const body: Record<string, unknown> = {
    key,
    reason: parsed.values.reason,
    ...(list !== undefined
      ? { operation: add !== undefined ? "add" : "remove", item: list }
      : {
          valueText: fromFile ?? first.slice(eq + 1),
          ...(parsed.values.item ? { item: parsed.values.item } : {}),
        }),
  };

  const res = await deps.call("POST", "/agent-ops/settings/propose", body, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, `Failed to propose a change to ${key}`), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const card = (res.body.card ?? {}) as {
    cardId?: string;
    label?: string;
    path?: string;
    from?: string;
    to?: string;
    target?: { item?: string };
  };
  success(
    deps.io,
    [
      // The item is the address THIS call supplied, not something the read
      // rendered, so it is flattened here before it goes on a line.
      `Proposed: ${asString(card.label) || key}${
        card.target?.item ? ` · ${renderOwn(card.target.item)}` : ""}`
        + ` — ${asString(card.from)} → ${asString(card.to)}`,
      `Card ${asString(card.cardId)} is in the chat, under ${asString(card.path)}.`,
      "",
      "Nothing has changed yet: the user applies or dismisses it with one click. Do not wait for",
      "that, do not post the same card again, and do not also tell the user which control to find —",
      "the card is the affordance. `shipit settings get` reports what became of it.",
    ].join("\n"),
  );
}

export async function handleSettingsGet(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { values: {}, booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit settings get: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const key = parsed.positional[0];
  if (!key) {
    fail(
      deps.io,
      "shipit settings get: name the setting to read, e.g. `shipit settings get advanced.enableSubAgents`.\n"
        + "`shipit settings list` is the index of every key.",
    );
  }

  const res = await deps.call(
    "GET",
    `/agent-ops/settings/get?key=${encodeURIComponent(key)}`,
    undefined,
    deps.env,
  );
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, `Failed to read ShipIt setting ${key}`), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }

  const entry = res.body as unknown as SettingEntry & {
    description?: string;
    valueType?: string;
    shape?: Record<string, unknown>;
    proposeMaxLength?: number;
    proposeMaxLines?: number;
    live?: Record<string, unknown>;
    items?: SettingItem[];
    lastProposal?: LastProposal;
  };
  const lines = [
    `${entry.key} — ${entry.label}`,
    `Tab: ${entry.tab} · Scope: ${entry.scope} · Type: ${asString(entry.valueType)}`,
    entry.readable
      ? `Value: ${entry.display}`
      : `Value: unreadable (${asString(entry.unreadableReason)})`,
  ];
  const state = entry.effect?.state;
  const detail = entry.effect?.detail ? `: ${entry.effect.detail}` : "";
  // With no value there is nothing for an effect line to be about.
  if (entry.readable) {
    if (state === "live") {
      // The detail is not optional trimming here: `live` carries one only when
      // the next use of the stored value FAILS, and saying "yes" on its own
      // would tell the user the opposite of what ShipIt just computed.
      lines.push(`In effect: yes — the stored value is what ShipIt uses next.${
        entry.effect?.detail ? ` ${entry.effect.detail}` : ""}`);
    } else if (state === "uncertain") {
      // ShipIt said it could not confirm the effect, which is not the same as
      // saying the setting has none. Do not tell the user it is not working.
      lines.push(`In effect: UNCONFIRMED — ShipIt cannot tell${detail}`);
    } else if (state) {
      lines.push(`In effect: NO — ${state}${detail}`);
    }
  }
  if (entry.address?.kind === "item" || entry.address?.kind === "repository-item") {
    lines.push(`Exists once per item, addressed by ${asString(entry.address.noun) || "an item id"}.`);
  } else if (entry.address?.kind === "repository") {
    lines.push("Exists once per repository — this session's own, never another.");
  }
  const refusal = refusalLine(entry);
  if (refusal) lines.push(refusal);
  lines.push(...proposalLines(entry.lastProposal, ""));
  lines.push("", asString(entry.description));
  lines.push(...itemLines(entry));
  if (entry.shape && Object.keys(entry.shape).length > 0) {
    lines.push("", `Accepts: ${renderValue(entry.shape)}`);
  }
  // The dialog's box and the card answer different questions, so the smaller of
  // the two is said out loud rather than left to a refusal
  // (docs/299-agent-settings-access req 9). BOTH bounds, because the card
  // enforces both and the combined one is the one an agent will get wrong.
  if (typeof entry.proposeMaxLength === "number") {
    lines.push(
      "",
      `A proposal card carries at most ${entry.proposeMaxLength.toLocaleString("en-US")} characters `
        + "of this, per version. Longer than that is the user's own edit, not a one-click approval — "
        + "pass a long value with `--value-file -`.",
    );
  }
  if (typeof entry.proposeMaxLines === "number") {
    lines.push(
      "",
      `A proposal card carries at most ${entry.proposeMaxLines.toLocaleString("en-US")} lines for the `
        + "change as a whole: the current value's lines PLUS the proposed value's, added together, not "
        + "each on its own. A change can be well inside the character limit and over this one.",
    );
  }
  if (entry.live && Object.keys(entry.live).length > 0) {
    lines.push("", `Resolved now: ${renderValue(entry.live)}`);
  }
  for (const note of new Set(entry.notes ?? [])) lines.push("", `Note: ${note}`);

  success(deps.io, lines.join("\n"));
}
