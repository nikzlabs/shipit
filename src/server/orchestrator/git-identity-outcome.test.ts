import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `setGitIdentity` makes two `git config` calls, so it has three answers and not
 * two (docs/299-agent-settings-access, plan.md → "Saved" has to mean saved). The
 * one that matters is `partial`: the name can land and the email throw, and
 * `git config` cannot prove a rollback would succeed either — so claiming
 * "nothing changed" there would be exactly the false report this removes.
 *
 * The second call is made to fail while the first runs for real, so the name is
 * genuinely on disk when `partial` is claimed.
 */

const control = vi.hoisted(() => ({
  failOnCall: 0,
  calls: 0,
}));

// eslint-disable-next-line no-restricted-syntax -- vi.mock's importOriginal is typed by an inline import() and nothing else
type ChildProcess = typeof import("node:child_process");

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<ChildProcess>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      control.calls += 1;
      if (control.calls === control.failOnCall) {
        throw new Error("fatal: could not write config file");
      }
      return actual.execFileSync(...args);
    },
  };
});

const { setGitIdentity } = await import("./git-config.js");

describe("setGitIdentity: two writes, three outcomes", () => {
  let dir: string;
  const original = process.env.GIT_CONFIG_GLOBAL;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-git-identity-"));
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, "gitconfig");
    control.calls = 0;
    control.failOnCall = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports `applied` when both halves land", () => {
    expect(setGitIdentity("Ada", "ada@example.com")).toEqual({ status: "applied" });
    const config = fs.readFileSync(path.join(dir, "gitconfig"), "utf-8");
    expect(config).toContain("Ada");
    expect(config).toContain("ada@example.com");
  });

  it("reports `failed` when the name write is refused, because nothing ran", () => {
    control.failOnCall = 1;

    const outcome = setGitIdentity("Ada", "ada@example.com");

    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toMatch(/neither half/i);
    expect(fs.existsSync(path.join(dir, "gitconfig"))).toBe(false);
  });

  it("reports `partial` when the name lands and the email does not, and says which", () => {
    control.failOnCall = 2;

    const outcome = setGitIdentity("Grace", "grace@example.com");

    expect(outcome.status).toBe("partial");
    expect(outcome.detail).toMatch(/name was saved/i);
    const config = fs.readFileSync(path.join(dir, "gitconfig"), "utf-8");
    expect(config).toContain("Grace");
    expect(config).not.toContain("grace@example.com");
  });
});
