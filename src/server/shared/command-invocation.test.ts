import { describe, it, expect } from "vitest";
import { isCommandInvocation } from "./command-invocation.js";

describe("isCommandInvocation (docs/299)", () => {
  it("recognizes a command with and without arguments", () => {
    expect(isCommandInvocation("/goal the suite is green", "/")).toBe(true);
    expect(isCommandInvocation("/code-review", "/")).toBe(true);
    expect(isCommandInvocation("/context", "/")).toBe(true);
    expect(isCommandInvocation("  /compact\n\nfocus on auth", "/")).toBe(true);
    // Plugin skills are namespaced with a colon.
    expect(isCommandInvocation("/probe:report", "/")).toBe(true);
  });

  it("is false for ordinary text", () => {
    expect(isCommandInvocation("fix the build", "/")).toBe(false);
    expect(isCommandInvocation("", "/")).toBe(false);
    expect(isCommandInvocation("/", "/")).toBe(false);
    expect(isCommandInvocation("/ goal", "/")).toBe(false);
  });

  it("is false for a path-first message, which keeps a slash inside the token", () => {
    expect(isCommandInvocation("/tmp/foo.ts is broken, fix it", "/")).toBe(false);
    expect(isCommandInvocation("/workspace/src/a.ts", "/")).toBe(false);
  });

  it("follows the harness's own prefix", () => {
    // Codex's skills are `$`-prefixed, so `/goal` is plain text there.
    expect(isCommandInvocation("/goal ship it", "$")).toBe(false);
    expect(isCommandInvocation("$code-review", "$")).toBe(true);
    expect(isCommandInvocation("$code-review", "/")).toBe(false);
    expect(isCommandInvocation("/goal ship it", undefined)).toBe(false);
  });

  it("is false for an uppercase token, so a shell variable is not a command", () => {
    expect(isCommandInvocation("$HOME is unset in the container", "$")).toBe(false);
    expect(isCommandInvocation("$PATH", "$")).toBe(false);
  });

  it("is false for a token with no letter, so an amount is not a command", () => {
    expect(isCommandInvocation("$100 is the budget", "$")).toBe(false);
    expect(isCommandInvocation("/404 pages are broken", "/")).toBe(false);
  });
});
