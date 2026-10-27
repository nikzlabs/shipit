import { describe, it, expect } from "vitest";
import { OpencodeTurnAccumulator, parseOpencodeLine } from "./opencode-stream.js";

function observe(lines: string[]): OpencodeTurnAccumulator {
  const acc = new OpencodeTurnAccumulator();
  for (const line of lines) {
    const event = parseOpencodeLine(line);
    if (event) acc.observe(event);
  }
  return acc;
}

describe("OpencodeTurnAccumulator", () => {
  it("reads v1's nested error message", () => {
    const acc = observe([`{"type":"error","error":{"name":"APIError","data":{"message":"bad key","statusCode":401}}}`]);
    expect(acc.errorMessage).toBe("bad key");
  });

  it("reads OpenCode 2's flat error line (2.1.1 capture)", () => {
    const acc = observe([`{"type":"error","error":{"type":"provider.auth","message":"Incorrect API key provided (mock)","status":401,"response":{"body":"{}"}}}`]);
    expect(acc.errorMessage).toBe("Incorrect API key provided (mock)");
  });

  it("replaces the stream's steps with a complete list, reasoning billed as output", () => {
    const acc = observe([
      `{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"tool-calls","cost":0.5,"tokens":{"input":100,"output":12,"reasoning":0,"cache":{"read":20,"write":0}}}}`,
    ]);
    acc.replaceSteps([
      { tokens: { input: 100, output: 12, reasoning: 0, cache: { read: 20, write: 0 } }, cost: 0.001 },
      { tokens: { input: 130, output: 9, reasoning: 1, cache: { read: 20, write: 5 } } },
    ]);
    expect(acc.requests).toEqual([
      { input: 100, output: 12, cacheRead: 20, cacheWrite: 0 },
      { input: 130, output: 10, cacheRead: 20, cacheWrite: 5 },
    ]);
    expect({ input: acc.input, output: acc.output, cacheRead: acc.cacheRead, cacheWrite: acc.cacheWrite, cost: acc.costUsd })
      .toEqual({ input: 230, output: 22, cacheRead: 40, cacheWrite: 5, cost: 0.001 });
    expect(acc.contextTokens).toBe(155);
  });
});
