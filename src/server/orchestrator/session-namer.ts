import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentId, ServiceRouting } from "../shared/types.js";
import { isHarnessInstalled } from "../shared/installed-harnesses.js";
import {
  applyServiceRouting,
  codexProviderArgs,
  scrubHarnessEnvCredentials,
} from "../shared/spawn-routing.js";
import { disjointCodexTokens } from "../shared/codex-token-usage.js";
import { ensureCodexHomeInitialized } from "./agents/codex/home-init.js";

export interface SessionName {
  slug: string;
  title: string;
}

/**
 * docs/252 phase 7 (req 9) — what a naming run consumed, when the CLI said.
 *
 * Naming used to discard this entirely: it asked for text and returned a
 * string. Once the user can point naming at a metered service (req 9), every
 * session they create can cost money, and that spend appeared nowhere — which
 * collides with req 16's split reading as exhaustive. Undefined means the CLI
 * reported nothing, which is deliberately distinct from "it was free": the
 * caller records nothing rather than a $0 row.
 */
export interface SessionNameUsage {
  durationMs: number;
  /** The harness's own dollar figure, when it reported one. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

export interface SessionNameResult {
  /** `null` = keep the placeholder title. Every failure lands here. */
  name: SessionName | null;
  /** Present only when the CLI reported telemetry, whether or not naming parsed. */
  usage?: SessionNameUsage;
  /** Short failure detail for req 9's notice. Absent on success. */
  failure?: string;
}

/**
 * docs/252 phase 7 — where a naming run should point.
 *
 * The whole triple, not an `AgentId`: naming is a `(service, billing mode,
 * model)` selection like any other (req 9), and the harness is *derived* from
 * it (`non-turn-model.ts`) rather than being the thing that decides which
 * credential and which models exist. The previous signature took an `AgentId`
 * plus a credential root and passed no model at all, so it could not express
 * the requirement even when the resolution was correct.
 */
export interface SessionNamingTarget {
  /** Derived from the selection — which CLI to spawn. */
  harnessId: AgentId;
  /** Forwarded verbatim to the CLI. Omitted keeps the CLI's own default. */
  model?: string | undefined;
  /**
   * Endpoint + credential shaping for a string-delivered credential. Absent for
   * an account-delivered one, which is the CLI's own login and must be left
   * exactly as it is — shaping it would break the token exchange.
   */
  serviceRouting?: ServiceRouting | undefined;
  /** The secret for `serviceRouting.credentialSourceEnv`, when there is one. */
  credentialSecret?: string | undefined;
  /**
   * docs/150 — credential root (provider-account directory) the naming CLI
   * should read, i.e. the account this naming call is billed against.
   *
   * Omitted means the singleton root, which resolves through the legacy alias
   * symlink to the *migrated default* account — so naming ran on
   * `claude-default` no matter which account was primary, and broke outright
   * once that account was disconnected. Callers that know the route pass it;
   * see `graduateSession`.
   */
  credentialRoot?: string | undefined;
}

const PROMPT_TEMPLATE = `Given this user message for a coding session, generate:
1. A short branch-friendly slug (lowercase, hyphens only, no special chars, max 40 chars)
2. A human-readable session title (max 60 chars)

User message: "{MESSAGE}"

Respond with ONLY valid JSON, no markdown fences: {"slug": "...", "title": "..."}`;

/**
 * Generate a session title and branch-friendly slug from the user's first
 * message, on the model chosen for non-turn work (req 9).
 *
 * Shells out to the locally installed CLI for the DERIVED harness, pointed at
 * the selected service. Returns `name: null` on any failure (network error,
 * parse error, CLI missing/unauthenticated). Callers must treat `null` as "skip
 * the rename" rather than retry, so naming never blocks session graduation —
 * that half already behaved as req 9 requires. What is new is the selection and
 * the notice the caller raises from `failure`.
 */
export async function generateSessionName(
  userMessage: string,
  target: SessionNamingTarget,
): Promise<SessionNameResult> {
  const { harnessId } = target;
  // docs/252 phase 9 (req 14) — naming runs on the ORCHESTRATOR's own CLIs, not in
  // the session container, so a deployment that did not install this harness has
  // nothing to shell out to. Skip explicitly rather than spawning a missing binary
  // and reading the failure back out of stderr; `null` is already "keep the
  // placeholder title", so the surrounding operation is unaffected.
  //
  // Unreachable through the resolver, which only ever derives an INSTALLED
  // harness — kept because this function is also callable directly and the
  // failure it prevents is a confusing one.
  if (!isHarnessInstalled(harnessId)) {
    console.warn(`[session-namer] ${harnessId} is not installed in this deployment; skipping naming`);
    return { name: null, failure: `${harnessId} is not installed in this deployment.` };
  }

  const truncated = userMessage.slice(0, 200);
  const prompt = PROMPT_TEMPLATE.replace("{MESSAGE}", truncated);

  try {
    const run = await callAgentCli(prompt, target);
    const usage = run.usage ? { usage: run.usage } : {};
    if (!run.text) {
      return { name: null, ...usage, failure: run.failure ?? "The naming CLI returned nothing." };
    }

    const jsonMatch = /\{[^}]*"slug"\s*:\s*"[^"]*"[^}]*"title"\s*:\s*"[^"]*"[^}]*\}/.exec(run.text);
    if (!jsonMatch) {
      console.warn("[session-namer] No JSON found in response:", run.text.slice(0, 200));
      return { name: null, ...usage, failure: "The naming CLI returned no usable title." };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { slug?: string; title?: string };
    const slug = typeof parsed.slug === "string"
      ? parsed.slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40)
      : null;
    const title = typeof parsed.title === "string"
      ? parsed.title.slice(0, 60)
      : null;

    if (slug && title) return { name: { slug, title }, ...usage };
    console.warn("[session-namer] Invalid parsed result:", parsed);
    return { name: null, ...usage, failure: "The naming CLI returned no usable title." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[session-namer] Error:", message);
    return { name: null, failure: message };
  }
}

/** One CLI invocation's outcome: its final text, its telemetry, and why it failed. */
interface CliRun {
  text: string | null;
  usage?: SessionNameUsage;
  failure?: string;
}

async function callAgentCli(prompt: string, target: SessionNamingTarget): Promise<CliRun> {
  const { harnessId, model, serviceRouting } = target;
  switch (harnessId) {
    case "claude": {
      // `--output-format json` rather than `text`: the JSON envelope carries the
      // turn's `usage` and `total_cost_usd` alongside the answer, which is what
      // req 9's spend has to be recorded from. Parsing is guarded — an
      // unrecognized envelope degrades to treating stdout as the text, which is
      // exactly the previous behaviour.
      const args = ["-p", prompt, "--output-format", "json"];
      if (model) args.push("--model", model);
      const raw = await callCli("claude", args, target);
      if (raw.text === null) return raw;
      const parsed = parseClaudeJson(raw.text);
      if (!parsed.usage) return { ...raw, text: parsed.text };
      // The envelope's own `duration_ms` when it has one, else the wall clock we
      // measured — a run that reported tokens and no duration is still a run.
      const durationMs = parsed.usage.durationMs || raw.usage?.durationMs || 0;
      return { text: parsed.text, usage: { ...parsed.usage, durationMs } };
    }
    case "codex": {
      // Naming is one of the two `codex` processes that start against the same
      // config root on a session's first message — the other is the turn's own
      // agent — and Codex's first-run initialization of that root is not
      // concurrency-safe, so whichever loses exits 1 before doing any work. Both
      // spawners await the same gate, which initializes a cold root exactly once
      // and is a directory read thereafter. See `agents/codex/home-init.ts`.
      //
      // Awaited BEFORE the spawn, not around it: the point is to be the only
      // process in the root while it is cold, not to serialize naming against
      // turns generally.
      if (target.credentialRoot) {
        await ensureCodexHomeInitialized(path.join(target.credentialRoot, ".codex"));
      }
      // We run from /tmp (a one-shot prompt unrelated to any repo). Codex >=0.130
      // refuses `exec` outside a trusted git repo unless this flag is passed.
      //
      // `--json` for the same reason Claude gets `--output-format json`
      // (planning#341): plain `codex exec` prints prose and nothing else, so a
      // naming run on a metered service spent real money and wrote no usage row
      // — the one hole left in req 16's split. The JSONL's `turn.completed`
      // carries the turn's `usage`; verified against codex-cli 0.146.0, which is
      // the version `docker/agent-cli` pins.
      //
      // The provider block goes ahead of the prompt, in the same `-c` position
      // the turn path writes it (`shared/spawn-routing.ts`) — Codex resolves an
      // endpoint through a NAMED provider entry, not a base-URL flag.
      const args = ["exec", "--json", "--skip-git-repo-check", ...codexProviderArgs(serviceRouting)];
      if (model) args.push("--model", model);
      args.push(prompt);
      const raw = await callCli("codex", args, target);
      if (raw.text === null) return raw;
      const parsed = parseCodexJsonl(raw.text);
      const failure = parsed.failure ? { failure: parsed.failure } : {};
      if (!parsed.usage) return { ...raw, text: parsed.text, ...failure };
      // Codex's `turn.completed` carries no duration, so the wall clock stands.
      return {
        text: parsed.text,
        usage: { ...parsed.usage, durationMs: raw.usage?.durationMs ?? 0 },
        ...failure,
      };
    }
  }
}

/**
 * Claude Code's `--output-format json` envelope, reduced to the two things
 * naming needs. Best-effort by construction: an envelope this does not
 * recognize leaves the raw stdout as the text, which the slug regex then reads
 * exactly as it read plain text output before.
 */
function parseClaudeJson(stdout: string): { text: string | null; usage?: SessionNameUsage } {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: unknown;
      total_cost_usd?: unknown;
      duration_ms?: unknown;
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cache_read_input_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
      };
    };
    if (typeof parsed !== "object" || parsed === null) return { text: stdout };
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const usage: SessionNameUsage = {
      durationMs: num(parsed.duration_ms) ?? 0,
      ...(num(parsed.total_cost_usd) !== undefined ? { costUsd: num(parsed.total_cost_usd) } : {}),
      ...(num(parsed.usage?.input_tokens) !== undefined ? { inputTokens: num(parsed.usage?.input_tokens) } : {}),
      ...(num(parsed.usage?.output_tokens) !== undefined ? { outputTokens: num(parsed.usage?.output_tokens) } : {}),
      ...(num(parsed.usage?.cache_read_input_tokens) !== undefined
        ? { cacheReadTokens: num(parsed.usage?.cache_read_input_tokens) }
        : {}),
      ...(num(parsed.usage?.cache_creation_input_tokens) !== undefined
        ? { cacheCreateTokens: num(parsed.usage?.cache_creation_input_tokens) }
        : {}),
    };
    const hasTelemetry =
      usage.costUsd !== undefined
      || usage.inputTokens !== undefined
      || usage.outputTokens !== undefined;
    return {
      text: typeof parsed.result === "string" ? parsed.result : stdout,
      ...(hasTelemetry ? { usage } : {}),
    };
  } catch {
    return { text: stdout };
  }
}

/**
 * `codex exec --json`'s JSONL stream, reduced to the three things naming needs.
 *
 * Measured against codex-cli 0.146.0 driving a local Responses recorder — the
 * same method phase 3 used for spawn shaping. One run prints, in order:
 *
 * ```
 * {"type":"thread.started","thread_id":"…"}
 * {"type":"item.completed","item":{"type":"error","message":"Model metadata …"}}
 * {"type":"turn.started"}
 * {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 * {"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,
 *   "cache_write_input_tokens":0,"output_tokens":42,"reasoning_output_tokens":7}}
 * ```
 *
 * Three things that shape the parse, all of them observed rather than assumed:
 *
 *  - **`input_tokens` includes `cached_input_tokens`** — same overlap the app
 *    server reports, so the same `disjointCodexTokens` splits it. Recording the
 *    raw pair would charge every cached token twice at the input rate, and
 *    Codex reports no dollar figure that would mask the error.
 *  - **`output_tokens` already includes `reasoning_output_tokens`**, which is
 *    reported alongside as a breakdown. ShipIt carries the total and drops the
 *    breakdown; adding them would double-count reasoning.
 *  - **An `error` item is not necessarily fatal.** The run above emitted one
 *    ("Model metadata … not found") and then completed normally. So an error
 *    message becomes the failure detail only when no agent message arrived.
 *
 * Best-effort, exactly like {@link parseClaudeJson}: **whenever no agent message
 * is found and the stream reported no error, the raw stdout is handed back** so
 * the slug regex reads it as it read plain `codex exec` output before. That is
 * deliberately not conditioned on the stream being unrecognizable end to end —
 * cross-backend review pointed out that a mixed stream, or a future CLI that
 * renames the agent-message event, would otherwise lose naming outright. The
 * fallback costs nothing when there is genuinely no title in the bytes (the
 * regex simply fails), and the whole point of the flag is telemetry: naming must
 * never lose its title to gain a metric.
 */
export function parseCodexJsonl(stdout: string): {
  text: string | null;
  usage?: SessionNameUsage;
  failure?: string;
} {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  let text: string | null = null;
  let errorMessage: string | undefined;
  let usage: SessionNameUsage | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: { type?: unknown; item?: unknown; usage?: unknown; error?: unknown };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }
    if (typeof event.type !== "string") continue;

    if (event.type === "item.completed") {
      const item = event.item as { type?: unknown; text?: unknown; message?: unknown } | undefined;
      // Last agent message wins — the naming prompt asks for one, but a run
      // that somehow produces two should be judged on what it finished saying.
      if (item?.type === "agent_message" && typeof item.text === "string") text = item.text;
      if (item?.type === "error" && typeof item.message === "string") errorMessage = item.message;
      continue;
    }
    if (event.type === "turn.completed") {
      const reported = event.usage as Record<string, unknown> | undefined;
      if (!reported) continue;
      const tokens = disjointCodexTokens({
        inputTokens: num(reported.input_tokens),
        outputTokens: num(reported.output_tokens),
        cachedInputTokens: num(reported.cached_input_tokens),
        cacheWriteInputTokens: num(reported.cache_write_input_tokens),
      });
      if (!tokens) continue;
      usage = {
        // Filled in by the caller from the wall clock; `turn.completed` has none.
        durationMs: 0,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        ...(tokens.cacheRead !== undefined ? { cacheReadTokens: tokens.cacheRead } : {}),
        ...(tokens.cacheWrite !== undefined ? { cacheCreateTokens: tokens.cacheWrite } : {}),
      };
      continue;
    }
    if (event.type === "turn.failed") {
      const err = event.error as { message?: unknown } | undefined;
      if (typeof err?.message === "string") errorMessage = err.message;
    }
  }

  // No agent message. If the stream said WHY, that detail is the useful answer
  // and the run is a failure. If it said nothing, fall back to reading stdout as
  // the prose the pre-`--json` spawn produced — an unrecognized or mixed stream
  // must not cost naming its title.
  if (text === null && !errorMessage) return { text: stdout, ...(usage ? { usage } : {}) };
  return {
    text,
    ...(usage ? { usage } : {}),
    ...(text === null && errorMessage ? { failure: errorMessage } : {}),
  };
}

/**
 * Invoke the locally installed provider CLI in non-interactive mode.
 *
 * HOME selects the credentials: a provider-account root when the caller
 * resolved one (docs/150 — the account layout mirrors `$HOME`, which is the
 * same trick the scoped auth flows use), else `/root` for the singleton mount.
 * We do not pass resume/thread flags; this is a one-shot prompt unrelated to
 * the coding conversation.
 *
 * docs/252 phase 7 — a string-delivered credential is materialized into the
 * harness's own variable here, through the SAME `applyServiceRouting` a turn's
 * spawn uses (`shared/spawn-routing.ts`). Sharing the function is the point: a
 * second implementation is how a naming run ends up authenticating differently
 * from the turn it is naming.
 */
function callCli(
  binary: string,
  args: string[],
  target: SessionNamingTarget,
): Promise<CliRun> {
  const { harnessId, serviceRouting, credentialSecret, credentialRoot } = target;
  return new Promise((resolve) => {
    let settled = false;
    const startedAt = Date.now();
    const finish = (value: CliRun): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.HOME = credentialRoot ?? process.env.HOME ?? "/root";
    // docs/150 / docs/252 — a run scoped to a provider-account root must not
    // inherit the orchestrator's own environment credentials: both CLIs prefer
    // the variable over the login on disk, so a host that has one configured
    // (the dogfood `dev` service does) would bill metered API usage while this
    // run is attributed to the selected subscription. The adapters already scrub
    // at their spawn sites; this is the same rule where the orchestrator builds
    // the environment itself. Found by cross-backend review.
    if (credentialRoot) scrubHarnessEnvCredentials(env, harnessId);
    if (serviceRouting) {
      // The secret has to be in the environment under its STORAGE name before
      // shaping runs — that is the variable `applyServiceRouting` reads from and
      // the harness's own variable is where it lands. The orchestrator's own
      // ambient credentials are cleared by the same call, so a naming run cannot
      // silently authenticate with the dogfood instance's key.
      if (credentialSecret) env[serviceRouting.credentialSourceEnv] = credentialSecret;
      const shaped = applyServiceRouting(env, serviceRouting);
      if (!shaped.credentialDelivered) {
        console.warn(
          `[session-namer] no credential for ${serviceRouting.serviceId}/${serviceRouting.billingMode}`
          + ` (expected ${serviceRouting.credentialSourceEnv})`,
        );
        finish({ text: null, failure: `No credential for ${serviceRouting.serviceName}.` });
        return;
      }
    }

    try {
      const child = execFile(
        binary,
        args,
        { timeout: 15_000, cwd: "/tmp", env, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const stderrTail = typeof stderr === "string" ? stderr.slice(-200).trim() : "";
            console.warn(
              `[session-namer] ${harnessId} CLI failed:`,
              error.message,
              stderrTail ? `stderr=${stderrTail}` : "",
            );
            finish({ text: null, failure: stderrTail || error.message });
            return;
          }
          finish({
            text: typeof stdout === "string" ? stdout : null,
            usage: { durationMs: Date.now() - startedAt },
          });
        },
      );

      // Detach stdin so the CLI doesn't sit waiting for piped input.
      child.stdin?.end();

      child.on("error", (err) => {
        console.warn(`[session-namer] ${harnessId} CLI spawn error:`, err.message);
        finish({ text: null, failure: err.message });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[session-namer] ${harnessId} CLI exception:`, message);
      finish({ text: null, failure: message });
    }
  });
}
