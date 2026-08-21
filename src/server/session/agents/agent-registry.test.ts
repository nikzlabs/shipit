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
    expect(agents).toHaveLength(4);
    expect(agents.map((a) => a.id)).toEqual(["claude", "codex", "opencode", "grok"]);
  });

  it("checks Claude auth via checkClaudeAuth callback", async () => {
    const registry = createRegistry({ claudeAuth: false });
    await registry.detect();
    expect(registry.get("claude")!.hasRunnableModels).toBe(false);

    const registry2 = createRegistry({ claudeAuth: true });
    await registry2.detect();
    expect(registry2.get("claude")!.hasRunnableModels).toBe(true);
  });

  it("checks Codex auth via OPENAI_API_KEY", async () => {
    const registry = createRegistry({ installedBinaries: ["codex"] });
    await registry.detect();
    expect(registry.get("codex")!.hasRunnableModels).toBe(false);

    process.env.OPENAI_API_KEY = "sk-test-key";
    const registry2 = createRegistry({ installedBinaries: ["codex"] });
    await registry2.detect();
    expect(registry2.get("codex")!.hasRunnableModels).toBe(true);
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
    expect(registry.get("codex")!.hasRunnableModels).toBe(false);

    process.env.OPENAI_API_KEY = "sk-test";
    registry.refreshAuth("codex");
    expect(registry.get("codex")!.hasRunnableModels).toBe(true);
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
    expect(codex.capabilities.models[0]).toBe("gpt-5.6-sol");
    expect(codex.capabilities.models).not.toContain("gpt-5.6");
    expect(codex.capabilities.models).toContain("gpt-5.4");
    expect(codex.capabilities.toolNames).toContain("shell");
  });

  it("every shipped harness reports supportsReview=true", async () => {
    // docs/266 item 15 — chat-native review needs a shell tool and a subagent
    // primitive, and since docs/220 removed the last `submit_review` write path
    // it needs NO MCP surface: the flow is a plain chat message
    // (`compose-review-body.ts`). docs/125's "subagents AND custom MCP tools"
    // rule is what kept this false on opencode and grok, and planning#459
    // probed both live at depth 0 — each ran
    // `shipit agent run --role reviewer --prompt-file -` itself and returned
    // material findings.
    //
    // The flag gates the file-preview / Present "Ask agent to review"
    // affordance, so a regression flipping any of these back to false silently
    // hides the button on that backend while `/review` — which is ungated —
    // keeps working, which is the confusing half of the bug.
    const registry = createRegistry({
      installedBinaries: ["claude", "codex", "opencode", "grok"],
    });
    await registry.detect();
    for (const id of ["claude", "codex", "opencode", "grok"] as const) {
      expect(registry.get(id)!.capabilities.supportsReview).toBe(true);
    }
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
