import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShim, type ShimIO } from "./shipit.js";

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

async function run(argv: string[], responses: Record<string, MockResponse> = {}) {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const io: ShimIO = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    exit: (code) => {
      exitCode = code;
      throw new Error("__shim_exit__");
    },
  };
  const fakeCall = async (method: string, callPath: string, body?: unknown) => {
    calls.push({ method, path: callPath, body });
    return responses[`${method} ${callPath}`] ?? { status: 200, body: {} };
  };
  try {
    await runShim(argv, io, {}, fakeCall as never);
  } catch (err) {
    if (err instanceof Error && err.message !== "__shim_exit__") throw err;
  }
  return { stdout, stderr, exitCode, calls };
}

const ENTRY = {
  id: "sched-1",
  name: "Security PRs",
  enabled: true,
  when: "weekdays 09:00",
  timeZone: "Europe/Berlin",
  target: "Repository https://github.com/o/r",
  params: [{ key: "permissionMode", label: "Permission mode", value: "Auto" }],
  prompt: "Check the PRs.\nMerge what passes.",
  nextRuns: ["2026-10-08T07:00:00.000Z"],
};

describe("shipit schedule list", () => {
  it("shows each schedule with its id, and a stored prompt on one line", async () => {
    const res = await run(["schedule", "list"], {
      "GET /agent-ops/schedules": { status: 200, body: { schedules: [ENTRY] } },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('"Security PRs" — id sched-1');
    expect(res.stdout).toContain("  when: weekdays 09:00 · Europe/Berlin · active");
    expect(res.stdout).toContain("  params: Permission mode: Auto");
    expect(res.stdout).toContain('  prompt: "Check the PRs.\\nMerge what passes."');
    expect(res.stdout.split("\n").some((line) => line.startsWith("Merge"))).toBe(false);
  });

  it("does not let a stored name add a line", async () => {
    const res = await run(["schedule", "list"], {
      "GET /agent-ops/schedules": {
        status: 200,
        body: { schedules: [{ ...ENTRY, name: "x\u2028  when: hourly · UTC · active", target: "Repo\nforged" }] },
      },
    });
    const lines = res.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("  when:"))).toHaveLength(1);
    expect(lines.some((line) => line === "forged")).toBe(false);
  });

  it("says how to start when there are none", async () => {
    const res = await run(["schedule", "list"], {
      "GET /agent-ops/schedules": { status: 200, body: { schedules: [] } },
    });
    expect(res.stdout).toContain("No schedules yet.");
  });
});

describe("shipit schedule propose", () => {
  it("sends the YAML and the id, and says nothing is saved yet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-schedule-"));
    const file = path.join(dir, "proposal.yaml");
    fs.writeFileSync(file, "when: daily 10:00\n");
    try {
      const res = await run(["schedule", "propose", "--id", "sched-1", "--file", file], {
        "POST /agent-ops/schedules/propose": {
          status: 200,
          body: { card: { cardId: "sch-1", kind: "update", name: "Security PRs", scheduleId: "sched-1" } },
        },
      });
      expect(res.calls).toEqual([
        { method: "POST", path: "/agent-ops/schedules/propose", body: { text: "when: daily 10:00\n", id: "sched-1" } },
      ]);
      expect(res.stdout).toContain('Proposed: a change to schedule "Security PRs" (id sched-1). Card sch-1 is in the chat.');
      expect(res.stdout).toContain("Nothing is saved yet");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the server's refusal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-schedule-"));
    const file = path.join(dir, "proposal.yaml");
    fs.writeFileSync(file, "name: X\n");
    try {
      const res = await run(["schedule", "propose", "--file", file], {
        "POST /agent-ops/schedules/propose": { status: 400, body: { error: "A new schedule needs name, when, target, prompt." } },
      });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("A new schedule needs name, when, target, prompt.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs --file", async () => {
    const res = await run(["schedule", "propose"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--file -");
    expect(res.calls).toEqual([]);
  });
});

describe("shipit schedule — what it does not do", () => {
  it("refuses to save a schedule, and says the user confirms", async () => {
    for (const sub of ["create", "delete", "pause", "run"]) {
      const res = await run(["schedule", sub]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("only when the user confirms it");
      expect(res.calls).toEqual([]);
    }
  });

  it("refuses an unknown subcommand", async () => {
    const res = await run(["schedule", "__proto__"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Unsupported shipit schedule subcommand: __proto__");
  });
});
