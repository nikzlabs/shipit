/**
 * `shipit agent run` / `shipit agent result` handlers (docs/144, SHI-245).
 *
 * `run` spawns ANOTHER registered agent for a one-shot sub-task and prints its
 * text on stdout. The prompt (the single context channel — task, diff, focus
 * hints) is read from a file or stdin, so backticks and $(...) are never
 * shell-evaluated. The shim forwards its inherited SHIPIT_AGENT_DEPTH so the
 * orchestrator's recursion guard can reject a sub-agent spawning a sub-agent.
 * Review is just a review-shaped prompt.
 *
 * `result` re-reads a finished run's persisted consult card — the SAME artifact
 * the UI renders. Two reasons it exists (SHI-245): the caller can confirm its
 * copy is the user's copy instead of assuming it, and a run whose `run` call was
 * killed mid-flight (a foreground tool timeout SIGTERMs the shim; the spawn
 * keeps going server-side) is still recoverable instead of being lost silently.
 *
 * The `shipit agent` dispatch lives in `shipit.ts`.
 */

import {
  asString,
  fail,
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

  // SHI-245 — a long consult routinely outlives the *caller's* patience: an
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

  // Unbounded (`timeoutMs: 0`): the spawn blocks until the sub-agent exits
  // (30–120s typical, up to the 30-minute sub-agent wall-clock cap). The
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

  // SHI-245 — name the run on stderr. This text and the "Consulted …" card in
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
 * `shipit agent result [<run-id>] [--json]` (SHI-245) — print a finished spawn's
 * persisted output: the exact card the UI shows. No id ⇒ the session's most
 * recent run. A run-id prefix is accepted as long as it is unambiguous.
 */
export async function handleAgentResult(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit agent result: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.positional.length > 1) {
    fail(deps.io, "shipit agent result: pass at most one run id.");
  }

  const runId = parsed.positional[0];
  const qs = runId ? `?spawnId=${encodeURIComponent(runId)}` : "";
  const res = await deps.call("GET", `/agent-ops/agent/result${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Sub-agent result lookup failed"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }

  const output = asString(res.body.outputMarkdown);
  const status = asString(res.body.status) || "success";
  const subAgentId = asString(res.body.subAgentId);
  const spawnId = asString(res.body.spawnId);

  deps.io.stderr(`shipit agent result: run ${spawnId} · ${subAgentId} · ${status}\n`);
  if (!output) {
    // A terminal card with no text (a crash, a cancel before any output) is a
    // real answer to "what did that run produce" — say so rather than printing
    // nothing, which reads like the lookup itself failed.
    deps.io.stderr("shipit agent result: that run produced no output.\n");
    deps.io.exit(0);
    return;
  }
  deps.io.stdout(output.endsWith("\n") ? output : `${output}\n`);
  deps.io.exit(0);
}
