import { randomUUID } from "node:crypto";
import { provisionOpenCodeAccount, revokeOpenCodeAccount } from "./openai-account-delivery.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
import { opencodeModelArg, opencodeProviderConfig, isOpenCodeAccountRouting, opencodeAccountConfig, prepareOpenCodeAccountEnv } from "../shared/opencode-spawn-shaping.js";
import { parseOpencodeLine, OpencodeTurnAccumulator } from "../shared/opencode-stream.js";

export interface SessionName {
  slug: string;
  title: string;
}

/** Missing telemetry means unknown usage, not zero cost. */
export interface SessionNameUsage {
  durationMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

export interface SessionNameResult {
  /** Null keeps the placeholder title. */
  name: SessionName | null;
  usage?: SessionNameUsage;
  failure?: string;
}

export interface SessionNamingTarget {
  harnessId: AgentId;
  model?: string | undefined;
  serviceRouting?: ServiceRouting | undefined;
  credentialSecret?: string | undefined;
  /** Omission uses the orchestrator home, which can select a different account. */
  credentialRoot?: string | undefined;
}

const PROMPT_TEMPLATE = `Given this user message for a coding session, generate:
1. A short branch-friendly slug (lowercase, hyphens only, no special chars, max 40 chars)
2. A human-readable session title (max 60 chars)

User message: "{MESSAGE}"

Respond with ONLY valid JSON, no markdown fences: {"slug": "...", "title": "..."}`;

export async function generateSessionName(
  userMessage: string,
  target: SessionNamingTarget,
): Promise<SessionNameResult> {
  const { harnessId } = target;
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

interface CliRun {
  text: string | null;
  usage?: SessionNameUsage;
  failure?: string;
}

async function callAgentCli(prompt: string, target: SessionNamingTarget): Promise<CliRun> {
  const { harnessId, model, serviceRouting } = target;
  switch (harnessId) {
    case "claude": {
      // JSON output includes usage and cost.
      const args = ["-p", prompt, "--output-format", "json"];
      if (model) args.push("--model", model);
      const raw = await callCli("claude", args, target);
      if (raw.text === null) return raw;
      const parsed = parseClaudeJson(raw.text);
      if (!parsed.usage) return { ...raw, text: parsed.text };
      const durationMs = parsed.usage.durationMs || raw.usage?.durationMs || 0;
      return { text: parsed.text, usage: { ...parsed.usage, durationMs } };
    }
    case "codex": {
      // Serialize first-run initialization with turns using the same home.
      await ensureCodexHomeInitialized(path.join(namingHome(target), ".codex"));
      // Naming runs from /tmp, outside a trusted repository.
      const args = ["exec", "--json", "--skip-git-repo-check", ...codexProviderArgs(serviceRouting)];
      if (model) args.push("--model", model);
      args.push(prompt);
      const raw = await callCli("codex", args, target);
      if (raw.text === null) return raw;
      const parsed = parseCodexJsonl(raw.text);
      const failure = parsed.failure ? { failure: parsed.failure } : {};
      if (!parsed.usage) return { ...raw, text: parsed.text, ...failure };
      return {
        text: parsed.text,
        usage: { ...parsed.usage, durationMs: raw.usage?.durationMs ?? 0 },
        ...failure,
      };
    }
    case "opencode": {
      const args = ["run", "--format", "json", "--auto"];
      const extraEnv: Record<string, string> = {
        // OpenCode uses PWD before cwd to find its project.
        PWD: "/tmp",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_DISABLE_SHARE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      };
      let cleanupConfig: (() => void) | undefined;
      if (isOpenCodeAccountRouting(serviceRouting) && model) {
        if (!target.credentialRoot) return { text: null, failure: "ChatGPT account credentials are unavailable." };
        extraEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS = "0";
        extraEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(opencodeAccountConfig(model));
        const configPath = path.join(os.tmpdir(), `opencode-naming-${randomUUID()}.json`);
        fs.writeFileSync(configPath, JSON.stringify(opencodeAccountConfig(model)));
        extraEnv.OPENCODE_CONFIG = configPath;
        cleanupConfig = () => fs.rmSync(configPath, { force: true });
        args.push("--model", `openai/${model}`);
      } else if (serviceRouting && model) {
        const provider = opencodeProviderConfig(serviceRouting, model);
        if (!provider) {
          return {
            text: null,
            failure: `OpenCode cannot run ${serviceRouting.serviceId} over style ${serviceRouting.style}.`,
          };
        }
        const configPath = path.join(os.tmpdir(), `opencode-naming-${randomUUID()}.json`);
        fs.writeFileSync(configPath, JSON.stringify({ $schema: "https://opencode.ai/config.json", provider }));
        extraEnv.OPENCODE_CONFIG = configPath;
        cleanupConfig = () => {
          try { fs.unlinkSync(configPath); } catch { /* ignore */ }
        };
        args.push("--model", opencodeModelArg(model));
      } else if (model) {
        args.push("--model", model);
      }
      args.push(prompt);
      // Isolate each run's SQLite store and avoid the home's dangling credential symlink.
      const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-naming-data-"));
      extraEnv.XDG_DATA_HOME = dataHome;
      try {
        if (isOpenCodeAccountRouting(serviceRouting)) provisionOpenCodeAccount(target.credentialRoot!, target.credentialRoot!, serviceRouting.credentialTarget.accountId, dataHome);
        const isolatedTarget = isOpenCodeAccountRouting(serviceRouting) ? { ...target, credentialRoot: dataHome } : target;
        if (isOpenCodeAccountRouting(serviceRouting)) {
          extraEnv.XDG_CONFIG_HOME = path.join(dataHome, "config");
          extraEnv.XDG_CACHE_HOME = path.join(dataHome, "cache");
        }
        const raw = await callCli("opencode", args, isolatedTarget, extraEnv);
        if (raw.text === null) return raw;
        const parsed = parseOpencodeJsonl(raw.text);
        if (!parsed.usage) return { ...raw, text: parsed.text };
        return {
          text: parsed.text,
          usage: { ...parsed.usage, durationMs: raw.usage?.durationMs ?? 0 },
        };
      } finally {
        revokeOpenCodeAccount(target.credentialRoot ?? "", dataHome);
        cleanupConfig?.();
        try { fs.rmSync(dataHome, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    case "grok": {
      const args = ["-p", prompt, "--output-format", "json", "--always-approve", "--no-auto-update"];
      if (model) args.push("-m", model);
      // Avoid the home's potentially dangling credential symlink; auth comes from env.
      const grokHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-naming-home-"));
      const extraEnv: Record<string, string> = {
        GROK_HOME: grokHomeDir,
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_TELEMETRY_ENABLED: "0",
        DISABLE_TELEMETRY: "1",
        GROK_ERROR_REPORTING: "0",
        DISABLE_ERROR_REPORTING: "1",
      };
      if (serviceRouting) extraEnv.GROK_XAI_API_BASE_URL = serviceRouting.baseUrl;
      try {
        const raw = await callCli("grok", args, target, extraEnv);
        if (raw.text === null) return raw;
        const parsed = parseGrokJson(raw.text);
        if (!parsed.usage) return { ...raw, text: parsed.text };
        return {
          text: parsed.text,
          usage: { ...parsed.usage, durationMs: raw.usage?.durationMs ?? 0 },
        };
      } finally {
        try { fs.rmSync(grokHomeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }
}

// Grok returns text; Claude returns result. Their JSON envelopes are not interchangeable.
function parseGrokJson(stdout: string): { text: string | null; usage?: SessionNameUsage } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { text: stdout };
  }
  if (typeof parsed !== "object" || parsed === null) return { text: stdout };
  const envelope = parsed as {
    text?: unknown;
    total_cost_usd?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const usage: SessionNameUsage = {
    durationMs: 0,
    ...(num(envelope.total_cost_usd) !== undefined ? { costUsd: num(envelope.total_cost_usd) } : {}),
    ...(num(envelope.usage?.input_tokens) !== undefined ? { inputTokens: num(envelope.usage?.input_tokens) } : {}),
    ...(num(envelope.usage?.output_tokens) !== undefined ? { outputTokens: num(envelope.usage?.output_tokens) } : {}),
    ...(num(envelope.usage?.cache_read_input_tokens) !== undefined
      ? { cacheReadTokens: num(envelope.usage?.cache_read_input_tokens) }
      : {}),
    ...(num(envelope.usage?.cache_creation_input_tokens) !== undefined
      ? { cacheCreateTokens: num(envelope.usage?.cache_creation_input_tokens) }
      : {}),
  };
  const text = typeof envelope.text === "string" ? envelope.text : null;
  const hasTelemetry =
    usage.costUsd !== undefined
    || usage.inputTokens !== undefined
    || usage.outputTokens !== undefined;
  if (text === null) return { text: stdout };
  return hasTelemetry ? { text, usage } : { text };
}

function parseOpencodeJsonl(stdout: string): { text: string | null; usage?: SessionNameUsage } {
  const acc = new OpencodeTurnAccumulator();
  for (const line of stdout.split("\n")) {
    const event = parseOpencodeLine(line);
    if (event) acc.observe(event);
  }
  const text = acc.finalText.length > 0 ? acc.finalText : null;
  if (!acc.sawStepFinish) return { text };
  return {
    text,
    usage: {
      durationMs: 0,
      ...(acc.costUsd > 0 ? { costUsd: acc.costUsd } : {}),
      inputTokens: acc.input,
      outputTokens: acc.output,
      cacheReadTokens: acc.cacheRead,
      cacheCreateTokens: acc.cacheWrite,
    },
  };
}

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

// Codex input includes cached tokens, and output includes reasoning tokens.
// Error items can precede a successful answer; only report them when no answer arrives.
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

  // Preserve titles in plain or mixed output when no failure was reported.
  if (text === null && !errorMessage) return { text: stdout, ...(usage ? { usage } : {}) };
  return {
    text,
    ...(usage ? { usage } : {}),
    ...(text === null && errorMessage ? { failure: errorMessage } : {}),
  };
}

// Use the orchestrator home; agentHome() defaults to a session-only path.
// Initialization and spawn must resolve the same root.
function namingHome(target: SessionNamingTarget): string {
  return target.credentialRoot ?? process.env.HOME ?? "/root";
}

function callCli(
  binary: string,
  args: string[],
  target: SessionNamingTarget,
  extraEnv?: Record<string, string>,
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
    env.HOME = namingHome(target);
    if (extraEnv) Object.assign(env, extraEnv);
    // Ambient API keys can override the selected subscription's login.
    if (credentialRoot) scrubHarnessEnvCredentials(env, harnessId);
    if (serviceRouting && !isOpenCodeAccountRouting(serviceRouting)) {
      // Routing reads the storage variable and writes the harness variable.
      if (credentialSecret && serviceRouting.credentialSourceEnv) env[serviceRouting.credentialSourceEnv] = credentialSecret;
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

    if (isOpenCodeAccountRouting(serviceRouting)) prepareOpenCodeAccountEnv(env);
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

      // Close stdin so the CLI does not wait for piped input.
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
