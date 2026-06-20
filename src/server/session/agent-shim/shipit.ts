/**
 * `shipit` shim — a curated, sandboxed subset of session-management
 * operations for the inner agent (Claude or Codex).
 *
 * Installed at /usr/local/bin/shipit inside the session worker container so
 * the agent's bash tool can run `shipit session create --prompt-file -` to
 * spawn sibling sessions. The shim does not touch the orchestrator directly;
 * it POSTs to the worker's `/agent-ops/session/*` router on localhost, which
 * brokers through the orchestrator's session-scoped routes.
 *
 * Mirrors the `gh.ts` shim from doc 116 — same shape, same conventions,
 * same security model (the shared CLI plumbing lives in `shim-common.ts`).
 * The worker injects this container's session id as the parent on every
 * request, so the agent cannot spawn sessions under a different parent (or
 * read/mutate sessions it didn't spawn).
 *
 * This file is the entry point: it owns the help text, the shared shim-side
 * types/helpers the domain handlers need (`RunDeps`, `formatError`,
 * `REJECTED_HELP`, `INLINE_PROMPT_FLAGS`), and the top-level argument routing
 * that dispatches to the per-domain handler modules:
 *   - `shipit-session.ts` — session create/list/view/message/wait/archive/notify
 *   - `shipit-issue.ts`   — tracker-neutral issue view/list/create/comment/edit/status/assign
 *   - `shipit-agent.ts`   — one-shot sub-agent spawn (`shipit agent run`)
 *   - `shipit-source.ts`  — read-only ShipIt source browsing (Ops sessions)
 *
 * Output:
 *   `shipit session create` prints a stable text block on stdout (id, branch,
 *   status) and exits 0. With `--json`, it prints a JSON object instead.
 *   `shipit session list/view` print plain-text tables or JSON when `--json`
 *   is requested. Errors go to stderr; exit code is non-zero.
 *
 * For documentation: see /shipit-docs/sessions.md inside the container.
 */

import {
  callBroker,
  defaultIO,
  fail,
  parseFlags,
  success,
  type ShimEnv,
  type ShimIO,
} from "./shim-common.js";
import {
  handleSessionArchive,
  handleSessionCreate,
  handleSessionList,
  handleSessionMessage,
  handleSessionNotifyOnMerge,
  handleSessionView,
  handleSessionWait,
} from "./shipit-session.js";
import {
  handleIssueAssign,
  handleIssueComment,
  handleIssueCreate,
  handleIssueEdit,
  handleIssueList,
  handleIssueStatus,
  handleIssueView,
} from "./shipit-issue.js";
import { handleAgentRun } from "./shipit-agent.js";
import { handleReleasePlan, handleReleasePrepare } from "./shipit-release.js";
import {
  handleSourceBlame,
  handleSourceCat,
  handleSourceLog,
  handleSourceSearch,
  handleSourceShow,
  handleSourceStatus,
  handleSourceTree,
} from "./shipit-source.js";

// Re-exported so existing importers (and tests) keep resolving these from
// `./shipit.js` after the shared plumbing moved into shim-common.
export { parseFlags, type ShimIO };

const SHIM_NAME = "shipit (ShipIt)";

/**
 * Shown when the agent reaches for an operation outside the curated subset.
 * Shared with the per-domain handler modules (which import it) so every
 * "unsupported flag/subcommand" error points at the same docs.
 */
export const REJECTED_HELP = `${SHIM_NAME} only supports a curated subset of session-management operations.
See /shipit-docs/sessions.md for the full list.`;

const HELP = `${SHIM_NAME} — agent-driven session management.

Supported subcommands:
  shipit session create  --prompt-file FILE --title T
                          [--agent claude|codex] [--model M]
                          [--turn ID] [--detached] [--shipit-source] [--approximate] [--json]
  shipit session list    [--turn ID] [--json]
  shipit session view    <id> [--json]
  shipit session message <id> -m "TEXT" [--json]
  shipit session wait    <id...> [--timeout SECONDS] [--any|--all] [--json]
  shipit session notify-on-merge <id> [--json]
  shipit session archive <id> [--json]
  shipit session help

Issues (tracker-neutral — tracker inferred from the pointer; docs/175 + docs/177 + docs/187):
  shipit issue view      <pointer> [--tracker github|linear] [--comments] [--json]
  shipit issue list      [--tracker github|linear] [--state open|closed|all] [--json]
  shipit issue create    --title T [--body B | --body-file FILE] [--label NAME]... [--priority P] [--tracker github|linear] [--json]
  shipit issue comment   <pointer> -b BODY | --body-file FILE [--tracker T] [--json]
  shipit issue edit      <pointer> [--title T] [--body B | --body-file FILE] [--label NAME]... [--priority P] [--tracker T] [--json]
  shipit issue status    <pointer> <state> [--tracker T] [--json]
  shipit issue assign    <pointer> <user|me | --none> [--tracker T] [--json]

  A <pointer> is whatever the user/doc gave you — SHI-28, owner/repo#42, or an
  issue URL; the tracker is inferred from its shape. Writes are do-then-surface:
  the change is made immediately and an inline provenance card with an Undo
  button is posted in the chat. 'create' defaults to Linear (no pointer to infer
  from); Undo cancels the new issue.

  --label is repeatable (or comma-separated) and resolves against the tracker's
  existing labels — an unknown name is rejected with the valid options, not
  created. On 'edit' labels are added to the issue's existing set. --priority is
  urgent|high|medium|low|none on Linear; GitHub has no priority field, so use a
  label there instead.

Releases (docs/214 — deterministic, merge-triggered; CI publishes):
  shipit release plan    [<patch|minor|major|VERSION>] [--prerelease] [--version-source-path FILE] [--json]
  shipit release prepare [<bump|VERSION>] [--pick SHA]... [--from BRANCH]
                         [--release-branch NAME] [--bootstrap] [--allow-empty]
                         [--notes TEXT] [--prerelease [--confirm]]
                         [--version-source-path FILE] [--json]

  'plan' is read-only: it detects the version source and computes the next
  version. 'prepare' opens a version-bump PR against the release branch
  (default 'stable') — MERGING that PR is what publishes the release; CI tags
  the merged commit and creates the GitHub Release. You never push a tag for a
  final release. Use --pick <sha> to cherry-pick a hotfix, or --from <branch>
  to bring a branch's content. --bootstrap creates the release branch on its
  first use. A bare 'prepare' (no --pick/--from) brings no new commits and is
  refused as content-free — pass --from <branch> to bring content, or
  --allow-empty to cut a bump-only release on purpose.

  Prereleases (rc) don't go through the release branch. 'prepare --prerelease'
  proposes the rc; re-run with --confirm to cut + push the vX.Y.Z-rc.N tag
  (a tag push is always confirmation-gated). There is no 'release tag',
  'release publish', or 'release push' — publishing is CI's job.

Sub-agents (docs/144 — spawn another agent for a one-shot sub-task):
  shipit agent run --agent claude|codex --prompt-file FILE [--model M] [--json]

  Spawns ANOTHER registered agent with the prompt from --prompt-file (or
  --prompt-file - for stdin) and prints its final text on stdout. Use it for a
  second-opinion review or a bounded delegation: put ALL context the sub-agent
  needs into the prompt (the task, any \`git diff\`, file references, focus
  hints). The spawned agent runs full-capability in this same workspace and its
  work is committed under your session's agent. Requires the "Multi-agent
  sessions" setting to be enabled. Blocks until the sub-agent finishes (30–120s
  typical). Example:

    shipit agent run --agent codex --prompt-file - <<'EOF'
    Review this diff for bugs. Report findings as file:line — comment.
    $(git diff)
    EOF

Ops-only (read-only ShipIt source, docs/162):
  shipit source status   [--json]
  shipit source tree     [PATH] [--json]
  shipit source search   "QUERY" [--path PATH] [--json]
  shipit source cat      PATH [--json]
  shipit source log      [PATH] [--limit N] [--json]
  shipit source blame    PATH [--json]
  shipit source show     COMMIT [PATH] [--json]

The shim brokers session operations through the ShipIt orchestrator. The
parent session is always the session this container belongs to — the agent
cannot spawn sessions under a different parent, or view/manage sessions it
didn't spawn.

The new session's first user message is passed via \`--prompt-file\` — a file
path, or \`-\` to read the prompt from stdin. There is no inline \`-p\`/\`--prompt\`
flag: a prompt on the command line gets mangled when it contains backticks or
\`$(...)\`, which the shell evaluates before the shim sees them. Use a
single-quoted heredoc, exactly like \`gh pr create --body-file -\`:

  shipit session create --prompt-file - --title "Port API" <<'EOF'
  Port the API in /server to TypeScript. Land it as a separate PR.
  EOF

\`--title\` is REQUIRED: you are naming the session, so give it a short,
human-readable name describing what it's for. It appears in the sidebar.

Use \`shipit session create\` when the user explicitly asked for a separate
session / parallel branch / independent workspace. For in-turn fan-out
under Claude, prefer the built-in \`Task\` tool.

By default a spawned session is a CHILD: it nests under this session in the
sidebar and you can coordinate it (\`list\`/\`view\`/\`wait\`/\`message\`/
\`notify-on-merge\`). Add \`--detached\` for a COMPLETELY SEPARATE session —
no nesting, no coordination, no card in this chat; identical to a session the
user made by hand. Use it ONLY for work unrelated to your current task that you
will never need to hear about again (e.g. spinning off a fix for an unrelated
bug). The test: if you'd ever want to wait on it, follow up, or be told it
merged, it should be a child — omit \`--detached\`. \`--detached\` cannot be
combined with \`--shipit-source\`.

In an Ops session, use \`shipit source *\` to read the ShipIt source code that
runs this host, then \`shipit session create --shipit-source --title "..."\` to
spawn a repo-backed fix session branched from the exact inspected commit.
With \`--shipit-source\` the diagnosis is wrapped in an incident packet and
can't name the session, so the \`--title\` describes what the fix is for.

See /shipit-docs/sessions.md for the full reference, including allowed
flags and the list of intentionally-rejected operations
(\`shipit session delete\`, \`shipit source edit\`, cross-repo spawns, etc.).`;

/**
 * Per-invocation dependencies passed to every handler. `sleep`/`now` are
 * injectable so the `wait` segment loop's backoff is deterministic in tests.
 */
export interface RunDeps {
  env: ShimEnv;
  io: ShimIO;
  call: typeof callBroker;
  /** Sleep helper (injectable for deterministic backoff tests). */
  sleep: (ms: number) => Promise<void>;
  /** Monotonic clock (injectable so deadline-driven loops are testable). */
  now: () => number;
}

/**
 * Inline prompt flags the agent might reach for out of muscle memory, shared by
 * `shipit session create` and `shipit agent run`. Both intentionally reject an
 * inline prompt: a prompt on the command line gets mangled the moment it
 * contains backticks or `$(...)`, which the shell evaluates before the shim
 * sees it. The prompt must come from a file (or stdin via `--prompt-file -`).
 */
export const INLINE_PROMPT_FLAGS = ["-p", "--prompt", "-m", "--message"];

/** Format a broker/orchestrator error response as a single-line message. */
export function formatError(
  res: { status: number; body: Record<string, unknown> },
  fallback: string,
): string {
  const message = typeof res.body.error === "string" ? res.body.error : fallback;
  if (res.status === 0) return message;
  if (res.status === 429) {
    return `${message}\n\nThis session has reached its per-turn or per-parent spawn cap. See /shipit-docs/sessions.md.`;
  }
  if (res.status === 401) {
    return `${message}\n\nShipIt was unable to authenticate the request against the orchestrator.`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

/**
 * Subcommands that exist in the agent's mental model of ShipIt but the
 * shim refuses to expose. Listed explicitly so the agent gets a helpful
 * error pointing at the docs, instead of a generic "unknown command".
 */
const REJECTED_SESSION_SUBCOMMANDS = new Set([
  "delete",   // destructive; user-only.
  "adopt",    // not supported by design (cross-parent reparenting).
  "merge",    // future extension; user merges via the PR/merge UI today.
  "fork",     // separate primitive owned by the UI.
  "rename",   // user-driven; not part of the agent's surface.
  "switch",   // user navigation; not the agent's affordance.
]);

/**
 * Source subcommands the agent might reach for that the shim refuses to expose.
 * Source access is strictly read-only — mutation happens through a spawned
 * `--shipit-source` fix session, never against the source snapshot directly.
 */
const REJECTED_SOURCE_SUBCOMMANDS = new Set([
  "edit",
  "write",
  "commit",
  "push",
  "checkout",
  "git",
  "apply",
  "patch",
]);

const REJECTED_ISSUE_SUBCOMMANDS = new Set([
  "delete", // destructive; not part of the agent's surface.
  "close",  // use `shipit issue status <pointer> completed` (or `canceled`) instead.
]);

/**
 * Release verbs the agent might reach for that the shim refuses (docs/214). For
 * a FINAL release publishing is CI's job — the agent never hand-pushes a tag;
 * `prepare` opens the bump PR and merging it triggers the publish. (rc tags are
 * cut via `prepare --prerelease --confirm`, still never a raw `git tag`.)
 */
const REJECTED_RELEASE_SUBCOMMANDS = new Set(["tag", "publish", "push"]);

const SESSION_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  create: handleSessionCreate,
  list: handleSessionList,
  view: handleSessionView,
  message: handleSessionMessage,
  wait: handleSessionWait,
  archive: handleSessionArchive,
  "notify-on-merge": handleSessionNotifyOnMerge,
};

const ISSUE_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  view: handleIssueView,
  list: handleIssueList,
  create: handleIssueCreate,
  comment: handleIssueComment,
  edit: handleIssueEdit,
  status: handleIssueStatus,
  assign: handleIssueAssign,
};

const AGENT_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  run: handleAgentRun,
};

const RELEASE_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  plan: handleReleasePlan,
  prepare: handleReleasePrepare,
};

const SOURCE_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  status: handleSourceStatus,
  tree: handleSourceTree,
  search: handleSourceSearch,
  cat: handleSourceCat,
  log: handleSourceLog,
  blame: handleSourceBlame,
  show: handleSourceShow,
};

/**
 * Top-level shim entry point. Tests call this directly with stubs so we can
 * verify behavior without spawning a subprocess.
 */
export async function runShim(
  argv: string[],
  io: ShimIO = defaultIO,
  env: ShimEnv = {},
  call: typeof callBroker = callBroker,
  timing?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<void> {
  const deps: RunDeps = {
    env,
    io,
    call,
    sleep: timing?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: timing?.now ?? (() => Date.now()),
  };

  const args = stripNodeArgs(argv);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    success(io, HELP);
    return;
  }
  if (args[0] === "--version") {
    success(io, "shipit (ShipIt shim) 0.1.0");
    return;
  }

  const command = args[0];

  if (command === "source") {
    await dispatchSource(args.slice(1), deps, io);
    return;
  }

  if (command === "issue") {
    await dispatchIssue(args.slice(1), deps, io);
    return;
  }

  if (command === "agent") {
    await dispatchAgent(args.slice(1), deps, io);
    return;
  }

  if (command === "release") {
    await dispatchRelease(args.slice(1), deps, io);
    return;
  }

  if (command !== "session") {
    fail(io, `Unknown shipit subcommand: ${command}\n${REJECTED_HELP}`);
  }

  const sub = args[1];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }

  if (REJECTED_SESSION_SUBCOMMANDS.has(sub)) {
    fail(
      io,
      `${SHIM_NAME} does not support \`shipit session ${sub}\`.\nTried: shipit session ${sub}\nSee /shipit-docs/sessions.md for the full list.`,
    );
  }

  const handler = SESSION_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit session subcommand: ${sub}\n${REJECTED_HELP}`);
  }

  await handler(args.slice(2), deps);
}

/**
 * Dispatch a `shipit source <sub>` invocation (docs/162). Read-only by
 * construction: mutating subcommands are rejected with a pointer to the
 * `--shipit-source` fix-session flow.
 */
async function dispatchSource(args: string[], deps: RunDeps, io: ShimIO): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }
  if (REJECTED_SOURCE_SUBCOMMANDS.has(sub)) {
    fail(
      io,
      `${SHIM_NAME} does not support \`shipit source ${sub}\` — source access is read-only.\n` +
        "To change ShipIt source, spawn a fix session: shipit session create --shipit-source --title \"...\" --prompt-file - <<'EOF' ... EOF.\n" +
        "See /shipit-docs/sessions.md.",
    );
  }
  const handler = SOURCE_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit source subcommand: ${sub}\n${REJECTED_HELP}`);
  }
  await handler(args.slice(1), deps);
}

/**
 * Dispatch a `shipit issue <sub>` invocation (docs/175 read + docs/177 +
 * docs/187 write). Reads map to view/list; writes (create/comment/edit/status/
 * assign) are do-then-surface. Only destructive verbs (close/delete) are gated.
 */
async function dispatchIssue(args: string[], deps: RunDeps, io: ShimIO): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }
  if (REJECTED_ISSUE_SUBCOMMANDS.has(sub)) {
    fail(
      io,
      `${SHIM_NAME} does not support \`shipit issue ${sub}\`. ` +
        "Use `shipit issue status <pointer> completed` to mark work done, or " +
        "`shipit issue status <pointer> canceled` to drop it — there is no close/delete.\n" +
        "See /shipit-docs/issues.md.",
    );
  }
  const handler = ISSUE_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit issue subcommand: ${sub}\n${REJECTED_HELP}`);
  }
  await handler(args.slice(1), deps);
}

/**
 * Dispatch a `shipit agent <sub>` invocation (docs/144). Only `run` exists —
 * the one-shot sub-agent spawn primitive.
 */
async function dispatchAgent(args: string[], deps: RunDeps, io: ShimIO): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }
  const handler = AGENT_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit agent subcommand: ${sub}\n${REJECTED_HELP}`);
  }
  await handler(args.slice(1), deps);
}

/**
 * Dispatch a `shipit release <sub>` invocation (docs/214). `plan`/`prepare`
 * only — `tag`/`publish`/`push` are rejected with a pointer at the
 * merge-triggered flow (publishing is CI's job, not the agent's).
 */
async function dispatchRelease(args: string[], deps: RunDeps, io: ShimIO): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }
  if (REJECTED_RELEASE_SUBCOMMANDS.has(sub)) {
    fail(
      io,
      `${SHIM_NAME} does not support \`shipit release ${sub}\` — publishing is CI's job.\n` +
        "For a final release run `shipit release prepare` and MERGE the bump PR; CI tags + publishes.\n" +
        "For a prerelease run `shipit release prepare --prerelease --confirm`.\n" +
        "See /shipit-docs/release.md.",
    );
  }
  const handler = RELEASE_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit release subcommand: ${sub}\n${REJECTED_HELP}`);
  }
  await handler(args.slice(1), deps);
}

/**
 * Strip "node ..." or "tsx ..." prefixes from argv. Allows runShim to accept
 * either raw user args (`["session", "create", ...]`) or full process.argv.
 *
 * Same logic as `gh.ts`.
 */
function stripNodeArgs(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const first = argv[0];
  if (
    first === "node" ||
    first === "tsx" ||
    first.startsWith("/") ||
    first.endsWith("node") ||
    first.endsWith("tsx")
  ) {
    return argv.slice(2);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Standalone entry — only when run as a script, not when imported by tests
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runShim(process.argv.slice(2)).catch((err: unknown) => {
    if (err instanceof Error && err.message === "__shim_exit__") return;
    process.stderr.write(`shipit: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
