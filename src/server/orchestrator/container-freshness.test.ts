import { describe, expect, it } from "vitest";
import { getContainerFreshness } from "./container-freshness.js";

describe("getContainerFreshness", () => {
  it("classifies matching builds as current", () => {
    expect(getContainerFreshness("abc", "abc")).toEqual({
      state: "current",
      workerBuildId: "abc",
      orchestratorBuildId: "abc",
    });
  });

  it("classifies different known builds as stale", () => {
    expect(getContainerFreshness("old", "new")).toEqual({
      state: "stale",
      workerBuildId: "old",
      orchestratorBuildId: "new",
    });
  });

  it("classifies a missing identity as unknown", () => {
    expect(getContainerFreshness(undefined, "new")).toEqual({
      state: "unknown",
      orchestratorBuildId: "new",
    });
    expect(getContainerFreshness(" ", undefined)).toEqual({ state: "unknown" });
  });
});
