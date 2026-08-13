/**
 * `shipit plugin` handlers — docs/262 req 12.
 *
 * One verb: `refresh`. A plugin repository is declared with a tracked branch,
 * and until now the only things that re-activated it were a `shipit.yaml` edit
 * and the session opening. An agent that has just pushed a fix to the plugin
 * repository had no way to pull it — which is the whole point of tracking a
 * branch.
 *
 * A separate `list`/`status` command was reviewed out of the design: the
 * Plugins tab and `SHIPIT_PLUGIN_COMMIT` already answer "what is live", and a
 * refresh prints before/after anyway.
 *
 * **Transport** (plan §2): through the worker's `/agent-ops` surface, like
 * `shipit issue` and the `gh` shim — not the browser's `/api/plugin-repos`,
 * which is a snapshot GET that must never activate anything, and not a direct
 * orchestrator call, which containers are default-denied
 * (`api-container-guard.ts`).
 *
 * The call is UNBOUNDED (`call(..., 0)`), the same transport `shipit service
 * start` uses: a refresh fetches a repository, checks out a generation and can
 * run that plugin's install, so a default deadline would abort a refresh that
 * is still working and report a failure that did not happen.
 */

import { asString, fail, parseFlags, readStdin, success } from "./shim-common.js";
import { formatError, type RunDeps } from "./shipit.js";

/** One repository's before/after, as the orchestrator reports it. */
interface RefreshRow {
  repo: string;
  ref: string;
  before: string | null;
  after: string | null;
  status: string;
  detail?: string;
}

function toRow(value: unknown): RefreshRow {
  const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    repo: asString(obj.repo),
    ref: asString(obj.ref),
    before: typeof obj.before === "string" ? obj.before : null,
    after: typeof obj.after === "string" ? obj.after : null,
    status: asString(obj.status) || "unknown",
    detail: asString(obj.detail) || undefined,
  };
}

const HELP = `Usage: shipit plugin refresh [repo-name] [--json]

Bring a declared plugin repository to its declared version now — the same
activation a shipit.yaml edit runs, awaited, with before/after commits.

With no name, every declared repository is refreshed.

  shipit plugin exec --alias <alias> --command <name> [-- args...]

Run one imported plugin's companion CLI (docs/262 req 17). You do not normally
type this: each surfaced command has a generated wrapper on PATH that calls it,
and the wrapper's name is what a plugin's docs tell you to run.`;

export async function runPlugin(args: string[], deps: RunDeps): Promise<void> {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help" || action === "-h") {
    success(deps.io, HELP);
    return;
  }
  if (action === "exec") {
    await exec(rest, deps);
    return;
  }
  if (action !== "refresh") {
    fail(deps.io, `Unknown \`shipit plugin\` action \`${action}\`.\n\n${HELP}`);
  }
  await refresh(rest, deps);
}

/**
 * `shipit plugin exec` — docs/262 req 17, the other end of a generated wrapper
 * (`session/plugin-cli.ts`).
 *
 * The command itself runs in an invocation container the orchestrator builds;
 * this process only carries the call. That is the whole point of the wrapper:
 * plugin code never runs in the agent container, where the worker's loopback
 * credential broker is reachable (plan §2, "CLIs" — the same boundary
 * `install` has).
 *
 * Three things travel with the call and nothing else does. The **argv after
 * `--`**, verbatim: a plugin's own flags must not be interpreted here, so the
 * separator is honored before any parsing. The **working directory**, so a
 * cwd-addressed tool behaves as it would if it had run beside the agent — the
 * orchestrator re-roots it under `/project`. And **stdin**, when there is any,
 * so `--body-file -` works the way it does for every other shim.
 */
async function exec(args: string[], deps: RunDeps): Promise<void> {
  // The separator FIRST: everything after it is the plugin's, including things
  // that look like our own flags (`--json`, `--alias`). A wrapper always emits
  // it, so its absence just means the caller passed no arguments.
  const sep = args.indexOf("--");
  const own = sep === -1 ? args : args.slice(0, sep);
  const passthrough = sep === -1 ? [] : args.slice(sep + 1);

  const { values, unsupported, positional } = parseFlags(own, {
    values: { "--alias": "alias", "--command": "command" },
  });
  if (unsupported.length > 0 || positional.length > 0) {
    fail(deps.io, `Unsupported argument for \`shipit plugin exec\`: ${unsupported[0] ?? positional[0]}\n\n${HELP}`);
  }
  if (!values.alias || !values.command) {
    fail(deps.io, `\`shipit plugin exec\` needs \`--alias\` and \`--command\`.\n\n${HELP}`);
  }

  const res = await deps.call(
    "POST",
    "/agent-ops/plugin/exec",
    {
      alias: values.alias,
      command: values.command,
      args: passthrough,
      cwd: process.cwd(),
      stdin: await readOptionalStdin(),
    },
    deps.env,
    // Unbounded, like refresh: a companion CLI is a real program and may run
    // for minutes. A deadline here would kill a call whose container is still
    // working and report a failure that did not happen.
    0,
  );

  // A transport or authorization failure is ShipIt's, not the plugin's, so it
  // is reported as one rather than folded into the command's own output.
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, `Could not run \`${values.command}\`.`));
  }

  // From here the shim is a pipe: the plugin's own streams and its own exit
  // code, unchanged. Nothing is appended — a caller parsing the output must
  // see exactly what the command wrote.
  if (typeof res.body.stdout === "string" && res.body.stdout) deps.io.stdout(res.body.stdout);
  if (typeof res.body.stderr === "string" && res.body.stderr) deps.io.stderr(res.body.stderr);
  const code = typeof res.body.exitCode === "number" ? res.body.exitCode : 1;
  deps.io.exit(code);
}

/**
 * Whatever is piped in, or the empty string.
 *
 * A short idle deadline rather than the shim default: this runs on EVERY
 * companion-CLI call, and the overwhelmingly common case is a caller with no
 * stdin at all. A closed pipe or `/dev/null` reaches EOF immediately, so the
 * deadline only ever fires for an inherited pipe nobody writes to — where
 * waiting fifteen seconds to send an empty string would be a hang the agent
 * cannot explain. Once any byte arrives the deadline is off, so a large
 * heredoc is never clipped.
 */
async function readOptionalStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    return await readStdin(process.stdin, 2000);
  } catch {
    return "";
  }
}

async function refresh(args: string[], deps: RunDeps): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    success(deps.io, HELP);
    return;
  }
  const { positional, booleans, unsupported } = parseFlags(args, { booleans: { "--json": "json" } });
  // A typo must not silently refresh EVERY repository — the agent asked for
  // something specific and would be told it worked (review finding). Every
  // other shim command rejects these; this one had simply ignored the field.
  if (unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for \`shipit plugin refresh\`: ${unsupported[0]}\n\n${HELP}`);
  }
  if (positional.length > 1) {
    fail(deps.io, `Expected at most one repository name, got ${positional.length}.\n\n${HELP}`);
  }
  const repo = positional[0];

  const res = await deps.call(
    "POST",
    "/agent-ops/plugin/refresh",
    repo ? { repo } : {},
    deps.env,
    0,
  );
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Could not refresh the plugin repositories."));
  }

  const rows = Array.isArray(res.body.rows) ? res.body.rows.map(toRow) : [];
  const text = booleans.has("json")
    ? JSON.stringify({ rows }, null, 2)
    : rows.length === 0
      ? "This project declares no tracked plugin repositories."
      : rows.map(describe).join("\n");

  // A failed refresh exits non-zero but is never an exception: req 15 keeps the
  // prior generation live, so the session still works — what the agent needs to
  // know is that it is working against the OLD version.
  if (rows.some((r) => r.status === "failed")) fail(deps.io, text, 1);
  success(deps.io, text);
}

/** One human-readable line per repository. */
function describe(row: RefreshRow): string {
  const short = (commit: string | null): string => (commit ? commit.slice(0, 9) : "none");
  const head = `${row.repo} (${row.ref})`;
  if (row.status === "failed") {
    // Naming the still-live commit matters more than naming the failure: it is
    // what the session is actually running.
    const live = row.after ? ` — still on ${short(row.after)}` : "";
    return `${head}: refresh failed${live}\n  ${row.detail ?? "no reason reported"}`;
  }
  if (row.status === "unchanged") {
    return `${head}: already at ${short(row.after)}${row.detail ? `\n  ${row.detail}` : ""}`;
  }
  return `${head}: ${short(row.before)} → ${short(row.after)}${row.detail ? `\n  ${row.detail}` : ""}`;
}
