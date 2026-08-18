/**
 * `shipit plugin` handlers — docs/262 req 12.
 *
 * One verb: `refresh`. A plugin repository is declared with a tracked branch,
 * and until now the only things that re-activated it were a `shipit.yaml` edit
 * and the session opening. An agent that has just pushed a fix to the plugin
 * repository had no way to pull it — which is the whole point of tracking a
 * branch.
 *
 * **`status` was once reviewed out of this design, and docs/266 put it back.**
 * The original reasoning — the Plugins tab and `SHIPIT_PLUGIN_COMMIT` already
 * answer "what is live" — was right about the question it asked and missed the
 * one that mattered: a session agent cannot read that tab, and "what is live"
 * is not "is what is live usable". nikzlabs/shipit#2323 is the cost. A consuming
 * project ran a version whose install had left nothing behind; refresh exited 0
 * and said `unchanged`, the card said `active`, every surface failed, and the
 * plugin's author could not tell a failed install from a successful one that
 * produced the wrong tree. They guessed, shipped the wrong fix, and had it
 * confirmed by a coincidence. `status` reports the same reasons the card shows,
 * plus the one no card holds: what the last install actually did.
 *
 * **A SUCCESSFUL install's output rides `--json` on both verbs** (planning#416).
 * The failed half was already reachable — the tail is in the failure reason,
 * which reaches the refresh row's `detail` and the degraded card. The successful
 * half reached a browser panel and nothing else, which is why
 * nikzlabs/shipit#2315's central question ("does non-`dep-dirs` install output
 * survive?") could not be answered from inside a session at all: the reporter and
 * an independent reviewer read the same documentation and concluded the opposite,
 * and it was settled by reading orchestrator source that a session on an ordinary
 * project cannot see. It is a flag on verbs that already exist rather than a
 * `logs` verb, because a second call only occurs to someone who already suspects
 * the install — and the reader who needs this does not yet.
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
  /** docs/266-plugin-install-diagnosability req 7 — why the version live NOW is unusable, if it is. */
  degraded: string[];
  /** docs/266 reqs 5, 6 — this round re-installed the version already live. */
  reinstalled: boolean;
  /** planning#416 — the last install for this repository, output included. */
  install?: InstallRecordView;
}

/**
 * The last install attempt, as `--json` reports it (planning#416).
 *
 * `output` is the one field that is new to this shim, and it is the reason the
 * whole record rides the row: an install that SUCCEEDED and produced the wrong
 * tree is the case a session could not diagnose at all, and "succeeded" alone
 * does not distinguish it from one that produced the right one.
 */
interface InstallRecordView {
  commit: string;
  at: string;
  outcome: string;
  detail?: string;
  output?: string;
}

function toRow(value: unknown): RefreshRow {
  const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const install = toInstall(obj.install);
  return {
    repo: asString(obj.repo),
    ref: asString(obj.ref),
    before: typeof obj.before === "string" ? obj.before : null,
    after: typeof obj.after === "string" ? obj.after : null,
    status: asString(obj.status) || "unknown",
    detail: asString(obj.detail) || undefined,
    degraded: Array.isArray(obj.degraded)
      ? obj.degraded.filter((d): d is string => typeof d === "string")
      : [],
    reinstalled: obj.reinstalled === true,
    ...(install ? { install } : {}),
  };
}

/**
 * Absent unless the orchestrator sent a record with the two fields that make it
 * one. A half-formed record is dropped rather than rendered with empty strings:
 * this is evidence a consumer may quote into an issue on someone else's
 * repository, and an invented `commit` there is worse than a missing field.
 */
function toInstall(value: unknown): InstallRecordView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.commit !== "string" || typeof obj.at !== "string") return undefined;
  return {
    commit: obj.commit,
    at: obj.at,
    outcome: asString(obj.outcome) || "unknown",
    ...(typeof obj.detail === "string" ? { detail: obj.detail } : {}),
    ...(typeof obj.output === "string" ? { output: obj.output } : {}),
  };
}

const HELP = `Usage: shipit plugin refresh [repo-name] [--json] [--force]

Bring a declared plugin repository to its declared version now — the same
activation a shipit.yaml edit runs, awaited, with before/after commits.

With no name, every declared repository is refreshed.

--json adds what the last install for each repository did — its outcome and the
tail of what it PRINTED, on a successful install as well as a failed one. That
is the one thing about a plugin no other surface shows you, and the answer to
"it says it installed, so what did it write?". It is a bounded tail, so read it
for what the install claimed to do rather than as a complete log.

--force re-runs the install for the version ALREADY live, for one named
repository. Use it when a version is live but unusable: it installs that commit
again instead of waiting for the plugin's author to publish a new commit. You
do not have to stop the plugin's own service first — a version something is
using is rebuilt beside it and swapped in when the install succeeds. A
re-install that fails changes nothing: the version that was live stays live,
and \`shipit plugin status\` says what the install did.

  shipit plugin status [repo-name] [--json]

Why the live version of each declared plugin repository is (or is not) usable:
the commit being executed, every problem the Plugins tab would show, and what
the last install did — with \`--json\` carrying that install's own output, the
same field refresh reports. Reads only: it fetches nothing and activates
nothing, so it is the safe first step when a plugin's surfaces are failing.

  shipit plugin exec --alias <alias> --command <name> [-- args...]

Run one imported plugin's companion CLI (docs/262 req 17). You do not normally
type this: each surfaced command has a generated wrapper on PATH that calls it,
and the wrapper's name is what a plugin's docs tell you to run.

See /shipit-docs/plugins.md for using a plugin repository — declaring one, the
read-only checkout, install, and what to read when a plugin is live but broken.
If THIS repository is the plugin (its shipit.yaml declares exports.plugins),
/shipit-docs/plugin-authoring.md covers what a consuming project does
differently.`;

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
  if (action === "status") {
    await status(rest, deps);
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
  // code, unchanged. Nothing is appended to them — a caller parsing the output
  // must see exactly what the command wrote.
  if (typeof res.body.stdout === "string" && res.body.stdout) deps.io.stdout(res.body.stdout);
  if (typeof res.body.stderr === "string" && res.body.stderr) deps.io.stderr(res.body.stderr);

  // A ShipIt REFUSAL rides a 2xx — the route always answers in the command's
  // own shape so a caller never has to tell a transport failure from a command
  // failure — so `error` has to be printed here or it is printed nowhere. It
  // was not, and the agent got exit 126 with no output at all: a stale wrapper
  // after a collision, a repository whose trust was revoked, a missing
  // generation, all silent (review finding). It goes to stderr, so it never
  // contaminates a caller parsing stdout.
  if (typeof res.body.error === "string" && res.body.error) {
    deps.io.stderr(res.body.error.endsWith("\n") ? res.body.error : `${res.body.error}\n`);
  }
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
  const { positional, booleans, unsupported } = parseFlags(args, {
    booleans: { "--json": "json", "--force": "force" },
  });
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
  const force = booleans.has("force");
  // docs/266 — refused here as well as in the service, because this is where the
  // agent can be told what to type instead. `--force` re-runs a live version's
  // install and replaces what that install left; applying that to every declared
  // repository because a name was left off is not a mistake to make reachable.
  if (force && !repo) {
    fail(
      deps.io,
      `\`--force\` needs the name of one plugin repository: \`shipit plugin refresh <name> --force\`.\n\n${HELP}`,
    );
  }

  const res = await deps.call(
    "POST",
    "/agent-ops/plugin/refresh",
    { ...(repo ? { repo } : {}), ...(force ? { force: true } : {}) },
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
  // docs/266-plugin-install-diagnosability req 7 — what is wrong with the version that is live NOW, appended
  // to every status. A round that found nothing to do is exactly the case this
  // is for: it said `already at <sha>` and exited 0 while the plugin was
  // unusable, and the reason was sitting on a card the session cannot read.
  const degraded = row.degraded.length > 0
    ? `\n${row.degraded.map((d) => `  ! ${d}`).join("\n")}`
      + "\n  ! run `shipit plugin status` for the whole picture"
    : "";
  if (row.status === "failed") {
    // Naming the still-live commit matters more than naming the failure: it is
    // what the session is actually running.
    const live = row.after ? ` — still on ${short(row.after)}` : "";
    return `${head}: refresh failed${live}\n  ${row.detail ?? "no reason reported"}${degraded}`;
  }
  // docs/266 — a re-install lands on the SAME commit, so "already at" would tell
  // a consumer their retry did nothing. docs/273-plugin-generation-rebuild: this
  // is no longer only a forced retry — a round that finds the live version was
  // never installed for what the declaration now selects re-installs by itself,
  // and reads the same way.
  if (row.reinstalled) {
    return `${head}: re-installed ${short(row.after)}${row.detail ? `\n  ${row.detail}` : ""}${degraded}`;
  }
  if (row.status === "unchanged") {
    return `${head}: already at ${short(row.after)}${row.detail ? `\n  ${row.detail}` : ""}${degraded}`;
  }
  return `${head}: ${short(row.before)} → ${short(row.after)}`
    + `${row.detail ? `\n  ${row.detail}` : ""}${degraded}`;
}

/**
 * `shipit plugin status [name]` — docs/266-plugin-install-diagnosability reqs 1–4, 9, 10.
 *
 * Exit code is about the QUESTION, not the answer: asking succeeds even when
 * every repository is broken. An agent diagnosing a failure must be able to run
 * this without its own tooling treating the diagnosis as a new failure — and
 * "unusable" is already in the text and in `--json`'s `usable: false`.
 */
async function status(args: string[], deps: RunDeps): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    success(deps.io, HELP);
    return;
  }
  const { positional, booleans, unsupported } = parseFlags(args, { booleans: { "--json": "json" } });
  if (unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for \`shipit plugin status\`: ${unsupported[0]}\n\n${HELP}`);
  }
  if (positional.length > 1) {
    fail(deps.io, `Expected at most one repository name, got ${positional.length}.\n\n${HELP}`);
  }
  const repo = positional[0];

  // The querystring is built first so the call site carries ONE interpolation
  // at the end of the path. `local-agent-ops.test.ts` reads these literals out
  // of this file to prove local mode admits every verb this shim can emit, and
  // a nested template would leave it staring at half a path.
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  const res = await deps.call("GET", `/agent-ops/plugin/status${query}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Could not read the plugin repositories' status."));
  }

  if (booleans.has("json")) {
    success(deps.io, JSON.stringify(res.body, null, 2));
    return;
  }
  const repos = Array.isArray(res.body.repos) ? res.body.repos.map(toStatusRepo) : [];
  const warnings = Array.isArray(res.body.warnings)
    ? res.body.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const blocks = repos.map(describeStatus);
  const text = [
    ...(repos.length === 0 ? ["This project declares no plugin repositories."] : blocks),
    ...warnings.map((w) => `! ${w}`),
  ].join("\n\n");
  success(deps.io, text);
}

/** One repository's status, as the orchestrator reports it. */
interface StatusRepo {
  repo: string;
  source: string;
  ref: string | null;
  commit: string | null;
  status: string;
  issues: string[];
  installSummary: string;
  usable: boolean;
}

function toStatusRepo(value: unknown): StatusRepo {
  const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    repo: asString(obj.repo),
    source: asString(obj.source),
    ref: typeof obj.ref === "string" ? obj.ref : null,
    commit: typeof obj.commit === "string" ? obj.commit : null,
    status: asString(obj.status) || "unknown",
    issues: Array.isArray(obj.issues) ? obj.issues.filter((i): i is string => typeof i === "string") : [],
    installSummary: asString(obj.installSummary),
    // Absent means "the orchestrator did not say", and the honest rendering of
    // that is the pessimistic one: a reader who cannot tell must not be told
    // everything is fine.
    usable: obj.usable === true,
  };
}

function describeStatus(repo: StatusRepo): string {
  const where = repo.commit ? `${repo.ref ?? "?"} @ ${repo.commit.slice(0, 9)}` : (repo.ref ?? "nothing live");
  // A round in flight is not a broken plugin. Both are `usable: false` — the
  // surfaces are not ready either way — but a flat "NOT USABLE" here would
  // point a reader at `--force` for a repository that is simply mid-refresh.
  const verdict = repo.usable
    ? "usable"
    : repo.status === "activating" ? "not usable yet — a round is in progress" : "NOT USABLE";
  return [
    `${repo.repo} (${repo.source}) — ${repo.status}, ${verdict}`,
    `  running: ${where}`,
    `  install: ${repo.installSummary}`,
    ...repo.issues.map((issue) => `  ! ${issue}`),
  ].join("\n");
}
