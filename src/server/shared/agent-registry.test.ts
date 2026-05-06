/**
 * Unit tests for AgentRegistry — focus on the dual-mode Codex auth detection
 * added in feature 119 (Codex subscription auth). The integration test in
 * `orchestrator/integration_tests/agent-registry.test.ts` exercises the
 * end-to-end flow with a real binary-detection mock; this file isolates the
 * `isAuthConfigured("codex")` branch table.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "./agent-registry.js";

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (ORIGINAL_OPENAI_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
  }
});

describe("AgentRegistry / isAuthConfigured('codex')", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  async function detect(opts: { fileAuth: boolean; envAuth: boolean }) {
    if (opts.envAuth) {
      process.env.OPENAI_API_KEY = "sk-test";
    }
    const registry = new AgentRegistry({
      checkBinary: () => Promise.resolve(true),
      checkClaudeAuth: () => true,
      checkCodexAuth: () => opts.fileAuth,
    });
    await registry.detect();
    const codex = registry.get("codex");
    if (!codex) throw new Error("codex agent missing from registry");
    return codex;
  }

  it("returns true when only the ChatGPT subscription file is present", async () => {
    const codex = await detect({ fileAuth: true, envAuth: false });
    expect(codex.authConfigured).toBe(true);
  });

  it("returns true when only OPENAI_API_KEY is set", async () => {
    const codex = await detect({ fileAuth: false, envAuth: true });
    expect(codex.authConfigured).toBe(true);
  });

  it("returns true when both auth modes are present", async () => {
    const codex = await detect({ fileAuth: true, envAuth: true });
    expect(codex.authConfigured).toBe(true);
  });

  it("returns false when neither auth mode is present", async () => {
    const codex = await detect({ fileAuth: false, envAuth: false });
    expect(codex.authConfigured).toBe(false);
  });

  it("refreshAuth picks up a freshly-written subscription file", async () => {
    let fileAuth = false;
    const registry = new AgentRegistry({
      checkBinary: () => Promise.resolve(true),
      checkClaudeAuth: () => true,
      checkCodexAuth: () => fileAuth,
    });
    await registry.detect();
    expect(registry.get("codex")?.authConfigured).toBe(false);

    // Simulate a successful `codex login --device-auth` writing the file.
    fileAuth = true;
    registry.refreshAuth("codex");
    expect(registry.get("codex")?.authConfigured).toBe(true);
  });

  it("refreshAuth picks up a freshly-set OPENAI_API_KEY", async () => {
    const registry = new AgentRegistry({
      checkBinary: () => Promise.resolve(true),
      checkClaudeAuth: () => true,
      checkCodexAuth: () => false,
    });
    await registry.detect();
    expect(registry.get("codex")?.authConfigured).toBe(false);

    process.env.OPENAI_API_KEY = "sk-fresh";
    registry.refreshAuth("codex");
    expect(registry.get("codex")?.authConfigured).toBe(true);
  });

  it("defaults checkCodexAuth to false when not injected (env-only behavior)", async () => {
    const registry = new AgentRegistry({
      checkBinary: () => Promise.resolve(true),
      checkClaudeAuth: () => true,
      // checkCodexAuth omitted — should default to () => false
    });
    await registry.detect();
    expect(registry.get("codex")?.authConfigured).toBe(false);

    process.env.OPENAI_API_KEY = "sk-only";
    registry.refreshAuth("codex");
    expect(registry.get("codex")?.authConfigured).toBe(true);
  });
});
