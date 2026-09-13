import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { killChild } from "../../../shared/kill-child.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import {
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
 * puts the Google URL on stderr and then reads the authorization code from plain
 * stdin. The window is the CLI's own 60 seconds and ShipIt cannot extend it, so
 * this timeout only bounds a process that never printed anything.
 */
const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;

/** The prompt is irrelevant; the run exists to carry the OAuth exchange. */
const SIGN_IN_PROMPT = "Reply with the single word pong.";

// The CLI prints its sign-in link on stderr; match either host it can use.
export const GOOGLE_AUTH_URL_PATTERN = /https:\/\/(?:accounts\.google\.com|antigravity\.google)\/[^\s"']+/;

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

/** `expiry` is ISO-8601; the id/access token's JWT `exp` is the fallback. */
export function readAntigravityTokenFreshness(obj: Record<string, unknown>): number | null {
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

/** The preview is free, so the row carries no plan name (docs/274 honest absence). */
export function extractAntigravityIdentity(
  obj: Record<string, unknown>,
): { externalId: string; email?: string } | null {
  const payload = jwtPayload(obj.id_token);
  const sub = payload?.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;
  const email = payload?.email;
  return { externalId: sub, ...(typeof email === "string" && email.length > 0 ? { email } : {}) };
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export interface AntigravityAuthManagerOptions {
  spawn?: SpawnFn;
  timeoutMs?: number;
}

export class AntigravityAuthManager
  extends EventEmitter<AgentAuthManagerEvents>
  implements AgentAuthManager
{
  readonly loginId: LoginIntegrationId = "google-antigravity-oauth";

  private proc: ChildProcess | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private stderrBuffer = "";
  private lastPendingDetails: AgentAuthPendingDetails | null = null;
  private activeCredentialDir: string | null = null;
  private activeFlowAccountId: string | null = null;
  private terminalEmitted = false;
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;

  constructor(opts: AntigravityAuthManagerOptions = {}) {
    super();
    this.spawnFn = opts.spawn ?? spawn;
    this.timeoutMs = opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
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
    this.lastPendingDetails = null;
    this.terminalEmitted = false;
    this.activeCredentialDir = opts?.credentialDir ?? null;
    this.activeFlowAccountId = opts?.accountId ?? null;
    const home = this.homeFor();

    ensureConfigDir(antigravityCliDir(home), "[antigravity-auth]");
    // Account mode must not select the key provider.
    syncAntigravityModelProvider(home, false);

    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
    // An ambient GEMINI_API_KEY (or ADC) would authenticate the run instead.
    scrubHarnessEnvCredentials(env, "antigravity");

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(
        "antigravity",
        ["-p", SIGN_IN_PROMPT, "--output-format", "text", "--dangerously-skip-permissions"],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[antigravity-auth] could not spawn the sign-in run:", message);
      this.fail("error", message);
      return;
    }

    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => { this.handleOutput(chunk.toString("utf-8")); });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.stderrBuffer += text;
      this.handleOutput(text);
    });

    proc.on("error", (err: Error) => { this.fail("error", err.message); });

    proc.on("close", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.lastPendingDetails = null;
      this.clearTimeout();
      if (code === 0 && tokenExistsAt(home)) {
        if (!this.claimTerminal()) return;
        this.emit("complete");
        this.clearActiveScope();
        return;
      }
      // req 4 — Google's own sentence, not ShipIt's generic copy. The
      // eligibility refusal is the case this exists for.
      const message = antigravityStderrErrorText(this.stderrBuffer)
        ?? (this.lastPendingDetails
          ? "Sign-in did not complete. The CLI reads the authorization code within 60 seconds of printing the link — start again and paste it promptly."
          : `The Antigravity CLI exited with code ${String(code)} without starting a sign-in.`);
      this.fail("error", message);
    });

    this.timeoutHandle = setTimeout(() => {
      this.timeoutHandle = null;
      this.fail("timeout", "The Antigravity CLI printed no sign-in link.");
      this.kill();
    }, this.timeoutMs);
  }

  private handleOutput(text: string): void {
    if (this.lastPendingDetails) return;
    const match = GOOGLE_AUTH_URL_PATTERN.exec(text);
    if (!match) return;
    const details: AgentAuthPendingDetails = { kind: "code-paste-url", verificationUri: match[0] };
    this.lastPendingDetails = details;
    this.emit("pending", details);
  }

  submitCode(code: string): void {
    if (!this.proc?.stdin) {
      console.warn("[antigravity-auth] submitCode with no sign-in process; the code was dropped");
      return;
    }
    this.proc.stdin.write(`${code.trim()}\n`);
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
    if (proc) killChild(proc, "SIGTERM");
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
