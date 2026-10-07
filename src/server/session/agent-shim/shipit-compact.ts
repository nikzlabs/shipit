// docs/324-agent-requested-compaction — the agent compacts its own context after its turn.
import { fail, parseFlags, success } from "./shim-common.js";
import { formatError, REJECTED_HELP, type RunDeps } from "./shipit.js";

export const COMPACT_USAGE = `shipit compact [INSTRUCTIONS] [--note "TEXT"] [--json]

Compacts YOUR context after this turn ends — for example when you finish one
feature and start the next. INSTRUCTIONS say what the compaction must keep.
With --note, ShipIt gives you a new turn after the compaction with the note,
and you continue. Without one, the session waits for the user's next message.
Either way, your next turn starts with your INSTRUCTIONS, word for word.

  shipit compact 'Keep the API contract for /orders and the naming rules the user set' \\
    --note 'Start feature B: the CSV export.'

A later call in the same turn replaces the earlier one. The harness's own
automatic compaction is not affected. See /shipit-docs/sessions.md.`;

export async function handleCompact(args: string[], deps: RunDeps): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    success(deps.io, COMPACT_USAGE);
    return;
  }
  const parsed = parseFlags(args, {
    values: { "--note": "note", "-n": "note" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit compact: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const instructions = parsed.positional.join(" ").trim();
  const note = parsed.values.note?.trim();
  if (parsed.values.note !== undefined && !note) {
    fail(deps.io, "shipit compact: --note is empty. Leave it out to wait for the user after the compaction.");
  }

  const res = await deps.call(
    "POST",
    "/agent-ops/compact",
    { ...(instructions ? { instructions } : {}), ...(note ? { note } : {}) },
    deps.env,
  );
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to request the compaction"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const then = note
    ? `ShipIt gives you a new turn with your note${instructions ? " and your instructions, word for word" : ""}.`
    : `the session waits for the user's next message${instructions ? "; that turn starts with your instructions, word for word" : ""}.`;
  success(
    deps.io,
    [
      "compact: requested",
      "when:    after this turn ends. Nothing is compacted while you are still working.",
      `then:    ${then}`,
      "now:     finish this piece of work and end your turn. Say in your reply that you compact and why.",
    ].join("\n"),
  );
}
