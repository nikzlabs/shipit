// Concurrent first-use Codex processes can race on SQLite and skill initialization.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killChild } from "../../../shared/kill-child.js";
import { getErrorMessage } from "../../validation.js";

export const CODEX_HOME_INIT_TIMEOUT_MS = 20_000;

const inFlight = new Map<string, Promise<void>>();

export function isCodexHomeInitialized(codexHome: string): boolean {
  try {
    return fs
      .readdirSync(codexHome)
      .some((entry) => /^state_\d+\.sqlite$/.test(entry));
  } catch {
    return false;
  }
}

// The app-server handshake initializes the root; --version does not.
function runWarmup(codexHome: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killChild(child);
      resolve();
    };

    const child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: path.dirname(codexHome), CODEX_HOME: codexHome },
    });

    const timer = setTimeout(finish, CODEX_HOME_INIT_TIMEOUT_MS);

    child.stdout?.on("data", finish);
    child.on("error", finish);
    child.on("close", finish);

    try {
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { clientInfo: { name: "shipit-codex-home-init", version: "1.0.0" } },
        })}\n`,
      );
    } catch {
      // close settles a broken pipe.
    }
  });
}

// Serializes warm-up within this process only; failure must not block a turn.
export async function ensureCodexHomeInitialized(codexHome: string): Promise<void> {
  const key = path.resolve(codexHome);
  if (isCodexHomeInitialized(key)) return;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const started = Date.now();
  console.log(`[codex-home] initializing cold config root ${key} before spawning against it`);
  const run = (async (): Promise<void> => {
    try {
      await runWarmup(key);
      const ok = isCodexHomeInitialized(key);
      console.log(
        `[codex-home] ${key} ${ok ? "initialized" : "warm-up finished but root still looks cold"}`
          + ` in ${Date.now() - started}ms`,
      );
    } catch (err) {
      console.warn(`[codex-home] warm-up for ${key} failed:`, getErrorMessage(err));
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}

export function resetCodexHomeInitForTests(): void {
  inFlight.clear();
}
