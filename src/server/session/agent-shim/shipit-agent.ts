/**
 * `shipit agent run` / `shipit agent result` handlers (docs/144, planning#247).
 *
 * `run` spawns ANOTHER registered agent for a one-shot sub-task and prints its
 * text on stdout. The prompt (the single context channel — task, diff, focus
 * hints) is read from a file or stdin, so backticks and $(...) are never
 * shell-evaluated. The shim forwards its inherited SHIPIT_AGENT_DEPTH so the
 * orchestrator's recursion guard can reject a sub-agent spawning a sub-agent.
 *
 * docs/261 — WHO runs is said by naming a ROLE. `--role reviewer` leaves the
 * reviewer to ShipIt's own settings (req 6): a review is no longer "a
 * review-shaped prompt handed to whichever backend the repository's markdown
 * named". A call that names no role must name every parameter — harness,
 * service, billing mode, model, and the reasoning level where the harness
 * declares levels (docs/275 req 2) — and an omission is refused rather than
 * completed from a stored default (req 7).
 *
 * docs/264 — a role is now any name the USER configured, not one of a compiled-in
 * list, and it may carry any subset of its parameters as an **override**
 * (req 10): `--role deep-dive --model X`. The two used to be mutually exclusive;
 * that refusal narrowed to the one shape with nothing to complete it from. Two
 * reads make both nameable — `shipit agent roles` and `shipit agent params`
 * (req 12) — and they exist together because an agent that may name a parameter
 * and cannot see which parameters exist names one from memory.
 *
 * `result` re-reads a finished run's persisted consult card — the SAME artifact
 * the UI renders. Two reasons it exists (planning#247): the caller can confirm its
 * copy is the user's copy instead of assuming it, and a run whose `run` call was
 * killed mid-flight (a foreground tool timeout SIGTERMs the shim; the spawn
 * keeps going server-side) is still recoverable instead of being lost silently.
 *
 * The `shipit agent` dispatch lives in `shipit.ts`.
 */

import {
  asString,
  fail,
  isTransientStatus,
  onTerminationSignal,
  parseFlags,
  readBodyFromFileOrStdin,
  success,
} from "./shim-common.js";
import {
  INLINE_PROMPT_FLAGS,
  REJECTED_HELP,
  formatError,
  type RunDeps,
} from "./shipit.js";
// The module rather than the `types.js` barrel: the shim runs under tsx with no
// bundler, so an import here is a module the container actually loads.
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";

const AGENT_RUN_INLINE_REDIRECT = `shipit agent run: inline prompt flags (-p/--prompt/-m) are not supported.
Pass the prompt via --prompt-file FILE, or --prompt-file - to read it from stdin,
so backticks and $(...) in the prompt are not evaluated by the shell. Use a
single-quoted heredoc, exactly like \`gh pr create --body-file -\`:

  shipit agent run --role reviewer --prompt-file - <<'EOF'
  Review this diff and list any bugs as file:line — comment. Diff:
  $(git diff)
  EOF`;

/** Read the inherited recursion depth (absent ⇒ 0, i.e. a primary). */
function inheritedAgentDepth(): number {
  const raw = process.env.SHIPIT_AGENT_DEPTH;
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * docs/261 req 7 — the flags that, together, name what a one-shot run runs on.
 * Listed once, in the order the error messages print them, so "every parameter"
 * has a single definition here and cannot drift from the check.
 *
 * docs/275 req 2 — `--effort` exists exactly where the harness declares
 * reasoning levels, which is a catalogue fact the shim cannot see. So the local
 * completeness check covers only the four flags marked `required`; whether
 * `--effort` is required, forbidden, or valid is the server's call, and its
 * refusal names the levels (or the fact there are none).
 */
const EXPLICIT_FLAGS = [
  { flag: "--agent", key: "agent", body: "agentId", required: true },
  { flag: "--service", key: "service", body: "serviceId", required: true },
  { flag: "--billing-mode", key: "billingMode", body: "billingMode", required: true },
  { flag: "--model", key: "model", body: "modelId", required: true },
  { flag: "--effort", key: "effort", body: "reasoningEffort", required: false },
] as const;

const ROLE_HINT =
  `To run a role instead, use: --role ${RESERVED_ROLE_NAME} (or any role configured on this `
  + "install — `shipit agent roles` lists them). A role names one word and supplies the rest.";

/**
 * docs/264-agent-roles req 16 — turn the parsed flags into the spawn target's half of the
 * request body. **One rule, shared with `shipit session create`.**
 *
 * What changed from docs/261, and both halves matter:
 *
 *  - **`--role NAME` alongside a parameter is no longer refused** — it is the
 *    override path (req 10). The role supplies everything the caller did not
 *    name, so `--role deep-dive --model X` is an ordinary call rather than two
 *    questions at once.
 *  - **The role name is no longer checked here.** It used to be matched against a
 *    compiled-in list, which cannot know the roles a *user* configured — they
 *    live server-side (req 18 lets a role be any name typed). So the local check
 *    becomes a pass-through and the server's resolution is the authority, with
 *    its refusal naming the roles that do exist (req 13). The shim buys a message
 *    for what it can know and does not pretend to know the rest.
 *
 * What stays refused is a call with **no base and only some parameters** — a
 * one-shot run has no parent to complete it from, so it must name everything
 * itself: the four identity flags always, `--effort` where the harness declares
 * levels (docs/275 req 2). (`session create` does have one, which is why the
 * same shape is legal there and is the one place the two commands differ.)
 *
 * The server enforces all of this again — this shim is not the only caller, and a
 * client-side check is a message, not a guarantee. What it buys is the message:
 * the agent learns which flag it forgot without a round trip.
 */
function spawnTargetPayload(
  values: Record<string, string | undefined>,
  io: RunDeps["io"],
): Record<string, unknown> {
  const role = values.role;
  // `!== undefined`, NOT a truthiness test: a flag the caller passed with an
  // empty value is something they TRIED to say, and dropping it here would run
  // the bare role instead — the dropped override req 10 forbids. It rides along
  // and the server refuses it by name. (The explicit path below keeps counting a
  // blank as missing, which is the better message for the shape it is in.)
  const named = EXPLICIT_FLAGS.filter((f) => values[f.key] !== undefined);

  // The one parameter the shim can judge without the catalogue, so it is judged
  // on BOTH paths rather than only where a target is assembled: `--billing-mode`
  // has a closed value set, and an override carrying a third value is the same
  // typo whether it rides a role or a five-flag call.
  const mode = values.billingMode;
  if (mode !== undefined && mode !== "sub" && mode !== "key") {
    fail(
      io,
      `shipit agent run: --billing-mode must be "sub" (a subscription) or "key" (a metered API key), not "${mode}".`,
    );
  }

  if (role !== undefined) {
    // A role plus any subset of the parameters. Everything named rides along as
    // an override; the server validates each against this install's catalogue
    // and refuses an incoherent one by name.
    const payload: Record<string, unknown> = { role };
    for (const f of named) payload[f.body] = values[f.key];
    return payload;
  }

  const missing = EXPLICIT_FLAGS.filter((f) => f.required && !values[f.key]?.trim());
  if (missing.length > 0) {
    fail(
      io,
      "shipit agent run: a run that does not name a role must name EVERY parameter it runs on — "
        + `missing ${missing.map((f) => f.flag).join(", ")}.\n`
        + "(--effort is also required where the harness declares reasoning levels — "
        + "`shipit agent params` shows them.)\n"
        + `Nothing is filled in from a stored setting, so an incomplete call is refused rather than\n`
        + `completed from somewhere you cannot see. ${ROLE_HINT}`,
    );
  }
  // docs/275 — `--effort` rides along exactly as given, blank included: the
  // server owns whether it is required, forbidden or valid for the named
  // harness, and a blank is refused there by name rather than dropped here.
  const payload: Record<string, unknown> = {};
  for (const f of EXPLICIT_FLAGS) {
    if (values[f.key] !== undefined) payload[f.body] = values[f.key];
  }
  return payload;
}

export async function handleAgentRun(args: string[], deps: RunDeps): Promise<void> {
  const usedInline = args.some(
    (a) => INLINE_PROMPT_FLAGS.includes(a) || a.startsWith("--prompt=") || a.startsWith("--message="),
  );
  if (usedInline) {
    fail(deps.io, AGENT_RUN_INLINE_REDIRECT);
  }

  const parsed = parseFlags(args, {
    values: {
      "--agent": "agent", "-a": "agent",
      "--prompt-file": "promptFile", "-f": "promptFile", "-F": "promptFile",
      "--model": "model",
      // docs/261 req 7 — the rest of what a model IS (req 3: a model is a
      // service, a billing mode and an id) plus the reasoning level (req 5).
      // `--model` alone cannot say which credential pays for a model two
      // services offer, and no effort flag existed at all.
      "--service": "service",
      "--billing-mode": "billingMode",
      "--effort": "effort",
      // docs/261 req 6 — the implicit path: name the role, not the reviewer.
      "--role": "role",
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit agent run: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const target = spawnTargetPayload(parsed.values, deps.io);
  const promptFile = parsed.values.promptFile;
  if (!promptFile) {
    fail(deps.io, "shipit agent run: --prompt-file is required (a file, or `-` for stdin, holding the sub-agent's prompt).");
  }
  const prompt = await readBodyFromFileOrStdin(promptFile, deps.io, "shipit agent run", "prompt file");
  if (prompt.trim().length === 0) {
    fail(deps.io, "shipit agent run: the prompt is empty. --prompt-file must hold the sub-agent's task.");
  }
  if (prompt.length > 200_000) {
    fail(deps.io, "shipit agent run: the prompt exceeds 200,000 characters.");
  }

  const payload: Record<string, unknown> = { ...target, prompt, depth: inheritedAgentDepth() };

  // planning#247 — a long consult routinely outlives the *caller's* patience: an
  // agent's foreground shell tool caps commands (10 min in Claude Code) and
  // SIGTERMs on expiry, while a review-sized spawn can run to the 30-minute cap.
  // Killing the shim does NOT stop the run — it finishes server-side and
  // persists its consult card — so the one thing that must not happen is dying
  // silently, which is what made the loss undetectable. Say where the output
  // will be.
  const releaseSignals = onTerminationSignal(() => {
    deps.io.stderr(
      "shipit agent run: interrupted — the sub-agent is still running server-side and its output " +
        "is NOT lost. When it finishes, read it with: shipit agent result\n" +
        "(Long consults outlive a foreground shell timeout; launch this command in the background.)\n",
    );
    deps.io.exit(1);
  });

  // Unbounded (`timeoutMs: 0`): the spawn blocks until the sub-agent exits —
  // routinely many minutes, up to the 30-minute sub-agent wall-clock cap. The
  // orchestrator holds the request open the whole time. Passing `0` routes this
  // leg over Node's `http` instead of `fetch`, because undici's default 300s
  // `headersTimeout` would abort a longer consult with an opaque "fetch failed"
  // even though the run is still in flight (the contract is genuinely no timeout).
  let res;
  try {
    res = await deps.call("POST", "/agent-ops/agent/spawn", payload, deps.env, 0);
  } finally {
    releaseSignals();
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Sub-agent spawn failed"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }

  const text = asString(res.body.text);
  const status = asString(res.body.status) || "success";
  const truncated = res.body.truncated === true;
  const spawnId = asString(res.body.spawnId);

  // Print the sub-agent's final text on stdout regardless of terminal status, so
  // the primary always sees whatever the sub-agent produced.
  if (text) deps.io.stdout(text.endsWith("\n") ? text : `${text}\n`);

  // planning#247 — name the run on stderr. This text and the "Consulted …" card in
  // the UI are one artifact, and the id is what lets either side say *which*
  // run they are looking at when they seem to disagree (two consults in a turn
  // produce two cards, and it is otherwise impossible to tell them apart).
  if (spawnId) {
    deps.io.stderr(
      `shipit agent run: run ${spawnId} — this is the same text ShipIt renders inline for the user. ` +
        `Re-read it any time with: shipit agent result ${spawnId}\n`,
    );
  }

  if (status !== "success") {
    deps.io.stderr(`shipit agent run: sub-agent ${status}${truncated ? " (output truncated)" : ""}.\n`);
    deps.io.exit(1);
    return;
  }
  if (truncated) {
    deps.io.stderr("shipit agent run: note — the sub-agent's output was truncated at the cost cap.\n");
  }
  deps.io.exit(0);
}

/**
 * `shipit agent roles [--json]` (docs/264-agent-roles req 12) — the roles this install has.
 *
 * The read that makes `--role NAME` nameable: an agent mapping "review the PR"
 * onto a role (req 3), or telling the user which roles exist, had no way to see
 * them before — they live in the user's settings, not in anything compiled in.
 *
 * Prints the name first on each line, because the name is the whole invocation:
 * everything after it is context for choosing between them.
 */
export async function handleAgentRoles(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { values: {}, booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit agent roles: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const res = await deps.call("GET", "/agent-ops/agent/roles", undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list roles"), 1);
  }
  const roles = (res.body.roles as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(roles)}\n`);
    deps.io.exit(0);
    return;
  }
  if (roles.length === 0) {
    // Not reachable on a healthy install — the reviewer is always present
    // (req 2) — so say what it means rather than printing an empty list.
    success(deps.io, "No roles are configured. Roles are created in ShipIt's Settings.");
    return;
  }
  const lines = roles.map((role) => {
    const parts = [asString(role.name)];
    if (role.description) parts.push(asString(role.description));
    if (role.runsOn) parts.push(asString(role.runsOn));
    // A role that cannot run is still listed, with the reason: which remedy it
    // needs differs, and a role missing from the list would read as "no such
    // role" and send the agent to invent a different one.
    if (role.unavailable) parts.push(`UNAVAILABLE (${asString(role.unavailable)})`);
    return parts.join("\t");
  });
  success(
    deps.io,
    [
      ...lines,
      "",
      "Run one with: shipit agent run --role NAME --prompt-file - (or shipit session create --role NAME).",
      "The reviewer's model is resolved per run, which is why it lists none.",
    ].join("\n"),
  );
}

/**
 * `shipit agent params [--json]` (docs/264-agent-roles req 12) — the parameters an override
 * may name on THIS install.
 *
 * Ships with `roles` and never without it. An agent allowed to carry "review this
 * with Opus at high effort" (req 10) but unable to see which models exist would
 * fill the gap from memory, and a remembered model is indistinguishable from a
 * supplied one by the time it reaches ShipIt.
 *
 * What it is NOT is an invitation to assemble a target from scratch: a role plus
 * an override does the same job in less and stays anchored to something the user
 * configured. The footer says so, because this list is exactly where that
 * temptation appears.
 */
export async function handleAgentParams(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { values: {}, booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit agent params: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const res = await deps.call("GET", "/agent-ops/agent/params", undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list spawn parameters"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const harnesses = (res.body.harnesses as Record<string, unknown>[] | undefined) ?? [];
  if (harnesses.length === 0) {
    success(deps.io, "No harness is installed in this deployment.");
    return;
  }
  const blocks = harnesses.map((harness) => {
    const levels = (harness.reasoningLevels as string[] | undefined) ?? [];
    const models = (harness.models as Record<string, unknown>[] | undefined) ?? [];
    const lines = [
      `${asString(harness.name)} (--agent ${asString(harness.id)})`,
      // docs/275 req 6 — say which shape a complete role-less call takes here:
      // where there are no levels there is no `--effort` parameter, and naming
      // one is refused rather than dropped.
      `  --effort: ${
        levels.length > 0
          ? `${levels.join(", ")} (required on a role-less call)`
          : "(this harness declares no levels — omit --effort; the other four flags are the whole call)"
      }`,
      models.length > 0
        ? "  models:"
        : "  models:   (none — this install has no credential this harness can use)",
    ];
    for (const model of models) {
      lines.push(
        `    --service ${asString(model.serviceId)} --billing-mode ${asString(model.billingMode)} `
        + `--model ${asString(model.modelId)}\t${asString(model.label)}`,
      );
    }
    return lines.join("\n");
  });
  success(
    deps.io,
    [
      ...blocks,
      "",
      "These are the values an override may name. Prefer a role and override only what the",
      "user asked to change (`--role deep-dive --model X`) — relay a parameter the user named,",
      "never decide one yourself. `shipit agent roles` lists the roles.",
    ].join("\n"),
  );
}

/**
 * docs/248 — exit codes for `shipit agent result`, so a caller that backgrounded
 * a long consult can branch on `$?` instead of grepping the run's own output for
 * the word "pending" (a code review can easily contain it).
 *
 * `0`/`3` mirror docs/182's `WAIT_EXIT_IDLE`/`WAIT_EXIT_ERROR`. Pending is `4`
 * because every lower code is already spoken for by a FAILURE: `1` is this
 * command's lookup error (unknown/ambiguous run id, unreachable orchestrator)
 * and `2` is the shim-wide `fail()` default for a bad invocation. "Still
 * running" has to be distinguishable from both, or a caller retrying until the
 * command succeeds would spin forever on a condition that can never clear.
 */
const RESULT_EXIT_SUCCESS = 0;
const RESULT_EXIT_PENDING = 4;
const RESULT_EXIT_RUN_FAILED = 3;

/** docs/248 — `--wait` tuning. Mirrors the `shipit session wait` segment loop. */
const RESULT_WAIT_DEFAULT_SECS = 5 * 60;
/** The sub-agent's own wall-clock cap — past it the run cannot still be alive. */
const MAX_RESULT_WAIT_SECS = 30 * 60;
const RESULT_WAIT_SEGMENT_SECS = 25;
const RESULT_WAIT_INITIAL_BACKOFF_MS = 500;
const RESULT_WAIT_MAX_BACKOFF_MS = 8_000;
/** Per-request abort budget: one segment plus margin for the server's resolve. */
const RESULT_WAIT_REQUEST_MARGIN_MS = 10_000;
/**
 * Slack the per-request abort budget may add past the overall deadline. Without
 * it, `--timeout 5` would hand the first request a 15-second budget and blow the
 * caller's stated bound by 3x.
 */
const RESULT_WAIT_DEADLINE_GRACE_MS = 2_000;
/**
 * Floor on how long one `pending` iteration may take before the loop re-issues.
 * A server that ignores `wait` and answers `pending` instantly would otherwise
 * spin the loop at request-per-millisecond rates for the whole timeout.
 */
const RESULT_WAIT_MIN_SEGMENT_MS = 1_000;

/** Consult-card statuses that end a wait. */
const TERMINAL_CARD_STATUSES = new Set(["success", "error", "timeout", "cancelled"]);

/**
 * Recognize a consult card in a 2xx body, or `null` when the body is not one.
 *
 * The `null` case is load-bearing: `callBroker` turns an unparseable body — a
 * response truncated or reset after its 2xx headers — into `{}`, and a caller
 * that defaulted a missing status to "success" would report a *finished,
 * successful run* on the strength of a corrupted response. That is the one
 * failure this command's exit code must never produce.
 */
function cardStatusOf(body: Record<string, unknown>): string | null {
  const status = asString(body.status);
  if (TERMINAL_CARD_STATUSES.has(status) || status === "pending") return status;
  // A wait response may legibly say "still going" without restating the card.
  if (body.outcome === "pending") return "pending";
  return null;
}

/** Map a consult card's status to this command's exit code. */
function exitCodeForResultStatus(status: string): number {
  if (status === "pending") return RESULT_EXIT_PENDING;
  if (status === "success") return RESULT_EXIT_SUCCESS;
  // error | timeout | cancelled — the run reached a terminal state that wasn't
  // success. Unrecognized statuses never reach here: `cardStatusOf` rejects the
  // body as unreadable before it becomes an outcome.
  return RESULT_EXIT_RUN_FAILED;
}

const UNREADABLE_RESPONSE = "the orchestrator returned a response that is not a consult card";

interface ResultLookup {
  body: Record<string, unknown>;
  /** Set when the overall `--wait` deadline elapsed with the run still pending. */
  waitTimedOut: boolean;
  /** Set when transport errors were swallowed and retried during the wait. */
  lastTransportError?: string;
  /** A non-2xx response the caller should surface as a lookup failure. */
  lookupError?: string;
}

/**
 * docs/248 — wait for a run to reach a terminal status, with a resumable
 * segment loop beneath an overall deadline. Same structure as `waitForChildOnce`
 * (docs/182): each iteration issues a bounded server segment; `pending`
 * re-issues, and a transient transport failure backs off and retries. A
 * transport error is never an outcome. Never throws.
 */
async function waitForResult(
  runId: string | undefined,
  deadline: number,
  deps: RunDeps,
): Promise<ResultLookup> {
  let backoff = RESULT_WAIT_INITIAL_BACKOFF_MS;
  let lastTransportError: string | undefined;
  let lastBody: Record<string, unknown> | undefined;
  // The run this wait is following. Starts as whatever the caller named (a full
  // id, a prefix, or nothing at all) and is replaced by the full id from the
  // first readable response — see the pinning note below.
  let pinnedId = runId;

  while (deps.now() < deadline) {
    const iterationStart = deps.now();
    const remainingMs = deadline - iterationStart;
    const segSecs = Math.max(1, Math.min(RESULT_WAIT_SEGMENT_SECS, Math.ceil(remainingMs / 1000)));
    const overallSecs = Math.max(1, Math.ceil(remainingMs / 1000));
    const params = new URLSearchParams({
      wait: "true",
      timeout: String(overallSecs),
      segment: String(segSecs),
    });
    if (pinnedId) params.set("spawnId", pinnedId);

    const res = await deps.call(
      "GET",
      `/agent-ops/agent/result?${params.toString()}`,
      undefined,
      deps.env,
      // Never overshoot the caller's stated timeout by more than the grace.
      Math.min(
        segSecs * 1000 + RESULT_WAIT_REQUEST_MARGIN_MS,
        remainingMs + RESULT_WAIT_DEADLINE_GRACE_MS,
      ),
    );

    if (isTransientStatus(res.status)) {
      // Transport failure is NEVER an outcome — swallow and retry with backoff.
      lastTransportError = formatError(res, "transport error reaching the ShipIt orchestrator");
      const sleepMs = Math.min(backoff, Math.max(0, deadline - deps.now()));
      if (sleepMs <= 0) break;
      await deps.sleep(sleepMs);
      backoff = Math.min(backoff * 2, RESULT_WAIT_MAX_BACKOFF_MS);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      // A real answer from the server (unknown id, ambiguous prefix) — terminal.
      return {
        body: res.body,
        waitTimedOut: false,
        lookupError: formatError(res, "Sub-agent result lookup failed"),
        ...(lastTransportError ? { lastTransportError } : {}),
      };
    }

    const cardStatus = cardStatusOf(res.body);
    if (cardStatus === null) {
      // 2xx, but not a card — a body reset or truncated after its headers parses
      // to `{}`. Retry it like any other transport damage rather than letting it
      // become a terminal (and, by default, successful) outcome.
      lastTransportError = UNREADABLE_RESPONSE;
      const sleepMs = Math.min(backoff, Math.max(0, deadline - deps.now()));
      if (sleepMs <= 0) break;
      await deps.sleep(sleepMs);
      backoff = Math.min(backoff * 2, RESULT_WAIT_MAX_BACKOFF_MS);
      continue;
    }

    backoff = RESULT_WAIT_INITIAL_BACKOFF_MS;
    lastBody = res.body;
    // Pin to the FULL id the server just reported. The server pins only within
    // one segment, so without this a wait that named no id (or a prefix) would
    // re-resolve "the most recent run" on every segment and silently switch to a
    // newer consult started mid-wait — then report ITS status as the answer.
    const reportedId = asString(res.body.spawnId);
    if (reportedId) pinnedId = reportedId;

    if (cardStatus !== "pending") {
      return { body: res.body, waitTimedOut: false, ...(lastTransportError ? { lastTransportError } : {}) };
    }

    // Still pending. A conforming server has already spent a segment holding the
    // request open; one that answered instantly (an older build that ignores
    // `wait`) has not, so pace the loop rather than hammering it.
    const elapsed = deps.now() - iterationStart;
    if (elapsed < RESULT_WAIT_MIN_SEGMENT_MS) {
      const sleepMs = Math.min(
        RESULT_WAIT_MIN_SEGMENT_MS - elapsed,
        Math.max(0, deadline - deps.now()),
      );
      if (sleepMs <= 0) break;
      await deps.sleep(sleepMs);
    }
  }

  if (!lastBody) {
    // Every attempt failed in transport — we never learned anything about the
    // run. That is a lookup failure, not "still pending".
    return {
      body: {},
      waitTimedOut: true,
      lookupError: lastTransportError ?? "Sub-agent result lookup failed: the orchestrator was unreachable.",
      ...(lastTransportError ? { lastTransportError } : {}),
    };
  }
  return { body: lastBody, waitTimedOut: true, ...(lastTransportError ? { lastTransportError } : {}) };
}

/**
 * `shipit agent result [<run-id>] [--wait [--timeout SECONDS]] [--json]`
 * (planning#247, docs/248) — print a spawn's persisted output: the exact card the UI
 * shows. No id ⇒ the session's most recent run. A run-id prefix is accepted as
 * long as it is unambiguous.
 *
 * The exit code carries the run's status (see `RESULT_EXIT_*`), and `--wait`
 * blocks until the run is terminal, so a caller that backgrounded a long consult
 * never needs a hand-written `sleep`/`grep` loop. A wait that hits its timeout
 * exits `4` and says how to resume — every call re-derives from durable state,
 * so being interrupted loses nothing.
 */
export async function handleAgentResult(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--timeout": "timeout", "-T": "timeout" },
    booleans: { "--json": "json", "--wait": "wait" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit agent result: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.positional.length > 1) {
    fail(deps.io, "shipit agent result: pass at most one run id.");
  }

  const runId = parsed.positional[0];
  const wait = parsed.booleans.has("wait");
  // `--timeout` does NOT imply `--wait`: a stray flag must never silently turn a
  // quick read into a five-minute block.
  if (parsed.values.timeout && !wait) {
    fail(deps.io, "shipit agent result: --timeout only applies with --wait. Add --wait to block until the run finishes.");
  }
  let overallSecs = RESULT_WAIT_DEFAULT_SECS;
  if (parsed.values.timeout) {
    const n = Number(parsed.values.timeout);
    if (!Number.isFinite(n) || n <= 0) {
      fail(deps.io, "shipit agent result: --timeout must be a positive number of seconds.");
    }
    // Floor to whole seconds, but never to zero: `--timeout 0.5` is a positive
    // timeout the caller meant, and rounding it to 0 would skip the lookup
    // entirely and then blame the orchestrator for being unreachable.
    overallSecs = Math.min(Math.max(1, Math.floor(n)), MAX_RESULT_WAIT_SECS);
  }

  let lookup: ResultLookup;
  if (wait) {
    lookup = await waitForResult(runId, deps.now() + overallSecs * 1000, deps);
  } else {
    const qs = runId ? `?spawnId=${encodeURIComponent(runId)}` : "";
    const res = await deps.call("GET", `/agent-ops/agent/result${qs}`, undefined, deps.env);
    const unreadable = res.status >= 200 && res.status < 300 && cardStatusOf(res.body) === null;
    lookup = {
      body: res.body,
      waitTimedOut: false,
      ...(res.status < 200 || res.status >= 300
        ? { lookupError: formatError(res, "Sub-agent result lookup failed") }
        : unreadable
          // Same guard as the wait loop: a body damaged after its 2xx headers
          // must not be read as a finished, successful run.
          ? { lookupError: `Sub-agent result lookup failed: ${UNREADABLE_RESPONSE}.` }
          : {}),
    };
  }

  if (lookup.lookupError) {
    fail(deps.io, lookup.lookupError, 1);
  }

  const output = asString(lookup.body.outputMarkdown);
  // Non-null past the lookupError guard above.
  const status = cardStatusOf(lookup.body) ?? "success";
  const subAgentId = asString(lookup.body.subAgentId);
  const spawnId = asString(lookup.body.spawnId);
  const exitCode = exitCodeForResultStatus(status);
  const resume = `shipit agent result${spawnId ? ` ${spawnId}` : ""} --wait`;

  if (parsed.booleans.has("json")) {
    // Mirror what text mode puts on stderr, so a `--json` caller is not the one
    // consumer that cannot see a degraded wait or learn how to resume it.
    deps.io.stdout(
      `${JSON.stringify({
        ...lookup.body,
        outcome: status === "pending" ? "pending" : "finished",
        ...(lookup.lastTransportError ? { lastTransportError: lookup.lastTransportError } : {}),
        ...(status === "pending" ? { resumeCommand: resume } : {}),
      })}\n`,
    );
    deps.io.exit(exitCode);
    return;
  }

  deps.io.stderr(`shipit agent result: run ${spawnId} · ${subAgentId} · ${status}\n`);
  // planning#309 — ShipIt's own explanation of a terminal status, when the status
  // alone would mislead (a consult cancelled by an orchestrator restart reads
  // exactly like one the user cancelled). On stderr, never stdout: stdout is the
  // sub-agent's verbatim output and must stay in the consultant's voice.
  const statusDetail = asString(lookup.body.statusDetail);
  if (statusDetail) deps.io.stderr(`shipit agent result: ${statusDetail}\n`);
  if (lookup.lastTransportError) {
    deps.io.stderr(`shipit agent result: transport retried (${lookup.lastTransportError})\n`);
  }

  if (status === "pending") {
    // The run is alive. Say how to keep waiting — resumable because each call
    // re-derives the answer from the persisted card, so nothing is lost by
    // having been interrupted.
    deps.io.stderr(
      lookup.waitTimedOut
        ? `shipit agent result: still running after ${overallSecs}s. Re-run to keep waiting: ${resume}\n`
        : `shipit agent result: that run is still going. Block until it finishes with: ${resume}\n`,
    );
    if (output) deps.io.stdout(output.endsWith("\n") ? output : `${output}\n`);
    deps.io.exit(RESULT_EXIT_PENDING);
    return;
  }

  if (!output) {
    // A terminal card with no text (a crash, a cancel before any output) is a
    // real answer to "what did that run produce" — say so rather than printing
    // nothing, which reads like the lookup itself failed.
    deps.io.stderr("shipit agent result: that run produced no output.\n");
    deps.io.exit(exitCode);
    return;
  }
  deps.io.stdout(output.endsWith("\n") ? output : `${output}\n`);
  deps.io.exit(exitCode);
}
