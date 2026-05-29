import { describe, it, expect } from "vitest";
import type { AgentRunParams } from "../shared/types.js";
import {
  getPrepareRunParams,
  identityPrepareRunParams,
  prepareClaudeRunParams,
  prepareCodexRunParams,
  type PrepareRunParamsFn,
} from "./agent-run-params-prep.js";

const baseParams: AgentRunParams = {
  prompt: "hello",
  cwd: "/workspace/session-x",
  systemPrompt: "do the thing",
  model: "opus",
};

describe("prepareClaudeRunParams", () => {
  it("injects the managed-settings path and forwards autoCreatePrActive", () => {
    const out = prepareClaudeRunParams(baseParams, { autoCreatePrActive: true });
    expect(out.settingsPath).toBe("/etc/shipit/managed-settings.json");
    expect(out.autoCreatePr).toBe(true);
    // Shared fields pass through untouched.
    expect(out.prompt).toBe("hello");
    expect(out.cwd).toBe("/workspace/session-x");
    expect(out.systemPrompt).toBe("do the thing");
    expect(out.model).toBe("opus");
  });

  it("forwards autoCreatePr=false when the user opted out (or no GitHub auth)", () => {
    const out = prepareClaudeRunParams(baseParams, { autoCreatePrActive: false });
    expect(out.autoCreatePr).toBe(false);
    expect(out.settingsPath).toBe("/etc/shipit/managed-settings.json");
  });

  it("does not mutate the input params (pure)", () => {
    const snapshot = JSON.stringify(baseParams);
    prepareClaudeRunParams(baseParams, { autoCreatePrActive: true });
    expect(JSON.stringify(baseParams)).toBe(snapshot);
  });
});

describe("prepareCodexRunParams", () => {
  it("is identity — Codex has no run-params-prep-time fields today", () => {
    const out = prepareCodexRunParams(baseParams, { autoCreatePrActive: true });
    expect(out).toBe(baseParams);
    expect(out.settingsPath).toBeUndefined();
    expect(out.autoCreatePr).toBeUndefined();
  });
});

describe("getPrepareRunParams", () => {
  it("returns the matching hook from the registry", () => {
    const map = new Map<string, PrepareRunParamsFn>();
    map.set("claude", prepareClaudeRunParams);
    map.set("codex", prepareCodexRunParams);
    expect(getPrepareRunParams(map as never, "claude")).toBe(prepareClaudeRunParams);
    expect(getPrepareRunParams(map as never, "codex")).toBe(prepareCodexRunParams);
  });

  it("falls back to identity when the map is undefined", () => {
    expect(getPrepareRunParams(undefined, "claude")).toBe(identityPrepareRunParams);
  });

  it("falls back to identity when the agent is not registered", () => {
    const map = new Map<string, PrepareRunParamsFn>();
    map.set("claude", prepareClaudeRunParams);
    // Pretend Cursor lands without registering its hook yet — fallback keeps
    // the system working instead of throwing at every turn.
    expect(getPrepareRunParams(map as never, "cursor" as never)).toBe(
      identityPrepareRunParams,
    );
  });
});
