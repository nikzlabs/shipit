import { asString, fail, parseFlags, success } from "./shim-common.js";
import { REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

// Reading ShipIt's own settings from inside a session (docs/299-agent-settings-access
// req 1): `list` indexes what the agent may see, `get` details one of them.

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

/** One addressed instance of a per-item setting; `get` carries them, `list` names them. */
interface SettingItem {
  address?: string;
  display?: string;
  notes?: string[];
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
  }
  return lines;
}

function effectMarker(entry: SettingEntry): string {
  const state = entry.effect?.state;
  if (!state || state === "live") return "";
  // An unreadable entry already says why on the value line; repeating it as an
  // effect marker makes the index unreadable for the reader, not just for ShipIt.
  if (!entry.readable) return "";
  const detail = entry.effect?.detail ? ` — ${entry.effect.detail}` : "";
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
    live?: Record<string, unknown>;
    items?: SettingItem[];
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
      lines.push("In effect: yes — the stored value is what ShipIt uses next.");
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
  lines.push("", asString(entry.description));
  lines.push(...itemLines(entry));
  if (entry.shape && Object.keys(entry.shape).length > 0) {
    lines.push("", `Accepts: ${JSON.stringify(entry.shape)}`);
  }
  if (entry.live && Object.keys(entry.live).length > 0) {
    lines.push("", `Resolved now: ${JSON.stringify(entry.live)}`);
  }
  for (const note of new Set(entry.notes ?? [])) lines.push("", `Note: ${note}`);

  success(deps.io, lines.join("\n"));
}
