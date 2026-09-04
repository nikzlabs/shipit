import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { killChild, killProcessTree } from "../../../shared/kill-child.js";
import type { ClaudeEvent, ImageAttachment, PermissionMode, ServiceRouting } from "../../../shared/types.js";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import type { AgentHomeResolver } from "../../../shared/agent-home.js";
import { resolveAgentHome } from "../../../shared/agent-home.js";

/**
 * docs/150 — when a spawn is scoped to a provider account, drop the env-based
 * Anthropic credentials from its environment.
 *
 * Pointing HOME at an account root is not enough on its own: the CLI prefers
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` over the OAuth credentials on
 * disk, so an orchestrator that has either configured (the dogfood `dev`
 * service does — see CLAUDE.md) would keep billing metered API usage while the
 * router believed the turn ran on the selected subscription. Selection would be
 * ignored a second way, silently.
 *
 * Deliberately only when a scoped home applies: a session pinned to the
 * RESERVED `claude-api-key` / `claude-env-oauth` route resolves no account root
 * and must keep exactly those vars — they are its auth. Same shape as the Codex
 * adapter's existing `delete env.OPENAI_API_KEY` when file auth wins.
 */
function scrubEnvAuthForScopedHome(env: Record<string, string>, scopedHome: string | undefined): void {
  if (!scopedHome) return;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
}

/**
 * docs/252 — the shaping rule itself now lives in `shared/spawn-routing.ts`, so
 * the orchestrator's own CLI shell-out (session naming, phase 7) can shape a
 * spawn identically without importing this tree. Re-exported here because this
 * is where every existing importer and test looks for it; the ordering contract
 * is unchanged — call it AFTER {@link scrubEnvAuthForScopedHome}.
 */
import { applyServiceRouting } from "../../../shared/spawn-routing.js";
export { applyServiceRouting };

/**
 * Phrases that signal an auth failure in CLI output. Used both for non-JSON
 * stderr lines (startup auth prompts) and for the text of an error `result`
 * event (a runtime 401). docs/142 A1 added the credential/401 phrasings: a
 * runtime "API Error: 401 Invalid authentication credentials" arrives as a
 * structured `result` event with `subtype: "error"`, NOT a stderr line, so it
 * previously slipped past detection and died as a generic error instead of
 * flipping the session into the OAuth/re-auth flow.
 */
const AUTH_ERROR_PATTERNS = [
  "not authenticated",
  "not logged in",
  "authentication required",
  "please login",
  "unauthorized",
  "oauth",
  "sign in",
  "invalid authentication credentials",
  "authentication_error",
  "authentication_failed",
  "invalid api key",
  "invalid x-api-key",
];

/** True when `text` contains any known auth-failure phrase (case-insensitive). */
export function textIndicatesAuthFailure(text: string): boolean {
  const lc = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((p) => lc.includes(p));
}

/**
 * True when a `result` event reports a FAILED turn — `is_error` is the
 * authoritative flag, not `subtype`. The CLI ends an API-error turn with
 * `subtype: "success"` and `is_error: true`; the only non-success subtypes it
 * emits are `error_during_execution` (an interrupt) and `error_max_turns`.
 * Verified against CLI 2.1.219.
 */
export function resultEventIsError(event: ClaudeEvent): boolean {
  if (event.type !== "result") return false;
  return event.is_error === true || event.subtype !== "success";
}

/**
 * True when a parsed event is a FAILED `result` whose message indicates an auth
 * failure (the runtime-401 case). Successful results are ignored — that matters
 * because {@link AUTH_ERROR_PATTERNS} contains generic words ("oauth",
 * "sign in") a legitimate final answer could contain.
 *
 * This gated on `subtype === "error"` until now — a value the real CLI never
 * emits — so no auth failure was ever detected here in production: no
 * `auth_required`, hence no docs/179 quiet retry, no refresher nudge, and no
 * sign-in card. The turn instead "succeeded" carrying the CLI's own
 * `Not logged in · Please run /login` text, and the user had to re-send.
 */
export function resultEventIndicatesAuthFailure(event: ClaudeEvent): boolean {
  if (!resultEventIsError(event) || event.type !== "result") return false;

  // Not every FAILED result is an API failure, and only an API failure can be
  // an auth failure. Two structural exclusions run before any text matching,
  // because {@link AUTH_ERROR_PATTERNS} deliberately contains generic words
  // ("oauth", "sign in") that a *conversation* can contain:
  //
  //   - `error_max_turns` / `error_during_execution` are the turn cap and an
  //     interrupt. Their `result` carries the conversation's trailing text
  //     rather than a CLI error string, so a session doing OAuth work that
  //     hit the turn cap would otherwise be misread as unauthenticated —
  //     swallowed, "healed", and silently re-dispatched, hiding the real
  //     failure and re-running the turn.
  //   - a `terminal_reason` that is present and is not `api_error` says
  //     outright that the upstream call is not what ended the turn. Absent is
  //     not treated as disqualifying: older CLIs omit it, and failing to
  //     detect a genuine auth failure is the bug this whole path exists for.
  if (event.subtype === "error_max_turns" || event.subtype === "error_during_execution") return false;
  if (typeof event.terminal_reason === "string" && event.terminal_reason !== "api_error") return false;

  return typeof event.result === "string" && textIndicatesAuthFailure(event.result);
}

/**
 * True when a parsed event is the CLI's SYNTHETIC assistant message for an auth
 * failure — the first thing an unauthenticated turn emits, ahead of the result
 * event. It is an error envelope, not model output, so the caller both raises
 * `auth_required` from it (recovering a turn earlier than the result event
 * would) and drops it: rendering it would put "Please run /login" in the
 * transcript as the agent's reply, which is not an instruction a ShipIt user
 * can act on — there is no CLI to run it in.
 *
 * Requires `is_api_error_message`, so a model that merely *talks about* signing
 * in can't trip it. Other API errors (quota, overload) carry the same flag with
 * a different `error` code and are deliberately left alone.
 */
export function assistantEventIndicatesAuthFailure(event: ClaudeEvent): boolean {
  if (event.type !== "assistant" || event.is_api_error_message !== true) return false;
  if (typeof event.error === "string" && textIndicatesAuthFailure(event.error)) return true;
  return event.message.content.some(
    (block) => block.type === "text" && textIndicatesAuthFailure(block.text),
  );
}

/**
 * Shared auth-failure gate for the two drain loops. Raises `auth_required` via
 * `emitAuthRequired` and reports whether the event must be SWALLOWED rather
 * than forwarded.
 *
 * Both of the CLI's auth-failure events are swallowed, because an auth failure
 * ends the turn and ShipIt — not the CLI — owns what the user sees next: either
 * the docs/179 quiet heal-and-retry (where a half-rendered failed turn would
 * flicker in and then have to be undone) or the sign-in card. This is already
 * the shape the rest of the system expects: a turn that dies on the stderr auth
 * path emits no `agent_result` either, and `turn-executor` documents that an
 * auth-required turn legitimately ends without one.
 *
 * ## Every event is swallowed, but the raise is latched
 *
 * One auth failure produces TWO auth-shaped events (verified, CLI 2.1.219): the
 * synthetic assistant envelope, then the `is_error` result. Both must be
 * swallowed — each carries the CLI's "Please run /login" copy, and either one
 * reaching the transcript is the bug §3 fixed. But `auth_required` must be
 * raised only ONCE per turn. It is a semantic "this turn failed auth" signal,
 * and its consumers are emphatically not idempotent: the quiet recovery heals
 * the token and re-dispatches the entire turn, so a second raise re-runs the
 * user's turn a second time, side effects and all.
 *
 * De-duplication belongs HERE, at the emitter, rather than in each consumer.
 * The two-event shape is a CLI protocol detail; a consumer receiving a
 * semantic event should not have to know the wire format produced it twice.
 * And there is more than one consumer with non-idempotent side effects — the
 * re-dispatch, plus the visible surface path's error message, refresher nudge
 * and `session_agent_finished` broadcast — so a consumer-side fix would have
 * to be repeated at each of them, and re-repeated at the next one added.
 * Consumers still latch their own turn-scoped work (see
 * `wireAuthRequiredHandler`), because this gate cannot cover a duplicate
 * arriving from a *different* source: the non-JSON branch of each drain loop
 * raises `auth_required` from raw stderr text as well.
 *
 * The latch is per-TURN, not per-process: `StreamingClaudeProcess` is resident
 * across turns, so it resets on each outbound user message. A session that
 * fails auth, recovers, and fails again later must raise the signal again.
 */
function consumeAuthFailureEvent(event: ClaudeEvent, raiseAuthRequiredOnce: () => void): boolean {
  if (!assistantEventIndicatesAuthFailure(event) && !resultEventIndicatesAuthFailure(event)) {
    return false;
  }
  raiseAuthRequiredOnce();
  return true;
}

export interface ClaudeRunOptions {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: ImageAttachment[];
  cwd?: string;
  permissionMode?: PermissionMode;
  /** Path to an MCP config JSON file passed via --mcp-config. */
  mcpConfigPath?: string;
  /**
   * Names of enabled user MCP servers (docs/088). Each contributes a
   * `mcp__<name>__*` glob to the `auto` tool allowlist.
   * Deliberately excluded from `plan` mode — third-party MCP tools cannot be
   * assumed read-only.
   */
  mcpServerNames?: string[];
  /** Model alias or ID to use (e.g., "sonnet", "opus"). */
  model?: string;
  /**
   * docs/252 phase 3 — base URL + credential for the selected model's service.
   * Absent ⇒ the CLI runs against Anthropic exactly as it did before.
   */
  serviceRouting?: ServiceRouting;
  /**
   * Per-spawn HOME override — a same-harness sub-agent spawn's isolated
   * credential root (see `AgentRunParams.homeDir`). Takes precedence over the
   * constructor-injected `resolveHome`, and like a scoped home it triggers the
   * env credential scrub so an ambient key can't out-prefer the root's own
   * on-disk login.
   */
  homeDir?: string;
  /**
   * docs/217 — reasoning effort passed as `--effort <level>`. Valid levels:
   * low, medium, high, xhigh, max (validated server-side against the agent's
   * option set). Omitted → the model's adaptive default.
   */
  reasoningEffort?: string;
  /**
   * Path to a Claude Code settings file (passed as `--settings`). The
   * orchestrator always points this at /etc/shipit/managed-settings.json for
   * the `claude` agent so the PreToolUse branch-block hook is active. See
   * docs/130-block-branch-ops/plan.md.
   */
  settingsPath?: string;
  /**
   * When true, set SHIPIT_AUTO_CREATE_PR=1 in the CLI environment. The
   * managed-settings.json Stop hook self-gates on this var to enforce PR
   * creation. See docs/129-stop-hook-pr-enforcement/plan.md.
   */
  autoCreatePr?: boolean;
  /**
   * docs/211 — when true, set SHIPIT_SANDBOX=1 in the CLI environment. The
   * managed-settings.json PreToolUse branch-block hook self-gates OFF on this
   * var so a Sandbox session's agent can manage its own branches across the
   * repos it clones. See docs/211-sandbox-sessions/plan.md.
   */
  sandbox?: boolean;
  /**
   * planning#267 — when true, set SHIPIT_GUARD_DESTRUCTIVE_GIT=1 in the CLI
   * environment. The managed-settings.json PreToolUse hook arms its
   * destructive-git rule (hard reset / forced checkout / force-push) on this
   * var, so the `shipit branch reset-to-base` safety gate can't be worked
   * around by hand. See docs/130-block-branch-ops/plan.md.
   */
  guardDestructiveGit?: boolean;
  /**
   * docs/193 — the MCP tool the CLI calls for permission prompts
   * (`--permission-prompt-tool`, e.g. `mcp__shipit__permission_prompt`).
   * Routes the CLI's built-in sensitive-file gate to ShipIt's approve/deny card
   * instead of a headless auto-deny (planning#114). Omitted when the permission
   * bridge couldn't be located.
   */
  permissionPromptTool?: string;
}

/**
 * Hand the system prompt to the CLI as a FILE, never as an argv element.
 *
 * `--append-system-prompt <text>` has the same 131,072-byte `MAX_ARG_STRLEN`
 * ceiling that the prompt itself used to hit, and the system prompt is the
 * argument most likely to reach it: ShipIt's own instructions are already tens
 * of kilobytes before anything is added, and `session-agent-run-params.ts`
 * appends the UNBOUNDED conversation replay to this same value on fork, rewind
 * and unresumable-conversation recovery. So the exact failure fixed for the
 * prompt was still reachable here, on a different trigger.
 *
 * `--append-system-prompt-file` takes the identical content with no size limit.
 * It carries no entry of its own in `claude --help` — only a passing mention —
 * so it is worth stating that it is verified working against CLI 2.1.221, the
 * version `docker/agent-cli/package-lock.json` pins exactly. A CLI bump is a
 * deliberate edit in this repo, which is where a change to it would be caught.
 *
 * Returns the path; the caller owns deleting it when the process exits.
 */
function writeSystemPromptFile(text: string): string {
  // randomUUID, not a timestamp: sub-agent spawns run concurrently and two
  // that started in the same millisecond must not share (or delete) one file.
  const path = `/tmp/claude-system-prompt-${randomUUID()}.txt`;
  fs.writeFileSync(path, text, "utf-8");
  return path;
}

/** Best-effort unlink of a temp file; a leftover must never fail a turn. */
function removeFileQuietly(path: string | null): void {
  if (!path) return;
  try { fs.unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Frame one prompt as the NDJSON `user` message the CLI's
 * `--input-format stream-json` mode reads off stdin. Shared by both processes
 * so the one-shot and the resident path put the identical bytes on the wire.
 */
function frameUserMessage(text: string): string {
  const msg = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  return `${JSON.stringify(msg)}\n`;
}

/**
 * docs/105 — make the CLI re-emit the raw Anthropic SSE frames alongside its
 * own events. Passed **only on a service-routed spawn**, and for exactly one
 * reason: the closing `message_delta` frame is the only place a redirected
 * provider may state a single call's token usage, and without a per-call
 * reading the context dial falls back to summing the turn's billing totals —
 * which multiplies context by the call count (a GLM turn read 2.1M against a
 * 1M window). Z.ai zeroes the `assistant` event's usage AND sends
 * `iterations: []`, so the frames are its only reading; measured 2026-08-17.
 *
 * The flag is not free — it adds one event per streamed token chunk, ~440
 * lines where a small turn had 8 — so the first-party Anthropic spawn, which
 * gets an authoritative `result.usage.iterations`, keeps its argv unchanged
 * and pays nothing. The adapter drops every frame except the one it reads, so
 * nothing extra crosses the container boundary either way.
 */
const PARTIAL_MESSAGE_ARGS = ["--include-partial-messages"] as const;

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  /** Separate line buffer for stderr — see the stderr handler in {@link run}. */
  private stderrBuffer = "";
  /** Temp file backing `--append-system-prompt-file`; deleted when the process exits. */
  private systemPromptFile: string | null = null;
  /**
   * A stdin write that failed, held until `close` rather than reported at once.
   * See the stdin handler in {@link run} for why the delay is load-bearing.
   */
  private stdinFailure: Error | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** Per-turn latch — see {@link consumeAuthFailureEvent}. */
  private authRaisedThisTurn = false;

  /**
   * docs/150 — optional per-spawn HOME override. Set only by the local-mode
   * agent factory, which points it at the provider account this session was
   * routed to. Undefined (production, tests) keeps `agentHome()`.
   */
  constructor(private readonly resolveHome?: AgentHomeResolver) {
    super();
  }

  /**
   * Raise `auth_required` at most once per turn. One auth failure emits two
   * auth-shaped events plus possibly a raw stderr line; the signal's
   * consumers re-dispatch the turn, so raising it twice runs the turn twice.
   */
  private raiseAuthRequiredOnce(): void {
    if (this.authRaisedThisTurn) return;
    this.authRaisedThisTurn = true;
    this.emit("auth_required");
  }

  /**
   * Send a prompt to Claude CLI in print mode with streaming JSON output.
   * Emits "event" for each parsed NDJSON line and "done" when the process exits.
   *
   * ## The prompt travels on stdin, never in argv
   *
   * This path used to spawn `claude -p <prompt>` over a PTY, putting the WHOLE
   * prompt in a single argv element. Linux caps one argument at
   * `MAX_ARG_STRLEN` = 32 pages = 131,072 bytes — a limit `getconf ARG_MAX`
   * does not describe and no amount of total-size headroom raises. A prompt at
   * or past that made `execvp` fail with E2BIG, and because node-pty forks
   * before it execs, the failure arrived as a line of *child output*
   * ("execvp(3) failed.: Argument list too long") rather than a spawn error:
   * the CLI never started, emitted no event at all, and the run was reported as
   * an empty success. `shipit agent run --role reviewer` hit this on every
   * review whose prompt carried a diff of any size (~131 KB and up), four times
   * in one session before it was diagnosed.
   *
   * So the prompt is delivered exactly as {@link StreamingClaudeProcess}
   * delivers it — as an NDJSON `user` message on piped stdin under
   * `--input-format stream-json` — which has no size limit. stdin is closed
   * immediately afterwards: that EOF is what makes the CLI finish the turn and
   * exit, keeping this path one-shot (the resident process keeps stdin open
   * precisely to stay alive). Verified against CLI 2.1.221: a 200 KB prompt
   * completes and exits 0.
   *
   * Piped stdio is also what makes an exec failure *loud*. `child_process.spawn`
   * reports E2BIG (and ENOENT) as an `error` event on the child, which this
   * class forwards as `error` — the one signal both the turn executor and
   * `runAgentToCompletion` already map to a failed run.
   *
   * The PTY it replaces was there to dodge a different problem: with `-p
   * <prompt>` the CLI still waits ~3s on piped stdin ("no stdin data received
   * in 3s, proceeding without it") because a prompt could arrive there too. In
   * `--input-format stream-json` mode stdin IS the declared input, so there is
   * nothing to wait for and nothing to hang on.
   *
   * Images are handled by the orchestrator before reaching this method —
   * they're saved to the host uploads directory and referenced in the prompt.
   */
  run(opts: ClaudeRunOptions): void {
    const { prompt, sessionId, systemPrompt, cwd, permissionMode, mcpConfigPath, mcpServerNames, model, reasoningEffort, settingsPath, autoCreatePr, sandbox, guardDestructiveGit, permissionPromptTool, serviceRouting, homeDir } = opts;
    // New turn — this process is one-shot, but reset explicitly so the latch's
    // scope is stated at the turn boundary rather than inferred from lifetime.
    this.authRaisedThisTurn = false;

    // `Skill` is allowlisted in both modes — including plan — so an explicit
    // `/my-skill` invocation is honored in every permission mode. This accepts
    // that plan mode is no longer guaranteed read-only when a user
    // deliberately invokes a side-effecting skill. See docs/138.
    //
    // The internal `shipit` tools (`mcp__shipit__present`,
    // `mcp__shipit__voice_note`,
    // `mcp__shipit__report_shipit_bug`, `mcp__shipit__propose_actions`) are
    // allowlisted by exact name alongside playwright because they're served by
    // the built-in consolidated `shipit` MCP server the worker registers
    // (planning#130; docs/125, docs/093, docs/163, docs/164, docs/207), not a
    // user-configured one — so they never flow through `mcpServerNames`. Without
    // these entries the CLI gates the tools behind an interactive prompt that
    // headless `-p` mode cannot satisfy ("permission not yet granted", docs/149).
    // They write only to ShipIt's own state (present buffer, a voice note, a
    // bug-report proposal, an action-checklist card), so they are
    // safe under plan mode — and the voice tool is needed in plan mode so the
    // agent can author a headline before ExitPlanMode. We list the four
    // model-facing tools by name rather than a `mcp__shipit__*` glob so the
    // server's `permission_prompt` tool (the CLI's --permission-prompt-tool, not
    // model-callable) is deliberately NOT allowlisted.
    //
    // `ExitPlanMode` is allowlisted in both modes — including plan, where it
    // matters most. It's read-only/safe (it only signals the plan is complete),
    // and without it headless `--input-format stream-json` mode gates the call
    // behind an interactive permission prompt the worker can't answer
    // (docs/149). The model then never surfaces a clean `ExitPlanMode` tool_use,
    // so the session is stranded in plan mode (no working PlanApproval card, no
    // file edits). Allowlisting it lets the CLI surface the tool_use, which lets
    // the docs/140 §6.8 live-steering guard render an interactive card.
    const AUTO_TOOLS = "Write,Read,Edit,NotebookEdit,Bash,PowerShell,Monitor,Glob,Grep,LSP,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode,Skill,ShareOnboardingGuide,Workflow,mcp__playwright__*,mcp__shipit__present,mcp__shipit__voice_note,mcp__shipit__report_shipit_bug,mcp__shipit__propose_actions";
    const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode,Skill,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot,mcp__shipit__present,mcp__shipit__voice_note,mcp__shipit__report_shipit_bug,mcp__shipit__propose_actions";

    // docs/088: enabled user MCP servers contribute a `mcp__<name>__*` glob to
    // the `auto` allowlist. `plan` mode deliberately omits them
    // — third-party MCP tools can't be assumed read-only.
    const userMcpGlobs = (mcpServerNames ?? [])
      .map((name) => `mcp__${name}__*`)
      .join(",");
    const withUserMcp = (base: string): string =>
      userMcpGlobs ? `${base},${userMcpGlobs}` : base;

    // `guarded` (docs/138) reuses the AUTO_TOOLS allowlist: the CLI's auto
    // (classifier) mode drops the blanket `Bash` grant and routes shell/network
    // through the classifier, while working-dir Write/Edit stay tier-2
    // auto-approved. Spike-confirmed the allowlist does not suppress the
    // classifier, so reusing AUTO_TOOLS is correct.
    const tools = permissionMode === "plan"
      ? PLAN_TOOLS
      : withUserMcp(AUTO_TOOLS);

    // `--replay-user-messages` is deliberately NOT passed (the resident process
    // does pass it): its echo exists so live steering can ack a mid-turn
    // message, and this path sends exactly one message before closing stdin.
    // Adding it would put an `agent_user_replay` event into a contract that
    // never had one.
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", tools,
    ];

    // Deliberate inversion (docs/138): ShipIt `guarded` → CLI `auto` (the
    // classifier-gated mode); ShipIt `auto` passes no flag. `plan` is verbatim.
    if (permissionMode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (permissionMode === "guarded") {
      args.push("--permission-mode", "auto");
    }

    if (serviceRouting) {
      args.push(...PARTIAL_MESSAGE_ARGS);
    }

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    // docs/193 — route the CLI's sensitive-file permission gate to ShipIt's
    // approve/deny card. `--permission-prompt-tool` is honored only in `--print`
    // mode (this is the headless path), and only fires for "ask"-tier calls —
    // allowlisted working-dir edits still auto-approve, so no prompt spam.
    if (permissionPromptTool) {
      args.push("--permission-prompt-tool", permissionPromptTool);
    }

    if (model) {
      args.push("--model", model);
    }

    if (reasoningEffort) {
      args.push("--effort", reasoningEffort);
    }

    if (settingsPath) {
      args.push("--settings", settingsPath);
    }

    const effectiveSystemPrompt = systemPrompt;

    if (effectiveSystemPrompt) {
      // `--append-system-prompt` (not `--system-prompt`) so the CLI's default
      // system prompt is preserved — that gives us Anthropic's cross-user
      // prompt-cache benefits on the stable preamble, and lets
      // `--exclude-dynamic-system-prompt-sections` move per-machine sections
      // (cwd, git status, env, memory paths) out of the cached prefix and into
      // the first user message. `--exclude-dynamic-system-prompt-sections` is
      // a no-op with `--system-prompt`, which is why we don't use that flag.
      //
      // The `-file` variant, not the inline one — see {@link writeSystemPromptFile}
      // for why this argument is the one most likely to overflow argv.
      this.systemPromptFile = writeSystemPromptFile(effectiveSystemPrompt);
      args.push("--append-system-prompt-file", this.systemPromptFile);
      args.push("--exclude-dynamic-system-prompt-sections");
    }

    // The prompt is no longer in argv, so log its size separately — that number
    // is what a "the run produced nothing" report needs first.
    console.log(
      "[claude] spawning:", "claude", args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(prompt)} | cwd:`, cwd,
    );

    // Build the spawn env. We start from `process.env` (so the CLI inherits
    // PATH, NODE-related vars, etc.) but explicitly normalize the
    // `SHIPIT_AUTO_CREATE_PR` gate: the managed-settings.json Stop hook
    // self-gates on it (docs/130), so if it leaks in from the parent process
    // (e.g. when this orchestrator is itself dogfooded under an outer ShipIt
    // that has the var set) the hook would activate even when `autoCreatePr`
    // is false. Always overwrite with the value derived from this call.
    // docs/150 — the worker runs as the unprivileged `shipit` user whose home
    // is /home/shipit; agentHome() resolves to /root in local mode. A scoped
    // home overrides both in local mode, where it points at the provider
    // account this session was routed to (there is no per-session credentials
    // mount to make the process-global home account-correct). Resolved once
    // per spawn, never at construction. A per-spawn `homeDir` (a same-harness
    // sub-agent's isolated credential root) outranks both.
    const scopedHome = homeDir ?? this.resolveHome?.();
    const spawnEnv: Record<string, string> = {
      ...process.env,
      HOME: resolveAgentHome(scopedHome),
      NODE_ENV: "development",
    };
    scrubEnvAuthForScopedHome(spawnEnv, scopedHome);
    // docs/252 phase 3 — AFTER the scrub, never before: the scrub deletes the
    // very variables this writes.
    const shaped = applyServiceRouting(spawnEnv, serviceRouting);
    if (serviceRouting) {
      console.log(
        `[claude] service routing: ${serviceRouting.serviceId}/${serviceRouting.billingMode}`
        + ` -> ${serviceRouting.baseUrl}`,
      );
      // A redirected spawn with no credential in the environment cannot
      // authenticate, and spawning anyway turns ShipIt's structured
      // `auth_required` into a raw provider 401 the user has to interpret. The
      // Codex adapter already stops here; this is the same answer on the same
      // question. Reachable when a credential write's secrets push failed or
      // timed out (both are deliberately fail-open) between the pick and the
      // turn.
      if (!shaped.credentialDelivered) {
        console.warn(
          `[claude] no credential in the environment for ${serviceRouting.serviceId}`
          + `/${serviceRouting.billingMode} (expected ${serviceRouting.credentialSourceEnv})`,
        );
        this.raiseAuthRequiredOnce();
        return;
      }
    }
    if (autoCreatePr) {
      spawnEnv.SHIPIT_AUTO_CREATE_PR = "1";
    } else {
      delete spawnEnv.SHIPIT_AUTO_CREATE_PR;
    }
    // docs/211 — SHIPIT_SANDBOX=1 turns OFF the managed-settings.json branch-block
    // hook for a Sandbox session (it owns its own branches across cloned repos).
    // Normalized on every spawn like SHIPIT_AUTO_CREATE_PR so a leaked parent
    // value (e.g. dogfooding under an outer ShipIt) can't flip it on.
    if (sandbox) {
      spawnEnv.SHIPIT_SANDBOX = "1";
    } else {
      delete spawnEnv.SHIPIT_SANDBOX;
    }
    // planning#267 — SHIPIT_GUARD_DESTRUCTIVE_GIT=1 arms the same hook's
    // destructive-git rule for a session sitting on a merged branch. Normalized
    // on every spawn for the same reason as the two vars above.
    if (guardDestructiveGit) {
      spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT = "1";
    } else {
      delete spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT;
    }

    try {
      this.proc = spawn("claude", args, {
        cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      removeFileQuietly(this.systemPromptFile);
      this.systemPromptFile = null;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.proc = null;
      return;
    }

    this.buffer = "";
    this.stderrBuffer = "";
    this.stdinFailure = null;

    // Inactivity watchdog: warn if no output within 30 seconds
    this.watchdog = setTimeout(() => {
      console.warn("[claude] No output received within 30 seconds — process may be stuck");
      this.emit("log", "server", "Warning: No output from Claude CLI after 30 seconds. The process may be stuck.");
      this.watchdog = null;
    }, 30_000);

    // stdout carries the NDJSON event stream. ANSI is stripped defensively —
    // the CLI emits none on a pipe, but a stray control sequence would break
    // JSON.parse for the whole line.
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.clearWatchdog();
      this.buffer += stripAnsi(chunk.toString("utf-8"));
      this.drainLines();
    });

    // stderr is its own stream now that this is not a PTY. It carries no
    // events, but it does carry the CLI's startup auth complaints — the same
    // text the merged PTY stream used to route through `drainLines`'s non-JSON
    // branch — so the auth check has to run here too or an unauthenticated
    // one-shot turn stops raising `auth_required`.
    //
    // Buffered into LINES, never checked chunk-by-chunk. A pipe splits wherever
    // it likes, so "Not logged in" can arrive as "Not log" + "ged in" and match
    // no pattern in either half — the PTY path never had that problem because
    // it reassembled lines before matching. Clearing the watchdog here too
    // keeps its "no output in 30s" warning honest: stderr is output.
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.clearWatchdog();
      this.stderrBuffer += stripAnsi(chunk.toString("utf-8"));
      this.drainStderrLines();
    });

    // A failure to exec the CLI (E2BIG on an oversized argv, ENOENT on a
    // missing binary) arrives here, asynchronously. Forwarding it is what turns
    // a CLI that never started into a failed run rather than a silent
    // zero-output success.
    this.proc.on("error", (err) => {
      this.clearWatchdog();
      this.emit("error", err);
    });

    // EPIPE from the write below lands on the STREAM, not on the child, and an
    // unhandled stream `error` takes down the whole worker process. The window
    // is real: a 200 KB prompt flushes across several ticks, so a CLI that dies
    // early (bad flags, a startup auth failure) can close the read end
    // mid-write. Report it as a failed run — at this point in the turn the
    // prompt provably never landed, which is the one thing that must not be
    // mistaken for an empty success.
    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      this.clearWatchdog();
      console.warn(`[claude] stdin error (${err.code ?? "unknown"}): the prompt did not reach the CLI`);
      // HELD, not emitted here. The commonest reason the CLI closes the read
      // end early is that it failed auth and exited — and with a large prompt
      // still flushing, EPIPE can beat the stderr line that says so. Emitting
      // straight away wins that race and tears the turn down as a generic
      // process error, so the auth phrase arrives after the slot is gone: no
      // `auth_required`, no quiet heal-and-retry, no sign-in card, just an
      // error the user cannot act on. Reported below instead, once stderr has
      // been drained and the auth signal has had its chance.
      this.stdinFailure = err;
    });

    this.proc.on("close", (exitCode) => {
      this.clearWatchdog();
      // Drain any remaining buffer, flushing the final (possibly unterminated) line
      this.drainLines(true);
      // Same for stderr: the CLI's last line often has no trailing newline, and
      // an auth complaint stranded in the buffer raises no `auth_required`.
      this.drainStderrLines(true);
      // Now that the drains have had their say, a held stdin failure is safe to
      // report — unless this turn already raised `auth_required`, which owns
      // what the user sees next and must not be shouted over.
      if (this.stdinFailure && !this.authRaisedThisTurn) {
        this.emit("error", this.stdinFailure);
      }
      removeFileQuietly(this.systemPromptFile);
      this.systemPromptFile = null;
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });

    // Deliver the prompt, then close stdin: the EOF is what tells the CLI no
    // further messages are coming, so it finishes this turn and exits.
    this.writeStdin(frameUserMessage(prompt));
    this.proc.stdin?.end();
  }

  /** Emit complete stderr lines, running the auth check on each. */
  private drainStderrLines(flush = false): void {
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = flush ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (textIndicatesAuthFailure(trimmed)) {
        this.raiseAuthRequiredOnce();
      }
      console.warn("[claude] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    }
  }

  /** Write data to the running process's stdin. */
  writeStdin(data: string): void {
    if (!this.proc?.stdin?.writable) {
      // Expected after the prompt is delivered — stdin is closed on purpose.
      console.warn(`[claude] writeStdin: stdin not writable — ${data.length} bytes dropped`);
      return;
    }
    this.proc.stdin.write(data);
  }

  /**
   * Ask the running process to stop, with a force-kill fallback after 5s.
   *
   * SIGINT is the signal a PTY's Ctrl+C used to generate; sending it directly
   * is the same request without a terminal in the way. stdin is already closed
   * by then, so a `control_request` interrupt (the resident process's route) is
   * not available here.
   *
   * The SIGINT itself is deliberately narrow — the CLI alone, so it can flush a
   * turn its tool descendants may still be feeding. Descendants are dealt with
   * by the escalation below, which routes through {@link kill} and therefore
   * through `killProcessTree` (planning#509).
   */
  interrupt(): void {
    if (!this.proc) return;

    killChild(this.proc, "SIGINT");

    // If the process doesn't exit within 5 seconds, force kill
    const forceKillTimer = setTimeout(() => {
      if (this.proc) {
        console.warn("[claude] Force killing process after interrupt timeout");
        this.kill();
      }
    }, 5000);

    // Clear the force-kill timer when the process exits normally
    this.proc.once("close", () => {
      clearTimeout(forceKillTimer);
    });
  }

  /**
   * Kill the running process if any — and everything it spawned. An MCP server's
   * browser outlives a plain pid kill (see `killProcessTree`), so teardown has
   * to be tree-wide or the turn leaves a Chromium burning CPU in the container.
   */
  kill(): void {
    this.clearWatchdog();
    if (this.proc) {
      killProcessTree(this.proc, "SIGTERM", { label: "claude" });
      this.proc = null;
    }
    removeFileQuietly(this.systemPromptFile);
    this.systemPromptFile = null;
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /**
   * Parse complete NDJSON lines from the buffer.
   * @param flush - If true, also attempt to parse the final unterminated segment
   *   (used on process close to avoid losing the last event).
   */
  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    // Keep the last (possibly incomplete) chunk unless flushing
    if (!flush) {
      this.buffer = lines.pop() ?? "";
    } else {
      this.buffer = "";
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as ClaudeEvent;
        // docs/142 A1, docs/179 — an auth failure arrives as structured events,
        // not a stderr line: a synthetic assistant message carrying the CLI's
        // "Please run /login" text, then a result flagged `is_error`. Surface it
        // as an auth failure so the session heals + retries, and swallow the
        // CLI's own error copy.
        if (consumeAuthFailureEvent(event, () => this.raiseAuthRequiredOnce())) continue;
        this.emit("event", event);
      } catch {
        // Not valid JSON — relay as log output.
        // Auth-related messages can also arrive here rather than on stderr.
        if (textIndicatesAuthFailure(trimmed)) {
          this.raiseAuthRequiredOnce();
        }
        console.warn("[claude] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}

/**
 * StreamingClaudeProcess — persistent Claude CLI process using
 * --input-format stream-json for live steering (docs/140).
 *
 * Unlike ClaudeProcess (one-shot per turn), this class:
 * - Spawns once and keeps the process alive across turns.
 * - Sends user messages as NDJSON on stdin.
 * - Treats `result` events as turn-end without killing the process.
 * - Emits `done` only when the process actually exits (on kill/dispose).
 * - Keeps stdin OPEN, which is what keeps the process alive between turns
 *   (the one-shot path closes it to make the CLI exit after one turn).
 */
export class StreamingClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  /** Temp file backing `--append-system-prompt-file`; deleted when the process exits. */
  private systemPromptFile: string | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private requestIdCounter = 0;

  /** See {@link ClaudeProcess}'s constructor — same per-spawn HOME override. */
  constructor(private readonly resolveHome?: AgentHomeResolver) {
    super();
  }
  /**
   * Per-TURN latch — see {@link consumeAuthFailureEvent}. This process is
   * resident across turns, so unlike {@link ClaudeProcess} the reset is
   * load-bearing: it happens in {@link sendUserMessage}, the one place a new
   * turn begins. Without it, a session that failed auth once would never raise
   * the signal again and every later auth failure would go unrecovered.
   */
  private authRaisedThisTurn = false;

  /**
   * Raise `auth_required` at most once per turn. One auth failure emits two
   * auth-shaped events, and the raw-stderr checkers can add a third; the
   * signal's consumers re-dispatch the turn, so raising it twice runs the
   * user's turn twice.
   */
  private raiseAuthRequiredOnce(): void {
    if (this.authRaisedThisTurn) return;
    this.authRaisedThisTurn = true;
    this.emit("auth_required");
  }

  run(opts: ClaudeRunOptions): void {
    const { prompt, sessionId, systemPrompt, cwd, permissionMode, mcpConfigPath, mcpServerNames, model, reasoningEffort, settingsPath, autoCreatePr, sandbox, guardDestructiveGit, permissionPromptTool, serviceRouting, homeDir } = opts;

    // See ClaudeProcess.run above for why the named `mcp__shipit__*` tools join
    // `mcp__playwright__*` in both lists (planning#130; docs/125, docs/149).
    const AUTO_TOOLS = "Write,Read,Edit,NotebookEdit,Bash,PowerShell,Monitor,Glob,Grep,LSP,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode,Skill,ShareOnboardingGuide,Workflow,mcp__playwright__*,mcp__shipit__present,mcp__shipit__voice_note,mcp__shipit__report_shipit_bug,mcp__shipit__propose_actions";
    const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode,Skill,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot,mcp__shipit__present,mcp__shipit__voice_note,mcp__shipit__report_shipit_bug,mcp__shipit__propose_actions";

    const userMcpGlobs = (mcpServerNames ?? []).map((name) => `mcp__${name}__*`).join(",");
    const withUserMcp = (base: string): string => userMcpGlobs ? `${base},${userMcpGlobs}` : base;
    const tools = permissionMode === "plan" ? PLAN_TOOLS : withUserMcp(AUTO_TOOLS);

    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--replay-user-messages",
      "--verbose",
      "--allowedTools", tools,
    ];

    if (permissionMode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (permissionMode === "guarded") {
      args.push("--permission-mode", "auto");
    }

    if (serviceRouting) args.push(...PARTIAL_MESSAGE_ARGS);
    if (sessionId) args.push("--resume", sessionId);
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
    // docs/193 — see ClaudeProcess.run above. Honored in --print stream-json
    // mode too; routes the sensitive-file gate to ShipIt's approve/deny card.
    if (permissionPromptTool) args.push("--permission-prompt-tool", permissionPromptTool);
    if (model) args.push("--model", model);
    if (reasoningEffort) args.push("--effort", reasoningEffort);
    if (settingsPath) args.push("--settings", settingsPath);
    if (systemPrompt) {
      // See ClaudeProcess.run above for why we use --append-system-prompt
      // and --exclude-dynamic-system-prompt-sections instead of --system-prompt.
      // The `-file` variant for the same reason — the resident process gets the
      // same replay-inflated system prompt on a fork or a rewind.
      this.systemPromptFile = writeSystemPromptFile(systemPrompt);
      args.push("--append-system-prompt-file", this.systemPromptFile);
      args.push("--exclude-dynamic-system-prompt-sections");
    }

    // docs/150 — the worker runs as the unprivileged `shipit` user whose home
    // is /home/shipit; agentHome() resolves to /root in local mode. A scoped
    // home overrides both in local mode, where it points at the provider
    // account this session was routed to (there is no per-session credentials
    // mount to make the process-global home account-correct). Resolved once
    // per spawn, never at construction. A per-spawn `homeDir` (a same-harness
    // sub-agent's isolated credential root) outranks both.
    const scopedHome = homeDir ?? this.resolveHome?.();
    const spawnEnv: Record<string, string> = {
      ...process.env,
      HOME: resolveAgentHome(scopedHome),
      NODE_ENV: "development",
    };
    scrubEnvAuthForScopedHome(spawnEnv, scopedHome);
    // docs/252 phase 3 — AFTER the scrub, never before: the scrub deletes the
    // very variables this writes.
    const shaped = applyServiceRouting(spawnEnv, serviceRouting);
    if (serviceRouting) {
      console.log(
        `[claude] service routing: ${serviceRouting.serviceId}/${serviceRouting.billingMode}`
        + ` -> ${serviceRouting.baseUrl}`,
      );
      // A redirected spawn with no credential in the environment cannot
      // authenticate, and spawning anyway turns ShipIt's structured
      // `auth_required` into a raw provider 401 the user has to interpret. The
      // Codex adapter already stops here; this is the same answer on the same
      // question. Reachable when a credential write's secrets push failed or
      // timed out (both are deliberately fail-open) between the pick and the
      // turn.
      if (!shaped.credentialDelivered) {
        console.warn(
          `[claude] no credential in the environment for ${serviceRouting.serviceId}`
          + `/${serviceRouting.billingMode} (expected ${serviceRouting.credentialSourceEnv})`,
        );
        this.raiseAuthRequiredOnce();
        return;
      }
    }
    if (autoCreatePr) {
      spawnEnv.SHIPIT_AUTO_CREATE_PR = "1";
    } else {
      delete spawnEnv.SHIPIT_AUTO_CREATE_PR;
    }
    // docs/211 — SHIPIT_SANDBOX=1 turns OFF the managed-settings.json branch-block
    // hook for a Sandbox session (it owns its own branches across cloned repos).
    // Normalized on every spawn like SHIPIT_AUTO_CREATE_PR so a leaked parent
    // value (e.g. dogfooding under an outer ShipIt) can't flip it on.
    if (sandbox) {
      spawnEnv.SHIPIT_SANDBOX = "1";
    } else {
      delete spawnEnv.SHIPIT_SANDBOX;
    }
    // planning#267 — see ClaudeProcess.run above. NOTE: this process is resident
    // across turns, so the value is fixed at first spawn. That is acceptable
    // because the hazard window — the docs/239 self-merge wake — arrives as a
    // SYSTEM turn, and system turns never reuse the resident streaming process
    // (`dispatched-turn.ts`), so they always spawn with a freshly-computed env.
    if (guardDestructiveGit) {
      spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT = "1";
    } else {
      delete spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT;
    }

    console.log("[streaming-claude] spawning:", "claude", args.slice(0, 8).join(" "), "| cwd:", cwd);

    try {
      this.proc = spawn("claude", args, {
        cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      removeFileQuietly(this.systemPromptFile);
      this.systemPromptFile = null;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.buffer = "";

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.clearWatchdog();
      this.buffer += chunk.toString("utf-8");
      this.drainLines();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      const trimmed = text.trim();
      if (!trimmed) return;
      this.checkAuthMessages(trimmed);
      console.warn("[streaming-claude] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    });

    this.proc.on("error", (err) => {
      this.clearWatchdog();
      this.emit("error", err);
    });

    // EPIPE on a write lands on the STREAM, not on the child, and an unhandled
    // stream `error` takes down the worker process. `writeToStdin`'s guards
    // catch a stdin that is already closed; they cannot catch one that closes
    // mid-write. Log-only here, deliberately: this process is resident across
    // turns, so emitting `error` would tear down a session over a single
    // dropped write, and `writeToStdin` already reports drops the same way.
    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      console.warn(`[streaming-claude] stdin error (${err.code ?? "unknown"}) — message DROPPED`);
      this.emit("log", "server", `Write to the Claude CLI failed (${err.code ?? "unknown"}). The message was not delivered.`);
    });

    this.proc.on("close", (exitCode) => {
      this.clearWatchdog();
      this.drainLines(true);
      removeFileQuietly(this.systemPromptFile);
      this.systemPromptFile = null;
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });

    // Send the initial user message
    this.sendUserMessage(prompt);
  }

  sendUserMessage(text: string, _opts?: { images?: ImageAttachment[] }): void {
    // A new turn starts here — re-arm the auth latch so a later auth failure on
    // this resident process raises `auth_required` again. `run()` reaches this
    // method too, so this is the single reset point for both entry paths.
    this.authRaisedThisTurn = false;
    const line = frameUserMessage(text);
    // docs/140 diag — log bytes written + a text snippet so a live-steering
    // bug repro shows whether the NDJSON line actually reached the CLI's
    // stdin. Paired with the `[claude-adapter]` log one frame up and the
    // worker-side `[steer-worker]` log one frame below.
    console.log(
      `[streaming-claude] sendUserMessage NDJSON bytes=${line.length} text=${JSON.stringify(text.slice(0, 80))}`,
    );
    this.writeToStdin(line);
    this.armWatchdog();
  }

  writeStdin(data: string): void {
    this.writeToStdin(data);
  }

  interrupt(): void {
    const requestId = `ctrl-${++this.requestIdCounter}-${Date.now()}`;
    const msg = {
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt" },
    };
    this.writeToStdin(`${JSON.stringify(msg)}\n`);

    // docs/140 — DO NOT force-kill the process on a streaming interrupt. Unlike
    // the one-shot path (where SIGINT genuinely exits the CLI), a streaming
    // `control_request` interrupt is graceful by design: the CLI ends the
    // current turn with a `result` (subtype `error_during_execution`) and keeps
    // the persistent process alive for the next message. A 5s force-kill timer
    // here always fired — the process never closes, so the timer SIGTERMs the
    // still-alive process (exit 143), tearing down the persistent session and
    // any turn the user steered into it after interrupting. The watchdog (armed
    // on send, cleared on `result`) and idle eviction own teardown of a
    // genuinely stuck process; interrupt must not.
  }

  /**
   * Push a `set_permission_mode` control_request onto stdin so the persistent
   * CLI process changes mode mid-stream — no restart, same session_id. The
   * CLI replies with a control_response and emits a fresh `init` event
   * carrying the new mode (which the orchestrator's existing init listener
   * uses for guarded-availability detection). `mode` is the CLI's string
   * (`"plan"`, `"auto"`, `"default"`, …) — the adapter does the ShipIt → CLI
   * mapping.
   */
  setPermissionMode(cliMode: string): void {
    const requestId = `set-mode-${++this.requestIdCounter}-${Date.now()}`;
    const msg = {
      type: "control_request",
      request_id: requestId,
      request: { subtype: "set_permission_mode", mode: cliMode },
    };
    console.log(`[streaming-claude] setPermissionMode → ${cliMode}`);
    this.writeToStdin(`${JSON.stringify(msg)}\n`);
  }

  /** See {@link ClaudeProcess.kill} — tree-wide for the same reason. */
  kill(): void {
    this.clearWatchdog();
    if (this.proc) {
      killProcessTree(this.proc, "SIGTERM", { label: "streaming-claude" });
      this.proc = null;
    }
    removeFileQuietly(this.systemPromptFile);
    this.systemPromptFile = null;
  }

  private writeToStdin(data: string): void {
    // docs/140 diag — surface the two ways a write to a "live" streaming
    // process can silently drop. Without these warnings the user sees the
    // optimistic message bubble in chat but the CLI never gets the line, and
    // the orchestrator has no record of why.
    if (!this.proc) {
      console.warn(
        `[streaming-claude] writeToStdin: no process — message DROPPED (bytes=${data.length})`,
      );
      this.emit(
        "log",
        "server",
        "Live steering write failed: the streaming process is not running. Message dropped.",
      );
      return;
    }
    if (!this.proc.stdin?.writable) {
      console.warn(
        `[streaming-claude] writeToStdin: stdin not writable (destroyed=${this.proc.stdin?.destroyed ?? "?"}, ended=${this.proc.stdin?.writableEnded ?? "?"}) — message DROPPED (bytes=${data.length})`,
      );
      this.emit(
        "log",
        "server",
        "Live steering write failed: stdin is not writable. Message dropped.",
      );
      return;
    }
    const ok = this.proc.stdin.write(data);
    if (!ok) {
      // Backpressure: write was buffered. Not an error, just noteworthy if a
      // steer never seems to land.
      console.warn(
        `[streaming-claude] writeToStdin: write returned false (backpressure, bytes=${data.length})`,
      );
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      console.warn("[streaming-claude] No output within 30s — process may be stuck");
      this.emit("log", "server", "Warning: No output from Claude CLI after 30 seconds. The process may be stuck.");
      this.watchdog = null;
    }, 30_000);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private checkAuthMessages(text: string): void {
    const lc = text.toLowerCase();
    if (
      lc.includes("not authenticated") ||
      lc.includes("not logged in") ||
      lc.includes("authentication required") ||
      lc.includes("please login") ||
      lc.includes("unauthorized") ||
      lc.includes("oauth") ||
      lc.includes("sign in")
    ) {
      this.raiseAuthRequiredOnce();
    }
  }

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    if (!flush) {
      this.buffer = lines.pop() ?? "";
    } else {
      this.buffer = "";
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as ClaudeEvent;
        // Clear watchdog on any valid event (turn is making progress)
        if (event.type === "result") {
          // Turn ended — arm watchdog for next potential turn; don't kill process
          this.clearWatchdog();
        }
        // docs/142 A1, docs/179 — an auth failure comes through as structured
        // events (synthetic assistant message + `is_error` result), not as
        // stderr; surface it as an auth failure so the session re-auths instead
        // of the turn "succeeding" with the CLI's /login text as its reply.
        if (consumeAuthFailureEvent(event, () => this.raiseAuthRequiredOnce())) continue;
        this.emit("event", event);
      } catch {
        if (textIndicatesAuthFailure(trimmed)) {
          this.raiseAuthRequiredOnce();
        }
        console.warn("[streaming-claude] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}
