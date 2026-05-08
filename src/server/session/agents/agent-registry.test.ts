import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentRegistry, ALLOWED_ENV_KEYS } from "./agent-registry.js";

describe("AgentRegistry", () => {
  let savedOpenAIKey: string | undefined;

  beforeEach(() => {
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
  });

  function createRegistry(opts: {
    installedBinaries?: string[];
    claudeAuth?: boolean;
  } = {}) {
    const installed = new Set(opts.installedBinaries ?? ["claude"]);
    return new AgentRegistry({
      checkBinary: async (binary) => installed.has(binary),
      checkClaudeAuth: () => opts.claudeAuth ?? true,
    });
  }

  it("detects installed binaries", async () => {
    const registry = createRegistry({ installedBinaries: ["claude", "codex"] });
    await registry.detect();

    const claude = registry.get("claude");
    expect(claude).toBeDefined();
    expect(claude!.installed).toBe(true);

    const codex = registry.get("codex");
    expect(codex).toBeDefined();
    expect(codex!.installed).toBe(true);
  });

  it("list() returns all agents", async () => {
    const registry = createRegistry({ installedBinaries: ["claude"] });
    await registry.detect();

    const agents = registry.list();
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.id)).toEqual(["claude", "codex"]);
  });

  it("checks Claude auth via checkClaudeAuth callback", async () => {
    const registry = createRegistry({ claudeAuth: false });
    await registry.detect();
    expect(registry.get("claude")!.authConfigured).toBe(false);

    const registry2 = createRegistry({ claudeAuth: true });
    await registry2.detect();
    expect(registry2.get("claude")!.authConfigured).toBe(true);
  });

  it("checks Codex auth via OPENAI_API_KEY", async () => {
    const registry = createRegistry({ installedBinaries: ["codex"] });
    await registry.detect();
    expect(registry.get("codex")!.authConfigured).toBe(false);

    process.env.OPENAI_API_KEY = "sk-test-key";
    const registry2 = createRegistry({ installedBinaries: ["codex"] });
    await registry2.detect();
    expect(registry2.get("codex")!.authConfigured).toBe(true);
  });

  it("available() returns only installed + auth-configured agents", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const registry = createRegistry({
      installedBinaries: ["claude", "codex"],
      claudeAuth: true,
    });
    await registry.detect();

    const available = registry.available();
    expect(available).toHaveLength(2);
    expect(available.map((a) => a.id)).toEqual(["claude", "codex"]);
  });

  it("refreshAuth() updates auth status for a specific agent", async () => {
    const registry = createRegistry({ installedBinaries: ["codex"] });
    await registry.detect();
    expect(registry.get("codex")!.authConfigured).toBe(false);

    process.env.OPENAI_API_KEY = "sk-test";
    registry.refreshAuth("codex");
    expect(registry.get("codex")!.authConfigured).toBe(true);
  });

  it("get() returns undefined for unknown agent", async () => {
    const registry = createRegistry();
    await registry.detect();
    expect(registry.get("unknown" as any)).toBeUndefined();
  });

  it("agents have correct metadata", async () => {
    const registry = createRegistry({ installedBinaries: ["claude", "codex"] });
    await registry.detect();

    expect(registry.get("claude")!.name).toBe("Claude Code");
    expect(registry.get("claude")!.binary).toBe("claude");
    expect(registry.get("codex")!.name).toBe("Codex");
    expect(registry.get("codex")!.binary).toBe("codex");
  });

  it("agents have capabilities", async () => {
    const registry = createRegistry({ installedBinaries: ["codex"] });
    await registry.detect();

    const codex = registry.get("codex")!;
    expect(codex.capabilities.supportsResume).toBe(true);
    expect(codex.capabilities.models).toContain("gpt-5.4");
    expect(codex.capabilities.toolNames).toContain("shell");
  });

  it("Claude reports supportsReview=true and Codex reports false", async () => {
    // 125 — chat-native AI review needs both a subagent primitive (Task) and
    // custom MCP tool registration. Claude Code provides both; Codex provides
    // neither. The capability is what the client uses to gate the
    // file-preview "Ask agent to review" affordance, so a regression here
    // would silently drag the Codex session back into the broken pre-125
    // state.
    const registry = createRegistry({ installedBinaries: ["claude", "codex"] });
    await registry.detect();
    expect(registry.get("claude")!.capabilities.supportsReview).toBe(true);
    expect(registry.get("codex")!.capabilities.supportsReview).toBe(false);
  });
});

describe("ALLOWED_ENV_KEYS", () => {
  it("contains expected keys", () => {
    expect(ALLOWED_ENV_KEYS.has("OPENAI_API_KEY")).toBe(true);
  });

  it("does not contain arbitrary keys", () => {
    expect(ALLOWED_ENV_KEYS.has("PATH")).toBe(false);
    expect(ALLOWED_ENV_KEYS.has("HOME")).toBe(false);
  });
});
