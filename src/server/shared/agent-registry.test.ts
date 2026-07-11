/**
 * Unit tests for AgentRegistry — focus on the dual-mode Codex auth detection
 * added in feature 119 (Codex subscription auth). The integration test in
 * `orchestrator/integration_tests/agent-registry.test.ts` exercises the
 * end-to-end flow with a real binary-detection mock; this file isolates the
 * `isAuthConfigured("codex")` branch table.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry, ALLOWED_ENV_KEYS, isAllowedAgentEnvKey, getAgentCapabilities } from "./agent-registry.js";

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

describe("reasoning capability metadata (docs/217)", () => {
  it("exposes the verified Claude --effort levels", () => {
    const values = getAgentCapabilities("claude")?.reasoning?.options.map((o) => o.value);
    expect(values).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("exposes the verified Codex model_reasoning_effort levels", () => {
    const values = getAgentCapabilities("codex")?.reasoning?.options.map((o) => o.value);
    expect(values).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("gives each agent a distinct option set (named differently per backend)", () => {
    const claude = getAgentCapabilities("claude")?.reasoning;
    const codex = getAgentCapabilities("codex")?.reasoning;
    expect(claude?.label).not.toBe(codex?.label);
    // Codex has "none"/"minimal" that Claude lacks; Claude has "max" that Codex lacks.
    expect(codex?.options.some((o) => o.value === "none")).toBe(true);
    expect(claude?.options.some((o) => o.value === "max")).toBe(true);
    expect(claude?.options.some((o) => o.value === "none")).toBe(false);
    expect(codex?.options.some((o) => o.value === "max")).toBe(false);
  });
});

describe("model capability metadata", () => {
  it("offers the latest explicit Claude and Codex models first where applicable", () => {
    const claudeModels = getAgentCapabilities("claude")?.models;
    const codexModels = getAgentCapabilities("codex")?.models;

    expect(claudeModels).toContain("claude-sonnet-5");
    expect(codexModels?.slice(0, 3)).toEqual(["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });
});

describe("isAllowedAgentEnvKey (docs/088)", () => {
  it("accepts literal allowlist entries", () => {
    for (const key of ALLOWED_ENV_KEYS) {
      expect(isAllowedAgentEnvKey(key)).toBe(true);
    }
  });

  it("accepts any mcp__* key", () => {
    expect(isAllowedAgentEnvKey("mcp__linear__LINEAR_API_KEY")).toBe(true);
    expect(isAllowedAgentEnvKey("mcp__sentry__SENTRY_AUTH_TOKEN")).toBe(true);
    expect(isAllowedAgentEnvKey("mcp__a__b")).toBe(true);
  });

  it("rejects unknown keys, empty strings, and near-misses", () => {
    expect(isAllowedAgentEnvKey("")).toBe(false);
    expect(isAllowedAgentEnvKey("RANDOM_SECRET")).toBe(false);
    expect(isAllowedAgentEnvKey("mcp_linear_KEY")).toBe(false);
    expect(isAllowedAgentEnvKey("MCP__linear__KEY")).toBe(false);
  });
});
