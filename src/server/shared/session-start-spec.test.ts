import { describe, it, expect } from "vitest";
import { MAX_START_PROMPT_CHARS, parseSessionStartSpec } from "./session-start-spec.js";
import { START_PARAM_LABELS } from "./session-start-labels.js";
import type { SessionStartParams } from "./types.js";

const SAMPLE_VALUES: { [K in keyof SessionStartParams]-?: SessionStartParams[K] } = {
  role: "reviewer",
  agent: "codex",
  model: "gpt-5",
  serviceId: "openai",
  billingMode: "sub",
  reasoning: "high",
  permissionMode: "plan",
  networkMode: null,
  sshHosts: ["host-1"],
  armAutoMerge: true,
};

const repo = { kind: "repo", repoUrl: "https://github.com/o/r" };

describe("parseSessionStartSpec", () => {
  it("reads every session-start parameter (req 5)", () => {
    expect(Object.keys(SAMPLE_VALUES).sort()).toEqual(Object.keys(START_PARAM_LABELS).sort());
    expect(parseSessionStartSpec({ target: repo, params: SAMPLE_VALUES, prompt: "Go" })).toEqual({
      spec: { target: repo, params: SAMPLE_VALUES, prompt: "Go" },
    });
  });

  it("trims text, drops repeated SSH destinations and fills a sandbox's grants", () => {
    const parsed = parseSessionStartSpec({
      target: { kind: "sandbox", capabilities: { network: false } },
      params: { model: "  gpt-5 ", sshHosts: ["a", "a", "b"], networkMode: true },
      prompt: "  Go  ",
    });
    expect(parsed).toEqual({
      spec: {
        target: { kind: "sandbox", capabilities: { git: false, docker: false, network: false, dangerousGitHubOps: false } },
        params: { model: "gpt-5", sshHosts: ["a", "b"], networkMode: true },
        prompt: "Go",
      },
    });
    expect(parseSessionStartSpec({ target: repo, prompt: "Go" })).toEqual({ spec: { target: repo, params: {}, prompt: "Go" } });
  });

  it("refuses what it cannot read, by name", () => {
    const problem = (value: unknown) => {
      const parsed = parseSessionStartSpec(value);
      return "problem" in parsed ? parsed.problem : null;
    };
    expect(problem("go")).toBe("The session-start description must be an object.");
    expect(problem({ target: { kind: "repo" }, prompt: "Go" })).toMatch(/^The target must be/);
    expect(problem({ target: repo, params: [], prompt: "Go" })).toBe("The session-start parameters must be an object.");
    expect(problem({ target: repo, params: { colour: "red" }, prompt: "Go" })).toBe('Unknown session-start parameter "colour".');
    expect(problem({ target: repo, params: { billingMode: "free" }, prompt: "Go" }))
      .toBe('The session-start parameter "billingMode" has a value it cannot take.');
    expect(problem({ target: repo, params: { sshHosts: [1] }, prompt: "Go" })).toMatch(/"sshHosts"/);
    expect(problem({ target: repo, params: { networkMode: "on" }, prompt: "Go" })).toMatch(/"networkMode"/);
    expect(problem({ target: repo, prompt: "   " })).toBe("The prompt is empty.");
    expect(problem({ target: repo, prompt: "x".repeat(MAX_START_PROMPT_CHARS + 1) }))
      .toBe("The prompt is longer than 50,000 characters.");
  });
});
