import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Regex patterns to detect OAuth/verification URLs in Claude CLI output.
 * The CLI prints a URL the user must visit to authenticate.
 * Exported for testing.
 */
export const AUTH_URL_PATTERNS = [
  /https:\/\/console\.anthropic\.com\S+/,
  /https:\/\/claude\.ai\/oauth\S*/,
  /https?:\/\/\S*auth\S*verify\S*/i,
  /https?:\/\/\S*login\S*/i,
];

/**
 * Extract an OAuth/auth URL from arbitrary text output.
 * Returns the cleaned URL or `null` if no auth URL is found.
 * Exported for testing.
 */
export function extractAuthUrl(text: string): string | null {
  for (const pattern of AUTH_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[0].replace(/[)\]}>'"]+$/, ""); // strip trailing punctuation
    }
  }
  return null;
}

/** Path where Claude CLI stores credentials. */
const CLAUDE_CONFIG_DIR = "/root/.claude";

export class AuthManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private _authenticated = false;

  get authenticated(): boolean {
    return this._authenticated;
  }

  /**
   * Quick check: does the Claude config directory contain credentials?
   * This is a heuristic — the config dir is populated after successful OAuth.
   */
  checkCredentials(): boolean {
    try {
      const configPath = path.join(CLAUDE_CONFIG_DIR, ".credentials.json");
      const hasCredentials = existsSync(configPath);
      this._authenticated = hasCredentials;
      return hasCredentials;
    } catch {
      return false;
    }
  }

  /**
   * Start the OAuth flow by spawning `claude` interactively.
   * Captures the verification URL from output and emits "auth_url".
   * Emits "auth_complete" once the process exits successfully (credentials saved).
   */
  startOAuthFlow(): void {
    if (this.proc) {
      return;
    }

    console.log("[auth] Starting OAuth flow...");

    // Spawn claude without -p to trigger interactive auth
    this.proc = spawn("claude", [], {
      env: { ...process.env, HOME: "/root" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      console.log("[auth output]", text.trim());

      const url = extractAuthUrl(text);
      if (url) {
        console.log("[auth] Detected auth URL:", url);
        this.emit("auth_url", url);
        return;
      }
    };

    this.proc.stdout!.on("data", handleOutput);
    this.proc.stderr!.on("data", handleOutput);

    this.proc.on("close", (code) => {
      console.log("[auth] OAuth process exited with code", code);
      this.proc = null;

      // Check if credentials were written
      if (this.checkCredentials()) {
        console.log("[auth] Authentication successful");
        this._authenticated = true;
        this.emit("auth_complete");
      } else {
        console.log("[auth] Authentication may have failed (no credentials found)");
        this.emit("auth_failed");
      }
    });

    this.proc.on("error", (err) => {
      console.error("[auth] Process error:", err.message);
      this.proc = null;
      this.emit("auth_error", err);
    });
  }

  /** Kill the auth process if running. */
  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}
