
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
// Avoid the barrel: tsx loads imports without bundling.
import { RESERVED_ROLE_NAME } from "../../shared/types/agent-types.js";

const AGENT_RUN_INLINE_REDIRECT = `shipit agent run: inline prompt flags (-p/--prompt/-m) are not supported.
Pass the prompt via --prompt-file FILE, or --prompt-file - to read it from stdin,
so backticks and $(...) in the prompt are not evaluated by the shell. Use a
single-quoted heredoc, exactly like \`gh pr create --body-file -\`:

  shipit agent run --role reviewer --prompt-file - <<'EOF'
  Review this diff and list any bugs as file:line — comment. Diff:
  $(git diff)
  EOF`;

function inheritedAgentDepth(): number {
  const raw = process.env.SHIPIT_AGENT_DEPTH;
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The server's harness catalogue determines whether effort is required or allowed.
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

function spawnTargetPayload(
  values: Record<string, string | undefined>,
  io: RunDeps["io"],
): Record<string, unknown> {
  const role = values.role;
  // Preserve blank overrides so the server rejects them instead of using role defaults.
  const named = EXPLICIT_FLAGS.filter((f) => values[f.key] !== undefined);

  const mode = values.billingMode;
  if (mode !== undefined && mode !== "sub" && mode !== "key") {
    fail(
      io,
      `shipit agent run: --billing-mode must be "sub" (a subscription) or "key" (a metered API key), not "${mode}".`,
    );
  }

  if (role !== undefined) {
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
      "--service": "service",
      "--billing-mode": "billingMode",
      "--effort": "effort",
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

  const releaseSignals = onTerminationSignal(() => {
    deps.io.stderr(
      "shipit agent run: interrupted — the sub-agent is still running server-side and its output " +
        "is NOT lost. When it finishes, read it with: shipit agent result\n" +
        "(Long consults outlive a foreground shell timeout; launch this command in the background.)\n",
    );
    deps.io.exit(1);
  });

  // Consults can exceed fetch's 300s timeout; use the unbounded transport.
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

  if (text) deps.io.stdout(text.endsWith("\n") ? text : `${text}\n`);

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
    success(deps.io, "No roles are configured. Roles are created in ShipIt's Settings.");
    return;
  }
  const lines = roles.map((role) => {
    const parts = [asString(role.name)];
    if (role.description) parts.push(asString(role.description));
    if (role.runsOn) parts.push(asString(role.runsOn));
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
      "",
      "Read the description before you choose a role AND before you write its prompt. It is the",
      "user's account of what the role is for, so it is what tells you which role an unnamed",
      "request means, and how much the prompt has to spell out: a role described as fast, cheap or",
      "narrow wants explicit steps; one described as deep or exploratory can take an open brief.",
      "Where a role has no description, what it runs on is the only hint there is. Neither moves",
      "the target — write the prompt to fit the role, never override a parameter to fit the task.",
    ].join("\n"),
  );
}

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

const RESULT_EXIT_SUCCESS = 0;
const RESULT_EXIT_PENDING = 4;
const RESULT_EXIT_RUN_FAILED = 3;

const RESULT_WAIT_DEFAULT_SECS = 5 * 60;
const MAX_RESULT_WAIT_SECS = 30 * 60;
const RESULT_WAIT_SEGMENT_SECS = 25;
const RESULT_WAIT_INITIAL_BACKOFF_MS = 500;
const RESULT_WAIT_MAX_BACKOFF_MS = 8_000;
const RESULT_WAIT_REQUEST_MARGIN_MS = 10_000;
const RESULT_WAIT_DEADLINE_GRACE_MS = 2_000;
const RESULT_WAIT_MIN_SEGMENT_MS = 1_000;

const TERMINAL_CARD_STATUSES = new Set(["success", "error", "timeout", "cancelled"]);

// A damaged 2xx body becomes {}; missing status must not imply success.
function cardStatusOf(body: Record<string, unknown>): string | null {
  const status = asString(body.status);
  if (TERMINAL_CARD_STATUSES.has(status) || status === "pending") return status;
  if (body.outcome === "pending") return "pending";
  return null;
}

function exitCodeForResultStatus(status: string): number {
  if (status === "pending") return RESULT_EXIT_PENDING;
  if (status === "success") return RESULT_EXIT_SUCCESS;
  return RESULT_EXIT_RUN_FAILED;
}

const UNREADABLE_RESPONSE = "the orchestrator returned a response that is not a consult card";

interface ResultLookup {
  body: Record<string, unknown>;
  waitTimedOut: boolean;
  lastTransportError?: string;
  lookupError?: string;
}

async function waitForResult(
  runId: string | undefined,
  deadline: number,
  deps: RunDeps,
): Promise<ResultLookup> {
  let backoff = RESULT_WAIT_INITIAL_BACKOFF_MS;
  let lastTransportError: string | undefined;
  let lastBody: Record<string, unknown> | undefined;
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
      Math.min(
        segSecs * 1000 + RESULT_WAIT_REQUEST_MARGIN_MS,
        remainingMs + RESULT_WAIT_DEADLINE_GRACE_MS,
      ),
    );

    if (isTransientStatus(res.status)) {
      lastTransportError = formatError(res, "transport error reaching the ShipIt orchestrator");
      const sleepMs = Math.min(backoff, Math.max(0, deadline - deps.now()));
      if (sleepMs <= 0) break;
      await deps.sleep(sleepMs);
      backoff = Math.min(backoff * 2, RESULT_WAIT_MAX_BACKOFF_MS);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        body: res.body,
        waitTimedOut: false,
        lookupError: formatError(res, "Sub-agent result lookup failed"),
        ...(lastTransportError ? { lastTransportError } : {}),
      };
    }

    const cardStatus = cardStatusOf(res.body);
    if (cardStatus === null) {
      lastTransportError = UNREADABLE_RESPONSE;
      const sleepMs = Math.min(backoff, Math.max(0, deadline - deps.now()));
      if (sleepMs <= 0) break;
      await deps.sleep(sleepMs);
      backoff = Math.min(backoff * 2, RESULT_WAIT_MAX_BACKOFF_MS);
      continue;
    }

    backoff = RESULT_WAIT_INITIAL_BACKOFF_MS;
    lastBody = res.body;
    // Pin the full ID so later segments cannot switch to a newer run.
    const reportedId = asString(res.body.spawnId);
    if (reportedId) pinnedId = reportedId;

    if (cardStatus !== "pending") {
      return { body: res.body, waitTimedOut: false, ...(lastTransportError ? { lastTransportError } : {}) };
    }

    // Older servers can ignore wait and return immediately; limit request frequency.
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
    return {
      body: {},
      waitTimedOut: true,
      lookupError: lastTransportError ?? "Sub-agent result lookup failed: the orchestrator was unreachable.",
      ...(lastTransportError ? { lastTransportError } : {}),
    };
  }
  return { body: lastBody, waitTimedOut: true, ...(lastTransportError ? { lastTransportError } : {}) };
}

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
  if (parsed.values.timeout && !wait) {
    fail(deps.io, "shipit agent result: --timeout only applies with --wait. Add --wait to block until the run finishes.");
  }
  let overallSecs = RESULT_WAIT_DEFAULT_SECS;
  if (parsed.values.timeout) {
    const n = Number(parsed.values.timeout);
    if (!Number.isFinite(n) || n <= 0) {
      fail(deps.io, "shipit agent result: --timeout must be a positive number of seconds.");
    }
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
          ? { lookupError: `Sub-agent result lookup failed: ${UNREADABLE_RESPONSE}.` }
          : {}),
    };
  }

  if (lookup.lookupError) {
    fail(deps.io, lookup.lookupError, 1);
  }

  const output = asString(lookup.body.outputMarkdown);
  const status = cardStatusOf(lookup.body) ?? "success";
  const subAgentId = asString(lookup.body.subAgentId);
  const spawnId = asString(lookup.body.spawnId);
  const exitCode = exitCodeForResultStatus(status);
  const resume = `shipit agent result${spawnId ? ` ${spawnId}` : ""} --wait`;

  if (parsed.booleans.has("json")) {
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
  // Keep platform explanations on stderr; stdout belongs to the consultant.
  const statusDetail = asString(lookup.body.statusDetail);
  if (statusDetail) deps.io.stderr(`shipit agent result: ${statusDetail}\n`);
  if (lookup.lastTransportError) {
    deps.io.stderr(`shipit agent result: transport retried (${lookup.lastTransportError})\n`);
  }

  if (status === "pending") {
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
    deps.io.stderr("shipit agent result: that run produced no output.\n");
    deps.io.exit(exitCode);
    return;
  }
  deps.io.stdout(output.endsWith("\n") ? output : `${output}\n`);
  deps.io.exit(exitCode);
}
