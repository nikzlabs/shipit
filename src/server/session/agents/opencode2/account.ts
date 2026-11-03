// OpenCode 2 keeps credentials in its database and reads a legacy auth.json at most once,
// so the ChatGPT projection is imported instead of rewritten (docs/269-opencode-v2 plan.md,
// "ChatGPT token delivery"). A new id lands inactive; `switch` then activates it with no gap.
// Without --server, `auth` would reach for a shared background service.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { killProcessTree } from "../../../shared/kill-child.js";
import { openCode2CredentialImport, readOpenCodeAccount } from "../../../shared/opencode-account.js";
import { OPENCODE2_BIN } from "./server.js";

const AUTH_COMMAND_TIMEOUT_MS = 30_000;
const STATE_FILE = ".shipit-chatgpt-credential.json";
const INTEGRATION = "openai";

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface Opencode2AccountTarget {
  /** The orchestrator's projection directory (`OpenCode2Roots.account`). */
  accountHome: string;
  /** The route id the projection must match. */
  accountId: string;
}

interface AccountState {
  /** ShipIt's active credential, if any. */
  id?: string;
  /** Replaced credentials whose logout failed; every later sync or clear retries them. */
  stale: string[];
}

export class Opencode2Account {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private active: ChildProcess | null = null;

  constructor(private readonly options: {
    dataRoot: string;
    /** The turn's server: commands change the credential it reads on its next request. */
    serverUrl: string;
    env: Record<string, string>;
    cwd: string;
    spawnFn: SpawnFn;
    onLog?: (message: string) => void;
  }) {}

  /** Import the projection's token unless it is already the active credential. */
  sync(target: Opencode2AccountTarget): Promise<void> {
    return this.enqueue(async () => {
      const { id, json } = openCode2CredentialImport(readOpenCodeAccount(target.accountHome, target.accountId));
      const state = this.readState();
      if (state.id === id) {
        if (state.stale.length > 0) await this.retire(state);
        return;
      }
      const file = path.join(os.tmpdir(), `opencode2-credential-${randomUUID()}.json`);
      try {
        fs.writeFileSync(file, json, { mode: 0o600 });
        await this.auth(["import", file]);
      } finally {
        fs.rmSync(file, { force: true });
      }
      await this.auth(["switch", INTEGRATION, id]);
      await this.retire({ id, stale: state.id ? [...state.stale, state.id] : state.stale });
    });
  }

  /** Remove ShipIt's credentials so a non-ChatGPT route never inherits one. */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      const state = this.readState();
      await this.retire({ stale: state.id ? [...state.stale, state.id] : state.stale });
    });
  }

  /** Stops the commands of a finished turn; its server is gone. */
  close(): void {
    this.closed = true;
    if (this.active) killProcessTree(this.active, "SIGTERM", { label: "opencode2-auth" });
  }

  // Record the ids first, so a crash mid-logout still leaves them to retry.
  private async retire(state: AccountState): Promise<void> {
    this.writeState(state);
    const stale: string[] = [];
    for (const old of state.stale) {
      try {
        await this.auth(["logout", INTEGRATION, old]);
      } catch {
        stale.push(old);
      }
    }
    if (stale.length > 0) this.options.onLog?.("A replaced ChatGPT credential could not be removed from OpenCode 2; the next turn retries.");
    this.writeState({ ...(state.id ? { id: state.id } : {}), stale });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const previous = this.chain;
    const next = (async () => {
      await previous;
      await work();
    })();
    this.chain = next.catch(() => undefined);
    return next;
  }

  private stateFile(): string {
    return path.join(this.options.dataRoot, STATE_FILE);
  }

  private readState(): AccountState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile(), "utf8")) as Partial<AccountState>;
      const stale = Array.isArray(parsed.stale) ? parsed.stale.filter((s): s is string => typeof s === "string") : [];
      return { ...(typeof parsed.id === "string" ? { id: parsed.id } : {}), stale };
    } catch {
      return { stale: [] };
    }
  }

  private writeState(state: AccountState): void {
    if (!state.id && state.stale.length === 0) {
      fs.rmSync(this.stateFile(), { force: true });
      return;
    }
    fs.mkdirSync(this.options.dataRoot, { recursive: true });
    const temporary = `${this.stateFile()}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temporary, this.stateFile());
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  // Never log the command's output: an import failure can echo the token.
  private auth(args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`opencode2 auth ${args[0]} skipped: the turn has ended`));
        return;
      }
      let proc: ChildProcess;
      try {
        proc = this.options.spawnFn(OPENCODE2_BIN, ["auth", ...args, "--server", this.options.serverUrl], {
          cwd: this.options.cwd,
          env: this.options.env,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.active = proc;
      const timer = setTimeout(() => {
        killProcessTree(proc, "SIGTERM", { label: "opencode2-auth" });
        reject(new Error(`opencode2 auth ${args[0]} timed out`));
      }, AUTH_COMMAND_TIMEOUT_MS);
      proc.once("error", (err) => {
        clearTimeout(timer);
        if (this.active === proc) this.active = null;
        reject(new Error(`opencode2 auth ${args[0]} could not start: ${err.message}`));
      });
      proc.once("close", (code) => {
        clearTimeout(timer);
        if (this.active === proc) this.active = null;
        if (code === 0) resolve();
        else reject(new Error(`opencode2 auth ${args[0]} exited with code ${String(code)}`));
      });
    });
  }
}
