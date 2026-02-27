import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readlinkSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { stripAnsi } from "../shared/strip-ansi.js";

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

/** Path where Claude CLI stores user preferences (onboarding state, theme, etc.). */
const CLAUDE_USER_CONFIG = "/root/.claude.json";

/** Trigger phrases that indicate the code-paste URL has been printed. */
const CODE_PASTE_TRIGGERS = ["Paste code here", "Pastecodehereifprompted"];

/**
 * Ensure the Claude CLI's onboarding wizard and workspace trust prompt
 * are pre-configured so `claude /login` goes straight to the login flow.
 *
 * - `hasCompletedOnboarding` skips the first-run setup wizard.
 * - `projects` entries with `hasTrustDialogAccepted` skip the "trust this folder?" prompt.
 *
 * See: https://github.com/anthropics/claude-code/issues/4714
 */
function ensureOnboardingComplete(): void {
  try {
    let config: Record<string, unknown> = {};
    if (existsSync(CLAUDE_USER_CONFIG)) {
      const raw = readFileSync(CLAUDE_USER_CONFIG, "utf-8");
      config = JSON.parse(raw);
    }

    let changed = false;

    if (!config.hasCompletedOnboarding) {
      config.hasCompletedOnboarding = true;
      changed = true;
    }

    // Pre-trust known directories so the CLI doesn't show the workspace trust prompt.
    // /app is the container WORKDIR (where the server runs), /workspace is the data volume.
    const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
    for (const dir of ["/app", "/workspace"]) {
      if (!projects[dir]?.hasTrustDialogAccepted) {
        projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
        changed = true;
      }
    }
    if (changed) config.projects = projects;

    // Ensure the CLI's config directory exists. In Docker, /root/.claude is a
    // symlink to /credentials/.claude — mkdirSync fails on a broken symlink, so
    // resolve the target and create that instead.
    let configDirToCreate = CLAUDE_CONFIG_DIR;
    try {
      configDirToCreate = readlinkSync(CLAUDE_CONFIG_DIR);
    } catch {
      // Not a symlink or doesn't exist — use the path directly
    }
    mkdirSync(configDirToCreate, { recursive: true });

    if (changed) {
      writeFileSync(CLAUDE_USER_CONFIG, JSON.stringify(config, null, 2));
      console.log("[auth] Updated", CLAUDE_USER_CONFIG, "— onboarding + trust");
    }
  } catch (err) {
    console.warn("[auth] Failed to pre-create Claude config:", err);
  }
}

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
      console.log("[auth] startOAuthFlow() skipped — PTY process already running (pid %d)", this.proc.pid);
      return;
    }

    console.log("[auth] Starting OAuth flow (node-pty)...");
    this.outputBuffer = "";
    this.authUrlEmitted = false;
    this.wizardEnterCount = 0;

    // Skip the first-run onboarding wizard by marking it complete
    ensureOnboardingComplete();

    // Use a wide terminal to minimize URL wrapping
    this.proc = pty.spawn("claude", ["/login"], {
      name: "xterm-256color",
      cols: 200,
      rows: 24,
      env: { ...process.env, HOME: "/root" } as Record<string, string>,
    });
    console.log("[auth] Spawned claude /login (pid %d)", this.proc.pid);

    // Watchdog: if no output after 15s, log diagnostic info
    const watchdog = setTimeout(() => {
      if (!this.authUrlEmitted && this.outputBuffer.length === 0 && this.proc) {
        console.warn("[auth] Watchdog: no output received after 15s. Process pid:", this.proc.pid);
        console.warn("[auth] Watchdog: sending Enter to probe");
        this.proc.write("\r");
      }
    }, 15000);
    this.proc.onExit(() => clearTimeout(watchdog));

    this.proc.onData((data: string) => {
      const cleaned = stripAnsi(data);
      this.outputBuffer += cleaned;
      if (cleaned.trim()) {
        console.log("[auth output]", cleaned.trim());
      } else if (data.length > 0) {
        console.log("[auth] Received %d bytes of terminal control data", data.length);
      }

      // Try to detect the auth URL in the accumulated output.
      // Primary: look for "Paste code here" trigger and extract URL before it.
      // Fallback: try extracting any auth URL from the full buffer (the trigger
      // text may not be visible after ANSI stripping in some CLI versions).
      if (!this.authUrlEmitted) {
        const triggerPos = this.findTriggerPos();
        if (triggerPos !== -1) {
          const url = extractUrlFromBuffer(this.outputBuffer.substring(0, triggerPos));
          if (url) {
            console.log("[auth] Detected code-paste auth URL:", url);
            this.authUrlEmitted = true;
            this.emit("auth_url", url);
          }
        } else {
          // Fallback: check for auth URL patterns directly in the buffer
          const url = extractAuthUrl(this.outputBuffer);
          if (url) {
            console.log("[auth] Detected auth URL (fallback):", url);
            this.authUrlEmitted = true;
            this.emit("auth_url", url);
          }
        }
      }

      // Send Enter to navigate past interactive prompts (trust, login method).
      // Debounce: wait for output to settle before pressing Enter.
      this.scheduleWizardEnter();
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

  /**
   * Schedule (or reschedule) the next wizard Enter keypress.
   * Each incoming data chunk resets the debounce. After sending Enter,
   * self-schedules the next one so we don't stall if the CLI produces
   * no further output (common with cursor-based Ink menus).
   */
  private scheduleWizardEnter(): void {
    if (this.authUrlEmitted || this.wizardEnterCount >= 10 || this.findTriggerPos() !== -1) {
      if (this.wizardEnterCount >= 10 && !this.authUrlEmitted) {
        console.log("[auth] Exhausted Enter attempts. Buffer (%d chars):", this.outputBuffer.length);
        console.log("[auth] Buffer contents:", this.outputBuffer.substring(0, 500));
      }
      return;
    }
    if (this.wizardTimer) clearTimeout(this.wizardTimer);
    // First Enter waits 2s for output to settle. Subsequent self-scheduled
    // Enters use 3s to give the CLI time to render the next screen.
    const delay = this.wizardEnterCount === 0 ? 2000 : 3000;
    this.wizardTimer = setTimeout(() => {
      if (!this.authUrlEmitted && this.proc && this.findTriggerPos() === -1 && this.wizardEnterCount < 10) {
        this.wizardEnterCount++;
        console.log(`[auth] Wizard: sending Enter (${this.wizardEnterCount}/10)`);
        this.proc.write("\r");
        // Self-schedule: if the CLI doesn't produce output after this
        // Enter, we'll still send the next one after a longer delay.
        this.scheduleWizardEnter();
      }
    }, delay);
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
