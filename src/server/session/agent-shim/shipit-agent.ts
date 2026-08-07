/**
 * `shipit agent run` / `shipit agent result` handlers (docs/144, planning#247).
 *
 * `run` spawns ANOTHER registered agent for a one-shot sub-task and prints its
 * text on stdout. The prompt (the single context channel — task, diff, focus
 * hints) is read from a file or stdin, so backticks and $(...) are never
 * shell-evaluated. The shim forwards its inherited SHIPIT_AGENT_DEPTH so the
 * orchestrator's recursion guard can reject a sub-agent spawning a sub-agent.
 * Review is just a review-shaped prompt.
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
} from "./shim-common.js";
import {
  INLINE_PROMPT_FLAGS,
  REJECTED_HELP,
  formatError,
  type RunDeps,
} from "./shipit.js";

const AGENT_RUN_INLINE_REDIRECT = `shipit agent run: inline prompt flags (-p/--prompt/-m) are not supported.
Pass the prompt via --prompt-file FILE, or --prompt-file - to read it from stdin,
so backticks and $(...) in the prompt are not evaluated by the shell. Use a
single-quoted heredoc, exactly like \`gh pr create --body-file -\`:

  shipit agent run --agent codex --prompt-file - <<'EOF'
  Review this diff and list any bugs as file:line — comment. Diff:
  $(git diff)
  EOF`;

/** Read the inherited recursion depth (absent ⇒ 0, i.e. a primary). */
function inheritedAgentDepth(): number {
  const raw = process.env.SHIPIT_AGENT_DEPTH;
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
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
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit agent run: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const agentId = parsed.values.agent;
  if (!agentId) {
    fail(deps.io, "shipit agent run: --agent is required (e.g. --agent codex).");
  }
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

  const payload: Record<string, unknown> = { agentId, prompt, depth: inheritedAgentDepth() };
  if (parsed.values.model) payload.model = parsed.values.model;

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
