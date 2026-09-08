import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import { beatFootageEnd, parseArgs, readStoryboard, verifyRepoPin } from "./driver.mjs";

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

  it("defaults to replay mode and a ten-minute ceiling, and strips a trailing slash", () => {
    const opts = parseArgs(["--instance", "http://x:3000/", "--scenario", "s", "--out", "o"]);
    expect(opts.instance).toBe("http://x:3000");
    expect(opts.mode).toBe("replay");
    expect(opts.waitCeilingS).toBe(600);
    expect(opts.headed).toBe(false);
  });

  it("rejects an unknown mode, a bad ceiling, and an unknown flag", () => {
    const base = ["--instance", "http://x", "--scenario", "s", "--out", "o"];
    expect(() => parseArgs([...base, "--mode", "live"])).toThrow("--mode must be record or replay");
    expect(() => parseArgs([...base, "--wait-ceiling", "0"])).toThrow("--wait-ceiling");
    expect(() => parseArgs([...base, "--bogus"])).toThrow("unknown argument: --bogus");
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

  it("is the later of the lead's end and the hold's end", () => {
    // A turn that outlasts its lead: the hold decides.
    expect(beatFootageEnd([{ id: "session", actionAt: 2.4, readyAt: 4.7 }], story)).toBe(5.7);
    // A turn shorter than its lead: the lead decides, so the typing footage is complete.
    expect(beatFootageEnd([{ id: "session", actionAt: 2.4, readyAt: 4.7 }, { id: "prompt", actionAt: 5.7, readyAt: 9 }], story)).toBe(13.7);
    expect(beatFootageEnd([{ id: "session", actionAt: 2.4, readyAt: 4.7 }, { id: "prompt", actionAt: 5.7, readyAt: 40 }], story)).toBe(42);
  });

  it("starts a beat with no action where the previous hold ended, like the cut does", () => {
    const log = [
      { id: "session", actionAt: 2.4, readyAt: 4.7 },
      { id: "prompt", actionAt: 5.7, readyAt: 9 },
      { id: "work", actionAt: null, readyAt: 12 },
    ];
    // prompt's hold ends at 11; work's lead is [11, 17], its hold [12, 18].
    expect(beatFootageEnd(log, story)).toBe(18);
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
