import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runShim } from "./shipit.js";
import type { ShimIO } from "./shim-common.js";

interface Recorded { method: string; path: string; body: unknown }
interface Response { status: number; body: Record<string, unknown> }

// Sequenced per route, so a retry can be answered differently from the first attempt.
function makeRunner(script: Record<string, Response[]>) {
  const calls: Recorded[] = [];
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let slept = 0;

  const io: ShimIO = {
    stdout: (t) => { stdout += t; },
    stderr: (t) => { stderr += t; },
    exit: (code) => { exitCode = code; throw new Error("__shim_exit__"); },
  };

  const call = async (method: string, p: string, body: unknown) => {
    const key = `${method} ${p.split("?")[0]}`;
    calls.push({ method, path: p, body });
    const queue = script[key];
    if (!queue || queue.length === 0) return { status: 200, body: { children: [] } };
    return queue.length === 1 ? queue[0] : queue.shift()!;
  };

  async function run(argv: string[]) {
    try {
      await runShim(argv, io, {}, call as never, { sleep: async (ms) => { slept += ms; } });
    } catch (err) {
      if (err instanceof Error && err.message !== "__shim_exit__") throw err;
    }
    return { stdout, stderr, exitCode, calls, slept };
  }

  return { run };
}

async function promptFile(text: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-retry-"));
  const file = path.join(dir, "prompt.txt");
  await fs.writeFile(file, text, "utf-8");
  return file;
}

const CREATE = "POST /agent-ops/session/create";
const OK: Response = {
  status: 200,
  body: { sessionId: "ses_1", branch: "shipit/x", status: "running", session: {} },
};

function createArgs(pf: string, extra: string[] = []): string[] {
  return ["session", "create", "--prompt-file", pf, "--title", "Port API", ...extra];
}

function keyOf(calls: Recorded[], index: number): unknown {
  return (calls[index].body as Record<string, unknown>).idempotencyKey;
}

describe("shipit session create — retry safety (docs/306)", () => {
  it("carries an idempotency key that is stable across identical invocations", async () => {
    const pf = await promptFile("Port API to TS");
    const a = await makeRunner({ [CREATE]: [OK] }).run(createArgs(pf));
    const b = await makeRunner({ [CREATE]: [OK] }).run(createArgs(pf));

    expect(a.exitCode).toBe(0);
    expect(keyOf(a.calls, 0)).toEqual(expect.any(String));
    // Without this the retry below would carry a fresh key and spawn a second session.
    expect(keyOf(a.calls, 0)).toBe(keyOf(b.calls, 0));
  });

  it("derives a different key for a different prompt", async () => {
    const one = await promptFile("Port API to TS");
    const two = await promptFile("Port the CLI to TS");
    const a = await makeRunner({ [CREATE]: [OK] }).run(createArgs(one));
    const b = await makeRunner({ [CREATE]: [OK] }).run(createArgs(two));

    expect(keyOf(a.calls, 0)).not.toBe(keyOf(b.calls, 0));
  });

  it("retries once under the same key when the first attempt is transient, and succeeds", async () => {
    const pf = await promptFile("Port API to TS");
    const { run } = makeRunner({
      [CREATE]: [{ status: 502, body: { error: "Could not reach orchestrator" } }, OK],
    });
    const out = await run(createArgs(pf));

    expect(out.calls).toHaveLength(2);
    expect(keyOf(out.calls, 0)).toBe(keyOf(out.calls, 1));
    expect(out.slept).toBeGreaterThan(0);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("ses_1");
  });

  it("says the session may exist when both attempts fail, instead of reporting a flat failure", async () => {
    const pf = await promptFile("Port API to TS");
    const { run } = makeRunner({
      [CREATE]: [{ status: 502, body: { error: "Could not reach orchestrator" } }],
    });
    const out = await run(createArgs(pf));

    expect(out.exitCode).toBe(1);
    expect(out.calls).toHaveLength(2);
    expect(out.stderr).toContain("could not confirm whether the session was created");
    expect(out.stderr).toContain("does NOT mean no session exists");
    expect(out.stderr).toContain("shipit session list");
  });

  it("points a detached spawn at the sidebar, which is the only place it appears", async () => {
    const pf = await promptFile("Port API to TS");
    const { run } = makeRunner({
      [CREATE]: [{ status: 502, body: { error: "Could not reach orchestrator" } }],
    });
    const out = await run(createArgs(pf, ["--detached"]));

    expect(out.stderr).toContain("sidebar");
    expect(out.stderr).not.toContain("run `shipit session list`");
  });

  it("does not retry a refusal — only a transient status is ambiguous", async () => {
    const pf = await promptFile("Port API to TS");
    const { run } = makeRunner({
      [CREATE]: [{ status: 429, body: { error: "Per-turn spawn limit reached (3)." } }],
    });
    const out = await run(createArgs(pf));

    expect(out.calls).toHaveLength(1);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Per-turn spawn limit");
  });

  it("treats a 200 with no session id as uncertain, not as success", async () => {
    const pf = await promptFile("Port API to TS");
    // callBroker turns an unreadable body into {}, so the status alone says nothing.
    const { run } = makeRunner({ [CREATE]: [{ status: 200, body: {} }] });
    const out = await run(createArgs(pf));

    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain("session-id:");
    expect(out.stderr).toContain("could not confirm whether the session was created");
    expect(out.stderr).toContain("carried no session id");
  });

  it("keeps the first attempt's uncertainty when the retry is refused", async () => {
    const pf = await promptFile("Port API to TS");
    const { run } = makeRunner({
      [CREATE]: [
        { status: 502, body: { error: "Could not reach orchestrator" } },
        { status: 429, body: { error: "Per-turn spawn limit reached (3)." } },
      ],
    });
    const out = await run(createArgs(pf));

    expect(out.exitCode).toBe(1);
    // The refusal may be caused by the session the lost first attempt created.
    expect(out.stderr).toContain("could not confirm whether the session was created");
    expect(out.stderr).toContain("A refusal describes the retry");
    expect(out.stderr).toContain("shipit session list");
  });

  it("says a deduplicated result is the same session, not a second one", async () => {
    const pf = await promptFile("Port API to TS");
    const { run } = makeRunner({
      [CREATE]: [
        { status: 502, body: { error: "Could not reach orchestrator" } },
        { ...OK, body: { ...OK.body, deduplicated: true } },
      ],
    });
    const out = await run(createArgs(pf));

    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("not a second one");
  });
});
