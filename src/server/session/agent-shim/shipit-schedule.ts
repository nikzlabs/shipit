import { asString, parseFlags } from "./shim-common.js";
import { renderLine, renderValue, type Rendered } from "../../shared/settings-catalogue/rendered.js";
import { rejectedHelpLines, serverErrorLines, type SettingsDeps } from "./settings-out.js";

// Scheduled sessions from inside a session (docs/324-scheduled-sessions reqs 8, 9): `list` shows
// the schedules with their ids, and `propose` posts the card the user confirms. Output goes
// through the same printer as `shipit settings`, which takes rendered lines only, because names,
// prompts and repository URLs are stored text.

interface ScheduleEntry {
  id?: string;
  name?: string;
  enabled?: boolean;
  when?: string;
  timeZone?: string;
  target?: string | null;
  grants?: string;
  params?: { label?: string; value?: string }[];
  prompt?: string | null;
  nextRuns?: string[];
  needsUserReason?: string;
}

function entryLines(entry: ScheduleEntry): Rendered[] {
  const lines = [
    renderLine(`${renderValue(asString(entry.name))} — id ${asString(entry.id)}`),
    renderLine(`  when: ${asString(entry.when)} · ${asString(entry.timeZone)} · ${entry.enabled ? "active" : "paused"}`),
    renderLine(`  target: ${entry.target ?? "(the stored description no longer reads)"}`),
  ];
  if (entry.grants) lines.push(renderLine(`  sandbox grants: ${entry.grants}`));
  const params = (entry.params ?? []).map((p) => `${asString(p.label)}: ${asString(p.value)}`);
  if (params.length > 0) lines.push(renderLine(`  params: ${params.join(" · ")}`));
  if (entry.prompt) lines.push(renderLine(`  prompt: ${renderValue(entry.prompt)}`));
  if (entry.nextRuns?.length) lines.push(renderLine(`  next runs (UTC): ${entry.nextRuns.join(", ")}`));
  if (entry.needsUserReason) lines.push(renderLine(`  needs the user: ${renderValue(entry.needsUserReason)}`));
  return lines;
}

export async function handleScheduleList(args: string[], deps: SettingsDeps): Promise<void> {
  const parsed = parseFlags(args, { values: {}, booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    deps.out.fail([
      renderLine(`Unsupported flag for shipit schedule list: ${asString(parsed.unsupported[0])}`),
      ...rejectedHelpLines(),
    ]);
  }
  const res = await deps.call("GET", "/agent-ops/schedules", undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    deps.out.fail(serverErrorLines(res, "Failed to list the schedules"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.out.json(res.body);
    return;
  }
  const schedules = (res.body.schedules as ScheduleEntry[] | undefined) ?? [];
  if (schedules.length === 0) {
    deps.out.lines([
      renderLine("No schedules yet. Propose one with `shipit schedule propose --file -`;"),
      renderLine("/shipit-docs/schedules.md has the YAML."),
    ]);
    return;
  }
  const lines: Rendered[] = [renderLine(`${schedules.length} schedule${schedules.length === 1 ? "" : "s"}:`)];
  for (const entry of schedules) lines.push(renderLine(""), ...entryLines(entry));
  deps.out.lines([
    ...lines,
    renderLine(""),
    renderLine("Change one with `shipit schedule propose --id <id> --file -`, giving only the fields that"),
    renderLine("change. The user confirms every proposal on its card; see /shipit-docs/schedules.md."),
  ]);
}

/**
 * `propose` — one card, and the user's Confirm is what saves the schedule (req 9). The YAML is
 * sent as text and read on the server, so the checks and their refusals are the ones Settings uses.
 */
export async function handleSchedulePropose(args: string[], deps: SettingsDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--id": "id", "--file": "file" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0 || parsed.positional.length > 0) {
    const what = parsed.unsupported[0] ?? parsed.positional[0];
    deps.out.fail([
      renderLine(`Unsupported argument for shipit schedule propose: ${asString(what)}`),
      ...rejectedHelpLines(),
    ]);
  }
  const file = parsed.values.file;
  if (!file) {
    deps.out.fail([
      renderLine("shipit schedule propose: pass the schedule as YAML with --file - (stdin) or --file PATH, e.g."),
      renderLine("  shipit schedule propose --file - <<'EOF'"),
      renderLine("  name: Security PRs"),
      renderLine("  when: weekdays 09:00"),
      renderLine("  target: { repo: https://github.com/owner/repo }"),
      renderLine("  prompt: Check current security PRs and merge them."),
      renderLine("  EOF"),
      renderLine("/shipit-docs/schedules.md has every field."),
    ]);
  }
  const text = await deps.out.readBody(file, "shipit schedule propose", "proposal file");
  const id = parsed.values.id;
  const res = await deps.call("POST", "/agent-ops/schedules/propose", { text, ...(id ? { id } : {}) }, deps.env);
  if (res.status < 200 || res.status >= 300) {
    deps.out.fail(serverErrorLines(res, "Failed to propose the schedule"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.out.json(res.body);
    return;
  }
  const card = (res.body.card ?? {}) as { cardId?: string; kind?: string; name?: string; scheduleId?: string };
  const what = card.kind === "update"
    ? `a change to schedule ${renderValue(asString(card.name))} (id ${asString(card.scheduleId)})`
    : `a new schedule ${renderValue(asString(card.name))}`;
  deps.out.lines([
    renderLine(`Proposed: ${what}. Card ${asString(card.cardId)} is in the chat.`),
    renderLine(""),
    renderLine("Nothing is saved yet: the schedule takes effect only when the user confirms the card. Do"),
    renderLine("not wait for that, do not post the same card again, and do not tell the user which control"),
    renderLine("to find — the card is the affordance. `shipit schedule list` shows the schedules as they are."),
  ]);
}
