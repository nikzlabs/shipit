import { EventEmitter } from "node:events";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { existsSync, readFileSync, statSync } from "node:fs";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import {
  ANTIGRAVITY_SPAWN_ENV,
  antigravityCliDir,
  antigravityTokenPath,
  syncAntigravityModelProvider,
} from "../../../shared/antigravity-home.js";
import { antigravityStderrErrorText } from "../../../shared/antigravity-stream.js";
import { ensureConfigDir } from "../agent-auth-base.js";
import {
  createCliLineRelay,
  sanitizeAuthDiagnostic,
  type AgentAuthLogLevel,
  type AgentAuthLogPayload,
  type AgentAuthLogSource,
  type AgentAuthProgressPayload,
} from "../auth-diagnostics.js";
import type {
  AgentAuthManager,
  AgentAuthManagerEvents,
  AgentAuthStartOptions,
  AgentAuthScopeOptions,
} from "../../agent-auth-manager.js";
import type { LoginIntegrationId } from "../../../shared/catalogue/types.js";
import type {
  AgentAuthPendingDetails,
  AgentAuthPhase,
} from "../../../shared/types/ws-server-messages.js";

const DEFAULT_HOME = "/root";

/**
 * The CLI has no `login` subcommand: sign-in happens inside a print run, which
 * puts the Google URL on the terminal and then reads the authorization code
 * back from it. The window is the CLI's own 60 seconds and ShipIt cannot extend it, so
 * this timeout only bounds a process that never printed anything.
 */
const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;

/** The prompt is irrelevant; the run exists to carry the OAuth exchange. */
const SIGN_IN_PROMPT = "Reply with the single word pong.";

// Match either host the sign-in link can use.
export const GOOGLE_AUTH_URL_PATTERN = /https:\/\/(?:accounts\.google\.com|antigravity\.google)\/[^\s"']+/;

/** The same URL, but only once something after it proves it is complete. */
const TERMINATED_AUTH_URL_PATTERN =
  /(https:\/\/(?:accounts\.google\.com|antigravity\.google)\/[^\s"']+)[\s"']/;

interface TokenStamp {
  mtimeMs: number;
  size: number;
}

/**
 * Stamped only when the file holds an actual credential. A sign-in is announced
 * off this, so "the file changed" is not enough: a save that died part-way
 * leaves a short, unparseable file whose mtime moved like any other write.
 * `isConfigured` keeps the looser size test on purpose — it reports what the
 * account HAS, while this claims what a run just DID.
 */
function tokenStamp(home: string): TokenStamp | null {
  try {
    const file = antigravityTokenPath(home);
    const st = statSync(file);
    if (!st.isFile() || st.size === 0) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const fields = credentialFields(parsed as Record<string, unknown>);
    const bearer = fields.access_token ?? fields.id_token;
    if (typeof bearer !== "string" || bearer.length === 0) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function tokenExistsAt(home: string): boolean {
  return tokenStamp(home) !== null;
}

/**
 * **`signal` is a number on every exit, and `0` means "not signalled".** node-pty
 * reports a normal exit as `{exitCode, signal: 0}` — never `undefined` — and a
 * SIGTERM as `{exitCode: 0, signal: 15}` (both measured, 2026-09-16,
 * probes/signin-exit-shape.md). Testing `signal === undefined` therefore made
 * the success branch unreachable in production while every injected fake, which
 * omitted the field, kept it green.
 */
function wasSignalled(signal?: number): boolean {
  return typeof signal === "number" && signal !== 0;
}

function readTokenFile(home: string): Record<string, unknown> | null {
  const file = antigravityTokenPath(home);
  try {
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (err) {
    console.warn("[antigravity-auth] could not parse the token file:", err instanceof Error ? err.message : err);
    return null;
  }
}

function jwtPayload(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A real sign-in writes `{auth_method, token: {…}}` — the credential fields sit
 * one level down, under `token` (captured 2026-09-14 from a `consumer`
 * sign-in). Reading only the top level made freshness `null` for every real
 * token, so nothing about an Antigravity credential was ever orderable and a
 * refreshed one could not be recognized as newer and synced back.
 */
function credentialFields(obj: Record<string, unknown>): Record<string, unknown> {
  const nested = obj.token;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : obj;
}

/** `expiry` is ISO-8601; the id/access token's JWT `exp` is the fallback. */
export function readAntigravityTokenFreshness(raw: Record<string, unknown>): number | null {
  const obj = credentialFields(raw);
  const iso = obj.expiry ?? obj.expires_at ?? obj.expiresAt;
  if (typeof iso === "string") {
    const at = Date.parse(iso);
    if (Number.isFinite(at) && at > 0) return at;
  }
  if (typeof iso === "number" && Number.isFinite(iso) && iso > 0) {
    return iso < 10_000_000_000 ? iso * 1000 : iso;
  }
  for (const key of ["id_token", "access_token"]) {
    const exp = jwtPayload(obj[key])?.exp;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) return exp * 1000;
  }
  return null;
}

export function readAntigravityTokenFreshnessFile(file: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return readAntigravityTokenFreshness(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * The preview is free, so the row carries no plan name (docs/274 honest absence)
 * — and a `consumer` sign-in carries no identity either: the captured file holds
 * only `access_token` (opaque, not a JWT), `refresh_token`, `token_type` and
 * `expiry`, with no `id_token` to name the account. So this returns null for the
 * one auth method that has been observed, and the account row shows no email.
 * Kept because the reader is right for a file that does carry one, and a
 * business sign-in has not been seen.
 */
export function extractAntigravityIdentity(
  raw: Record<string, unknown>,
): { externalId: string; email?: string } | null {
  const obj = credentialFields(raw);
  const payload = jwtPayload(obj.id_token);
  const sub = payload?.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;
  const email = payload?.email;
  return { externalId: sub, ...(typeof email === "string" && email.length > 0 ? { email } : {}) };
}

/**
 * The sign-in runs on a PTY, and that is not cosmetic: the CLI decides whether
 * it may start an interactive login by asking whether stdin is a CHARACTER
 * DEVICE, not whether a real terminal exists. On a pipe it logs
 * `not logged in and no controlling terminal` and exits with
 * `Error: authentication required. Run 'antigravity' to log in, then retry.`
 * — and a pipe is exactly what ShipIt must use to deliver the pasted code, so
 * the flow could never complete. Measured on 1.1.27 by varying stdin alone
 * (docs/301-antigravity-harness/probes/signin-stdin-shape.md). The Claude
 * manager spawns on a pty for the same family of reasons.
 */
export interface SignInProcess {
  onData: (cb: (data: string) => void) => void;
  /** `signal` is load-bearing: node-pty reports SIGTERM as `exitCode: 0`. */
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  kill: () => void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { name: string; cols: number; rows: number; env: Record<string, string> },
) => SignInProcess;

export interface AntigravityAuthManagerOptions {
  spawn?: SpawnFn;
  timeoutMs?: number;
  /** Overridden only so a test can drive the REAL spawn against a stub CLI. */
  command?: string;
}

export class AntigravityAuthManager
  extends EventEmitter<AgentAuthManagerEvents>
  implements AgentAuthManager
{
  readonly loginId: LoginIntegrationId = "google-antigravity-oauth";

  private proc: SignInProcess | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private stderrBuffer = "";
  /** The pty's combined output: the link arrives in arbitrary chunking. */
  private outputBuffer = "";
  private lastPendingDetails: AgentAuthPendingDetails | null = null;
  private activeCredentialDir: string | null = null;
  private activeFlowAccountId: string | null = null;
  private activeAttemptId: string | null = null;
  private activeAttemptStartedAt = 0;
  private submittedCodes: string[] = [];
  private terminalEmitted = false;
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private readonly command: string;

  constructor(opts: AntigravityAuthManagerOptions = {}) {
    super();
    this.spawnFn = opts.spawn ?? ((cmd, args, o) => pty.spawn(cmd, [...args], o));
    this.timeoutMs = opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    this.command = opts.command ?? "antigravity";
  }

  private homeFor(dir?: string | null): string {
    return dir ?? this.activeCredentialDir ?? DEFAULT_HOME;
  }

  isConfigured(opts?: AgentAuthScopeOptions): boolean {
    return tokenExistsAt(this.homeFor(opts?.credentialDir));
  }

  getActiveAccountId(): string | null {
    return this.activeFlowAccountId;
  }

  getPendingPayload(): AgentAuthPendingDetails | null {
    return this.lastPendingDetails;
  }

  private authEventBase(): { loginId: LoginIntegrationId; accountId?: string; attemptId: string } {
    return {
      loginId: this.loginId,
      ...(this.activeFlowAccountId ? { accountId: this.activeFlowAccountId } : {}),
      attemptId: this.activeAttemptId ?? "unknown",
    };
  }

  private emitProgress(phase: AgentAuthPhase, message: string): void {
    const elapsedMs = this.activeAttemptStartedAt ? Date.now() - this.activeAttemptStartedAt : undefined;
    const payload: AgentAuthProgressPayload = {
      ...this.authEventBase(),
      phase,
      message: sanitizeAuthDiagnostic(message),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    };
    this.emit("progress", payload);
  }

  /**
   * What the panel in Settings shows, and the only record a failed sign-in
   * leaves: the CLI's own words. The sanitizer keeps a URL's origin and drops
   * its query string, so the sign-in link arrives here as a statement that it
   * was printed — the usable link is the challenge's button, one layer up.
   */
  private emitDiagnosticLog(
    level: AgentAuthLogLevel,
    source: AgentAuthLogSource,
    message: string,
  ): void {
    // **Escapes first, then the known code, then the generic rules.** A pty
    // colours its echo, so an escape inside the code defeats an exact match
    // until it is stripped; and once a generic rule has rewritten part of the
    // code, no later exact match can recognise the rest — the two together
    // published a code's tail as ordinary text.
    const sanitized = sanitizeAuthDiagnostic(this.withoutSubmittedCode(stripAnsi(message)));
    if (!sanitized) return;
    const payload: AgentAuthLogPayload = {
      ...this.authEventBase(),
      timestamp: new Date().toISOString(),
      level,
      source,
      message: sanitized,
    };
    this.emit("log", payload);
  }

  readIdentity(credentialDir?: string): { externalId: string; email?: string } | null {
    const parsed = readTokenFile(this.homeFor(credentialDir));
    return parsed ? extractAntigravityIdentity(parsed) : null;
  }

  start(opts?: AgentAuthStartOptions): void {
    if (this.proc) {
      if (this.lastPendingDetails) this.emit("pending", this.lastPendingDetails);
      return;
    }
    this.stderrBuffer = "";
    this.outputBuffer = "";
    this.lastPendingDetails = null;
    this.terminalEmitted = false;
    this.submittedCodes = [];
    this.activeCredentialDir = opts?.credentialDir ?? null;
    this.activeFlowAccountId = opts?.accountId ?? null;
    this.activeAttemptId = randomUUID();
    this.activeAttemptStartedAt = Date.now();
    this.emitProgress("starting", "Starting the Antigravity CLI sign-in.");
    const home = this.homeFor();
    // Read BEFORE the run: what makes a sign-in a sign-in is a token this flow wrote.
    const baseline = tokenStamp(home);

    ensureConfigDir(antigravityCliDir(home), "[antigravity-auth]");
    // Account mode must not select the key provider.
    syncAntigravityModelProvider(home, false);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...ANTIGRAVITY_SPAWN_ENV,
      HOME: home,
    };
    // An ambient GEMINI_API_KEY (or ADC) would authenticate the run instead.
    scrubHarnessEnvCredentials(env, "antigravity");

    let proc: SignInProcess;
    try {
      proc = this.spawnFn(
        this.command,
        ["-p", SIGN_IN_PROMPT, "--output-format", "text", "--dangerously-skip-permissions"],
        { name: "xterm-color", cols: 80, rows: 40, env },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[antigravity-auth] could not spawn the sign-in run:", message);
      this.emitDiagnosticLog("error", "shipit", `Could not spawn the Antigravity CLI: ${message}`);
      this.fail("error", message);
      return;
    }

    this.proc = proc;
    this.emitProgress("waiting_for_url", "Waiting for the Antigravity CLI to print a sign-in link.");
    // A pty merges the two streams, so this buffer is also what req 4's error
    // sentence is read from.
    // Whole lines, from the shared relay: the reason is in `createCliLineRelay`,
    // and the same boundary already cost the link itself once (`handleOutput`).
    const relay = createCliLineRelay((source, line) => {
      if (line.trim()) this.emitDiagnosticLog("info", source, line.trim());
    });

    proc.onData((chunk) => {
      // A cancelled run keeps draining, and by then `this.proc` may be the NEXT
      // flow's process — so an unguarded callback labels old output with a new
      // account's scope, or replays an expired link as that account's challenge.
      if (this.proc !== proc) return;
      this.stderrBuffer += chunk;
      relay.push("cli_stdout", chunk);
      this.handleOutput(chunk);
    });

    proc.onExit(({ exitCode, signal }) => {
      if (this.proc !== proc) return;
      this.proc = null;
      // The CLI's last line carries no newline when it is a prompt.
      relay.flush();
      const hadPending = this.lastPendingDetails !== null;
      this.lastPendingDetails = null;
      this.clearTimeout();
      const now = tokenStamp(home);
      const wrote = now !== null && (now.mtimeMs !== baseline?.mtimeMs || now.size !== baseline?.size);
      // req 4 — Google's own sentence, not ShipIt's generic copy. The
      // eligibility refusal is the case this exists for.
      const refusal = antigravityStderrErrorText(this.stderrBuffer);
      // The one line that says which branch below was taken, on the terminal
      // AND in the panel — a user reading a failure is looking at the panel.
      const ending =
        `sign-in ended exit=${String(exitCode)} signal=${String(signal)}`
        + ` link=${String(hadPending)} token=${now === null ? "absent" : wrote ? "written" : "unchanged"}`
        + ` refusal=${String(refusal !== undefined)}`;
      console.log(`[antigravity-auth] ${ending}`);
      this.emitDiagnosticLog("info", "shipit", ending);
      /**
       * **A sentence from the CLI outranks the token; past that, the token
       * outranks the exit code.**
       *
       * The refusal has to win because an eligibility check runs AFTER the
       * exchange: an ineligible account gets a perfectly good token and then
       * `Error: Eligibility check failed…`, and calling that connected discards
       * the only explanation the user will get (req 4) to leave an account whose
       * every turn fails.
       *
       * The token has to outrank the exit code because the sign-in rides a print
       * run: a prompt that fails for its own reasons — quota, a blocked host —
       * exits non-zero over a credential that is fine, and failing there strands
       * a user who cannot connect a working account no matter how often they
       * retry. Reasoned, not observed: no probe has captured that exit
       * (probes/signin-exit-shape.md).
       *
       * A killed run is neither — node-pty reports SIGTERM as `exitCode: 0`, so
       * cancelling a flow on a home holding an OLD token would otherwise
       * announce a sign-in that never happened.
       */
      if (refusal === undefined && !wasSignalled(signal) && (wrote || (exitCode === 0 && now !== null))) {
        if (!this.claimTerminal()) return;
        this.emit("complete");
        this.clearActiveScope();
        return;
      }
      this.fail("error", refusal ?? this.exitMessage(exitCode, signal, hadPending));
    });

    this.timeoutHandle = setTimeout(() => {
      this.timeoutHandle = null;
      // Past a printed link this bound is not the one that matters — the CLI's
      // own 60 s window closed long before — so it is a hung process, not a
      // missing link, and saying "no link" contradicts the link on screen.
      this.fail("timeout", this.lastPendingDetails
        ? "The Antigravity sign-in did not finish. Start again."
        : "The Antigravity CLI printed no sign-in link.");
      this.kill();
    }, this.timeoutMs);
  }

  /**
   * Match against the ACCUMULATED output, and only once the URL is terminated by
   * whitespace: a stderr chunk boundary lands wherever the pipe buffer says, so
   * matching a single chunk emits a truncated link (split mid-query-string) or
   * none at all (split inside the host). The user pastes a code against that
   * link, so a truncated one wastes the CLI's 60-second window.
   */
  private handleOutput(text: string): void {
    if (this.lastPendingDetails) return;
    this.outputBuffer += text;
    const match = TERMINATED_AUTH_URL_PATTERN.exec(this.outputBuffer);
    if (!match) return;
    const details: AgentAuthPendingDetails = { kind: "code-paste-url", verificationUri: match[1] };
    this.lastPendingDetails = details;
    this.emitDiagnosticLog("info", "shipit", "Sign-in link received; waiting for the authorization code.");
    this.emit("pending", details);
  }

  /**
   * A pty echoes what is written to it, so the authorization code comes back on
   * the CLI's own output — which is relayed to the panel. The sanitizer's
   * long-secret rule would probably catch it; "probably" is not good enough for
   * a credential, so the exact string we submitted is taken out first.
   *
   * **The marker carries no whitespace.** A URL match ends at the first space,
   * so a spaced marker substituted inside a link truncates what the sanitizer
   * then sees and publishes every parameter after it.
   */
  private withoutSubmittedCode(text: string): string {
    let out = text;
    for (const code of this.submittedCodes) {
      if (out.includes(code)) out = out.split(code).join("[code-redacted]");
    }
    return out;
  }

  /** `hadPending` is passed in: the exit handler clears the field before it asks. */
  private exitMessage(exitCode: number, signal: number | undefined, hadPending: boolean): string {
    if (wasSignalled(signal)) return `The Antigravity sign-in was stopped (signal ${String(signal)}).`;
    if (hadPending) {
      return "Sign-in did not complete. The CLI reads the authorization code within 60 seconds of"
        + " printing the link — start again and paste it promptly.";
    }
    return `The Antigravity CLI exited with code ${String(exitCode)} without starting a sign-in.`;
  }

  submitCode(code: string): void {
    if (!this.proc) {
      console.warn("[antigravity-auth] submitCode with no sign-in process; the code was dropped");
      this.emitDiagnosticLog(
        "warn",
        "shipit",
        "An authorization code arrived after the sign-in run had ended; it was dropped.",
      );
      return;
    }
    try {
      // What a terminal sends when the user presses Enter; the line discipline
      // maps it to a newline, so the CLI reads one submitted line.
      // Every code submitted in this attempt, not just the latest: a second
      // submission would otherwise strip the first one's protection off output
      // still sitting in the line buffer.
      const submitted = code.trim();
      this.submittedCodes.push(submitted);
      this.proc.write(`${submitted}\r`);
      // Never the code itself: it is a credential, and the panel is copyable.
      this.emitDiagnosticLog("info", "shipit", "Authorization code delivered to the CLI.");
      this.emitProgress("checking_credentials", "Code submitted — completing sign-in…");
    } catch (err) {
      console.warn(`[antigravity-auth] could not deliver the authorization code: ${String(err)}`);
      this.emitDiagnosticLog(
        "error",
        "shipit",
        `Could not deliver the authorization code: ${String(err)}`,
      );
    }
  }

  cancel(): void {
    this.kill();
    this.clearActiveScope();
  }

  signOut(_opts?: AgentAuthScopeOptions): void {
    // The token file is removed by the credential layer, which owns the subtree.
    this.kill();
    this.clearActiveScope();
  }

  kill(): void {
    this.clearTimeout();
    const proc = this.proc;
    this.proc = null;
    this.lastPendingDetails = null;
    if (proc) proc.kill();
  }

  private claimTerminal(): boolean {
    if (this.terminalEmitted) return false;
    this.terminalEmitted = true;
    return true;
  }

  private fail(reason: "timeout" | "error", message: string): void {
    if (!this.claimTerminal()) return;
    this.emit("failed", { reason, message });
    this.clearActiveScope();
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
  }

  private clearActiveScope(): void {
    this.activeCredentialDir = null;
    this.activeFlowAccountId = null;
    this.activeAttemptId = null;
    this.activeAttemptStartedAt = 0;
  }
}
