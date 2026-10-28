import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { Opencode2Account } from "./account.js";
import { OPENCODE_ACCOUNT_MARKER } from "../../../shared/opencode-account.js";

let dir: string;
let calls: string[][];
let imported: unknown[];

function project(accountHome: string, access: string): void {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  fs.mkdirSync(path.join(accountHome, "opencode"), { recursive: true });
  fs.writeFileSync(path.join(accountHome, OPENCODE_ACCOUNT_MARKER), JSON.stringify({ id: "b", accountId: "route-1" }));
  fs.writeFileSync(path.join(accountHome, "opencode", "auth.json"), JSON.stringify({ openai: { type: "oauth", access, refresh: "", expires: exp * 1000, accountId: "acct-1" } }));
}

function token(seed: string): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `e30.${Buffer.from(JSON.stringify({ exp, seed, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.sig`;
}

function account(exitCode: number | ((args: string[]) => number) = 0): Opencode2Account {
  return new Opencode2Account({
    dataRoot: path.join(dir, "data"),
    serverUrl: "http://127.0.0.1:1",
    env: {},
    cwd: dir,
    spawnFn: (_cmd, args) => {
      calls.push(args);
      if (args[1] === "import") imported.push(JSON.parse(fs.readFileSync(args[2], "utf8")));
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", typeof exitCode === "number" ? exitCode : exitCode(args)));
      return child as unknown as ChildProcess;
    },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode2-account-"));
  calls = [];
  imported = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const target = () => ({ accountHome: path.join(dir, "account"), accountId: "route-1" });

describe("Opencode2Account", () => {
  it("imports a new token under a new id, activates it, then removes the one it replaced", async () => {
    project(target().accountHome, token("a"));
    await account().sync(target());
    project(target().accountHome, token("b"));
    await account().sync(target());
    const ids = imported.map((file) => (file as { id: string }[])[0].id);
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "auth import", "auth switch",
      "auth import", "auth switch", "auth logout",
    ]);
    expect(calls[3]).toEqual(["auth", "switch", "openai", ids[1], "--server", "http://127.0.0.1:1"]);
    expect(calls[4]).toEqual(["auth", "logout", "openai", ids[0], "--server", "http://127.0.0.1:1"]);
    expect((imported[0] as { value: { methodID: string; refresh: string; metadata: unknown } }[])[0].value)
      .toMatchObject({ methodID: "chatgpt-browser", refresh: "", metadata: { accountID: "acct-1" } });
  });

  it("does nothing when the active credential already holds the token", async () => {
    project(target().accountHome, token("a"));
    await account().sync(target());
    await account().sync(target());
    expect(calls).toHaveLength(2);
  });

  it("deletes the temporary import file, which holds the token", async () => {
    project(target().accountHome, token("a"));
    await account().sync(target());
    expect(fs.existsSync(calls[0][2])).toBe(false);
  });

  it("rejects a projection for another route, without running a command", async () => {
    project(target().accountHome, token("a"));
    await expect(account().sync({ ...target(), accountId: "route-2" })).rejects.toThrow("unavailable or expired");
    expect(calls).toEqual([]);
  });

  it("removes ShipIt's credential for a turn that does not use ChatGPT", async () => {
    project(target().accountHome, token("a"));
    await account().sync(target());
    await account().clear();
    await account().clear();
    expect(calls.map((c) => c[1])).toEqual(["import", "switch", "logout"]);
  });

  it("keeps a credential whose logout failed, and retries it on the next turn", async () => {
    project(target().accountHome, token("a"));
    await account().sync(target());
    const failLogout = (args: string[]): number => (args[1] === "logout" ? 1 : 0);
    await account(failLogout).clear();
    await account(failLogout).clear();
    await account().clear();
    await account().clear();
    expect(calls.map((c) => c[1])).toEqual(["import", "switch", "logout", "logout", "logout"]);
  });

  it("retries a stale credential even when the active one is unchanged", async () => {
    project(target().accountHome, token("a"));
    await account().sync(target());
    project(target().accountHome, token("b"));
    await account((args) => (args[1] === "logout" ? 1 : 0)).sync(target());
    await account().sync(target());
    expect(calls.map((c) => c[1])).toEqual(["import", "switch", "import", "switch", "logout", "logout"]);
  });

  it("runs no command once its turn has closed it", async () => {
    project(target().accountHome, token("a"));
    const closed = account();
    closed.close();
    await expect(closed.sync(target())).rejects.toThrow("the turn has ended");
    expect(calls).toEqual([]);
  });

  it("fails the sync when a command fails", async () => {
    project(target().accountHome, token("a"));
    await expect(account(1).sync(target())).rejects.toThrow("opencode2 auth import exited with code 1");
  });
});
