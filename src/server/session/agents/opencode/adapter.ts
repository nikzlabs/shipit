/**
 * OpencodeAdapter — spawn-per-turn `opencode run` implementing AgentProcess
 * (docs/268-opencode-harness). Claude-shaped: JSONL on stdout, prompt on stdin
 * then EOF, one process per turn.
 *
 * What makes this adapter different from the other two is the terminal
 * contract (req 4): OpenCode has **no terminal result event**, it does not
 * stream (the whole event log is written at process exit — see
 * {@link OpencodeAdapter.armWatchdog}), and it can end a turn by simply never
 * exiting. So:
 *
 *  - `agent_result` is synthesized from **process exit**, never from a stream
 *    event, out of the `OpencodeTurnAccumulator`'s running state;
 *  - an `error` event marks the turn failed AND schedules a kill — at 1.18.15
 *    the CLI hung after one, and while 1.18.18 exits 1 promptly instead, the
 *    kill costs a 2 s grace and covers both;
 *  - a turn whose final `step_finish` was dropped still resolves correctly,
 *    which the adapter test locks with a truncated real capture;
 *  - a turn that shows no sign of life at all is ended by the **stall
 *    deadline** (planning#476), because nothing else would ever end it.
 *
 * Wire facts verified against CLI 1.18.15 (docs/268 plan.md, Phase 0) and
 * re-verified against 1.18.18 for the failure paths (that doc's "Corrected:
 * the status code is not what hangs" section).
 *
 * ## Two Claude events this adapter never emits, and the basis for each
 *
 * Stated here rather than left as an absence, per docs/266 item 13's
 * probed / structural / not-wired rule.
 *
 *  - **`agent_rate_limits` — structural, and the constraint is ShipIt's
 *    catalogue rather than the CLI.** The transport is not the problem: an
 *    `{"type":"error"}` event carries the provider's **full `responseHeaders`
 *    map** verbatim on stdout, measured 2026-08-23 at a local recorder (a 401
 *    control printed every header, `metadata.url` included). What is missing
 *    is a window to put in one. `agent_rate_limits` describes a SUBSCRIPTION
 *    window, and every route OpenCode can take is either a metered key — where
 *    no subscription window exists, and the per-minute `x-ratelimit-*` buckets
 *    an API returns are a different quantity that must not be rendered as one
 *    — or **OpenCode Go**, the one subscription it carries (`carriers`), whose
 *    quota is declared-unread by a human decision: Go's caps are
 *    dollar-denominated with no per-key usage API (docs/272 req 6,
 *    `opencode-go-usage`). OpenCode has no `account` target at all, so it
 *    cannot reach Anthropic's or xAI's OAuth windows. So the conclusion is
 *    that no route ShipIt can currently take needs this wired — NOT that the
 *    channel is ready, though it is readier than planning#476 first suggested:
 *    a **429** was re-probed at 1.18.18 and does emit a full error event
 *    carrying `responseHeaders`, after the CLI's ~72 s retry sequence gives up
 *    (`armWatchdog`). What the 401 measurement showed for a non-retryable
 *    status therefore holds for the quota-relevant one too. Whichever change
 *    makes a window reachable still has to re-probe the response that would
 *    carry it.
 *  - **`agent_user_replay` — structural.** It echoes a steer the CLI accepted
 *    mid-turn. This adapter is one spawn per turn with the prompt written to
 *    stdin and then EOF (`supportsSteering: false`), so no user message ever
 *    reaches a running process and there is nothing to echo. Only a resident
 *    process would change that.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChild, killProcessTree } from "../../../shared/kill-child.js";
import { OPENCODE_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { HARNESSES } from "../../../shared/catalogue/harnesses.js";
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
} from "../agent-process.js";
import { resolveAgentHome, type AgentHomeResolver } from "../../../shared/agent-home.js";
import { ensureOpencodeDataDir } from "../../../shared/opencode-data-dir.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { PLAYWRIGHT_MCP_ARGS, PLAYWRIGHT_MCP_COMMAND } from "../playwright-mcp.js";
import { opencodeModelArg, opencodeProviderConfig } from "../../../shared/opencode-spawn-shaping.js";
import { parseOpencodeLine, OpencodeTurnAccumulator, type OpencodeEvent, type OpencodeToolPart } from "../../../shared/opencode-stream.js";
import { normalizeOpencodeToolCall, normalizeOpencodeToolResult } from "./opencode-tool-normalizer.js";
import { compactOpencodeSession } from "./compaction.js";

const OPENCODE_REASONING = HARNESSES.find((h) => h.id === "opencode")?.capabilities.reasoning;

/**
 * How long after a fatal `error` event the process gets before it is killed.
 * Nonzero only to let a straggling flush land; the CLI does not exit on its
 * own after a fatal error (verified — it hangs indefinitely).
 */
const ERROR_EXIT_GRACE_MS = 2_000;

/**
 * How long after the turn's final `step_finish` the process gets to exit on
 * its own before the adapter kills it. Without MCP servers the CLI exits
 * promptly; with them it never exits at all (verified live — the MCP children
 * keep the Bun event loop alive), and every production turn has MCP servers.
 */
const STOP_EXIT_GRACE_MS = 5_000;

/**
 * How long a turn may show NO sign of life before the adapter ends it
 * (planning#476). See {@link OpencodeAdapter.armWatchdog} for why a clock is
 * the only instrument available at all.
 *
 * **This is a ceiling on one quiet OPERATION, not on a turn**, and it is sized
 * by the longest quiet operation ShipIt itself sanctions: `shipit agent result
 * --wait --timeout` accepts up to **30 minutes** (`shipit-docs/agent.md`), and
 * CLAUDE.md instructs agents to collect a detached review exactly that way. A
 * long `bash` call is silent on every channel for its whole duration — the CLI
 * logs at the tool BOUNDARIES and nothing in between — so a deadline at or
 * below 30 minutes would kill a turn doing precisely what the platform told it
 * to do. 45 minutes clears that supported maximum by half again. Big Gradle and
 * Docker builds, SDK installs and full test suites sit under it too.
 *
 * Deliberately biased long: overshooting costs a wedged turn some extra time
 * before it reports (and a wedged session is visibly stuck, so a watching user
 * can still interrupt), while undershooting destroys work in progress.
 */
const STALL_DEADLINE_MS = 45 * 60_000;

/**
 * `<data dir>/log` — the directory the CLI appends its own run log to, read
 * ONLY for `mtime` (never parsed) as a liveness heartbeat. See
 * {@link OpencodeAdapter.readLogHeartbeat}.
 */
const OPENCODE_LOG_SUBDIR = "log";

export class OpencodeAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "opencode";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    // Mirrors the catalogue row (docs/268), where the live probe is recorded:
    // observed at last, and true once ShipIt's provider block declares the image
    // input modality (planning#458).
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: [...OPENCODE_TOOL_NAMES],
    // Which models exist is a property of the service join, not the CLI
    // (docs/252); the registry resolves them. Nothing reads this field off a
    // live adapter (ProxyAgentProcess hardcodes its own stub).
    models: [],
    ...(OPENCODE_REASONING ? { reasoning: OPENCODE_REASONING } : {}),
    // Mirrors the catalogue row, where the probe is recorded (planning#459).
    supportsReview: true,
    supportsSteering: false,
    // docs/276 — via the server's `POST /session/{id}/summarize`, spawned per
    // compaction. NOT via `opencode run`; see `compaction.ts`.
    supportsCompaction: true,
    skillsDirName: ".opencode",
    skillInvocationPrefix: "/",
  };

  private readonly resolveHome: AgentHomeResolver | undefined;
  /** Injectable for tests — replays captured streams without a real CLI. */
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private proc: ChildProcess | null = null;
  /**
   * docs/276 — the transient `opencode serve` of an in-flight compaction.
   *
   * Deliberately NOT `this.proc`: that field is the turn's CLI, and the whole
   * stdout/watchdog/exit machinery keys off it. This is a second handle with
   * one job — giving `kill()` and `interrupt()` something to stop, since a
   * compaction otherwise ignores both for the whole summarize window.
   */
  private compactionProc: ChildProcess | null = null;
  private buffer = "";
  private stderrBuffer = "";
  private accumulator = new OpencodeTurnAccumulator();
  private emittedInit = false;
  private resumeSessionId: string | undefined;
  private configPath: string | null = null;
  private systemPromptPath: string | null = null;
  private errorKillTimer: NodeJS.Timeout | null = null;
  private stopKillTimer: NodeJS.Timeout | null = null;
  private interruptKillTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /** Last time this adapter saw output from the CLI, for the stall deadline. */
  private lastActivityAt = 0;
  /** Set when the stall deadline ended the turn — the synthesized failure. */
  private stallReason: string | null = null;
  /** The CLI's own log directory for this spawn's HOME, or null if unusable. */
  private logDir: string | null = null;
  private stdinFailure: NodeJS.ErrnoException | null = null;
  /** Resolved user MCP servers, captured by writeMcpConfig for run() to merge. */
  private pendingMcpServers: Record<string, unknown> = {};
  private _isStreaming = false;

  constructor(opts?: {
    resolveHome?: AgentHomeResolver;
    spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.spawnFn = opts?.spawnFn ?? nodeSpawn;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  run(params: AgentRunParams): void {
    if (this.proc) {
      this.emit("error", new Error("OpenCode adapter: run() called while a turn is in flight"));
      return;
    }
    this.accumulator = new OpencodeTurnAccumulator();
    this.emittedInit = false;
    this.stallReason = null;
    this.resumeSessionId = params.sessionId;

    const args = ["run", "--format", "json", "--auto"];
    if (params.sessionId) {
      args.push("--session", params.sessionId);
    }

    // Per-spawn config: ShipIt's provider block (+ variants), the MCP servers
    // writeMcpConfig captured, and the system-prompt file as an instruction.
    // Delivered via OPENCODE_CONFIG, which merges AFTER global/project config
    // (verified), so a user repo's own opencode.json stays honored underneath.
    const config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };

    if (params.serviceRouting && params.model) {
      const provider = opencodeProviderConfig(params.serviceRouting, params.model);
      if (!provider) {
        // A style this harness cannot speak, or a non-env credential target —
        // the catalogue join should have prevented both. Refuse rather than
        // spawn a turn that would route to the wrong place (same backstop rule
        // as codexProviderArgs).
        this.emit(
          "error",
          new Error(
            `OpenCode cannot run ${params.serviceRouting.serviceId} over style ${params.serviceRouting.style}`,
          ),
        );
        return;
      }
      config.provider = provider;
      args.push("--model", opencodeModelArg(params.model));
    } else if (params.model) {
      // No routing — pass the model through verbatim (a `provider/model` id
      // reaching OpenCode's own registry). Not a path ShipIt's catalogue
      // produces today: OpenCode has no native service and every key-mode join
      // carries routing. Kept because dropping the model silently would be
      // worse than forwarding it.
      args.push("--model", params.model);
    }

    if (params.reasoningEffort) {
      // Validated by the catalogue's declared option list, NOT by the CLI —
      // OpenCode silently ignores an unknown variant (verified).
      args.push("--variant", params.reasoningEffort);
    }

    if (Object.keys(this.pendingMcpServers).length > 0) {
      config.mcp = this.pendingMcpServers;
    }

    if (params.systemPrompt) {
      // OpenCode has no system-prompt flag; the config `instructions` array
      // injects a file's content as standing instructions alongside AGENTS.md.
      this.systemPromptPath = `/tmp/opencode-system-prompt-${Date.now()}.md`;
      fs.writeFileSync(this.systemPromptPath, params.systemPrompt);
      config.instructions = [this.systemPromptPath];
    }

    this.configPath = `/tmp/opencode-config-${Date.now()}.json`;
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Env discipline (order is load-bearing, same as claude/process.ts): HOME
    // first, then the credential scrub, then service delivery — the scrub
    // deletes the very variable the delivery writes. A per-spawn `homeDir` (a
    // same-harness sub-agent's isolated credential root) outranks the
    // constructor-injected resolver.
    const scopedHome = params.homeDir ?? this.resolveHome?.();
    const home = resolveAgentHome(scopedHome);
    // `$HOME/.local/share/opencode` is a symlink into the credentials tree in
    // every image, and OpenCode's bootstrap mkdir dies EEXIST on it while the
    // target is missing — a dangling symlink IS an existing directory entry, so
    // no privilege level gets past it. In a container the entrypoint has already
    // made it at boot and this is a directory read; local/dogfood mode has no
    // entrypoint, and the sub-agent and PR-description spawns there do not go
    // through the link-clearing that the pinned agent's own turn does.
    const dataDir = ensureOpencodeDataDir(home);
    this.logDir = dataDir ? path.join(dataDir, OPENCODE_LOG_SUBDIR) : null;
    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      // The CLI resolves its project directory from $PWD when the variable is
      // present (Bun honors it over the real cwd), and a worker's own PWD
      // points at the worker, not the workspace — verified live: the turn's
      // writes landed in the parent process's directory. Pin it to the spawn
      // cwd so the two cannot disagree.
      PWD: params.cwd,
      OPENCODE_CONFIG: this.configPath,
      // The pinned binary must never self-replace (dependency policy), and a
      // container must not reach for models.dev, LSP downloads, or the share
      // service — routing is fully explicit in the provider block above.
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    };
    // OpenCode auto-detects every well-known provider key env var, any of
    // which would out-prefer the provider block's explicit credential and
    // silently re-route billing. Scrub them all, then deliver exactly one.
    scrubHarnessEnvCredentials(spawnEnv, "opencode");
    if (params.serviceRouting) {
      const routing = params.serviceRouting;
      const secret = process.env[routing.credentialSourceEnv];
      if (!secret || routing.credentialTarget.kind !== "env") {
        console.warn(
          `[opencode] no credential in the environment for ${routing.serviceId}` +
            `/${routing.billingMode} (expected ${routing.credentialSourceEnv})`,
        );
        this.emit("auth_required");
        return;
      }
      spawnEnv[routing.credentialTarget.name] = secret;
      console.log(
        `[opencode] service routing: ${routing.serviceId}/${routing.billingMode} -> ${routing.baseUrl}`,
      );
    }

    // docs/276 — a compaction spawn diverges here, once the per-turn config and
    // env exist (the transient server needs BOTH: `OPENCODE_CONFIG` carries the
    // `shipit` provider block, and the credential is delivered in `spawnEnv`).
    // It never runs the turn machinery below — no argv prompt, no accumulator,
    // no watchdog — because the trigger is an HTTP call, not a turn. See
    // `compaction.ts` for why `opencode run` cannot do this.
    if (params.compact) {
      this.runCompaction(params, spawnEnv);
      return;
    }

    console.log(
      "[opencode] spawning:", "opencode", args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(params.prompt)} | cwd:`, params.cwd,
    );

    try {
      this.proc = this.spawnFn("opencode", args, {
        cwd: params.cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.cleanupTurnFiles();
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.proc = null;
      return;
    }

    this.buffer = "";
    this.stderrBuffer = "";
    this.stdinFailure = null;
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

    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      // Held, not emitted (Claude's contract): the CLI may still produce a
      // stream that explains itself; only a turn that produced NOTHING gets
      // torn down with this as the reason at close.
      console.warn(`[opencode] stdin error (${err.code ?? "unknown"}): the prompt did not reach the CLI`);
      this.stdinFailure = err;
    });

    this.proc.on("close", (exitCode, signal) => {
      this.clearErrorKillTimer();
      // Flush whatever the block-buffered stdout managed to deliver.
      this.drainLines(true);
      this.drainStderrLines(true);
      this.cleanupTurnFiles();
      if (this.stdinFailure && !this.sawAnyEvent()) {
        // The prompt provably never landed and the CLI said nothing — the one
        // case that must not read as an empty success (Claude's rule).
        this.emit("error", this.stdinFailure);
      } else {
        this.emitSynthesizedResult(exitCode, signal);
      }
      this.stdinFailure = null;
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });

    // The prompt goes over stdin (verified: `opencode run` with no positional
    // message reads it) — argv has a 128 KiB per-argument ceiling on Linux and
    // assembled prompts can exceed it.
    this.proc.stdin?.write(params.prompt);
    this.proc.stdin?.end();
  }

  /**
   * The stall deadline (planning#476) — the adapter's only defence against a
   * CLI that will never exit, replacing a warn-only watchdog that could not be
   * one.
   *
   * ## What actually hangs, measured
   *
   * Re-probed at CLI **1.18.18** against a local HTTP recorder, 2026-08-23
   * (zero quota spent), with the response shape as the only variable:
   *
   *  - A **well-formed 429** does NOT hang. The CLI retries the turn's stream
   *    six times over ~72 s, then emits a complete `{"type":"error"}` event
   *    (message, `statusCode`, `isRetryable`, headers, body) and exits 1. The
   *    adapter already turns that into a failed result, so quota refusal —
   *    planning#476's headline — reaches `detectHardExhaustion` today. Same
   *    result for `anthropic-messages` and `openai-chat-completions`, and for
   *    an empty 429 body.
   *  - What hangs is a response the CLI never finishes **reading**: headers
   *    sent and the body never ended, or a connection accepted and never
   *    answered. Then stdout, stderr AND the CLI's own log file are all
   *    completely empty — the log's last line is `llm runtime selected` — and
   *    the process never exits. Killed at 15 min, twice.
   *
   * That second measurement is what rules out planning#476's option (b),
   * "read the CLI's log for the retry state": in the case that hangs there is
   * no retry state, and nothing at all, written to the log. It is not rejected
   * for coupling; it was tried and there is nothing there.
   *
   * ## Why this is a clock, and not a progress signal
   *
   * `opencode run --format json` does not stream. It accumulates the turn's
   * events and writes the whole log **at process exit** — verified by giving
   * step 2's model call a 60 s delay and watching step 1's events (generated at
   * 4.3 s, per their own `timestamp` fields) arrive at 64.4 s with everything
   * else, and re-verified under a PTY in case it was stdio buffering. It is
   * not: `_isStreaming` is false for exactly this reason. So the adapter sees
   * NOTHING mid-turn, and "no output for N" — which the old 60 s watchdog
   * warned about — is the normal state of every turn longer than N, not a
   * symptom. No signal available to this adapter distinguishes "waiting on a
   * model that will answer" from "waiting on one that never will".
   *
   * ## What makes the deadline safe
   *
   * The CLI's log directory is used as a **liveness heartbeat**: if anything
   * under it was touched since the deadline was armed, the deadline re-arms
   * instead of killing. A turn that is stepping, calling tools or dispatching
   * requests writes log lines throughout (`loop step=N`, permission
   * evaluations, `stream …`), so a turn crossing those boundaries keeps
   * re-arming for as long as it keeps crossing them, while the wedge — which
   * writes nothing at all — does not.
   *
   * The cadence is discrete, though, and that bounds what the heartbeat can
   * promise: it beats at step and tool BOUNDARIES, not during a step or a tool.
   * One long quiet operation — a 30-minute `bash` call, a model request that
   * streams for half an hour — produces no beat while it runs, which is exactly
   * why {@link STALL_DEADLINE_MS} has to clear the longest such operation
   * rather than merely being "generous". This reads `mtime` only,
   * never file content, and it can only ever POSTPONE the kill: no log, a moved
   * path, a changed format all degrade to the bare deadline rather than to an
   * early kill. That is also why the log's format being an unstable private
   * surface does not matter here — planning#476's option (b) wanted to PARSE it
   * for the retry state, which is both fragile and (measured above) empty.
   *
   * The heartbeat is per-HOME rather than per-turn, so a concurrent OpenCode
   * spawn sharing this HOME can postpone a wedged turn's deadline. Left as is:
   * the failure it produces is "detected later", which is the direction this
   * whole mechanism is deliberately biased in.
   *
   * The residual exposure is therefore one operation — model request or tool
   * call — that outlives {@link STALL_DEADLINE_MS} without reaching a boundary.
   * That constant is sized against the longest one the platform sanctions; see
   * its docstring. Against that residue: today the turn hangs until the user
   * interrupts it, forever.
   */
  private armWatchdog(): void {
    this.lastActivityAt = Date.now();
    this.scheduleStallCheck(STALL_DEADLINE_MS);
  }

  private scheduleStallCheck(delay: number): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.onStallDeadline(), delay);
  }

  /**
   * The deadline fired: end the turn unless something has shown a sign of life
   * since. Measures the idle span against the LAST sign rather than against
   * the arming instant, and re-schedules for the remainder — otherwise the
   * CLI's own startup logging, which every turn does in its first seconds,
   * would buy a wedge a second full window and double the worst case.
   *
   * Captures `this.proc` at entry (CLAUDE.md) so a stale timer can never reach
   * the next turn's process.
   */
  private onStallDeadline(): void {
    this.watchdog = null;
    const proc = this.proc;
    if (!proc) return;

    const lastSign = Math.max(this.lastActivityAt, this.readLogHeartbeat() ?? 0);
    const idleFor = Date.now() - lastSign;
    if (idleFor < STALL_DEADLINE_MS) {
      this.scheduleStallCheck(STALL_DEADLINE_MS - idleFor);
      return;
    }

    const minutes = Math.round(STALL_DEADLINE_MS / 60_000);
    // Says what happened and stops there. It deliberately does NOT tell the
    // user that retrying is safe: the deadline fires wherever the silence was,
    // so the turn may already have run tools that deployed, migrated, uploaded
    // or otherwise changed something outside this workspace, and a rerun would
    // repeat them. What was and was not done is the turn's own question.
    this.stallReason =
      `The OpenCode CLI produced no output and showed no activity for ${minutes} minutes, ` +
      "so ShipIt ended the turn rather than waiting indefinitely. The usual cause is a " +
      "request to the model service that was accepted and never answered — the CLI has no " +
      "request timeout of its own. Check what the turn had already done before retrying it.";
    console.warn(`[opencode] stall deadline (${minutes}m) reached — ending the turn`);
    this.emit("log", "server", this.stallReason);
    killProcessTree(proc, "SIGTERM", { label: "opencode-stall" });
  }

  /**
   * Newest `mtime` under the CLI's log directory, or null when there is
   * nothing to read. Deliberately a stat and never a parse: the log's FORMAT is
   * an unstable private surface, but "this file was appended to" is not, and a
   * heartbeat that disappears costs only the postponement it would have bought.
   */
  private readLogHeartbeat(): number | null {
    if (!this.logDir) return null;
    try {
      let newest = 0;
      for (const entry of fs.readdirSync(this.logDir)) {
        const { mtimeMs } = fs.statSync(path.join(this.logDir, entry));
        if (mtimeMs > newest) newest = mtimeMs;
      }
      return newest > 0 ? newest : null;
    } catch {
      return null;
    }
  }

  /** Whether the stream produced anything at all this turn. */
  private sawAnyEvent(): boolean {
    const acc = this.accumulator;
    return acc.sessionId !== undefined || acc.sawStepFinish || acc.finalText.length > 0;
  }

  /**
   * The synthesized terminal result (req 4) — the ONLY producer of
   * agent_result. Signal-aware: a SIGNAL death without a completed turn emits
   * NO result at all, matching the Claude one-shot contract, so a user
   * interrupt settles as *interrupted* (`runner.wasInterrupted`) rather than
   * as a completed empty turn. The two deliberate self-kills — the post-error
   * kill (errorMessage set) and the post-final-step stop-kill (sawFinalStop) —
   * still resolve, as error and success respectively.
   *
   * planning#476 adds a THIRD deliberate self-kill, the stall deadline, and it
   * has to resolve for the same reason the post-error kill does: a turn ended
   * by the adapter must not read as a user interrupt, or the whole point —
   * telling the user why the turn stopped — is lost to a silent settlement.
   */
  private emitSynthesizedResult(exitCode: number | null, signal: NodeJS.Signals | null): void {
    const acc = this.accumulator;
    // A stalled turn that nonetheless flushed its final step on the way out is
    // a completed turn, not a stall — the deadline only ever races a turn that
    // had nothing to show.
    const stalled = this.stallReason !== null && !acc.sawFinalStop;
    if (
      signal !== null &&
      signal !== undefined &&
      !acc.sawFinalStop &&
      acc.errorMessage === undefined &&
      !stalled
    ) {
      return;
    }
    if (exitCode === 0 && !this.sawAnyEvent() && !stalled) {
      // Exit 0 having said nothing: not a success, and not obviously an error
      // either — no result, like Claude's silent zero-output turn; the
      // orchestrator's abnormal-exit path owns it.
      console.warn("[opencode] process exited 0 with no stream events — no result to synthesize");
      return;
    }
    const errored =
      acc.errorMessage !== undefined ||
      stalled ||
      (exitCode !== null && exitCode !== 0 && !acc.sawFinalStop);
    const tokens =
      acc.input > 0 || acc.output > 0
        ? {
            input: acc.input,
            output: acc.output,
            cacheRead: acc.cacheRead,
            cacheWrite: acc.cacheWrite,
          }
        : undefined;
    this.emit("event", {
      type: "agent_result",
      status: errored ? "error" : "success",
      sessionId: acc.sessionId ?? this.resumeSessionId ?? "",
      ...(acc.costUsd > 0 ? { cost: { totalUsd: acc.costUsd } } : {}),
      ...(tokens ? { tokens } : {}),
      ...(acc.contextTokens !== undefined ? { contextTokens: acc.contextTokens } : {}),
      ...(errored
        ? {
            // A flushed `error` event outranks the stall reason: if the CLI
            // managed to say why on its way out, that is the better answer.
            error:
              acc.errorMessage ??
              this.stallReason ??
              `OpenCode exited with code ${String(exitCode)}${acc.sawStepFinish ? "" : " before finishing a step"}`,
          }
        : {}),
    });
  }

  /**
   * docs/276 — run a compaction instead of a turn, then settle the turn.
   *
   * Every exit path MUST emit exactly one `agent_result`. The orchestrator's
   * whole post-turn sequence — the local commit above all (CLAUDE.md post-turn
   * invariant 2) — hangs off it, and this path spawns no long-lived `this.proc`
   * whose `exit` would settle the turn for us. A compaction that fails silently
   * would therefore strand the session `running` forever.
   *
   * A failure is reported as a failed RESULT rather than an `error` event: this
   * spawn is the whole turn, so the turn genuinely failed, and the user asked
   * for the compaction and is owed the reason.
   */
  private runCompaction(params: AgentRunParams, spawnEnv: Record<string, string>): void {
    const sessionId = params.sessionId;
    // Exactly one `agent_result`, no matter how many things go wrong at once —
    // a kill racing the summarize response can otherwise settle twice, and a
    // duplicate terminal event is as damaging to the post-turn sequence as a
    // missing one.
    let settled = false;
    const settle = (error?: string): void => {
      if (settled) return;
      settled = true;
      this.compactionProc = null;
      this.cleanupTurnFiles();
      this.emit("event", {
        type: "agent_result",
        status: error ? "error" : "success",
        sessionId: sessionId ?? "",
        ...(error ? { error } : {}),
      });
    };

    // Nothing to compact: OpenCode's session is created BY the first turn, so a
    // session id is the only handle on a transcript that exists. Refuse rather
    // than start a server that could only 404.
    if (!sessionId) {
      settle("Cannot compact: this session has not run a turn yet.");
      return;
    }
    if (!params.model) {
      // The route rejects a body with no `providerID`/`modelID` (HTTP 400), and
      // the summarization is a real model call that has to be billed somewhere.
      settle("Cannot compact: no model is selected for this session.");
      return;
    }

    this.emit("event", { type: "agent_compaction_started", trigger: "manual" });

    // Fire-and-forget from a sync `run()`: the turn settles through the
    // `agent_result` this emits, exactly as the spawned-process path settles
    // through its `exit` handler. `void` rather than `await` because `run()` is
    // the AgentProcess contract's synchronous entry point.
    void (async () => {
      try {
        await compactOpencodeSession({
          sessionId,
          modelId: params.model!,
          cwd: params.cwd,
          env: spawnEnv,
          spawnFn: this.spawnFn,
          onLog: (message) => this.emit("log", "opencode", message),
          onServerSpawned: (proc) => {
            this.compactionProc = proc;
          },
        });
        // OpenCode's summarize answers a bare `true` — no token figures, no
        // duration. The card degrades to a bare "Context compacted" row, the
        // same as Codex's.
        this.emit("event", { type: "agent_compacted", trigger: "manual" });
        settle();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[opencode] compaction failed: ${reason}`);
        settle(`Compaction failed: ${reason}`);
      }
    })();
  }

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    this.buffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseOpencodeLine(line);
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
      console.warn("[opencode] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    }
  }

  private handleEvent(event: OpencodeEvent): void {
    this.accumulator.observe(event);

    if (event.type === "step_start" && this.stopKillTimer) {
      // A new step after a non-tool-calls finish — the "final" guess was
      // wrong; let the turn continue.
      clearTimeout(this.stopKillTimer);
      this.stopKillTimer = null;
    }
    if (event.type === "step_finish" && this.accumulator.sawFinalStop && !this.stopKillTimer && this.proc) {
      // The turn's final step completed. The CLI exits promptly on its own
      // when no MCP servers are configured — but with them it NEVER does
      // (see STOP_EXIT_GRACE_MS), so the adapter owns termination. The close
      // handler synthesizes the (successful) result either way. Tree-wide
      // (planning#509): this is the ordinary end of every OpenCode turn, and
      // MCP servers are exactly what leaves a browser behind.
      this.stopKillTimer = setTimeout(() => {
        this.stopKillTimer = null;
        if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode" });
      }, STOP_EXIT_GRACE_MS);
    }
    if (!this.emittedInit && typeof event.sessionID === "string") {
      this.emittedInit = true;
      this.emit("event", {
        type: "agent_init",
        agentId: "opencode",
        sessionId: event.sessionID,
        tools: [...OPENCODE_TOOL_NAMES],
      });
    }

    const mapped = this.mapEvent(event);
    for (const e of mapped) this.emit("event", e);

    if (event.type === "error") {
      // The CLI does not exit after a fatal error (verified — it hangs), so
      // the adapter owns termination: give a straggling flush a moment, then
      // kill. The close handler synthesizes the failed result.
      this.emit("log", "server", `OpenCode error: ${this.accumulator.errorMessage ?? "unknown"}`);
      if (!this.errorKillTimer && this.proc) {
        this.errorKillTimer = setTimeout(() => {
          this.errorKillTimer = null;
          if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode-error" });
        }, ERROR_EXIT_GRACE_MS);
      }
    }
  }

  /** Map one OpenCode event to zero or more normalized AgentEvents. */
  private mapEvent(event: OpencodeEvent): AgentEvent[] {
    switch (event.type) {
      case "text": {
        const part = event.part as { text?: string } | undefined;
        if (typeof part?.text !== "string" || part.text.length === 0) return [];
        const block: AgentContentBlock = { type: "text", text: part.text };
        return [{ type: "agent_assistant", content: [block] }];
      }
      case "tool_use": {
        // One completed event carries the whole call (no started event on this
        // wire): surface the tool_use and its result back-to-back so the
        // message-group boundary contract (tool results split groups) holds.
        const part = event.part as OpencodeToolPart & { id?: string };
        const callId = part.callID ?? part.id ?? `opencode-call-${Date.now()}`;
        const rawInput =
          typeof part.state?.input === "object" && part.state.input !== null
            ? (part.state.input as Record<string, unknown>)
            : {};
        // Lowercase wire names miss every recognition registry (planning#432) —
        // translate to the transcript vocabulary before anything persists.
        const { name, input } = normalizeOpencodeToolCall(part.tool ?? "unknown", rawInput);
        const isError = part.state?.status === "error";
        // The task wrapper would be swallowed whole by the client's skipHtml
        // markdown (planning#434) — unwrap before anything persists.
        const output = normalizeOpencodeToolResult(part.tool ?? "unknown", part.state?.output ?? "");
        return [
          {
            type: "agent_assistant",
            content: [{ type: "tool_use", id: callId, name, input }],
          },
          {
            type: "agent_tool_result",
            content: [
              {
                type: "tool_result",
                tool_use_id: callId,
                content: output,
                ...(isError ? { is_error: true } : {}),
              },
            ],
          },
        ];
      }
      // step_start / step_finish / error carry no renderable content — the
      // accumulator already recorded what the synthesized result needs.
      default:
        return [];
    }
  }

  /**
   * docs/276 — mid-turn compaction, which this adapter cannot do. `run()` is
   * one `opencode run` per turn and the compaction trigger is an HTTP call to a
   * SEPARATE server; firing one against the session a turn is actively writing
   * would race that turn's own message writes.
   *
   * Not a gap: the orchestrator only calls `compact()` while a turn is in
   * flight, and routes the ordinary `/compact` through `run({ compact: true })`
   * — the path that works here. Warn rather than throw, mirroring the Claude
   * adapter's non-streaming branch; a best-effort mid-turn compaction must not
   * tear down the turn it was asked about.
   */
  compact(_instructions?: string): void {
    console.warn(
      "[opencode-adapter] compact() called mid-turn — OpenCode has no resident process to compact (the orchestrator should have spawned a compaction run instead)",
    );
  }

  sendUserMessage(text: string): void {
    // supportsSteering is false; the orchestrator's steering gate should never
    // route here. Mirror the Claude adapter's loud-failure contract rather
    // than silently dropping the user's message.
    console.warn(
      `[opencode-adapter] sendUserMessage called on a one-shot adapter — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit(
      "error",
      new Error("OpenCode does not support live steering; the message was not delivered."),
    );
  }

  writeStdin(data: string): void {
    if (!this.proc?.stdin?.writable) {
      console.warn(`[opencode] writeStdin: stdin not writable — ${data.length} bytes dropped`);
      return;
    }
    this.proc.stdin.write(data);
  }

  interrupt(): void {
    // Capture at entry (CLAUDE.md: never read `this.proc` inside an async
    // callback) — this adapter instance is reused across turns, so a stale
    // escalation would otherwise SIGTERM the NEXT turn's process.
    // docs/276 — same capture-at-entry rule for the compaction server. No
    // escalation timer: it is a plain HTTP server with no retry loop to get
    // stuck in, so SIGTERM is enough and there is no CLI to be gentle with.
    const compacting = this.compactionProc;
    if (compacting) killProcessTree(compacting, "SIGTERM", { label: "opencode-compaction" });

    const proc = this.proc;
    if (!proc) return;
    // Disarm the stall deadline first (planning#476). The CLI is known to
    // survive SIGINT for a while, so an interrupt landing near the deadline
    // would otherwise let `onStallDeadline` set a stall reason in the gap — and
    // a stall reason makes `emitSynthesizedResult` emit a FAILED result where
    // the signal-death path would correctly emit none, turning the user's own
    // interrupt into an invented adapter failure.
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    killChild(proc, "SIGINT");
    // The CLI is known to survive SIGINT while stuck in a retry loop; escalate.
    // Held on the adapter and cleared at close so it dies with the turn.
    if (this.interruptKillTimer) clearTimeout(this.interruptKillTimer);
    this.interruptKillTimer = setTimeout(() => {
      this.interruptKillTimer = null;
      if (this.proc === proc) killProcessTree(proc, "SIGTERM", { label: "opencode-interrupt" });
    }, 5_000);
  }

  kill(): void {
    this.clearErrorKillTimer();
    if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode" });
    // docs/276 — a compaction has no `this.proc`; killing its server aborts the
    // in-flight summarize, which rejects and settles the turn through the
    // ordinary failure path.
    if (this.compactionProc) killProcessTree(this.compactionProc, "SIGTERM", { label: "opencode-compaction" });
    this.cleanupTurnFiles();
  }

  private clearErrorKillTimer(): void {
    if (this.errorKillTimer) {
      clearTimeout(this.errorKillTimer);
      this.errorKillTimer = null;
    }
    if (this.stopKillTimer) {
      clearTimeout(this.stopKillTimer);
      this.stopKillTimer = null;
    }
    if (this.interruptKillTimer) {
      clearTimeout(this.interruptKillTimer);
      this.interruptKillTimer = null;
    }
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private cleanupTurnFiles(): void {
    for (const p of [this.configPath, this.systemPromptPath]) {
      if (p) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    this.configPath = null;
    this.systemPromptPath = null;
  }

  /**
   * Capture the MCP server set for the per-turn config file `run()` writes.
   * OpenCode reads MCP servers from its own config (`mcp` key), so there is no
   * separate `--mcp-config` path; everything lands in the OPENCODE_CONFIG file
   * and cleanup happens with the turn's other files.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const servers: Record<string, unknown> = {
      playwright: {
        type: "local",
        command: [PLAYWRIGHT_MCP_COMMAND, ...PLAYWRIGHT_MCP_ARGS],
        enabled: true,
      },
    };

    if (ctx.shipitBridge) {
      // The consolidated shipit bridge (planning#130/docs/199). Tool subset is
      // this adapter's own: present/voice/bug/propose_actions/ask — ask
      // included because OpenCode has no native AskUserQuestion tool; no
      // permission tool because there is no --permission-prompt-tool
      // equivalent to route a gate through (runs are --auto).
      servers.shipit = {
        type: "local",
        command: [ctx.shipitBridge.tsxBin, ctx.shipitBridge.bridgePath],
        enabled: true,
        environment: { SHIPIT_MCP_TOOLS: "present,voice,bug,ask,propose_actions" },
      };
    }

    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (resolved) {
        // ShipIt's stored shape is Claude-style ({command, args, env} or
        // {url, headers}); OpenCode wants {type, command[], environment} /
        // {type: "remote", url, headers}.
        const r = resolved as { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
        servers[server.name] = r.url
          ? {
              type: "remote",
              url: r.url,
              enabled: true,
              ...(r.headers ? { headers: r.headers } : {}),
            }
          : {
              type: "local",
              command: [r.command ?? "", ...(r.args ?? [])],
              enabled: true,
              ...(r.env ? { environment: r.env } : {}),
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
