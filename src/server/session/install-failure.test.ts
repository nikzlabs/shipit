import { describe, it, expect } from "vitest";
import {
  formatEmptyDepDirsFailureMessage,
  formatInstallFailureMessage,
  INSTALL_STDERR_TAIL_BYTES,
} from "./install-failure.js";

describe("formatInstallFailureMessage", () => {
  it("returns just the command + code when there is no stderr", () => {
    expect(formatInstallFailureMessage("npm install", 1, "")).toBe(
      'Command "npm install" exited with code 1',
    );
  });

  it("appends the stderr tail so the failure says WHY (the EACCES case)", () => {
    const stderr =
      "npm error code EACCES\n" +
      "npm error syscall open\n" +
      "npm error path /workspace/package-lock.json\n" +
      "npm error errno -13\n" +
      "npm error Error: EACCES: permission denied, open '/workspace/package-lock.json'\n";
    const msg = formatInstallFailureMessage("npm install", 1, stderr);
    expect(msg).toContain('Command "npm install" exited with code 1');
    expect(msg).toContain("EACCES: permission denied");
  });

  it("keeps only the last few non-empty lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const msg = formatInstallFailureMessage("npm ci", 7, lines);
    expect(msg).toContain("line 19");
    expect(msg).toContain("line 14");
    // Older lines are dropped — only the tail (last 6) is kept.
    expect(msg).not.toContain("line 13");
  });

  it("ignores blank/whitespace-only trailing lines", () => {
    const msg = formatInstallFailureMessage("npm install", 1, "boom\n\n   \n");
    expect(msg).toBe('Command "npm install" exited with code 1\nboom');
  });

  it("names every empty dep dir, and both ways out of the failure", () => {
    // The message is the ONLY thing that reaches a human on this path — the
    // install log shows a command that exited 0. Which declaration was not
    // satisfied is the actionable fact, because the two fixes (repair the
    // install / narrow `agent.dep-dirs`) are told apart only by the repo.
    const msg = formatEmptyDepDirsFailureMessage(["game/node_modules", "tools/debug/node_modules"]);
    expect(msg).toContain("game/node_modules");
    expect(msg).toContain("tools/debug/node_modules");
    expect(msg).toContain("agent.dep-dirs");
    expect(msg).toContain("dep dirs empty");
  });

  it("reads as singular for one dir", () => {
    expect(formatEmptyDepDirsFailureMessage(["node_modules"])).toContain("dep dir empty");
  });

  it("bounds the retained tail to a sane size", () => {
    // The worker slices stderr to INSTALL_STDERR_TAIL_BYTES before calling this,
    // so the constant exists as the accumulation cap. Sanity-check it's bounded.
    expect(INSTALL_STDERR_TAIL_BYTES).toBeGreaterThan(0);
    expect(INSTALL_STDERR_TAIL_BYTES).toBeLessThanOrEqual(64 * 1024);
  });
});
