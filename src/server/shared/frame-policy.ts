import type { RuntimeMode } from "./types.js";

export type FramePolicy = "deny" | "permit";

// Local mode runs inside the outer instance's preview frame.
export function framePolicyFor(runtimeMode: RuntimeMode): FramePolicy {
  return runtimeMode === "local" ? "permit" : "deny";
}

export function framePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): FramePolicy {
  return framePolicyFor(env.RUNTIME_MODE?.toLowerCase() === "local" ? "local" : "containerized");
}

export function frameGuardHeaders(policy: FramePolicy): Record<string, string> {
  if (policy === "permit") return {};
  return {
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  };
}
