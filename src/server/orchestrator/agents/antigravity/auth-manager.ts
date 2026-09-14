import { EventEmitter } from "node:events";
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
import type {
  AgentAuthManager,
  AgentAuthManagerEvents,
  AgentAuthStartOptions,
  AgentAuthScopeOptions,
} from "../../agent-auth-manager.js";
import type { LoginIntegrationId } from "../../../shared/catalogue/types.js";
import type { AgentAuthPendingDetails } from "../../../shared/types/ws-server-messages.js";

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

function tokenExistsAt(home: string): boolean {
  try {
    const st = statSync(antigravityTokenPath(home));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
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
    this.activeCredentialDir = opts?.credentialDir ?? null;
    this.activeFlowAccountId = opts?.accountId ?? null;
    const home = this.homeFor();

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
      this.fail("error", message);
      return;
    }

    this.proc = proc;
    // A pty merges the two streams, so this buffer is also what req 4's error
    // sentence is read from.
    proc.onData((chunk) => {
      this.stderrBuffer += chunk;
      this.handleOutput(chunk);
    });

    proc.onExit(({ exitCode, signal }) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.lastPendingDetails = null;
      this.clearTimeout();
      // A killed run is never a success. node-pty reports SIGTERM as
      // `exitCode: 0`, so cancelling a flow that found an OLD token on disk
      // would otherwise announce a sign-in that never happened — the child
      // process path this replaced reported a null code and could not.
      if (exitCode === 0 && signal === undefined && tokenExistsAt(home)) {
        if (!this.claimTerminal()) return;
        this.emit("complete");
        this.clearActiveScope();
        return;
      }
      // req 4 — Google's own sentence, not ShipIt's generic copy. The
      // eligibility refusal is the case this exists for.
      const message = antigravityStderrErrorText(this.stderrBuffer) ?? this.exitMessage(exitCode, signal);
      this.fail("error", message);
    });

    this.timeoutHandle = setTimeout(() => {
      this.timeoutHandle = null;
      this.fail("timeout", "The Antigravity CLI printed no sign-in link.");
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
    this.emit("pending", details);
  }

  private exitMessage(exitCode: number, signal?: number): string {
    if (signal !== undefined) return `The Antigravity sign-in was stopped (signal ${String(signal)}).`;
    if (this.lastPendingDetails) {
      return "Sign-in did not complete. The CLI reads the authorization code within 60 seconds of"
        + " printing the link — start again and paste it promptly.";
    }
    return `The Antigravity CLI exited with code ${String(exitCode)} without starting a sign-in.`;
  }

  submitCode(code: string): void {
    if (!this.proc) {
      console.warn("[antigravity-auth] submitCode with no sign-in process; the code was dropped");
      return;
    }
    try {
      // What a terminal sends when the user presses Enter; the line discipline
      // maps it to a newline, so the CLI reads one submitted line.
      this.proc.write(`${code.trim()}\r`);
    } catch (err) {
      console.warn(`[antigravity-auth] could not deliver the authorization code: ${String(err)}`);
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
  }
}
