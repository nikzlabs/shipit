import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

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

/** Strip ANSI escape codes and terminal control sequences from text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /\x1b(?:\[[0-9;?]*[a-zA-Z@`]|\][^\x07]*\x07|[()#][A-Z0-9]|[>=])/g,
    "",
  );
}

/**
 * Extract an OAuth/auth URL from arbitrary text output.
 * Returns the cleaned URL or `null` if no auth URL is found.
 * Exported for testing.
 */
export function extractAuthUrl(text: string): string | null {
  const clean = stripAnsi(text);
  for (const pattern of AUTH_URL_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      return match[0].replace(/[)\]}>'"]+$/, ""); // strip trailing punctuation
    }
  }
  return null;
}

/**
 * Extract a full URL from buffered output, joining lines that were
 * wrapped by the terminal. Finds the last `https://` and extracts the
 * contiguous URL block (up to the next empty line), then strips all
 * whitespace/control characters to rejoin wrapped lines.
 * Exported for testing.
 */
export function extractUrlFromBuffer(buffer: string): string | null {
  const clean = stripAnsi(buffer);
  const start = clean.lastIndexOf("https://");
  if (start === -1) return null;

  const afterStart = clean.substring(start);

  // Find the URL block boundary: an empty line (\n followed by optional \r then \n).
  // PTY wrapping produces contiguous lines; an empty line signals end of the URL.
  const emptyLine = afterStart.search(/\n\r?\n/);
  const block = emptyLine !== -1 ? afterStart.substring(0, emptyLine) : afterStart;

  // Remove all newlines/carriage returns to join wrapped lines
  const joined = block.replace(/[\r\n]+/g, "");

  // Extract URL-safe characters, stopping at the first non-URL char (e.g. space)
  let url = "";
  for (const ch of joined) {
    if (/[a-zA-Z0-9%=&?+\-_./:~!*'()]/.test(ch)) {
      url += ch;
    } else {
      break;
    }
  }
  return url.length > 20 ? url : null;
}

/** Path where Claude CLI stores credentials. */
const CLAUDE_CONFIG_DIR = "/root/.claude";

/** Trigger phrases that indicate the code-paste URL has been printed. */
const CODE_PASTE_TRIGGERS = ["Paste code here", "Pastecodehereifprompted"];

export class AuthManager extends EventEmitter {
  private proc: IPty | null = null;
  private _authenticated = false;
  private credentialsPollInterval: ReturnType<typeof setInterval> | null = null;
  private outputBuffer = "";
  private authUrlEmitted = false;
  private wizardTimer: ReturnType<typeof setTimeout> | null = null;
  private wizardEnterCount = 0;

  get authenticated(): boolean {
    return this._authenticated;
  }

  /**
   * Quick check: does the Claude config directory contain credentials,
   * or is ANTHROPIC_API_KEY set in the environment?
   */
  checkCredentials(): boolean {
    try {
      // The CLI may store credentials in different files depending on version
      const credentialFiles = [".credentials.json", "credentials.json", "auth.json"];
      const hasCredentials = credentialFiles.some((f) => existsSync(path.join(CLAUDE_CONFIG_DIR, f)));
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
      this._authenticated = hasCredentials || hasApiKey;
      return this._authenticated;
    } catch {
      return false;
    }
  }

  /**
   * Start the OAuth flow by spawning `claude /login` in a pseudo-terminal.
   *
   * Uses node-pty to allocate a real PTY, so the CLI sees a terminal and
   * shows its interactive login flow (setup wizard, OAuth URL, code prompt).
   * Writing to the PTY goes directly to the terminal master fd — the same
   * as a real user typing — so readline prompts work correctly.
   *
   * Emits "auth_url" when the URL is detected, "auth_complete" when
   * credentials appear on disk, or "auth_failed" on timeout.
   */
  startOAuthFlow(): void {
    if (this.proc) {
      return;
    }

    console.log("[auth] Starting OAuth flow (node-pty)...");
    this.outputBuffer = "";
    this.authUrlEmitted = false;

    // Use a wide terminal to minimize URL wrapping
    this.proc = pty.spawn("claude", ["/login"], {
      name: "xterm-256color",
      cols: 200,
      rows: 24,
      env: { ...process.env, HOME: "/root" } as Record<string, string>,
    });

    this.proc.onData((data: string) => {
      const cleaned = stripAnsi(data);
      this.outputBuffer += cleaned;
      console.log("[auth output]", cleaned.trim());

      // Wait for "Paste code here" trigger — this means the CLI has printed
      // the code-paste URL. Extract the full URL from the buffer, joining
      // lines that were wrapped. Truncate buffer at the trigger position so
      // trigger text (which may be glued directly onto the URL) is excluded.
      if (!this.authUrlEmitted) {
        const triggerPos = this.findTriggerPos();
        if (triggerPos !== -1) {
          const url = extractUrlFromBuffer(this.outputBuffer.substring(0, triggerPos));
          if (url) {
            console.log("[auth] Detected code-paste auth URL:", url);
            this.authUrlEmitted = true;
            this.emit("auth_url", url);
          }
        }
      }

      // The CLI has a first-run setup wizard (theme, login method, etc.)
      // that blocks before reaching the auth URL. Instead of detecting
      // specific prompt characters (which may arrive in separate chunks),
      // use a debounce: after output settles for 1s, send Enter to accept
      // the default and proceed to the next screen.
      if (!this.authUrlEmitted && this.wizardEnterCount < 5 && this.findTriggerPos() === -1) {
        if (this.wizardTimer) clearTimeout(this.wizardTimer);
        this.wizardTimer = setTimeout(() => {
          if (!this.authUrlEmitted && this.proc && this.findTriggerPos() === -1) {
            this.wizardEnterCount++;
            console.log(`[auth] Wizard: output settled, sending Enter (${this.wizardEnterCount}/5)`);
            this.proc.write("\r");
          }
        }, 1000);
      }
    });

    this.proc.onExit(({ exitCode }) => {
      console.log("[auth] OAuth process exited with code", exitCode);
      this.proc = null;

      // Last chance: try to extract URL from buffer if not yet emitted
      if (!this.authUrlEmitted) {
        const triggerPos = this.findTriggerPos();
        const buf = triggerPos !== -1 ? this.outputBuffer.substring(0, triggerPos) : this.outputBuffer;
        const url = extractUrlFromBuffer(buf);
        if (url) {
          this.authUrlEmitted = true;
          this.emit("auth_url", url);
        }
      }

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
  }

  /** Find the position of the first trigger phrase in the output buffer. */
  private findTriggerPos(): number {
    for (const trigger of CODE_PASTE_TRIGGERS) {
      const pos = this.outputBuffer.indexOf(trigger);
      if (pos !== -1) return pos;
    }
    return -1;
  }

  /** Write an authorization code to the PTY (for the "Paste code here" prompt). */
  sendCode(code: string): void {
    if (this.proc) {
      const trimmed = code.trim();
      console.log("[auth] Sending auth code to PTY (%d chars)", trimmed.length);
      // Write code characters first, then Enter (\r) after a short delay.
      // Sending them separately ensures the CLI's Ink input handler processes
      // the code text before receiving the Enter keypress.
      this.proc.write(trimmed);
      setTimeout(() => {
        if (this.proc) {
          console.log("[auth] Sending Enter to confirm code");
          this.proc.write("\r");
        }
      }, 200);
      // The CLI may stay running in interactive mode after authentication
      // succeeds (it enters the REPL rather than exiting). Poll for
      // credentials on disk so we can detect success without waiting for exit.
      this.startCredentialsPoll();
    } else {
      console.warn("[auth] Cannot send code — no PTY process");
    }
  }

  /** Poll for credentials appearing on disk after code submission. */
  private startCredentialsPoll(): void {
    this.clearCredentialsPoll();
    console.log("[auth] Starting credentials poll (checking", CLAUDE_CONFIG_DIR, "every 500ms)");
    let attempts = 0;
    this.credentialsPollInterval = setInterval(() => {
      attempts++;
      if (this.checkCredentials()) {
        console.log("[auth] Credentials detected on disk after code submission");
        this._authenticated = true;
        this.clearCredentialsPoll();
        this.kill();
        this.emit("auth_complete");
      } else if (attempts >= 60) {
        // Give up after 30 seconds (60 × 500ms)
        console.log("[auth] Credentials poll timed out — no credentials found in", CLAUDE_CONFIG_DIR);
        this.clearCredentialsPoll();
        this.emit("auth_failed");
      }
    }, 500);
  }

  /** Stop polling for credentials. */
  private clearCredentialsPoll(): void {
    if (this.credentialsPollInterval) {
      clearInterval(this.credentialsPollInterval);
      this.credentialsPollInterval = null;
    }
  }

  /** Kill the auth process if running. */
  kill(): void {
    if (this.wizardTimer) {
      clearTimeout(this.wizardTimer);
      this.wizardTimer = null;
    }
    this.clearCredentialsPoll();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
