import { describe, it, expect } from "vitest";
import { codeModeFor, withCodeMode } from "./code-mode.js";
import { GLOBAL_SETTINGS } from "../shared/settings-catalogue/global-settings.js";

function store(values: Record<string, boolean>): Parameters<typeof codeModeFor>[1] {
  return {
    getDeclaredSetting: ((key: keyof typeof GLOBAL_SETTINGS) =>
      key in values ? values[key] : GLOBAL_SETTINGS[key].type.read(undefined)) as never,
  };
}

describe("codeModeFor", () => {
  it("reads each harness's own setting, with the declared defaults (docs/341-code-mode-setting req 4)", () => {
    const defaults = store({});
    expect(codeModeFor("opencode2", defaults)).toBe(true);
    expect(codeModeFor("codex", defaults)).toBe(false);
    expect(codeModeFor("opencode", defaults)).toBe(false);
    expect(codeModeFor("codex", store({ "advanced.codeMode.codex": true }))).toBe(true);
  });

  it("has no value for a harness without a Code Mode setting", () => {
    for (const id of ["claude", "grok", "antigravity"] as const) expect(codeModeFor(id, store({}))).toBeUndefined();
    expect(codeModeFor("codex", undefined)).toBeUndefined();
  });
});

describe("withCodeMode", () => {
  it("marks the spawn identity only when Code Mode is on, so a change retires a resident (req 6)", () => {
    expect(withCodeMode("codex|openai|sub|gpt|-|-", true)).toBe("codex|openai|sub|gpt|-|-|codemode");
    expect(withCodeMode("codex|openai|sub|gpt|-|-", false)).toBe("codex|openai|sub|gpt|-|-");
    expect(withCodeMode("codex|openai|sub|gpt|-|-", undefined)).toBe("codex|openai|sub|gpt|-|-");
    expect(withCodeMode(undefined, true)).toBeUndefined();
  });
});
