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
 *   - `shipit-agent.ts`   — one-shot sub-agent spawn + result re-read
 *                           (`shipit agent run` / `shipit agent result`)
 *   - `shipit-service.ts` — Compose service control (list/start/stop/restart/logs)
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
import { exitAfterFlush, shimWrite } from "./shim-exit.js";
import {
  handleSessionArchive,
  handleSessionCreate,
  handleSessionFind,
  handleSessionList,
  handleSessionMessage,
  handleSessionNotifyOnMerge,
  handleSessionRename,
  handleSessionReport,
  handleSessionView,
  handleSessionWait,
  handleSessionWhoami,
} from "./shipit-session.js";
import {
  handleIssueAssign,
  handleIssueComment,
  handleIssueCreate,
  handleIssueEdit,
  handleIssueLabel,
  handleIssueLabels,
  handleIssueList,
  handleIssueStatus,
  handleIssueStatuses,
  handleIssueView,
} from "./shipit-issue.js";
import { handleAgentRun, handleAgentResult } from "./shipit-agent.js";
import {
  handleServiceList,
  handleServiceLogs,
  handleServiceRestart,
  handleServiceStart,
  handleServiceStop,
} from "./shipit-service.js";
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

import { handleBranchResetToBase, RESET_USAGE } from "./shipit-branch.js";
import { runPlugin } from "./shipit-plugin.js";

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
  shipit session notify-on-merge --self [--json]
  shipit session archive <id> [--json]
  shipit session whoami  [--json]
  shipit session rename  --title T [--json]
                          Retitle THIS session (never another). Do it when you
                          open a PR, and when you continue past a merged one, so
                          the sidebar keeps describing what the session is about
                          rather than only its first PR. A title the user set by
                          hand wins — that refusal is final, don't work around it.
  shipit session report  -b TEXT | --body-file FILE
                          [--severity fyi|warn|blocker] [--subject T]
                          [--to parent|cohort] [--json]
  shipit session help

Branch (docs/239):
  shipit branch reset-to-base [--json]
                          Move this session's branch to its merged PR's base and
                          force the remote to match. Run this FIRST after a
                          self-merge wake, before editing anything. Exit 0 = the
                          branch is ready; nonzero = STOP and report (never reset
                          by hand).

Issues (tracker-neutral; docs/175 + docs/177 + docs/187 + docs/248):
  shipit issue view      <ref> [--tracker NAME] [--comments] [--json]
  shipit issue list      [--tracker NAME] [--state open|closed|all] [--full] [--json]
  shipit issue labels    [--tracker NAME] [--json]
  shipit issue statuses  [--tracker NAME] [--json]
  shipit issue create    --tracker NAME --title T [--body B | --body-file FILE] [--label NAME]... [--create-missing-labels] [--priority P] [--json]
  shipit issue comment   <ref> -b BODY | --body-file FILE [--tracker NAME] [--json]
  shipit issue comment edit <ref> --comment ID -b BODY | --body-file FILE [--tracker NAME] [--json]
  shipit issue edit      <ref> [--title T] [--body B | --body-file FILE] [--label NAME]... [--create-missing-labels] [--priority P] [--tracker NAME] [--json]
  shipit issue status    <ref> <state> [--tracker NAME] [--json]
  shipit issue assign    <ref> <user|me | --none> [--tracker NAME] [--json]
  shipit issue label create --tracker NAME --name NAME [--color '#rrggbb'] [--description TEXT] [--json]
  shipit issue label edit   --tracker NAME --name NAME [--new-name NAME] [--color '#rrggbb'] [--description TEXT] [--json]

  Every tracker this repository uses is declared in its shipit.yaml with a NAME;
  there is no built-in tracker and no implicit fallback. Three reference forms
  all work: 'planning#42' / 'roadmap#SHI-304' (name + backend id), 'roadmap#304'
  (name + number), and the backend's own address ('SHI-304', 'owner/repo#42', an
  issue URL). WRITE the name form yourself — it survives a declaration being
  re-pointed. A reference naming no declared tracker fails with the declared
  names listed; fix the reference or the declaration, never retry elsewhere.

  Naming nothing means this session's own repository — except on 'create' and the
  'label' verbs, which ALWAYS need --tracker NAME so a forgotten flag can't file
  into (or repaint the labels of) a possibly-public repo. Writes are do-then-surface: the change is made
  immediately and an inline provenance card with an Undo button is posted in the
  chat; Undo cancels a newly created issue.

  'comment edit' rewrites a comment you already posted — a wrong or stale comment
  is fixable rather than needing a follow-up saying to ignore it. Get the id from
  'issue view <ref> --comments --json'; Undo restores the previous body. You can
  only edit comments ShipIt itself wrote: someone else's is refused, not rewritten.
  There is no 'comment delete'.

  --label is repeatable (or comma-separated) and resolves against the tracker's
  existing labels — an unknown name is rejected with the valid options, not
  created. To mint a new label, run 'shipit issue label create' (Undo deletes it
  while unused) or pass --create-missing-labels to create unknown names on the
  fly (each gets its own Undo card). On 'edit' labels are added to the issue's
  existing set. --priority is urgent|high|medium|low|none on Linear; GitHub has
  no priority field, so use a label there instead.

  'label edit' fixes a label that already exists with the wrong color, casing or
  description — 'create' still refuses a name that exists in any casing, so a
  typo can never repaint a live label. A rename happens in place: every issue
  carrying the label keeps it and just shows the new name. Undo restores the
  previous values. There is no 'label delete' (undo would mint a fresh label no
  issue carries) — delete in the tracker's own UI if one truly must go.

  'labels'/'statuses' list the tracker's valid label names and status targets so
  you can pick one before a create/edit/status write instead of guessing. 'list
  --json' omits each issue's body by default to save tokens — pass --full to
  include it. Every issue subcommand takes --help for its own usage.

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

Plugin repositories (docs/262 — tools this project consumes from another repo):
  shipit plugin refresh [repo-name] [--json]

  Brings a declared plugin repository to its declared version NOW, and waits.
  Use it after pushing a change to the plugin repository — otherwise a tracked
  branch only re-activates when shipit.yaml changes or the session opens.
  Prints the before and after commit per repository. A failed refresh leaves
  the previous version live and exits non-zero, so the session keeps working —
  on the OLD version.

Compose services (docs/238 — start the services declared in docker-compose.yml):
  shipit service list    [--json]
  shipit service start   <name> [--timeout SECONDS] [--json]
  shipit service stop    <name> [--json]
  shipit service restart <name> [--timeout SECONDS] [--json]
  shipit service logs    <name> [--lines N] [--json]

  Services marked \`x-shipit-preview: manual\` (the default for any service with
  no \`ports\`) do NOT start on their own — a database, a cache, a worker, an
  emulator. START THEM YOURSELF when you need them; don't ask the user to click
  Start. \`list\` shows every service with its status and its agent-reachable
  \`url\` (the container IP — the address for your own curl / browser_navigate,
  not the user's preview origin).

  A manual service is manual because it's HEAVY: the first start may pull a
  large image or run a \`build:\`, taking minutes. \`start\`/\`restart\` wait up to
  10 minutes, so run them in the BACKGROUND if your shell caps foreground
  commands below that. If a start does time out it is still running — re-check
  with \`list\` and follow progress with \`logs\`.

  The stack's SHAPE is declared in docker-compose.yml, not issued imperatively:
  there is no \`service create\`/\`delete\`/\`build\`/\`exec\`/\`up\`/\`down\`. Edit the
  compose file and ShipIt reconciles it.

Sub-agents (docs/144 — spawn another agent for a one-shot sub-task):
  shipit agent run --role reviewer --prompt-file FILE [--json]
  shipit agent run --agent claude|codex --service S --billing-mode sub|key
                   --model M --effort E --prompt-file FILE [--json]
  shipit agent result [RUN-ID] [--wait [--timeout SECONDS]] [--json]

  There are two ways to say what the run happens on, and they do not mix
  (docs/261). '--role reviewer' asks ShipIt for the reviewer the USER
  configured — you name the role, never the reviewer, and supply no service,
  model or harness. Prefer it for a second opinion: which model reviews is a
  ShipIt setting, not your call. Anything else names EVERY parameter — the
  harness, the service, the billing mode, the model and the reasoning level.
  Nothing is filled in from a stored default, so an incomplete call is refused
  rather than quietly completed from somewhere you cannot see.

  'run' spawns ANOTHER registered agent with the prompt from --prompt-file (or
  --prompt-file - for stdin) and prints its final text on stdout. Use it for a
  second-opinion review or a bounded delegation: put ALL context the sub-agent
  needs into the prompt (the task, any \`git diff\`, file references, focus
  hints). The spawned agent runs full-capability in this same workspace and its
  work is committed under your session's agent. Requires the "Multi-agent
  sessions" setting to be enabled. Blocks until the sub-agent finishes: a real
  consult routinely runs for many minutes, up to a 30-minute cap, so run it in
  the BACKGROUND — most shell tools cap foreground commands well below that. A
  killed 'run' does not stop the spawn; recover it with 'result'. Never pipe it
  through tail/head/grep — the sub-agent's report IS the deliverable, and the
  finding you need is as likely to be at the top as the bottom. Example:

    shipit agent run --role reviewer --prompt-file - <<'EOF'
    Review this diff for bugs. Report findings as file:line — comment.
    $(git diff)
    EOF

  'result' re-prints a run's output — the same artifact ShipIt renders inline
  for the user. No RUN-ID ⇒ the most recent run in this session. Use it to
  recover output when a 'run' call was killed before it printed: the spawn
  keeps going server-side, so the answer is still there.

  --wait blocks until the run finishes (default 5m, --timeout up to 30m). Use it
  instead of a sleep/poll loop; it absorbs transport resets and, if the timeout
  elapses, exits 4 and tells you to re-run — waiting is resumable, so nothing is
  lost. Exit codes: 0 finished ok · 4 still running · 3 the run failed ·
  1 the lookup failed (bad run id, unreachable) · 2 bad flags. Branch on those,
  never on grepping the output for "pending" — a finished review can say it.

Ops-only (read-only ShipIt source, docs/162):
  shipit source status   [--json]
  shipit source tree     [PATH] [--json]
  shipit source search   "QUERY" [--path PATH] [--json]
  shipit source cat      PATH [--json]
  shipit source log      [PATH] [--limit N] [--json]
  shipit source blame    PATH [--json]
  shipit source show     COMMIT [PATH] [--json]

Ops-only (host session inventory, docs/255):
  shipit session find    --branch NAME | --pr NUMBER | --container NAME | --id ID
                          [--include-archived] [--include-warm]
                          [--limit N] [--offset N] [--json]
                          Resolve a branch, PR, or container name back to the
                          session that produced it — the one-step answer to
                          "what session created this PR?". --container takes a
                          name straight from 'docker ps' or the host journal
                          ('agent-83292266-744', 'shipit-83292266-744-web-1').
                          A service container with an explicit container_name
                          carries no session id — the error tells you to read
                          its 'shipit-parent-session' label instead. --pr
                          matches the session's current PR AND a previous one it
                          shipped from the same branch.
  shipit session list --all [--include-archived] [--include-warm]
                          [--limit N] [--offset N] [--json]
                          The whole host inventory. (Without --all, 'list' is
                          unchanged: only the children THIS session spawned.)

  Results are capped; when there are more, the output names the exact
  '--offset N' to pass for the next page. Warm pool sessions and sessions the
  user archived are excluded by default — add --include-warm /
  --include-archived to see them.

  Both return METADATA ONLY — id, title, kind, branch, repo, parent, agent,
  timestamps, container name, and the PR number/url/state. Never another
  session's conversation, prompts, secrets, or workspace contents.

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

Coordination runs BOTH ways. Parent → child is \`list\`/\`view\`/\`wait\`/
\`message\`/\`notify-on-merge\`. Child → parent (and siblings) is
\`shipit session report\`: it posts a card into each recipient's chat AND wakes
its agent with a queued turn, so a finding is pushed instead of sitting in a PR
nobody has opened yet. Use it when what you found reaches beyond your own
session — shared machinery you're scoped not to touch, a blocker, or something
that invalidates a sibling's work:

  shipit session report --severity blocker --to cohort \\
    --subject "regen command deletes all catalogs" --body-file - <<'EOF'
  \`npm run regen\` wipes data/catalogs/ before writing, so it destroys the other
  catalogs too. Don't run it until #123 lands.
  EOF

\`--to parent\` (the default) reaches the session that spawned you; \`--to cohort\`
(or \`--cohort\`) also reaches every live sibling. Severity is \`fyi\` (default),
\`warn\`, or \`blocker\`. You cannot target an arbitrary session id — recipients are
derived from your own parent linkage. A report costs each recipient a turn, so
batch findings into one report rather than sending a stream of them.

\`shipit session whoami\` resolves THIS session: its id, branch, parent, cohort
siblings, and any children it spawned. (\`view <id>\` is descendant-scoped, so
passing your own id doesn't work — use \`whoami\`.)

In an Ops session, use \`shipit source *\` to read the ShipIt source code that
runs this host, then \`shipit session create --shipit-source --title "..."\` to
spawn a repo-backed fix session branched from the exact inspected commit.
With \`--shipit-source\` the diagnosis is wrapped in an incident packet and
can't name the session, so the \`--title\` describes what the fix is for.

Also in an Ops session, \`shipit session find\` turns a branch / PR / container
name into the session that owns it. Reach for it BEFORE correlating journal
timestamps against container names — the orchestrator already knows the answer:

  shipit session find --branch shipit/kmwodw
  shipit session find --pr 1744
  shipit session find --container agent-83292266-744

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
  // docs/255 — Ops-only host inventory: resolve a branch / PR / container name
  // back to the session that produced it. Read-only, metadata only.
  find: handleSessionFind,
  view: handleSessionView,
  message: handleSessionMessage,
  wait: handleSessionWait,
  archive: handleSessionArchive,
  "notify-on-merge": handleSessionNotifyOnMerge,
  // docs/233 (planning#243) — the upward channel. Every subcommand above operates
  // parent→child; these are the only ones a session can point at itself.
  report: handleSessionReport,
  whoami: handleSessionWhoami,
  // docs/250 — self-scoped: renames THIS session, never another.
  rename: handleSessionRename,
};

const ISSUE_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  view: handleIssueView,
  list: handleIssueList,
  labels: handleIssueLabels,
  statuses: handleIssueStatuses,
  create: handleIssueCreate,
  comment: handleIssueComment,
  edit: handleIssueEdit,
  status: handleIssueStatus,
  assign: handleIssueAssign,
  label: handleIssueLabel,
};

const COMMAND_DOCS: Record<string, string> = {
  session: "/shipit-docs/sessions.md",
  source: "/shipit-docs/ops-session.md",
  issue: "/shipit-docs/issues.md",
  agent: "/shipit-docs/agent.md",
  service: "/shipit-docs/compose.md",
  release: "/shipit-docs/release.md",
  branch: "/shipit-docs/sessions.md",
};

/** Keep command help useful without maintaining a second copy of canonical docs. */
function commandHelp(domain: keyof typeof COMMAND_DOCS, sub: string): string {
  return `See ${COMMAND_DOCS[domain]} for \`shipit ${domain} ${sub}\` usage and examples.`;
}

function requestsHelp(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h");
}

const AGENT_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  run: handleAgentRun,
  result: handleAgentResult,
};

/**
 * Compose verbs the agent might reach for that the shim refuses (docs/238). The
 * stack's shape is DECLARED in `docker-compose.yml` and reconciled by ShipIt;
 * the agent edits that file rather than issuing imperative stack commands. Same
 * shape as `shipit release`'s refusal to hand-push a tag.
 */
const REJECTED_SERVICE_SUBCOMMANDS = new Set([
  "create", // declare it in docker-compose.yml instead.
  "delete", // remove it from docker-compose.yml instead.
  "remove",
  "build",  // `start`/`restart` already run `up -d --build`.
  "exec",   // use the terminal / bash tool.
  "up",     // ShipIt owns stack lifecycle; per-service `start` is the surface.
  "down",
]);

const SERVICE_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  list: handleServiceList,
  start: handleServiceStart,
  stop: handleServiceStop,
  restart: handleServiceRestart,
  logs: handleServiceLogs,
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

  if (command === "service" || command === "services") {
    await dispatchService(args.slice(1), deps, io);
    return;
  }

  if (command === "branch") {
    await dispatchBranch(args.slice(1), deps, io);
    return;
  }

  // docs/262 req 12 — the plugin verb. Its own handler rather than a branch of
  // the service dispatch: a plugin repository is not a Compose service, and the
  // two surfaces share nothing but the transport.
  if (command === "plugin" || command === "plugins") {
    await runPlugin(args.slice(1), { ...deps, io });
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

  if (requestsHelp(args.slice(2))) {
    success(io, commandHelp("session", sub));
    return;
  }

  await handler(args.slice(2), deps);
}

/**
 * Dispatch a `shipit branch <sub>` invocation (docs/239). One subcommand today —
 * `reset-to-base`, the explicit mode over the docs/218 reset core, which the
 * self-merge wake turn runs before it touches anything.
 */
async function dispatchBranch(args: string[], deps: RunDeps, io: ShimIO): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, RESET_USAGE);
    return;
  }
  if (sub !== "reset-to-base") {
    fail(io, `Unsupported shipit branch subcommand: ${sub}\n${REJECTED_HELP}`);
  }
  if (requestsHelp(args.slice(1))) {
    success(io, commandHelp("branch", sub));
    return;
  }
  await handleBranchResetToBase(args.slice(1), deps);
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
  if (requestsHelp(args.slice(1))) {
    success(io, commandHelp("source", sub));
    return;
  }
  await handler(args.slice(1), deps);
}

/**
 * Dispatch a `shipit issue <sub>` invocation (docs/175 read + docs/177 +
 * docs/187 write). Reads map to view/list/labels/statuses; writes (create/
 * comment/edit/status/assign) are do-then-surface. Only destructive verbs
 * (close/delete) are gated. `<sub> --help` prints per-subcommand usage (planning#201).
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
  if (requestsHelp(args.slice(1))) {
    success(io, commandHelp("issue", sub));
    return;
  }
  await handler(args.slice(1), deps);
}

/**
 * Dispatch a `shipit agent <sub>` invocation (docs/144, planning#247). `run` is the
 * one-shot sub-agent spawn primitive; `result` re-reads a finished run's
 * persisted output.
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
  if (requestsHelp(args.slice(1))) {
    success(io, commandHelp("agent", sub));
    return;
  }
  await handler(args.slice(1), deps);
}

/**
 * Dispatch a `shipit service <sub>` invocation (docs/238). Also reached via the
 * `services` alias — the plural is the word the compose file uses, so it's the
 * likely typo, and rejecting it would be pure friction.
 */
async function dispatchService(args: string[], deps: RunDeps, io: ShimIO): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }
  if (REJECTED_SERVICE_SUBCOMMANDS.has(sub)) {
    fail(
      io,
      `${SHIM_NAME} does not support \`shipit service ${sub}\` — the stack's shape is declared, not commanded.\n` +
        "Add, change, or remove services by editing docker-compose.yml; ShipIt reconciles the stack from the file.\n" +
        "To bring an existing service up or down, use `shipit service start|stop|restart <name>`.\n" +
        "See /shipit-docs/compose.md.",
    );
  }
  const handler = SERVICE_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit service subcommand: ${sub}\n${REJECTED_HELP}`);
  }
  if (requestsHelp(args.slice(1))) {
    success(io, commandHelp("service", sub));
    return;
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
  if (requestsHelp(args.slice(1))) {
    success(io, commandHelp("release", sub));
    return;
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
    shimWrite(process.stderr, `shipit: ${err instanceof Error ? err.message : String(err)}\n`);
    exitAfterFlush(1);
  });
}
