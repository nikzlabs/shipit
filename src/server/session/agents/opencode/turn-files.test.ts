import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { OpencodeAdapter } from "./adapter.js";
import type { AgentRunParams } from "../agent-process.js";
import { writeOpencodeTurnFiles } from "./turn-files.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  pid = 4242;
  kill = vi.fn(() => true);
}

let home: string;
const children: FakeChild[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cache-test-"));
  vi.stubEnv("AGENT_HOME", home);
});

afterEach(() => {
  for (const child of children.splice(0)) child.emit("close", 0, null);
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start(overrides: Partial<AgentRunParams> = {}) {
  const child = new FakeChild();
  children.push(child);
  let configPath = "";
  let config: { instructions?: string[]; provider?: unknown } = {};
  const adapter = new OpencodeAdapter({
    spawnFn: (_cmd, _args, opts) => {
      configPath = opts.env!.OPENCODE_CONFIG!;
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return child as unknown as ChildProcess;
    },
  });
  adapter.run({ prompt: "Reply OK", systemPrompt: "Stable instructions", cwd: home, ...overrides });
  return { adapter, child, configPath, config, instructionPath: config.instructions?.[0] ?? "" };
}

describe("OpenCode turn files and instruction cache identity", () => {
  it("keeps config.instructions identical from first turn through resumed turns with new adapters", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const first = start();
    const content = fs.readFileSync(first.instructionPath, "utf8");
    first.child.emit("close", 0, null);
    expect(fs.existsSync(first.instructionPath)).toBe(false);
    expect(fs.existsSync(first.configPath)).toBe(false);

    vi.mocked(Date.now).mockReturnValue(1_800_000_000_000);
    const resumed = start({ sessionId: "ses_created_by_first_turn" });
    expect(resumed.config.instructions).toEqual(first.config.instructions);
    expect(fs.readFileSync(resumed.instructionPath, "utf8")).toBe(content);
    expect(resumed.configPath).not.toBe(first.configPath);
    resumed.child.emit("close", 0, null);

    vi.mocked(Date.now).mockReturnValue(1_900_000_000_000);
    const third = start({ sessionId: "ses_created_by_first_turn" });
    expect(third.config.instructions).toEqual(first.config.instructions);
    expect(third.instructionPath).not.toMatch(/1700000000000|1800000000000|1900000000000/);
  });

  it("isolates different session workspaces, homes, and overlapping prompt revisions", () => {
    const first = start();
    const otherSession = start({ cwd: path.join(home, "other-session") });
    const scopedHome = start({ homeDir: path.join(home, "scoped-home") });
    const revised = start({ systemPrompt: "Other instructions" });
    const paths = [first, otherSession, scopedHome, revised].map((run) => run.instructionPath);
    expect(new Set(paths).size).toBe(4);
    expect(fs.readFileSync(first.instructionPath, "utf8")).toBe("Stable instructions");
    expect(fs.readFileSync(revised.instructionPath, "utf8")).toBe("Other instructions");
  });

  it("does not acquire instructions for a concurrent consult without a system prompt", () => {
    const main = start();
    const consult = start({ systemPrompt: undefined, homeDir: path.join(home, "consult") });
    expect(consult.config.instructions).toBeUndefined();
    consult.child.emit("close", 0, null);
    expect(fs.existsSync(consult.configPath)).toBe(false);
    expect(fs.readFileSync(main.instructionPath, "utf8")).toBe("Stable instructions");
    main.child.emit("close", 0, null);
    expect(fs.existsSync(main.instructionPath)).toBe(false);
  });

  it("keeps shared instructions until the last reader closes, including after kill", () => {
    const first = start();
    const second = start();
    expect(second.instructionPath).toBe(first.instructionPath);
    expect(second.configPath).not.toBe(first.configPath);

    first.adapter.kill();
    expect(fs.existsSync(first.configPath)).toBe(true);
    expect(fs.existsSync(first.instructionPath)).toBe(true);
    first.child.emit("close", null, "SIGTERM");
    expect(fs.existsSync(first.configPath)).toBe(false);
    expect(fs.existsSync(second.instructionPath)).toBe(true);
    first.adapter.kill();
    expect(fs.existsSync(second.instructionPath)).toBe(true);
    second.child.emit("close", 0, null);
    expect(fs.existsSync(second.instructionPath)).toBe(false);
    expect(fs.existsSync(second.configPath)).toBe(false);
  });

  it("keeps compaction files through server close even after settlement and a successor starts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "true" }));
    const compact = start({ sessionId: "ses_compact", model: "test-model", compact: true });
    const done = vi.fn();
    compact.adapter.on("done", done);
    compact.child.stdout.emit("data", "opencode server listening on http://127.0.0.1:4096\n");
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(compact.child.kill).toHaveBeenCalled();
    expect(fs.existsSync(compact.configPath)).toBe(true);
    expect(fs.existsSync(compact.instructionPath)).toBe(true);

    const successor = start({ sessionId: "ses_compact" });
    expect(successor.instructionPath).toBe(compact.instructionPath);
    compact.child.emit("close", 0, null);
    expect(fs.existsSync(compact.configPath)).toBe(false);
    expect(fs.existsSync(successor.instructionPath)).toBe(true);
  });

  it("releases both files if spawn throws", () => {
    let configPath = "";
    let instructionPath = "";
    const adapter = new OpencodeAdapter({
      spawnFn: (_cmd: string, _args: string[], opts: SpawnOptions) => {
        configPath = opts.env!.OPENCODE_CONFIG!;
        instructionPath = JSON.parse(fs.readFileSync(configPath, "utf8")).instructions[0];
        throw new Error("spawn failed");
      },
    });
    const error = vi.fn();
    adapter.on("error", error);
    adapter.run({ prompt: "OK", systemPrompt: "Instructions", cwd: home });
    expect(error).toHaveBeenCalledOnce();
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(instructionPath)).toBe(false);
  });

  it("releases an acquired instruction file if config writing fails", () => {
    const write = fs.writeFileSync;
    let instructionPath = "";
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (String(file).includes("opencode-config-")) {
        instructionPath = JSON.parse(data as string).instructions[0];
        throw new Error("disk full");
      }
      write(file, data, options);
    });
    const spawnFn = vi.fn();
    const adapter = new OpencodeAdapter({ spawnFn });
    const error = vi.fn();
    adapter.on("error", error);
    adapter.run({ prompt: "OK", systemPrompt: "Instructions", cwd: home });
    expect(error).toHaveBeenCalledOnce();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(instructionPath).not.toBe("");
    expect(fs.existsSync(instructionPath)).toBe(false);
  });

  it("publishes complete instructions atomically and removes a failed publication's temporary file", () => {
    let temporary = "";
    let published = "";
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      temporary = String(source);
      published = String(target);
      expect(fs.readFileSync(source, "utf8")).toBe("Complete instructions");
      expect(fs.existsSync(target)).toBe(false);
      throw new Error("rename failed");
    });
    expect(() => writeOpencodeTurnFiles({}, { home, cwd: home, systemPrompt: "Complete instructions" }))
      .toThrow("rename failed");
    expect(temporary).not.toBe("");
    expect(fs.existsSync(temporary)).toBe(false);
    expect(fs.existsSync(published)).toBe(false);
  });

  it.each(["missing-key", "missing-account"])("creates no turn files for %s", (failure) => {
    const write = vi.spyOn(fs, "writeFileSync");
    const spawnFn = vi.fn();
    const authRequired = vi.fn();
    const adapter = new OpencodeAdapter({ spawnFn });
    adapter.on("auth_required", authRequired);
    const common = { serviceId: "openai", serviceName: "OpenAI", style: "openai-responses", baseUrl: "https://api.openai.com/v1" } as const;
    adapter.run({ prompt: "OK", systemPrompt: "Instructions", cwd: home, model: "test-model",
      serviceRouting: failure === "missing-account"
        ? { ...common, billingMode: "sub", credentialTarget: { kind: "openai-chatgpt", accountId: "missing" } }
        : { ...common, billingMode: "key", credentialSourceEnv: "MISSING_TEST_KEY", credentialTarget: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY" } },
    });
    expect(authRequired).toHaveBeenCalledOnce();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(write.mock.calls.some(([file]) => /opencode-(config|system-prompt)-/.test(String(file)))).toBe(false);
  });

  it.each(["no-session", "no-model", "spawn-throws"])("releases files when compaction cannot start: %s", async (failure) => {
    const paths: string[] = [];
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (String(file).includes("opencode-config-")) {
        paths.push(String(file), ...JSON.parse(data as string).instructions);
      }
      write(file, data, options);
    });
    const adapter = new OpencodeAdapter({ spawnFn: () => { throw new Error("spawn failed"); } });
    const done = vi.fn();
    adapter.on("done", done);
    adapter.run({ prompt: "/compact", systemPrompt: "Instructions", cwd: home, compact: true,
      sessionId: failure === "no-session" ? undefined : "ses_compact",
      model: failure === "no-model" ? undefined : "test-model",
    });
    await vi.waitFor(() => expect(done).toHaveBeenCalledExactlyOnceWith(1));
    expect(paths).toHaveLength(2);
    for (const file of paths) expect(fs.existsSync(file)).toBe(false);
  });
});
