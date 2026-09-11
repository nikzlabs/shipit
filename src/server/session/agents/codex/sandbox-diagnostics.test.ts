import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isBubblewrapFailure, isSandboxVeto } from "./sandbox-diagnostics.js";

/**
 * These matchers run against text the AGENT produced, inside a repo whose own
 * source discusses this exact failure. So the load-bearing cases here are the
 * negative ones: a false positive pins a permanent, wrong diagnosis on a
 * healthy session and burns the once-per-process notice, where a miss costs
 * only the explanation.
 *
 * Every positive string is real: the bubblewrap line was reproduced in a
 * session container with `bwrap --ro-bind / / --dev /dev true`, and the veto
 * phrasings come from codex-cli 0.153.2's own string table.
 */
describe("isBubblewrapFailure", () => {
  it("matches the kernel's refusal to make a namespace", () => {
    expect(isBubblewrapFailure(
      "bwrap: No permissions to create new namespace, likely because the kernel does not allow "
      + "non-privileged user namespaces.",
    )).toBe(true);
  });

  it("matches it in a failed command's aggregated output", () => {
    expect(isBubblewrapFailure(
      "$ npm test\nbwrap: No permissions to create new namespace\n",
    )).toBe(true);
  });

  it("matches the helper failing to find bubblewrap at all", () => {
    expect(isBubblewrapFailure(
      "bubblewrap is unavailable: no system bwrap was found on PATH and no bundled "
      + "codex-resources/bwrap binary was found next to the Codex executable",
    )).toBe(true);
  });

  it("ignores output that merely mentions the words", () => {
    expect(isBubblewrapFailure("Installing bwrap via apt…")).toBe(false);
    expect(isBubblewrapFailure("bwrap creates a namespace for isolation")).toBe(false);
    expect(isBubblewrapFailure("see docs on user namespaces and sandboxing")).toBe(false);
  });

  /**
   * The one that made this narrow. An agent reading ShipIt's own source hands
   * the matcher the failure text verbatim — quoted, indented, inside a string
   * literal — and an earlier version diagnosed a broken sandbox off a `cat`.
   * Reading the real files, so this cannot rot into a hand-written imitation
   * of them.
   */
  it("ignores this repo's own source quoting the failure", () => {
    for (const file of ["./sandbox-diagnostics.ts", "./adapter.ts", "./sandbox-diagnostics.test.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf-8");
      expect(source).toContain("bwrap");
      expect(isBubblewrapFailure(source)).toBe(false);
    }
  });
});

describe("isSandboxVeto", () => {
  it("matches a veto phrased with the verb before `requirements`", () => {
    expect(isSandboxVeto("`sandbox_mode` is disallowed by requirements; falling back to required value")).toBe(true);
    expect(isSandboxVeto("`permission_profile` is not allowed by requirements from managed policy")).toBe(true);
    expect(isSandboxVeto("`sandbox_mode` are overridden by requirements from /etc/codex/requirements.toml")).toBe(true);
  });

  it("matches a veto phrased with the verb after `requirements`", () => {
    expect(isSandboxVeto(
      "`approval_policy = \"never\"` cannot be used because requirements do not allow "
      + "`sandbox_mode = \"danger-full-access\"`",
    )).toBe(true);
  });

  /**
   * A veto is not automatically a SANDBOX veto. Codex's requirements layer
   * governs web search, reviewers, browser use and more; announcing a broken
   * sandbox because the admin restricted web search would be a fabricated
   * diagnosis with a real symptom nowhere near it.
   */
  it("does not fire on a veto of a setting ShipIt does not set", () => {
    expect(isSandboxVeto("`web_search_mode` is disallowed by requirements; falling back to required value")).toBe(false);
    expect(isSandboxVeto("`model_reasoning_effort` is not allowed by requirements from managed policy")).toBe(false);
  });

  it("does not fire on a warning that merely names the file", () => {
    // The untrusted-project warning, which ShipIt already handles and which
    // must keep going to the log rather than raising a sandbox alarm.
    expect(isSandboxVeto(
      "Project-local config, hooks, and exec policies are disabled in the following folders "
      + "until the project is trusted, but skills still load. 1. /workspace/.codex",
    )).toBe(false);
    expect(isSandboxVeto("Invalid configuration; using defaults. config.toml:4:11: duplicate key")).toBe(false);
    expect(isSandboxVeto("Failed to read requirements file /etc/codex/requirements.toml")).toBe(false);
  });
});
