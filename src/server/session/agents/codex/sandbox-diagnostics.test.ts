import { describe, it, expect } from "vitest";
import { isBubblewrapFailure, isRequirementVeto } from "./sandbox-diagnostics.js";

/**
 * The matchers decide whether a session gets an explanation for the failure it
 * is about to suffer, so what they must not do is fire on ordinary output —
 * every false positive is a scary paragraph attached to a working turn.
 *
 * Every positive string here is real: the bubblewrap line was reproduced in a
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

  it("matches it embedded in a command's aggregated output", () => {
    expect(isBubblewrapFailure(
      "$ npm test\nbwrap: No permissions to create new namespace\n[exit code: 1]",
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
    expect(isBubblewrapFailure("namespace Foo { }")).toBe(false);
    // A repo whose own source discusses the failure — this file, for one.
    expect(isBubblewrapFailure("see docs on user namespaces and sandboxing")).toBe(false);
  });
});

describe("isRequirementVeto", () => {
  it("matches a veto phrased with the verb before `requirements`", () => {
    expect(isRequirementVeto("`sandbox_mode` is disallowed by requirements; falling back to required value")).toBe(true);
    expect(isRequirementVeto("`permission_profile` is not allowed by requirements from managed policy")).toBe(true);
    expect(isRequirementVeto("`sandbox_mode` are overridden by requirements from /etc/codex/requirements.toml")).toBe(true);
  });

  it("matches a veto phrased with the verb after `requirements`", () => {
    expect(isRequirementVeto(
      "`approval_policy = \"never\"` cannot be used because requirements do not allow "
      + "`sandbox_mode = \"danger-full-access\"`",
    )).toBe(true);
  });

  it("does not fire on a warning that merely names the file", () => {
    // The untrusted-project warning, which ShipIt already handles and which
    // must keep going to the log rather than raising a sandbox alarm.
    expect(isRequirementVeto(
      "Project-local config, hooks, and exec policies are disabled in the following folders "
      + "until the project is trusted, but skills still load. 1. /workspace/.codex",
    )).toBe(false);
    expect(isRequirementVeto("Invalid configuration; using defaults. config.toml:4:11: duplicate key")).toBe(false);
    expect(isRequirementVeto("Failed to read requirements file /etc/codex/requirements.toml")).toBe(false);
  });
});
