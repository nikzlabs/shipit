import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentRegistry, ALLOWED_ENV_KEYS } from "./agent-registry.js";

describe("AgentRegistry", () => {
  let savedOpenAIKey: string | undefined;
  let savedGoogleKey: string | undefined;

  beforeEach(() => {
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    savedGoogleKey = process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    if (savedGoogleKey !== undefined) process.env.GOOGLE_API_KEY = savedGoogleKey;
    else delete process.env.GOOGLE_API_KEY;
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

    const gemini = registry.get("gemini");
    expect(gemini).toBeDefined();
    expect(gemini!.installed).toBe(false);
  });

  it("list() returns all agents", async () => {
    const registry = createRegistry({ installedBinaries: ["claude"] });
    await registry.detect();

    const agents = registry.list();
    expect(agents).toHaveLength(3);
    expect(agents.map((a) => a.id)).toEqual(["claude", "codex", "gemini"]);
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

  it("checks Gemini auth via GOOGLE_API_KEY", async () => {
    const registry = createRegistry({ installedBinaries: ["gemini"] });
    await registry.detect();
    expect(registry.get("gemini")!.authConfigured).toBe(false);

    process.env.GOOGLE_API_KEY = "test-google-key";
    const registry2 = createRegistry({ installedBinaries: ["gemini"] });
    await registry2.detect();
    expect(registry2.get("gemini")!.authConfigured).toBe(true);
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
    const registry = createRegistry({ installedBinaries: ["claude", "codex", "gemini"] });
    await registry.detect();

    expect(registry.get("claude")!.name).toBe("Claude Code");
    expect(registry.get("claude")!.binary).toBe("claude");
    expect(registry.get("codex")!.name).toBe("Codex");
    expect(registry.get("codex")!.binary).toBe("codex");
    expect(registry.get("gemini")!.name).toBe("Gemini");
    expect(registry.get("gemini")!.binary).toBe("gemini");
  });

  it("agents have capabilities", async () => {
    const registry = createRegistry({ installedBinaries: ["codex"] });
    await registry.detect();

    const codex = registry.get("codex")!;
    expect(codex.capabilities.supportsResume).toBe(true);
    expect(codex.capabilities.models).toContain("codex-mini-latest");
    expect(codex.capabilities.toolNames).toContain("shell");
  });
});

describe("ALLOWED_ENV_KEYS", () => {
  it("contains expected keys", () => {
    expect(ALLOWED_ENV_KEYS.has("OPENAI_API_KEY")).toBe(true);
    expect(ALLOWED_ENV_KEYS.has("GOOGLE_API_KEY")).toBe(true);
  });

  it("does not contain arbitrary keys", () => {
    expect(ALLOWED_ENV_KEYS.has("PATH")).toBe(false);
    expect(ALLOWED_ENV_KEYS.has("HOME")).toBe(false);
  });
});
