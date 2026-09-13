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
  notes?: string[];
}

function effectMarker(entry: SettingEntry): string {
  const state = entry.effect?.state;
  if (!state || state === "live") return "";
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
  };
  const lines = [
    `${entry.key} — ${entry.label}`,
    `Tab: ${entry.tab} · Scope: ${entry.scope} · Type: ${asString(entry.valueType)}`,
    entry.readable
      ? `Value: ${entry.display}`
      : `Value: unreadable (${asString(entry.unreadableReason)})`,
  ];
  const state = entry.effect?.state;
  if (state && state !== "live") {
    lines.push(`In effect: NO — ${state}${entry.effect?.detail ? `: ${entry.effect.detail}` : ""}`);
  } else if (state === "live") {
    lines.push("In effect: yes — the stored value is what ShipIt uses next.");
  }
  const refusal = refusalLine(entry);
  if (refusal) lines.push(refusal);
  lines.push("", asString(entry.description));
  if (entry.shape && Object.keys(entry.shape).length > 0) {
    lines.push("", `Accepts: ${JSON.stringify(entry.shape)}`);
  }
  if (entry.live && Object.keys(entry.live).length > 0) {
    lines.push("", `Resolved now: ${JSON.stringify(entry.live)}`);
  }
  for (const note of entry.notes ?? []) lines.push("", `Note: ${note}`);

  success(deps.io, lines.join("\n"));
}
