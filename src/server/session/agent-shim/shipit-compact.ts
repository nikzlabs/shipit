// docs/324-agent-requested-compaction — the agent compacts its own context after its turn.
import { AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS } from "../../shared/compaction-threshold.js";
import { fail, parseFlags, success } from "./shim-common.js";
import { formatError, REJECTED_HELP, type RunDeps } from "./shipit.js";

const MINIMUM = AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS.toLocaleString("en-US");

export const COMPACT_USAGE = `shipit compact [INSTRUCTIONS] [--note "TEXT"] [--user-asked] [--json]

Compacts YOUR context after this turn ends — for example when you finish one
feature and start the next. INSTRUCTIONS say what the compaction must keep from
the conversation: decisions, the plan, what the user told you in chat. Do not
repeat your system prompt — ShipIt's instructions and the user's own
instructions — in them: every turn carries it, and a compaction does not touch it.
With --note, ShipIt gives you a new turn after the compaction with the note,
and you continue. Without one, the session waits for the user's next message.
After a compaction, your next turn starts with your INSTRUCTIONS, word for word.

ShipIt compacts only a context of ${MINIMUM} tokens or more, measured when this
turn ends. Under that, nothing is compacted, your next turn says so, and a
--note still gives you that turn.

When the USER asks you to compact your context, run this command yourself with
--user-asked; never tell them to type /compact. A compaction the user asked for
runs at any size, as their own /compact does. Use --user-asked only then.

  shipit compact 'Keep the API contract for /orders that we agreed on' \\
    --note 'Start feature B: the CSV export.'

A later call in the same turn replaces the earlier one. The harness's own
automatic compaction is not affected.

The command needs the user's setting 'advanced.agentCompaction', which is off
by default; while it is off, the command is refused. Read it with
'shipit settings get advanced.agentCompaction'. See /shipit-docs/sessions.md.`;

export async function handleCompact(args: string[], deps: RunDeps): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    success(deps.io, COMPACT_USAGE);
    return;
  }
  const parsed = parseFlags(args, {
    values: { "--note": "note", "-n": "note" },
    booleans: { "--json": "json", "--user-asked": "userAsked" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit compact: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const instructions = parsed.positional.join(" ").trim();
  const note = parsed.values.note?.trim();
  const userAsked = parsed.booleans.has("userAsked");
  if (parsed.values.note !== undefined && !note) {
    fail(deps.io, "shipit compact: --note is empty. Leave it out to wait for the user after the compaction.");
  }

  const res = await deps.call(
    "POST",
    "/agent-ops/compact",
    {
      ...(instructions ? { instructions } : {}),
      ...(note ? { note } : {}),
      ...(userAsked ? { userAsked: true } : {}),
    },
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
  const handBack = instructions ? "; after a compaction, it starts with your instructions, word for word" : "";
  const then = note
    ? `ShipIt gives you a new turn with your note${handBack}.`
    : `the session waits for the user's next message${handBack}.`;
  success(
    deps.io,
    [
      "compact: requested",
      "when:    after this turn ends. Nothing is compacted while you are still working.",
      userAsked
        ? "minimum: none — the user asked for this compaction."
        : `minimum: ${MINIMUM} tokens of context when this turn ends. Under that, nothing is compacted.`,
      `then:    ${then}`,
      "now:     finish this piece of work and end your turn. Say in your reply that you asked for a compaction and why.",
    ].join("\n"),
  );
}
