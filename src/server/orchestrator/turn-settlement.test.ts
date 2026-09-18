import { describe, it, expect } from "vitest";
import { resultIsTheAgentsOwn } from "./turn-settlement.js";

describe("resultIsTheAgentsOwn (docs/299-agent-settings-access req 8)", () => {
  it("accepts a plain successful result", () => {
    expect(resultIsTheAgentsOwn({ status: "success" })).toBe(true);
    expect(resultIsTheAgentsOwn({})).toBe(true);
  });

  it("rejects an error status, which is a prompt that did not run", () => {
    expect(resultIsTheAgentsOwn({ status: "error" })).toBe(false);
    expect(resultIsTheAgentsOwn({ status: "error", error: "429 Too Many Requests" })).toBe(false);
  });

  it("rejects an error string on a status that claims success", () => {
    // No shipped adapter emits this pair, which is exactly why the clause needs
    // a test: nothing else would notice a future one that does.
    expect(resultIsTheAgentsOwn({ status: "success", error: "the upstream returned 500" }))
      .toBe(false);
  });
});
