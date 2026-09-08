import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import { parseArgs, readStoryboard } from "./driver.mjs";

/**
 * The driver's pure parts (docs/296 plan §4): argument parsing and storyboard
 * validation. The browser half is exercised against a live instance
 * (plan §8), not here — nothing in this file launches Chromium.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

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
    repo: { url: "file://localhost/tmp/demo.git", commit: "abc" },
    viewport: { width: 1440, height: 900 },
    beats: [{ id: "a", click: "new-session", wait: [{ composer: "ready" }], lead: 0, hold: 1 }],
  };

  it("accepts the committed phase-1 scenario", () => {
    const sb = readStoryboard(join(HERE, "scenarios", "dogfood-smoke"));
    expect(sb.beats.map((b: { id: string }) => b.id)).toEqual(["new-session", "create", "edit"]);
    expect(sb.repo.url.startsWith("file://localhost/")).toBe(true);
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
    const both = write({ ...valid, beats: [{ id: "a", type: "hi", click: "merge" }] });
    const dup = write({ ...valid, beats: [{ id: "a" }, { id: "a" }] });
    try {
      expect(() => readStoryboard(both)).toThrow("has both type and click");
      expect(() => readStoryboard(dup)).toThrow("duplicate beat id a");
    } finally {
      rmSync(both, { recursive: true, force: true });
      rmSync(dup, { recursive: true, force: true });
    }
  });
});
