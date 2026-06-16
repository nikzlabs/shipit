/**
 * `shipit agent run` handler (docs/144) — spawn ANOTHER registered agent for a
 * one-shot sub-task and print its final text on stdout.
 *
 * The prompt (the single context channel — task, diff, focus hints) is read
 * from a file or stdin, so backticks and $(...) are never shell-evaluated. The
 * shim forwards its inherited SHIPIT_AGENT_DEPTH so the orchestrator's recursion
 * guard can reject a sub-agent spawning a sub-agent. Review is just a
 * review-shaped prompt. The `shipit agent` dispatch lives in `shipit.ts`.
 */

import {
  asString,
  fail,
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

  // No timeout: the spawn blocks until the sub-agent exits (30–120s typical, up
  // to the worker's wall-clock cap). The orchestrator holds the request open.
  const res = await deps.call("POST", "/agent-ops/agent/spawn", payload, deps.env);
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

  // Print the sub-agent's final text on stdout regardless of terminal status, so
  // the primary always sees whatever the sub-agent produced.
  if (text) deps.io.stdout(text.endsWith("\n") ? text : `${text}\n`);

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
