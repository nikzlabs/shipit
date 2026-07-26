import { describe, it, expect } from "vitest";
import {
  WORKER_LIFECYCLE_SECRET_ENV,
  isLifecycleProtectedPath,
  generateLifecycleSecret,
  lifecycleSecretMatches,
  takeLifecycleSecretFromEnv,
  parseLifecycleSecretFromContainerEnv,
} from "./worker-auth.js";

describe("isLifecycleProtectedPath", () => {
  it.each([
    "/agent/start",
    "/agent/interrupt",
    "/agent/kill",
    "/agent/spawn",
    "/agent/cancel",
    "/agent/stdin",
    "/agent/message",
    "/agent/permission-mode",
    "/agent/compact",
    "/agent/permission/resolve",
  ])("protects %s", (p) => {
    expect(isLifecycleProtectedPath(p)).toBe(true);
  });

  it("protects a path regardless of query string", () => {
    expect(isLifecycleProtectedPath("/agent/kill?force=1")).toBe(true);
  });

  it.each([
    // Read-only status stays open for health probes.
    "/agent/status",
    // Agent-shim surfaces the agent's children legitimately reach.
    "/agent-ops/permission/request",
    "/agent-ops/agent/spawn",
    "/agent-ops/git/credential",
    "/services/list",
    "/health",
    "/events",
    "/secrets",
    // Exact-path matching — no accidental prefix captures.
    "/agent/startx",
  ])("leaves %s open", (p) => {
    expect(isLifecycleProtectedPath(p)).toBe(false);
  });
});

describe("generateLifecycleSecret / lifecycleSecretMatches", () => {
  it("generates distinct non-empty secrets", () => {
    const a = generateLifecycleSecret();
    const b = generateLifecycleSecret();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });

  it("matches only the exact secret", () => {
    const secret = generateLifecycleSecret();
    expect(lifecycleSecretMatches(secret, secret)).toBe(true);
    expect(lifecycleSecretMatches(`${secret}x`, secret)).toBe(false);
    expect(lifecycleSecretMatches(secret.slice(1), secret)).toBe(false);
    expect(lifecycleSecretMatches(undefined, secret)).toBe(false);
    expect(lifecycleSecretMatches(["a"], secret)).toBe(false);
    expect(lifecycleSecretMatches("", secret)).toBe(false);
  });
});

describe("takeLifecycleSecretFromEnv", () => {
  it("returns the secret and scrubs it from the env", () => {
    const env: NodeJS.ProcessEnv = { [WORKER_LIFECYCLE_SECRET_ENV]: "s3cret", OTHER: "kept" };
    expect(takeLifecycleSecretFromEnv(env)).toBe("s3cret");
    // The scrub is the point: children spawned from this env (agent CLIs,
    // terminal PTY) must never inherit the secret.
    expect(WORKER_LIFECYCLE_SECRET_ENV in env).toBe(false);
    expect(env.OTHER).toBe("kept");
  });

  it("returns undefined when unset or empty", () => {
    expect(takeLifecycleSecretFromEnv({})).toBeUndefined();
    expect(takeLifecycleSecretFromEnv({ [WORKER_LIFECYCLE_SECRET_ENV]: "" })).toBeUndefined();
  });
});

describe("parseLifecycleSecretFromContainerEnv", () => {
  it("recovers the secret from a docker-inspect Config.Env list", () => {
    const env = ["WORKER_PORT=9100", `${WORKER_LIFECYCLE_SECRET_ENV}=abc123`, "HOME=/home/shipit"];
    expect(parseLifecycleSecretFromContainerEnv(env)).toBe("abc123");
  });

  it("returns undefined when absent, empty, or the list is missing", () => {
    expect(parseLifecycleSecretFromContainerEnv(["WORKER_PORT=9100"])).toBeUndefined();
    expect(parseLifecycleSecretFromContainerEnv([`${WORKER_LIFECYCLE_SECRET_ENV}=`])).toBeUndefined();
    expect(parseLifecycleSecretFromContainerEnv(undefined)).toBeUndefined();
  });
});
