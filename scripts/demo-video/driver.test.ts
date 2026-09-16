import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import {
  PermissionPromptError,
  beatFootageEnd,
  findPendingPermissionPrompt,
  parseArgs,
  readStoryboard,
  resolveWaitCeilingS,
  until,
  verifyRepoPin,
} from "./driver.mjs";

/**
 * The driver's pure parts (docs/296 plan §4): argument parsing, storyboard
 * validation, the per-beat footage end, and the repo pin check. The browser
 * half is exercised against a live instance (plan §8), not here — nothing in
 * this file launches Chromium.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = "214dd22abfea992775adbba46a1d961169ef479b";

describe("parseArgs", () => {
  it("requires instance, scenario and out", () => {
    expect(() => parseArgs([])).toThrow("--instance is required");
    expect(() => parseArgs(["--instance", "http://x"])).toThrow("--scenario is required");
    expect(() => parseArgs(["--instance", "http://x", "--scenario", "s"])).toThrow("--out is required");
  });

  it("defaults to replay mode and no ceiling of its own, and strips a trailing slash", () => {
    const opts = parseArgs(["--instance", "http://x:3000/", "--scenario", "s", "--out", "o"]);
    expect(opts.instance).toBe("http://x:3000");
    expect(opts.mode).toBe("replay");
    expect(opts.waitCeilingS).toBeNull();
    expect(opts.headed).toBe(false);
  });

  it("rejects an unknown mode, a bad ceiling, and an unknown flag", () => {
    const base = ["--instance", "http://x", "--scenario", "s", "--out", "o"];
    expect(() => parseArgs([...base, "--mode", "live"])).toThrow("--mode must be record or replay");
    expect(() => parseArgs([...base, "--wait-ceiling", "0"])).toThrow("--wait-ceiling");
    expect(() => parseArgs([...base, "--bogus"])).toThrow("unknown argument: --bogus");
  });
});

describe("resolveWaitCeilingS", () => {
  it("prefers the flag, then the storyboard's waitCeilingSeconds, then ten minutes", () => {
    const base = ["--instance", "http://x", "--scenario", "s", "--out", "o"];
    expect(resolveWaitCeilingS(parseArgs(base), {})).toBe(600);
    expect(resolveWaitCeilingS(parseArgs(base), { waitCeilingSeconds: 1800 })).toBe(1800);
    expect(resolveWaitCeilingS(parseArgs([...base, "--wait-ceiling", "90"]), { waitCeilingSeconds: 1800 })).toBe(90);
  });
});

describe("readStoryboard", () => {
  const write = (body: unknown): string => {
    const dir = mkdtempSync(join(os.tmpdir(), "storyboard-"));
    writeFileSync(join(dir, "storyboard.json"), JSON.stringify(body));
    return dir;
  };
  const valid = {
    repo: { url: "file://localhost/tmp/demo.git", commit: SHA },
    viewport: { width: 1440, height: 900 },
    beats: [{ id: "a", click: "new-session", wait: [{ composer: "ready" }], lead: 0, hold: 1 }],
  };

  it("accepts the committed phase-1 scenario", () => {
    const sb = readStoryboard(join(HERE, "scenarios", "dogfood-smoke"));
    expect(sb.beats.map((b: { id: string }) => b.id)).toEqual(["new-session", "create", "edit"]);
    expect(sb.repo.url.startsWith("file://localhost/")).toBe(true);
    expect(sb.pace).toEqual({ textCharsPerSecond: 120, typingCharsPerSecond: 30 });
  });

  it("accepts the committed phase-2 scenario, which pins the never-prompting permission mode", () => {
    const sb = readStoryboard(join(HERE, "scenarios", "website-hero"));
    expect(sb.permissionMode).toBe("auto");
    expect(sb.settings).toEqual({ autoCreatePr: true });
    // A real build turn sits inside one beat's wait; the first take on the
    // demo instance (2026-09-16) showed the default ten minutes is too tight a
    // margin for it.
    expect(sb.waitCeilingSeconds).toBe(1800);
    // The agent-works wait keys on the prompt's own noun, not on how the model
    // labels its counter: the first take rendered a zero streak as "—".
    expect(sb.beats[2].wait).toEqual([{ preview_text: "habit" }, { pr_card: "open" }]);
  });

  it("rejects a waitCeilingSeconds that is not a positive number", () => {
    for (const waitCeilingSeconds of [0, -5, "1800"]) {
      expect(() => readStoryboard(write({ ...valid, waitCeilingSeconds }))).toThrow("waitCeilingSeconds must be a positive number");
    }
  });

  it("allows only the auto permission mode: guarded and plan prompt by design", () => {
    for (const mode of ["guarded", "plan", "bypass"]) {
      const dir = write({ ...valid, permissionMode: mode });
      try {
        expect(() => readStoryboard(dir)).toThrow(`permissionMode must be "auto"`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("requires a full-SHA pin, numeric lead/hold, and a positive typing pace", () => {
    const cases: [unknown, string][] = [
      [{ ...valid, repo: { url: valid.repo.url, commit: "abc" } }, "repo.commit must be a full 40-hex SHA"],
      [{ ...valid, beats: [{ id: "a", lead: 0 }] }, "beat a: hold must be a non-negative number"],
      [{ ...valid, beats: [{ id: "a", lead: -1, hold: 1 }] }, "beat a: lead must be a non-negative number"],
      [{ ...valid, pace: { typingCharsPerSecond: 0 } }, "pace.typingCharsPerSecond must be a positive number"],
    ];
    for (const [body, message] of cases) {
      const dir = write(body);
      try {
        expect(() => readStoryboard(dir)).toThrow(message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects a missing repo, viewport, or beats", () => {
    for (const [key, message] of [
      ["repo", "repo.url is required"],
      ["viewport", "viewport {width,height} is required"],
      ["beats", "beats[] is required"],
    ] as const) {
      const { [key]: _omit, ...rest } = valid;
      const dir = write(rest);
      try {
        expect(() => readStoryboard(dir)).toThrow(message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects a beat with both actions, or a duplicate id", () => {
    const both = write({ ...valid, beats: [{ id: "a", type: "hi", click: "merge", lead: 1, hold: 1 }] });
    const dup = write({ ...valid, beats: [{ id: "a", lead: 1, hold: 1 }, { id: "a", lead: 1, hold: 1 }] });
    try {
      expect(() => readStoryboard(both)).toThrow("has both type and click");
      expect(() => readStoryboard(dup)).toThrow("duplicate beat id a");
    } finally {
      rmSync(both, { recursive: true, force: true });
      rmSync(dup, { recursive: true, force: true });
    }
  });
});

describe("beatFootageEnd", () => {
  const story = [
    { id: "session", lead: 0, hold: 1 },
    { id: "prompt", lead: 8, hold: 2 },
    { id: "work", lead: 6, hold: 6 },
  ];

  it("ends where the hold ends, and the hold starts at the later of readyAt and the lead's end", () => {
    // A turn that outlasts its (zero) lead: the hold runs from readyAt.
    expect(beatFootageEnd([{ id: "session", actionAt: 2.4, readyAt: 4.7 }], story)).toBe(5.7);
    // A turn shorter than its lead: the lead [5.7, 13.7] is kept whole and the hold [13.7, 15.7] follows it,
    // so the beat still costs lead + hold — the fixed budget the cut relies on.
    expect(beatFootageEnd([{ id: "session", actionAt: 2.4, readyAt: 4.7 }, { id: "prompt", actionAt: 5.7, readyAt: 9 }], story)).toBe(15.7);
    expect(beatFootageEnd([{ id: "session", actionAt: 2.4, readyAt: 4.7 }, { id: "prompt", actionAt: 5.7, readyAt: 40 }], story)).toBe(42);
  });

  it("starts a beat with no action where the previous hold ended, like the cut does", () => {
    const log = [
      { id: "session", actionAt: 2.4, readyAt: 4.7 },
      { id: "prompt", actionAt: 5.7, readyAt: 9 },
      { id: "work", actionAt: null, readyAt: 12 },
    ];
    // prompt: lead [5.7, 13.7], hold [13.7, 15.7]; work's lead is [15.7, 21.7] and,
    // being ready (12) before that lead ends, its hold is [21.7, 27.7].
    expect(beatFootageEnd(log, story)).toBe(27.7);
  });

  it("makes the kept footage exactly Σ(lead + hold) when every turn outlasts its lead", async () => {
    // Simulated run: each beat acts at the previous footage end (what the
    // driver does) and is ready after a turn longer than its lead.
    const { planSlices, keptSeconds } = await import("./cut-plan.mjs");
    const log: { id: string; actionAt: number | null; readyAt: number }[] = [];
    let now = 2;
    for (const [i, beat] of story.entries()) {
      const actionAt = i === 2 ? null : now;
      const readyAt = now + beat.lead + 5;
      log.push({ id: beat.id, actionAt, readyAt });
      now = beatFootageEnd(log, story);
    }
    expect(keptSeconds(planSlices(log, { beats: story }))).toBe(1 + 10 + 12);
  });

  it("refuses an empty log", () => {
    expect(() => beatFootageEnd([], story)).toThrow("beat log is empty");
  });
});

describe("findPendingPermissionPrompt", () => {
  // The shape of `GET /api/sessions/:id/history`: `messages[].permissionPrompt`
  // is the persisted card (`PersistedPermissionRequest`, chat-history.ts).
  const history = (prompts: Record<string, unknown>[]) => ({
    agentRunning: true,
    messages: [
      { role: "user", text: "build it" },
      { role: "assistant", text: "on it", toolUse: [{ id: "t1", name: "Write" }] },
      ...prompts.map((permissionPrompt) => ({ role: "assistant", text: "", permissionPrompt })),
    ],
  });

  it("names the tool and path of a pending prompt", () => {
    const h = history([
      { requestId: "perm_1", phase: "approved", toolName: "Bash", createdAt: "2026-09-16T00:00:00Z" },
      { requestId: "perm_2", phase: "pending", toolName: "Write", path: ".claude/settings.json", summary: "Write .claude/settings.json", createdAt: "2026-09-16T00:00:01Z" },
    ]);
    expect(findPendingPermissionPrompt(h)).toEqual({
      requestId: "perm_2",
      toolName: "Write",
      path: ".claude/settings.json",
      summary: "Write .claude/settings.json",
    });
  });

  it("is null for a resolved prompt, a transcript without one, and an empty history", () => {
    expect(findPendingPermissionPrompt(history([
      { requestId: "perm_1", phase: "approved", toolName: "Write", path: ".npmrc", createdAt: "x" },
      { requestId: "perm_2", phase: "denied", toolName: "Bash", createdAt: "x" },
    ]))).toBeNull();
    expect(findPendingPermissionPrompt(history([]))).toBeNull();
    expect(findPendingPermissionPrompt({ messages: [] })).toBeNull();
    expect(findPendingPermissionPrompt(null)).toBeNull();
  });

  it("builds an abort message that names the tool and the path", () => {
    const err = new PermissionPromptError({ requestId: "perm_9", toolName: "Write", path: ".claude/settings.json", summary: null });
    expect(err.message).toContain("Write");
    expect(err.message).toContain(".claude/settings.json");
    expect(err.message).toContain("perm_9");
    expect(new PermissionPromptError({ requestId: "perm_3", toolName: "Bash", path: null, summary: "Bash: rm -rf x" }).message).toContain("Bash: rm -rf x");
  });
});

describe("until", () => {
  it("retries a plain error until the ceiling but rethrows a take abort at once", async () => {
    // A thrown error inside the poll is normally swallowed and retried: a
    // locator that is not there yet is not a failure. A PermissionPromptError is
    // the opposite — waiting cannot resolve it — so it must escape immediately
    // rather than surface as "did not hold within N s" after the ceiling.
    let plain = 0;
    await expect(until(() => { plain++; throw new Error("not yet"); }, { ceilingMs: 600, what: "x" }))
      .rejects.toThrow("x did not hold within 1s (last error: not yet)");
    expect(plain).toBeGreaterThan(1);

    let aborts = 0;
    const started = Date.now();
    await expect(until(() => {
      aborts++;
      throw new PermissionPromptError({ requestId: "perm_1", toolName: "Write", path: ".env", summary: null });
    }, { ceilingMs: 60_000, what: "beat build" })).rejects.toBeInstanceOf(PermissionPromptError);
    expect(aborts).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("verifyRepoPin", () => {
  it("accepts a repo whose HEAD is the pin and names both SHAs otherwise", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "demo-pin-"));
    try {
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      };
      execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
      execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "one"], { env });
      const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const url = `file://localhost${dir}`;
      expect(verifyRepoPin({ url, commit: head })).toBe(head);
      expect(() => verifyRepoPin({ url, commit: SHA })).toThrow(`${url} is at ${head}, storyboard pins ${SHA}`);
      expect(() => verifyRepoPin({ url: `file://localhost${dir}-missing`, commit: head })).toThrow(/ls-remote .* failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
