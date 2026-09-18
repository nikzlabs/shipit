import { describe, it, expect } from "vitest";
import { framePolicyFor, framePolicyFromEnv, frameGuardHeaders } from "./frame-policy.js";

describe("frame policy", () => {
  it("denies framing in containerized mode and permits it in local mode", () => {
    expect(framePolicyFor("containerized")).toBe("deny");
    expect(framePolicyFor("local")).toBe("permit");
  });

  it("reads the same split out of the environment, for callers with no resolved mode", () => {
    expect(framePolicyFromEnv({ RUNTIME_MODE: "local" })).toBe("permit");
    expect(framePolicyFromEnv({ RUNTIME_MODE: "LOCAL" })).toBe("permit");
    expect(framePolicyFromEnv({ RUNTIME_MODE: "containerized" })).toBe("deny");
    expect(framePolicyFromEnv({})).toBe("deny");
    expect(framePolicyFromEnv({ RUNTIME_MODE: "locally" })).toBe("deny");
  });

  it("sends both headers on deny and nothing on permit", () => {
    expect(frameGuardHeaders("deny")).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    });
    expect(frameGuardHeaders("permit")).toEqual({});
  });
});
