import { describe, it, expect } from "vitest";
import { framePolicyFor, framePolicyFromEnv, frameGuardHeaders } from "./frame-policy.js";

describe("frame policy", () => {
  it("denies framing in containerized mode and permits it in local mode", () => {
    expect(framePolicyFor("containerized")).toBe("deny");
    expect(framePolicyFor("local")).toBe("permit");
  });

  it("reads the same split out of the environment, for callers with no resolved mode", () => {
    // The Vite config is the whole population — it serves the framable document
    // in both stacks that run Vite, and has no orchestrator DI to read from.
    expect(framePolicyFromEnv({ RUNTIME_MODE: "local" })).toBe("permit");
    expect(framePolicyFromEnv({ RUNTIME_MODE: "LOCAL" })).toBe("permit");
    expect(framePolicyFromEnv({ RUNTIME_MODE: "containerized" })).toBe("deny");
    // Unset is every real deployment, and must fail closed.
    expect(framePolicyFromEnv({})).toBe("deny");
    // Anything unrecognized is not local — same fail-closed direction as
    // `resolveRuntimeMode`.
    expect(framePolicyFromEnv({ RUNTIME_MODE: "locally" })).toBe("deny");
  });

  it("sends both headers on deny and nothing on permit", () => {
    expect(frameGuardHeaders("deny")).toEqual({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    });
    // Not a permissive value — no header at all. A `frame-ancestors *` would
    // read as a deliberate grant to every site rather than as "this mode does
    // not participate".
    expect(frameGuardHeaders("permit")).toEqual({});
  });
});
