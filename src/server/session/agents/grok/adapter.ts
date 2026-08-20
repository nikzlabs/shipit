/**
 * GrokAdapter — spawn-per-turn `grok -p` implementing AgentProcess
 * (docs/274-grok-build-harness). Claude-shaped: NDJSON on stdout, one process
 * per turn.
 *
 * The wire is the reason this adapter is small. Grok Build's
 * `--output-format streaming-messages-json` is Claude Code's `stream-json`
 * **near verbatim** — `system`/`init`, `assistant`/`user` envelopes holding
 * Anthropic Messages objects, a terminal `result` with `total_cost_usd` and
 * `usage` — so the event mapping mirrors `claude/adapter.ts` rather than
 * inventing a vocabulary. Every fact below was verified against CLI 1.0.1 in a
 * container on 2026-08-18; the captures that prove them are replayed byte-for-
 * byte by `adapter.test.ts`.
 *
 * Three places it is NOT Claude, each load-bearing:
 *
 *  - **The prompt goes in a FILE** (`--prompt-file`), not on argv and not on
 *    stdin. `-p <PROMPT>` is argv, which has a 128 KiB per-argument ceiling on
 *    Linux that assembled prompts exceed; `--prompt-file` is first-party and
 *    was verified to run a full turn.
 *  - **The session id is PRE-ASSIGNED** (`-s <uuid>`), not parsed out of the
 *    stream. Verified: a new conversation adopts the caller's UUID and both the
 *    init and result events carry it back, so ShipIt never has to race the
 *    first event to learn what to resume.
 *  - **MCP config has exactly one delivery path: `$GROK_HOME/config.toml`**,
 *    so this adapter gives every spawn a config root of its OWN. There is no
 *    `--mcp-config` flag and no config-pointing env var — probed directly:
 *    `GROK_CONFIG` and `GROK_CONFIG_PATH` are both inert (the init event
 *    reported `mcp_servers: []` under each), and neither name appears in the
 *    binary. That single fixed path is a problem, because a container can have
 *    TWO grok processes alive at once — a turn, plus a `shipit agent run`
 *    sub-agent spawned during it — and the worker builds the sub-agent's
 *    adapter with no scoped home, so both resolve the same root. Sharing one
 *    mutable `config.toml` between them means whichever finishes last decides
 *    what is left on disk. So each spawn writes into a throwaway root and
 *    symlinks `sessions/` (and `auth.json`, when there is one) back to the real
 *    one. Verified live: MCP servers connect, session state writes through the
 *    link, and `-r` resumes a conversation started under a *different*
 *    throwaway root.
 *
 *    **`auth.json` is not safe as a symlink alone** (planning#448). The CLI
 *    refreshes by atomic-rename onto `$GROK_HOME/auth.json`, which *replaces*
 *    the symlink with a regular file. The live token then lives only in the
 *    throwaway root — the session credentials copy the orchestrator watches
 *    never moves, so publish-back is a no-op and `rmSync` at turn end would
 *    delete the rotation. `publishSpawnAuthBack` copies a replaced file back
 *    onto the shared root (freshness-guarded) so the existing token-sync path
 *    can see it.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChild } from "../../../shared/kill-child.js";
import { GROK_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { HARNESSES } from "../../../shared/catalogue/harnesses.js";
import { GROK_PERMISSION_MODES } from "../../../shared/types/agent-types.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentContentBlock,
  AgentEvent,
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
  McpServerStatus,
} from "../agent-process.js";
import { resolveAgentHome, grokHome, type AgentHomeResolver } from "../../../shared/agent-home.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { PLAYWRIGHT_MCP_ARGS, PLAYWRIGHT_MCP_COMMAND } from "../playwright-mcp.js";
import { parseGrokLine, type GrokEvent } from "./stream.js";
import { normalizeGrokToolCall, normalizeGrokToolResult } from "./grok-tool-normalizer.js";
import { renderGrokConfigToml, type GrokMcpServer } from "./config-toml.js";

const GROK_REASONING = HARNESSES.find((h) => h.id === "grok")?.capabilities.reasoning;

/**
 * A `node_modules/.bin` directory, as a PATH entry.
 *
 * Anchored at the END so it matches the directory itself and not a package that
 * merely lives under one, and tolerant of a trailing separator because a PATH
 * entry may carry one.
 */
const NPM_BIN_DIR = /(^|[\\/])node_modules[\\/]\.bin[\\/]?$/;

/**
 * The grok binary a spawn must exec — resolved to an absolute path, never left
 * to `$PATH` (planning#444).
 *
 * `@xai-official/grok` publishes TWO different programs under the same name,
 * and until now ShipIt got the wrong one:
 *
 *   - `node_modules/.bin/grok` is a JS **launcher**. Its own resolution order
 *     starts at `$GROK_HOME/bin/grok`, and when that is absent it BOOTSTRAPS —
 *     decompressing the ~157 MB platform payload into `$GROK_HOME`. This
 *     adapter gives every spawn a fresh throwaway `GROK_HOME` (see the header),
 *     so the launcher would pay that 157 MB on EVERY TURN, and write it into
 *     the per-session credentials volume whenever the real root is usable.
 *     That is verbatim the cost planning#442 exists to prevent.
 *   - `/usr/local/bin/grok` is the installer's link straight at the decompressed
 *     platform binary (`install-agent-clis.sh` → `harness_link_target`), which
 *     needs no bootstrap and writes no payload anywhere.
 *
 * Every image prepends `/opt/agent-cli/node_modules/.bin` to `PATH`, so the
 * launcher WINS a bare-name lookup — measured in a live container:
 * `command -v grok` answered `/opt/agent-cli/node_modules/.bin/grok`. The
 * installer's comment claimed "PATH points straight at it and the launcher is
 * never involved"; that was false as shipped. The installer now unlinks the
 * shim, and this resolver is the second half: it skips any `node_modules/.bin`
 * candidate outright, so an image built before that change still spawns the
 * real binary.
 *
 * Falls back to the bare name when nothing else on `PATH` answers — a spawn
 * that runs the launcher is bad, and a spawn that runs nothing is worse.
 */
export function resolveGrokBinary(pathEnv = process.env.PATH ?? ""): string {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || NPM_BIN_DIR.test(dir)) continue;
    const candidate = path.join(dir, "grok");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable — keep looking.
    }
  }
  console.warn(
    "[grok] no grok binary on PATH outside node_modules/.bin — falling back to the bare name, "
      + "which may resolve to the npm launcher (a 157MB bootstrap into this turn's GROK_HOME)",
  );
  return "grok";
}

/**
 * Harness-compatibility toggles, set explicitly on every spawn (docs/274).
 *
 * `grok inspect` shows Grok reading OTHER agents' project files by default —
 * Claude's and Cursor's skills, rules, agents, MCP servers, hooks and sessions,
 * plus Codex sessions — each behind a `GROK_<VENDOR>_<AREA>_ENABLED` toggle.
 * Left alone, a ShipIt turn would pick up `.claude/settings.json`, `.mcp.json`
 * and hook definitions behind ShipIt's back, on a repo ShipIt configured for a
 * different harness.
 *
 * So every toggle is stated rather than defaulted, and the two left ON are the
 * two ShipIt WANTS: `.claude/skills` disclosure (verified live — Grok surfaces
 * both `.grok/skills` and `.claude/skills`, which is why no symlink is needed)
 * and Claude rules (`CLAUDE.md`, alongside the `AGENTS.md` it reads natively).
 * Everything that could execute code or redirect a tool is off.
 */
const COMPAT_TOGGLES: Record<string, string> = {
  GROK_CLAUDE_SKILLS_ENABLED: "1",
  GROK_CLAUDE_RULES_ENABLED: "1",
  GROK_CLAUDE_MCPS_ENABLED: "0",
  GROK_CLAUDE_HOOKS_ENABLED: "0",
  GROK_CLAUDE_AGENTS_ENABLED: "0",
  GROK_CLAUDE_SESSIONS_ENABLED: "0",
  GROK_CURSOR_SKILLS_ENABLED: "0",
  GROK_CURSOR_RULES_ENABLED: "0",
  GROK_CURSOR_MCPS_ENABLED: "0",
  GROK_CURSOR_HOOKS_ENABLED: "0",
  GROK_CURSOR_AGENTS_ENABLED: "0",
  GROK_CURSOR_SESSIONS_ENABLED: "0",
  GROK_CODEX_SESSIONS_ENABLED: "0",
};

/**
 * How long the process gets to exit on its own after the terminal `result`
 * before the adapter kills it.
 *
 * Grok exits promptly by itself in every observed run. This is the OpenCode
 * lesson applied pre-emptively rather than a defect being worked around: MCP
 * children can hold a CLI's event loop open indefinitely, and a turn that has
 * already delivered its result must not be what keeps the session busy.
 */
const RESULT_EXIT_GRACE_MS = 5_000;

/**
 * How often to stat `$GROK_HOME/auth.json` for a CLI rotation that replaced
 * the symlink (planning#448). Bounds the window the mid-turn publisher
 * (docs/153) cannot see to roughly this plus its own poll. Cleanup always
 * publishes once more, so a missed poll cannot strand the token.
 */
const SPAWN_AUTH_WATCH_MS = 1_000;

/**
 * Best-effort `expires_at` from a grok `auth.json`, for copy-back ordering
 * only.
 *
 * The orchestrator's `readXaiTokenFreshnessFile` is the reader that guards
 * publish-back; this one exists so the session adapter does not import the
 * orchestrator package to answer a single question — "is the throwaway copy
 * newer than the shared root?". Both walk the same scope-keyed `expires_at`
 * ISO string the live file actually writes. A parse failure here fails
 * closed (do not overwrite a dest we cannot prove is older).
 */
function grokAuthExpiryMs(file: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const rec of Object.values(parsed as Record<string, unknown>)) {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const raw = (rec as Record<string, unknown>).expires_at;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const t = Date.parse(raw);
      if (Number.isFinite(t) && t > 0) return t;
    }
  } catch {
    // missing / unreadable / not JSON
  }
  return null;
}

/** Copy `src` onto `dst` via temp + rename so a concurrent reader never sees a partial write. */
function atomicCopyFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o600);
  try {
    fs.renameSync(tmp, dst);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export class GrokAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "grok";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    // Mirrors the catalogue row (docs/274), where the live probe is recorded:
    // the image content block is accepted and its content does not reach the
    // model. Verified false, not merely unobserved.
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: GROK_PERMISSION_MODES,
    toolNames: [...GROK_TOOL_NAMES],
    // Which models exist is a property of the service join, not the CLI
    // (docs/252); the registry resolves them. Nothing reads this field off a
    // live adapter (ProxyAgentProcess hardcodes its own stub).
    models: [],
    ...(GROK_REASONING ? { reasoning: GROK_REASONING } : {}),
    // Mirrors the catalogue row, where the probe is recorded (planning#459).
    supportsReview: true,
    supportsSteering: false,
    // docs/276 — the CLI intercepts `/compact` in the prompt in headless mode
    // (Claude's in-band shape), so `run({ compact: true })` is the whole
    // mechanism and needs no special argv.
    supportsCompaction: true,
    skillsDirName: ".grok",
    skillInvocationPrefix: "/",
  };

  private readonly resolveHome: AgentHomeResolver | undefined;
  /** Injectable for tests — replays captured streams without a real CLI. */
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stderrBuffer = "";
  private promptPath: string | null = null;
  private systemPromptPath: string | null = null;
  /**
   * docs/276 — true when this turn was spawned purely to compact
   * (`run({ compact: true })`), so the `compact_boundary` it produces can be
   * labeled `"manual"`.
   *
   * This correlation is not optional politeness, it is the only way to tell:
   * Grok stamps `compact_metadata.trigger` `"auto"` on EVERY compaction,
   * including one it performed because ShipIt asked (verified — the manual
   * `/compact` runs that produced the docs/276 token measurements all reported
   * `"auto"` on the wire while writing `"trigger": "manual"` into their own
   * `compaction_requests/` record). Trusting the wire field would mislabel
   * every user-triggered compaction. Same fix, same reason, as Codex's
   * `compactionRequested`.
   */
  private compactionRequested = false;
  /** This turn's throwaway config root, removed wholesale at turn end. */
  private spawnHome: string | null = null;
  /**
   * The shared-root `auth.json` this turn linked (and must copy a CLI rotation
   * back onto). Null in key mode and on the self-contained fallback, where
   * there is no durable file to publish to.
   */
  private spawnAuthDest: string | null = null;
  /** Stat-poller that copies a CLI-replaced `auth.json` back mid-turn. */
  private spawnAuthWatch: { path: string; listener: () => void } | null = null;
  /**
   * Whether this turn's config root reaches a real `auth.json` — i.e. whether a
   * subscription login is what authenticates it.
   *
   * Set by {@link makeSpawnHome}, which is the one place that knows: it is the
   * step that links the durable `auth.json` in, and it is also the step that can
   * FAIL to (an unusable shared root falls back to a self-contained one with no
   * link, and a turn that believed it had a login there would then scrub its own
   * only credential).
   */
  private spawnHomeHasAuth = false;
  private resultKillTimer: NodeJS.Timeout | null = null;
  private interruptKillTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /** The id this turn runs under — pre-assigned, so it is known before the CLI starts. */
  private turnSessionId = "";
  private sawResult = false;
  private sawAnyEvent = false;
  private latestCallContextTokens: number | undefined;
  /**
   * This turn's tool_use id → RAW wire tool name. Grok's tool_result blocks
   * carry only the id, so result normalization (`normalizeGrokToolResult`)
   * needs the call side remembered. Reset per run(): the CLI is spawn-per-turn,
   * so a result always lands in the same turn as its call.
   */
  private turnCallNames = new Map<string, string>();
  /** Resolved MCP servers, captured by writeMcpConfig for run() to render. */
  private pendingMcpServers: Record<string, GrokMcpServer> = {};

  constructor(opts?: {
    resolveHome?: AgentHomeResolver;
    spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.spawnFn = opts?.spawnFn ?? nodeSpawn;
  }

  /**
   * One process per turn, no resident stream. `startsOwnTurns` is false for the
   * same reason: this CLI cannot begin a turn ShipIt did not ask for.
   */
  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    if (this.proc) {
      this.emit("error", new Error("Grok adapter: run() called while a turn is in flight"));
      return;
    }
    this.sawResult = false;
    this.sawAnyEvent = false;
    this.latestCallContextTokens = undefined;
    this.turnCallNames.clear();
    // docs/276 — a compaction spawn needs NO special argv. Grok intercepts a
    // leading `/compact` in the prompt itself (the Claude shape, not Codex's
    // out-of-band RPC), and `params.prompt` already IS `/compact` on this path,
    // so the ordinary spawn below carries the trigger. All this flag does is
    // label the resulting boundary; see the field's docstring for why the
    // wire's own `trigger` cannot.
    this.compactionRequested = params.compact === true;
    if (this.compactionRequested) {
      // Grok emits no progress event for compaction (Claude's
      // `status:"compacting"` has no Grok counterpart), so the "Compacting…"
      // indicator would never appear. We know we asked for it, so say so.
      this.emit("event", { type: "agent_compaction_started", trigger: "manual" });
    }

    // Pre-assign rather than parse (verified live): `-s <uuid>` on a new
    // conversation is adopted verbatim and echoed on both init and result, so
    // the id ShipIt will resume with is known before the CLI has spoken. `-r`
    // takes over once there is one to resume.
    this.turnSessionId = params.sessionId ?? randomUUID();

    const args = [
      "--output-format", "streaming-messages-json",
      "--no-auto-update",
      "--cwd", params.cwd,
    ];
    args.push(params.sessionId ? "-r" : "-s", this.turnSessionId);

    // ShipIt's three permission modes onto Grok's wider native set. `auto` is
    // `--always-approve` (the container IS the sandbox); `guarded` is Grok's
    // own classifier-gated `auto`, which collides by name with ShipIt's — the
    // one place the two vocabularies use the same word for different things.
    switch (params.permissionMode) {
      case "plan":
        args.push("--permission-mode", "plan");
        break;
      case "guarded":
        args.push("--permission-mode", "auto");
        break;
      default:
        args.push("--always-approve");
        break;
    }

    if (params.model) args.push("-m", params.model);

    // `--reasoning-effort` IS passed now (planning#435), and the gate that
    // decides whether it means anything is upstream rather than here.
    //
    // The flag reaches the wire under a SUBSCRIPTION and is silently discarded
    // under an API key — both recorder-verified with a negative control. That
    // gate is `capabilities.reasoning.billingModes` in the catalogue, composed
    // by `reasoningOptionsFor`, so a key-billed selection can offer no level for
    // a user, a role or a reviewer to pick and nothing arrives here to pass on.
    // Re-testing the billing mode in the adapter would be a second copy of one
    // rule; what the adapter owes is delivering what it was given.
    if (params.reasoningEffort) args.push("--reasoning-effort", params.reasoningEffort);

    if (params.systemPrompt) {
      // `--rules <FILE>` APPENDS to the CLI's own system prompt;
      // `--system-prompt-override` would replace it, discarding Grok's own tool
      // instructions along with it. ShipIt's prompt is standing instructions,
      // not a replacement for the harness's operating manual.
      this.systemPromptPath = `/tmp/grok-system-prompt-${randomUUID()}.md`;
      try {
        fs.writeFileSync(this.systemPromptPath, params.systemPrompt);
        args.push("--rules", this.systemPromptPath);
      } catch (err) {
        this.systemPromptPath = null;
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    // Env discipline — the order is load-bearing and is claude/process.ts's:
    // HOME first, then the credential scrub, then service delivery, because the
    // scrub deletes the very variable the delivery writes.
    const scopedHome = this.resolveHome?.();
    const home = resolveAgentHome(scopedHome);
    const configRoot = this.makeSpawnHome(grokHome(home));
    if (configRoot === null) {
      // Nothing usable to point GROK_HOME at. Fail loudly rather than spawn: the
      // CLI's own error for a broken config root names no path (planning#444).
      this.cleanupTurnFiles();
      this.emit(
        "error",
        new Error(
          `Grok: could not create a config root for this turn under ${os.tmpdir()}. The turn was not started.`,
        ),
      );
      return;
    }
    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      // This turn's own config root — NOT `$HOME/.grok`, which two concurrent
      // spawns would fight over (see the header). It carries this turn's
      // `config.toml` and links back to the real root for everything durable.
      GROK_HOME: configRoot,
      // The pinned binary must never self-replace (dependency policy). Belt
      // and braces with `--no-auto-update` above: the flag covers this
      // invocation, the env var covers anything it spawns.
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      DISABLE_TELEMETRY: "1",
      GROK_ERROR_REPORTING: "0",
      DISABLE_ERROR_REPORTING: "1",
      // Tags xAI's OAuth flow with the integrating product, the way T3 Code
      // sends `t3code` (docs/274, prior art). Inert on the key-billed path
      // ShipIt launches with; set now so the subscription work of planning#435
      // is not attributed to nobody.
      GROK_OAUTH2_REFERRER: "shipit",
      ...COMPAT_TOGGLES,
    };
    // Grok prefers `XAI_API_KEY` over its on-disk login, and `GROK_AUTH` /
    // `GROK_AUTH_PATH` redirect it at a different token store entirely — any
    // one of them inherited from the worker would silently bill the wrong
    // account. Scrub them all, then deliver exactly one.
    //
    // **Gated on there being a credential to deliver**, which is Claude's rule
    // (`claude/process.ts` scrubs only under a scoped home) reached from the
    // other direction. Scrubbing unconditionally looked stricter and was a
    // trap: an unrouted spawn would have its ambient key removed and nothing
    // put back, so it fails at the CLI with an auth error that names no cause.
    // Every catalogue selection Grok can run carries routing (one service, key
    // mode), so this branch is the manual/dogfood path — where "use the key in
    // my environment" is the only thing an unrouted spawn could mean.
    if (params.serviceRouting) {
      scrubHarnessEnvCredentials(spawnEnv, "grok");
      const routing = params.serviceRouting;
      const secret = process.env[routing.credentialSourceEnv];
      if (!secret || routing.credentialTarget.kind !== "env") {
        console.warn(
          `[grok] no credential in the environment for ${routing.serviceId}` +
            `/${routing.billingMode} (expected ${routing.credentialSourceEnv})`,
        );
        this.cleanupTurnFiles();
        this.emit("auth_required");
        return;
      }
      spawnEnv[routing.credentialTarget.name] = secret;
      spawnEnv.GROK_XAI_API_BASE_URL = routing.baseUrl;
      console.log(
        `[grok] service routing: ${routing.serviceId}/${routing.billingMode} -> ${routing.baseUrl}`,
      );
    } else if (this.spawnHomeHasAuth) {
      // **A SUBSCRIPTION turn, and the scrub is the whole of its credential
      // handling** (planning#435). An account-delivered credential carries no
      // routing at all — `serviceRoutingForSelection` returns nothing for one,
      // because a login IS the vendor's own and its token exchange is bound to
      // the vendor's own endpoint — so the branch above never runs and the CLI
      // reaches `cli-chat-proxy.grok.com` by itself off `auth.json`.
      //
      // Which is exactly why the env has to be scrubbed here rather than only
      // there. Grok prefers `XAI_API_KEY` over its on-disk login, and the worker
      // is handed every stored service credential regardless of which route the
      // turn is pinned to (`collectServiceCredentialEnv`) — so an install that
      // has ever saved an xAI key would have every "subscription" turn silently
      // billed to that key, with ShipIt attributing it to the account. Same for
      // `GROK_AUTH` / `GROK_AUTH_PATH`, which redirect the CLI at a different
      // token store and defeat the scoped home just as thoroughly.
      //
      // The gate is the auth FILE, not a scoped home: `resolveHome` is undefined
      // inside a container (the image symlinks `~/.grok` at the per-session
      // credentials mount instead), so a scoped-home test — Claude's shape —
      // would be false on the one path that matters most. This is the Codex
      // adapter's rule, which deletes `OPENAI_API_KEY` when file auth wins.
      scrubHarnessEnvCredentials(spawnEnv, "grok");
      console.log("[grok] subscription login on disk — env credentials scrubbed so it cannot be out-preferred");
    }

    // The prompt is a file, not argv (see the header). Written before the
    // config so a failure here leaves no config.toml behind to restore.
    this.promptPath = `/tmp/grok-prompt-${randomUUID()}.txt`;
    try {
      fs.writeFileSync(this.promptPath, params.prompt);
    } catch (err) {
      this.promptPath = null;
      this.cleanupTurnFiles();
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    args.push("--prompt-file", this.promptPath);

    // An absolute path, never the bare name — see `resolveGrokBinary`. Logged
    // because "which grok did this turn run" is exactly the question planning#444
    // could not answer from the outside.
    const binary = resolveGrokBinary();

    console.log(
      "[grok] spawning:", binary, args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(params.prompt)} | cwd:`, params.cwd,
    );

    try {
      this.proc = this.spawnFn(binary, args, {
        cwd: params.cwd,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.cleanupTurnFiles();
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.proc = null;
      return;
    }

    this.buffer = "";
    this.stderrBuffer = "";
    this.armWatchdog();

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.armWatchdog();
      this.buffer += chunk.toString("utf-8");
      this.drainLines();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.armWatchdog();
      this.stderrBuffer += chunk.toString("utf-8");
      this.drainStderrLines();
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    this.proc.on("close", (exitCode) => {
      this.clearTimers();
      this.drainLines(true);
      this.drainStderrLines(true);
      this.cleanupTurnFiles();
      if (!this.sawResult) this.emitSynthesizedResult(exitCode);
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });
  }

  /**
   * Warn-only inactivity watchdog (Claude parity — `claude/process.ts`).
   *
   * It deliberately does NOT kill, and Grok gives it a specific job: on an
   * upstream 5xx the CLI retries internally and emits NOTHING to stdout while
   * it does (observed against the recorder). A silent minute is therefore a
   * real state the CLI reaches on its own, not necessarily a hang — so this
   * narrates and leaves the decision to the user, whose interrupt is the
   * escape hatch.
   */
  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      console.warn("[grok] no output for 60s — the CLI may be retrying upstream (it is silent while it does)");
      this.emit("log", "server", "Warning: no output from the Grok CLI for 60 seconds. It may be retrying an upstream error; interrupting the turn is safe.");
    }, 60_000);
  }

  /**
   * Build this turn's throwaway config root and return the path to use as
   * `GROK_HOME`.
   *
   * It holds this turn's `config.toml` — the only way to deliver MCP servers —
   * and symlinks the two things that must OUTLIVE the turn back to the real
   * root: `sessions/`, without which `-r` could not resume, and `auth.json`
   * when one exists (key mode has none). The `auth.json` link is the starting
   * state, not the finishing one: the CLI's refresh rename replaces it, and
   * {@link publishSpawnAuthBack} is what makes the rotation durable
   * (planning#448). Everything else the CLI writes there (logs, caches, its
   * bundled docs) is genuinely per-run and goes away with the directory.
   *
   * **It never returns a root it has just proven unusable** (planning#444).
   *
   * The previous fallback returned `realRoot` on any failure, arguing that "a
   * turn that runs against the shared root might race a concurrent spawn over
   * one file, while a turn refused for a mkdir is no turn at all". That reasoning
   * assumes the shared root WORKS, and the one failure it actually met was the
   * case where it does not: every session image symlinks `~/.grok` at
   * `/credentials/.grok`, key-billed Grok writes no credential material, so
   * nothing created the target and the link DANGLED. A recursive `mkdir` through
   * a dangling symlink throws (ENOENT on Node's recursive form; the raw syscall
   * reports EEXIST, because the link is an existing directory entry — the same
   * trap `shared/opencode-data-dir.ts` documents). The `catch` then handed the
   * CLI that very path as `GROK_HOME`, which died at its own session creation
   * with `FS_OTHER / "File exists (os error 17)"` and `duration_ms: 0`, before
   * emitting any stream event. A silent fallback onto a broken path turned a
   * repairable condition into a total turn failure naming no cause.
   *
   * So the throwaway root is built FIRST and unconditionally, and linking the
   * durable state back is what may fail. When it does, the turn still runs — on
   * a fully self-contained root, with a local `sessions/` so the CLI can create
   * its session — and the condition is narrated to the transcript rather than
   * swallowed. What is lost in that state is cross-turn resume (this turn's
   * session state goes away with the directory) and any `auth.json`, which is
   * strictly more than the zero turns the old behaviour delivered.
   *
   * Returns `null` only when even a temp root could not be made — a genuinely
   * unusable `os.tmpdir()`. The caller fails the turn loudly instead of spawning.
   */
  private makeSpawnHome(realRoot: string): string | null {
    this.spawnHomeHasAuth = false;
    this.unwatchSpawnAuth();
    this.spawnAuthDest = null;
    let spawnHome: string;
    try {
      spawnHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    } catch (err) {
      console.error(`[grok] could not create a per-spawn config root under ${os.tmpdir()}: ${String(err)}`);
      this.spawnHome = null;
      return null;
    }
    this.spawnHome = spawnHome;

    try {
      // Created rather than assumed: on a cold credentials tree the directory
      // does not exist yet. This is also the line that fails when `realRoot` is
      // a dangling symlink — deliberately not "repaired" here, because the
      // credentials tree is per-session and uid-sensitive (docs/150, docs/270)
      // and the orchestrator owns what is created inside it.
      fs.mkdirSync(realRoot, { recursive: true });
      const sessions = path.join(realRoot, "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.symlinkSync(sessions, path.join(spawnHome, "sessions"));
      const auth = path.join(realRoot, "auth.json");
      if (fs.existsSync(auth)) {
        fs.symlinkSync(auth, path.join(spawnHome, "auth.json"));
        this.spawnHomeHasAuth = true;
        this.spawnAuthDest = auth;
        this.watchSpawnAuth(path.join(spawnHome, "auth.json"));
      }
    } catch (err) {
      console.warn(
        `[grok] the shared config root ${realRoot} is unusable (${String(err)}) — running this turn on a `
          + "self-contained root instead. Cross-turn resume and any auth.json there are unavailable until it is repaired.",
      );
      // BILLING, not just resume. `spawnHomeHasAuth` stays false here, so the
      // subscription scrub below does not fire — and if the worker's environment
      // carries `XAI_API_KEY` (it does whenever the install has ever stored one),
      // the CLI silently falls back to that key while ShipIt attributes the turn
      // to the account. That needs two unlikely states at once, which is exactly
      // why it must be said out loud rather than left to be inferred from a
      // resume warning. Raised in review of planning#435.
      if (process.env.XAI_API_KEY) {
        console.warn(
          "[grok] …and XAI_API_KEY is present, so a subscription-pinned turn would authenticate with "
            + "the METERED KEY instead. Repair the config root before trusting this turn's attribution.",
        );
      }
      this.emit(
        "log",
        "server",
        `Warning: Grok's config root (${realRoot}) could not be prepared, so this turn runs on a temporary one. `
          + "Conversation resume is unavailable until it is repaired.",
      );
      try {
        // A local sessions/ rather than a link: the CLI creates a session before
        // it does anything, and the whole failure this replaces was that step.
        fs.mkdirSync(path.join(spawnHome, "sessions"), { recursive: true });
      } catch {
        // The CLI makes its own under a writable GROK_HOME; nothing more to do.
      }
    }

    try {
      fs.writeFileSync(path.join(spawnHome, "config.toml"), renderGrokConfigToml(this.pendingMcpServers));
    } catch (err) {
      console.warn(`[grok] could not write this turn's config.toml: ${String(err)} — the turn runs without MCP servers`);
    }
    return spawnHome;
  }

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    this.buffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseGrokLine(line);
      if (!event) continue;
      this.handleEvent(event);
    }
    if (flush && this.buffer) this.buffer = "";
  }

  private drainStderrLines(flush = false): void {
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.warn("[grok] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    }
  }

  private handleEvent(raw: GrokEvent): void {
    this.sawAnyEvent = true;

    // docs/088 parity — the init event carries per-server MCP status, which is
    // what makes a dropped server visible instead of merely absent.
    if (raw.type === "system" && raw.subtype === "init" && raw.mcp_servers) {
      const statuses: McpServerStatus[] = raw.mcp_servers.map((s) =>
        s.status === "connected"
          ? { name: s.name, state: "loaded" }
          : { name: s.name, state: "failed", reason: `status: ${s.status}` },
      );
      if (statuses.length > 0) this.emit("mcp_status", statuses);
    }

    const mapped = this.mapEvent(raw);
    if (mapped) this.emit("event", mapped);

    if (raw.type === "result") {
      this.sawResult = true;
      // The turn is over as far as ShipIt is concerned. Grok exits on its own
      // promptly, so this timer normally never fires; it exists so an MCP
      // child holding the event loop open cannot keep the session busy.
      if (!this.resultKillTimer && this.proc) {
        this.resultKillTimer = setTimeout(() => {
          this.resultKillTimer = null;
          if (this.proc) killChild(this.proc, "SIGTERM");
        }, RESULT_EXIT_GRACE_MS);
      }
    }
  }

  /**
   * Record one model call's prompt size.
   *
   * Same rule as the Claude adapter's: real context occupancy is the LAST
   * call's `input + cache_read + cache_creation`, because the result event's
   * totals are sums across every call in the turn and would report a multiple
   * of the true prompt size. Grok's result carries no per-iteration list at
   * all, so this running value is the ONLY source — dropping it would leave
   * the context dial empty on every turn.
   */
  private recordCallContext(usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): void {
    if (!usage) return;
    const contextTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    // An output-only or zeroed usage object has no context reading. Do not turn
    // it into an authoritative zero that empties the dial.
    if (contextTokens > 0) this.latestCallContextTokens = contextTokens;
  }

  /**
   * Translate every tool_use block in an assistant envelope to the transcript
   * vocabulary (`grok-tool-normalizer.ts`), remembering the RAW name by call id
   * for the result side. Non-tool blocks (text, thinking) pass by reference —
   * the wire carries block types the `AgentContentBlock` union doesn't name,
   * and this touches only what it recognizes.
   */
  private normalizeToolCalls(content: AgentContentBlock[]): AgentContentBlock[] {
    return content.map((block) => {
      if (block?.type !== "tool_use" || typeof block.name !== "string") return block;
      this.turnCallNames.set(block.id, block.name);
      const { name, input } = normalizeGrokToolCall(
        block.name,
        typeof block.input === "object" && block.input !== null ? block.input : {},
      );
      return { ...block, name, input };
    });
  }

  /** Unwrap recognized result envelopes (the subagent report — see the normalizer). */
  private normalizeToolResults(content: AgentContentBlock[]): AgentContentBlock[] {
    return content.map((block) => {
      // tool_result blocks are not in the AgentContentBlock union but ride the
      // wire and the persisted transcript unchanged — read them structurally.
      const result = block as unknown as { type?: string; tool_use_id?: string; content?: unknown };
      if (result?.type !== "tool_result" || typeof result.content !== "string") return block;
      const rawName = result.tool_use_id ? this.turnCallNames.get(result.tool_use_id) : undefined;
      if (!rawName) return block;
      const normalized = normalizeGrokToolResult(rawName, result.content);
      if (normalized === result.content) return block;
      return { ...block, content: normalized } as unknown as AgentContentBlock;
    });
  }

  /** Convert one raw Grok event into the normalized AgentEvent schema. */
  private mapEvent(raw: GrokEvent): AgentEvent | null {
    switch (raw.type) {
      case "system":
        // docs/276 — Grok's compaction boundary is byte-for-byte Claude's:
        // `system`/`subtype:"compact_boundary"` carrying `compact_metadata`.
        // It reports `pre_tokens` but NO `post_tokens` and no `duration_ms`,
        // and the card degrades to the fields it does have.
        if (raw.subtype === "compact_boundary") {
          const pre = raw.compact_metadata?.pre_tokens;
          return {
            type: "agent_compacted",
            // NOT `raw.compact_metadata.trigger` — it is always `"auto"`. See
            // `compactionRequested`.
            trigger: this.compactionRequested ? "manual" : "auto",
            ...(typeof pre === "number" ? { preTokens: pre } : {}),
          };
        }
        if (raw.subtype !== "init") return null;
        return {
          type: "agent_init",
          agentId: "grok",
          sessionId: raw.session_id ?? this.turnSessionId,
          ...(raw.model ? { model: raw.model } : {}),
          ...(raw.tools ? { tools: raw.tools } : {}),
        };

      case "assistant":
        // `parent_tool_use_id` is carried for parity with Claude's subagent
        // transparency, but it was NULL on every event of every capture,
        // including turns that ran `spawn_subagent` — Grok does not stream a
        // subagent's internals headlessly, only the spawn's tool_result. So
        // the transcript shows a subagent's report, never its work, and that
        // is the CLI's behaviour rather than a mapping gap.
        if (!raw.parent_tool_use_id) this.recordCallContext(raw.message?.usage);
        return {
          type: "agent_assistant",
          // Raw wire names miss every recognition registry (planning#437) —
          // translate to the transcript vocabulary before anything persists.
          content: this.normalizeToolCalls(raw.message?.content ?? []),
          ...(raw.parent_tool_use_id ? { parentToolUseId: raw.parent_tool_use_id } : {}),
        };

      case "user":
        // Grok has no `--replay-user-messages` equivalent, so unlike Claude
        // every `user` event on this wire is a tool result rather than a steer
        // echo. There is no `isReplay` branch because there is nothing that
        // would set it.
        return {
          type: "agent_tool_result",
          // The subagent envelope would render as raw JSON where the report
          // belongs — unwrap before anything persists (planning#437).
          content: this.normalizeToolResults(raw.message?.content ?? []),
          ...(raw.parent_tool_use_id ? { parentToolUseId: raw.parent_tool_use_id } : {}),
        };

      case "result": {
        const u = raw.usage;
        // Token semantics are DISJOINT — verified arithmetically on a real
        // terminal event (29623 + 88128 + 0 + 857 + 0 = 118608 = the total), so
        // unlike Codex this backend needs no `<id>-token-usage.ts` normalizer
        // and these figures can be summed as they stand.
        const contextTokens = this.latestCallContextTokens;
        this.latestCallContextTokens = undefined;
        // Authoritative window from `modelUsage.<model>.contextWindow`; prefer
        // the largest across models touched in the turn, matching Claude.
        let contextWindow: number | undefined;
        for (const m of Object.values(raw.modelUsage ?? {})) {
          if (m?.contextWindow && (!contextWindow || m.contextWindow > contextWindow)) {
            contextWindow = m.contextWindow;
          }
        }
        // `subtype` is not the success flag — the same trap Claude's adapter
        // documents. An API-error turn ends `subtype: "success"` with
        // `is_error: true`, so both signals decide it.
        const errored = raw.is_error === true || (raw.subtype !== undefined && raw.subtype !== "success");
        return {
          type: "agent_result",
          status: errored ? "error" : "success",
          sessionId: raw.session_id ?? this.turnSessionId,
          ...(typeof raw.total_cost_usd === "number" ? { cost: { totalUsd: raw.total_cost_usd } } : {}),
          ...(u && (u.input_tokens !== undefined || u.output_tokens !== undefined)
            ? {
                tokens: {
                  input: u.input_tokens ?? 0,
                  output: u.output_tokens ?? 0,
                  ...(u.cache_read_input_tokens !== undefined ? { cacheRead: u.cache_read_input_tokens } : {}),
                  ...(u.cache_creation_input_tokens !== undefined ? { cacheWrite: u.cache_creation_input_tokens } : {}),
                },
              }
            : {}),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(typeof raw.duration_ms === "number" ? { durationMs: raw.duration_ms } : {}),
          ...(errored ? { error: raw.result ?? `Grok ended the turn with subtype "${raw.subtype ?? "unknown"}"` } : {}),
        };
      }

      case "error":
        // The unauthenticated / fatal shape: `{"type":"error","message":…}` on
        // stdout followed by exit 1 (verified on an unauthenticated run). No
        // result ever follows, so the close handler synthesizes one from this.
        this.emit("log", "server", `Grok error: ${raw.message_text ?? "unknown"}`);
        return null;

      default:
        return null;
    }
  }

  /**
   * The result for a turn that ended without one — a crash, a fatal `error`
   * event, or a kill.
   *
   * A SIGNAL death emits nothing, matching the Claude one-shot contract, so a
   * user interrupt settles as *interrupted* rather than as a completed empty
   * turn. `close` passes the exit code alone; a killed process reports a null
   * code, which is exactly the case that must stay silent.
   */
  private emitSynthesizedResult(exitCode: number | null): void {
    if (exitCode === null) return;
    if (exitCode === 0 && !this.sawAnyEvent) {
      // Exit 0 having said nothing: not a success and not obviously an error —
      // no result, like Claude's silent zero-output turn. The orchestrator's
      // abnormal-exit path owns it.
      console.warn("[grok] process exited 0 with no stream events — no result to synthesize");
      return;
    }
    if (exitCode === 0) return;
    this.emit("event", {
      type: "agent_result",
      status: "error",
      sessionId: this.turnSessionId,
      error: `Grok exited with code ${String(exitCode)} before producing a result`,
    });
  }

  /**
   * docs/276 — mid-turn compaction, which this adapter cannot do. Grok is one
   * spawn per turn with the prompt in a file and stdin `ignore`d, so there is
   * no channel into a running process and nothing resident between turns.
   *
   * That is not a gap: the orchestrator only calls `compact()` when a turn is
   * IN FLIGHT, and routes the ordinary `/compact` (no turn running) through
   * `run({ compact: true })`, which is the path that actually works here — the
   * CLI intercepts `/compact` in the prompt. So this warns rather than
   * throwing, mirroring the Claude adapter's non-streaming branch: a
   * compaction the user asked for mid-turn is best-effort, and failing it must
   * not tear down the turn it was asked about.
   */
  compact(_instructions?: string): void {
    console.warn(
      "[grok-adapter] compact() called mid-turn — Grok has no resident process to compact (the orchestrator should have spawned a /compact run instead)",
    );
  }

  sendUserMessage(text: string): void {
    // supportsSteering is false; the orchestrator's steering gate should never
    // route here. Mirror the Claude adapter's loud-failure contract rather than
    // silently dropping the user's message.
    console.warn(
      `[grok-adapter] sendUserMessage called on a one-shot adapter — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit(
      "error",
      new Error("Grok Build does not support live steering; the message was not delivered."),
    );
  }

  writeStdin(data: string): void {
    // stdin is `ignore` at spawn — the prompt travels by file, so there is no
    // channel to write to and pretending otherwise would drop bytes silently.
    console.warn(`[grok] writeStdin: this adapter spawns with no stdin — ${data.length} bytes dropped`);
  }

  interrupt(): void {
    // Captured at entry (CLAUDE.md: never read `this.proc` inside an async
    // callback) — this adapter instance is reused across turns, so a stale
    // escalation would otherwise SIGTERM the NEXT turn's process.
    const proc = this.proc;
    if (!proc) return;
    killChild(proc, "SIGINT");
    if (this.interruptKillTimer) clearTimeout(this.interruptKillTimer);
    this.interruptKillTimer = setTimeout(() => {
      this.interruptKillTimer = null;
      if (this.proc === proc) killChild(proc, "SIGTERM");
    }, 5_000);
  }

  kill(): void {
    this.clearTimers();
    if (this.proc) killChild(this.proc, "SIGTERM");
    this.cleanupTurnFiles();
  }

  private clearTimers(): void {
    for (const t of [this.resultKillTimer, this.interruptKillTimer, this.watchdog]) {
      if (t) clearTimeout(t);
    }
    this.resultKillTimer = null;
    this.interruptKillTimer = null;
    this.watchdog = null;
  }

  /**
   * Stat-poll `$GROK_HOME/auth.json` so a CLI rotation that replaced the
   * symlink is copied back onto the shared root *during* the turn, not only
   * at cleanup. `fs.watch` (inotify) would follow the original symlink's
   * inode and miss the rename; path-based `watchFile` sees both.
   */
  private watchSpawnAuth(spawnAuth: string): void {
    this.unwatchSpawnAuth();
    const listener = (): void => {
      this.publishSpawnAuthBack();
    };
    this.spawnAuthWatch = { path: spawnAuth, listener };
    fs.watchFile(spawnAuth, { interval: SPAWN_AUTH_WATCH_MS, persistent: false }, listener);
    // `watchFile` takes its baseline stat asynchronously, so a write that
    // lands between this call and that baseline is invisible to the poller
    // forever (same reason session-token-publisher.ts publishes at arm time).
    this.publishSpawnAuthBack();
  }

  private unwatchSpawnAuth(): void {
    const watch = this.spawnAuthWatch;
    if (!watch) return;
    this.spawnAuthWatch = null;
    try {
      fs.unwatchFile(watch.path, watch.listener);
    } catch {
      // Best-effort — an unwatch failure leaves at most one stat poller.
    }
  }

  /**
   * If the CLI replaced `$GROK_HOME/auth.json` (the symlink is now a regular
   * file) with a strictly fresher token, copy it onto the shared root the
   * orchestrator watches.
   *
   * Returns `"strand"` when the spawn copy is a replaced regular file that we
   * refused (or failed) to publish — the caller MUST quarantine it before
   * `rmSync` of the throwaway root, otherwise the only live token is deleted
   * (planning#448 review). `"done"` covers everything else, including "still
   * a symlink, dest is already current" and "older than dest, safe to drop".
   */
  private publishSpawnAuthBack(): "done" | "strand" {
    const spawnHome = this.spawnHome;
    const dest = this.spawnAuthDest;
    if (!spawnHome || !dest) return "done";
    const spawnAuth = path.join(spawnHome, "auth.json");
    try {
      const st = fs.lstatSync(spawnAuth);
      if (st.isSymbolicLink() || !st.isFile()) return "done";
    } catch {
      return "done"; // gone already (cleanup raced the watcher)
    }
    const spawnAt = grokAuthExpiryMs(spawnAuth);
    if (spawnAt === null) {
      console.warn(
        "[grok] CLI replaced GROK_HOME/auth.json but the copy is unreadable as a token; "
          + "not publishing over the shared root — quarantining the rotation so cleanup cannot delete it",
      );
      return "strand";
    }
    if (fs.existsSync(dest)) {
      const destAt = grokAuthExpiryMs(dest);
      if (destAt === null) {
        console.warn(
          "[grok] shared-root auth.json is unreadable as a token; refusing to overwrite it "
            + "with the throwaway copy — quarantining the rotation so cleanup cannot delete it",
        );
        return "strand";
      }
      if (spawnAt <= destAt) return "done";
    }
    try {
      atomicCopyFile(spawnAuth, dest);
      console.log("[grok] published CLI-rotated auth.json from throwaway GROK_HOME back to the shared root");
      return "done";
    } catch (err) {
      console.warn(
        `[grok] failed to publish rotated auth.json back to ${dest}: ${err instanceof Error ? err.message : String(err)}`
          + " — quarantining the rotation so cleanup cannot delete it",
      );
      return "strand";
    }
  }

  /**
   * Copy a replaced `$GROK_HOME/auth.json` next to the shared root instead of
   * letting `rmSync` destroy it. The dest itself is left untouched (the
   * publish was refused). Next-turn diagnosis can diff the two.
   */
  private quarantineSpawnAuth(): void {
    const spawnHome = this.spawnHome;
    const dest = this.spawnAuthDest;
    if (!spawnHome || !dest) return;
    const spawnAuth = path.join(spawnHome, "auth.json");
    const quarantined = `${dest}.stranded-${Date.now()}`;
    try {
      atomicCopyFile(spawnAuth, quarantined);
      console.warn(`[grok] quarantined unpublishable auth.json at ${quarantined}`);
    } catch (err) {
      console.warn(
        `[grok] failed to quarantine ${spawnAuth} to ${quarantined}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private cleanupTurnFiles(): void {
    for (const p of [this.promptPath, this.systemPromptPath]) {
      if (p) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    this.promptPath = null;
    this.systemPromptPath = null;
    // Publish BEFORE deleting the throwaway root: if the CLI replaced the
    // auth.json symlink, the live token lives only there (planning#448).
    this.unwatchSpawnAuth();
    if (this.publishSpawnAuthBack() === "strand") this.quarantineSpawnAuth();
    this.spawnAuthDest = null;
    // The whole throwaway root goes, config and links together. `rmSync` does
    // not follow remaining symlinks, so the real `sessions/` (and an
    // unpublished `auth.json` we still held as a link) are untouched.
    if (this.spawnHome) {
      try {
        fs.rmSync(this.spawnHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    this.spawnHome = null;
  }

  /**
   * Capture the MCP server set for the per-turn `config.toml` that `run()`
   * writes. There is no separate config path to hand back to the worker, so
   * the result carries only the cleanup.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const servers: Record<string, GrokMcpServer> = {
      playwright: {
        command: PLAYWRIGHT_MCP_COMMAND,
        args: [...PLAYWRIGHT_MCP_ARGS],
        enabled: true,
      },
    };

    if (ctx.shipitBridge) {
      // The consolidated shipit bridge (planning#130 / docs/199). Tool subset
      // is this adapter's own: no `permission` tool, because headless Grok runs
      // `--always-approve` and there is no `--permission-prompt-tool` to route
      // a gate through; `ask` included even though Grok has a native
      // `ask_user_question`, because the native one is the CLI's own surface
      // and ShipIt's card is the one the transcript renders.
      servers.shipit = {
        command: ctx.shipitBridge.tsxBin,
        args: [ctx.shipitBridge.bridgePath],
        enabled: true,
        env: { SHIPIT_MCP_TOOLS: "present,voice,bug,ask,propose_actions" },
      };
    }

    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (resolved) {
        const r = resolved as {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
          headers?: Record<string, string>;
        };
        // ShipIt's stored shape is Claude-style ({command, args, env} or
        // {url, headers}); Grok's TOML wants the same fields with `transport`
        // naming the remote kinds (shape read off a real `grok mcp add` run).
        servers[server.name] = r.url
          ? {
              transport: "http",
              url: r.url,
              enabled: true,
              ...(r.headers ? { headers: r.headers } : {}),
            }
          : {
              command: r.command ?? "",
              args: r.args ?? [],
              enabled: true,
              ...(r.env ? { env: r.env } : {}),
            };
      } else {
        const reason = `missing secret: ${missing.join(", ")}`;
        console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
        ctx.onServerFailed(server.name, reason);
      }
    }

    this.pendingMcpServers = servers;
    return {
      cleanup: () => {
        this.pendingMcpServers = {};
      },
    };
  }
}
