import { describe, it, expect } from "vitest";
import { autoMemoryFor, withAutoMemory } from "./claude-memory.js";
import { GLOBAL_SETTINGS } from "../shared/settings-catalogue/global-settings.js";

function store(values: Record<string, boolean>): Parameters<typeof autoMemoryFor>[1] {
  return {
    getDeclaredSetting: ((key: keyof typeof GLOBAL_SETTINGS) =>
      key in values ? values[key] : GLOBAL_SETTINGS[key].type.read(undefined)) as never,
  };
}

describe("autoMemoryFor", () => {
  it("leaves Claude Code's memory alone by default and turns it off when the setting is off", () => {
    expect(autoMemoryFor("claude", store({}))).toBeUndefined();
    expect(autoMemoryFor("claude", store({ "advanced.claudeMemory": false }))).toBe(false);
  });

  it("has no value for another harness or without a store", () => {
    for (const id of ["codex", "opencode", "opencode2", "grok", "antigravity"] as const) {
      expect(autoMemoryFor(id, store({ "advanced.claudeMemory": false }))).toBeUndefined();
    }
    expect(autoMemoryFor("claude", undefined)).toBeUndefined();
  });
});

describe("withAutoMemory", () => {
  it("marks the spawn identity only when memory is off, so a change retires a resident", () => {
    expect(withAutoMemory("claude|anthropic|sub|opus|-|-", false)).toBe("claude|anthropic|sub|opus|-|-|nomemory");
    expect(withAutoMemory("claude|anthropic|sub|opus|-|-", true)).toBe("claude|anthropic|sub|opus|-|-");
    expect(withAutoMemory("claude|anthropic|sub|opus|-|-", undefined)).toBe("claude|anthropic|sub|opus|-|-");
    expect(withAutoMemory(undefined, false)).toBeUndefined();
  });
});
