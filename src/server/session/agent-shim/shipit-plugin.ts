
import { asString, fail, parseFlags, readStdin, success } from "./shim-common.js";
import { formatError, type RunDeps } from "./shipit.js";

interface RefreshRow {
  repo: string;
  ref: string;
  before: string | null;
  after: string | null;
  status: string;
  detail?: string;
  degraded: string[];
  reinstalled: boolean;
  install?: InstallRecordView;
}

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

// The broker runs plugin code in a separate container without the credential broker.
async function exec(args: string[], deps: RunDeps): Promise<void> {
  // Split before parsing so plugin flags pass through unchanged.
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
    // No transport deadline while the plugin command is still running.
    0,
  );

  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, `Could not run \`${values.command}\`.`));
  }

  if (typeof res.body.stdout === "string" && res.body.stdout) deps.io.stdout(res.body.stdout);
  if (typeof res.body.stderr === "string" && res.body.stderr) deps.io.stderr(res.body.stderr);

  // Refusals can arrive as 2xx. Keep their errors out of parseable stdout.
  if (typeof res.body.error === "string" && res.body.error) {
    deps.io.stderr(res.body.error.endsWith("\n") ? res.body.error : `${res.body.error}\n`);
  }
  const code = typeof res.body.exitCode === "number" ? res.body.exitCode : 1;
  deps.io.exit(code);
}

// Bound idle inherited pipes; readStdin removes the deadline after the first byte.
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
  if (unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for \`shipit plugin refresh\`: ${unsupported[0]}\n\n${HELP}`);
  }
  if (positional.length > 1) {
    fail(deps.io, `Expected at most one repository name, got ${positional.length}.\n\n${HELP}`);
  }
  const repo = positional[0];
  const force = booleans.has("force");
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

  if (rows.some((r) => r.status === "failed")) fail(deps.io, text, 1);
  success(deps.io, text);
}

function describe(row: RefreshRow): string {
  const short = (commit: string | null): string => (commit ? commit.slice(0, 9) : "none");
  const head = `${row.repo} (${row.ref})`;
  const degraded = row.degraded.length > 0
    ? `\n${row.degraded.map((d) => `  ! ${d}`).join("\n")}`
      + "\n  ! run `shipit plugin status` for the whole picture"
    : "";
  if (row.status === "failed") {
    const live = row.after ? ` — still on ${short(row.after)}` : "";
    return `${head}: refresh failed${live}\n  ${row.detail ?? "no reason reported"}${degraded}`;
  }
  if (row.reinstalled) {
    return `${head}: re-installed ${short(row.after)}${row.detail ? `\n  ${row.detail}` : ""}${degraded}`;
  }
  if (row.status === "unchanged") {
    return `${head}: already at ${short(row.after)}${row.detail ? `\n  ${row.detail}` : ""}${degraded}`;
  }
  return `${head}: ${short(row.before)} → ${short(row.after)}`
    + `${row.detail ? `\n  ${row.detail}` : ""}${degraded}`;
}

// An unusable plugin does not make a successful status query fail.
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

  // local-agent-ops.test.ts extracts paths and cannot parse nested templates.
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

interface StatusRepo {
  repo: string;
  source: string;
  ref: string | null;
  commit: string | null;
  status: string;
  issues: string[];
  installSummary: string;
  depStoreNotice?: string;
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
    ...(typeof obj.depStoreNotice === "string" ? { depStoreNotice: obj.depStoreNotice } : {}),
    usable: obj.usable === true,
  };
}

function describeStatus(repo: StatusRepo): string {
  const where = repo.commit ? `${repo.ref ?? "?"} @ ${repo.commit.slice(0, 9)}` : (repo.ref ?? "nothing live");
  const verdict = repo.usable
    ? "usable"
    : repo.status === "activating" ? "not usable yet — a round is in progress" : "NOT USABLE";
  return [
    `${repo.repo} (${repo.source}) — ${repo.status}, ${verdict}`,
    `  running: ${where}`,
    `  install: ${repo.installSummary}`,
    ...(repo.depStoreNotice ? [`  ~ ${repo.depStoreNotice}`] : []),
    ...repo.issues.map((issue) => `  ! ${issue}`),
  ].join("\n");
}
