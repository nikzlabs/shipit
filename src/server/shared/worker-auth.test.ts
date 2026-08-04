/**
 * SHI-311 — policy tests for the worker trust boundary. These cover
 * `decideWorkerRequest` and its helpers directly; the Fastify wiring is covered
 * in `session/worker-auth-guard.test.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  LOOPBACK_ONLY_PREFIXES,
  WORKER_AUTH_HEADER,
  WORKER_TOKEN_ENV,
  decideWorkerRequest,
  generateWorkerToken,
  isLoopbackAddress,
  isLoopbackOnlyPath,
  normalizePeerAddress,
  tokensMatch,
} from "./worker-auth.js";

const TOKEN = "a".repeat(64);
const OTHER_SESSION_IP = "172.18.0.7";

/** Shorthand for a decision with sensible defaults. */
function decide(over: Partial<Parameters<typeof decideWorkerRequest>[0]>) {
  return decideWorkerRequest({
    pathname: "/agent/status",
    remoteAddress: OTHER_SESSION_IP,
    presentedToken: undefined,
    configuredToken: TOKEN,
    ...over,
  });
}

describe("isLoopbackAddress", () => {
  it("accepts the whole 127.0.0.0/8 block and ::1", () => {
    for (const ip of ["127.0.0.1", "127.0.0.53", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(ip), ip).toBe(true);
    }
  });

  it("rejects bridge addresses, including ones that merely start with 127", () => {
    for (const ip of ["172.18.0.3", "10.0.0.1", "192.168.1.5", "1270.0.0.1", "127.0.0", "::ffff:172.18.0.3"]) {
      expect(isLoopbackAddress(ip), ip).toBe(false);
    }
  });

  it("treats a missing peer address as NOT loopback (fails closed)", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });

  it("strips an IPv6 zone index before comparing", () => {
    expect(normalizePeerAddress("::1%lo0")).toBe("::1");
    expect(isLoopbackAddress("::1%lo0")).toBe(true);
  });
});

describe("isLoopbackOnlyPath", () => {
  it("covers the agent-ops broker and the agent's present artifacts", () => {
    expect(isLoopbackOnlyPath("/agent-ops/session/create")).toBe(true);
    expect(isLoopbackOnlyPath("/agent-ops/branch/reset-to-base")).toBe(true);
    expect(isLoopbackOnlyPath("/present-files/abc123")).toBe(true);
  });

  it("does NOT cover the orchestrator-facing routes with similar names", () => {
    // `/present/:id/raw` is how the orchestrator reads an artifact for the
    // Present tab — it must stay reachable off-container.
    expect(isLoopbackOnlyPath("/present/abc123/raw")).toBe(false);
    expect(isLoopbackOnlyPath("/agent/start")).toBe(false);
    expect(isLoopbackOnlyPath("/agent/permission/resolve")).toBe(false);
  });
});

describe("tokensMatch", () => {
  it("matches an identical token and nothing else", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokensMatch(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(tokensMatch(TOKEN, `${"a".repeat(63)}b`)).toBe(false);
  });

  it("rejects missing/non-string presentations without throwing", () => {
    expect(tokensMatch(TOKEN, undefined)).toBe(false);
    expect(tokensMatch(TOKEN, "")).toBe(false);
    expect(tokensMatch(TOKEN, ["a", "b"])).toBe(false);
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
  });
});

describe("generateWorkerToken", () => {
  it("returns a long hex string, distinct per call", () => {
    const a = generateWorkerToken();
    const b = generateWorkerToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("decideWorkerRequest", () => {
  it("SHI-311: a peer session container cannot reach /agent-ops even with a valid token", () => {
    // The regression proper. Session A learns B's container name, dials
    // agent-<b>:9100 and POSTs a broker route; B's worker would relay it with
    // B's own SESSION_ID injected.
    for (const path of LOOPBACK_ONLY_PREFIXES.map((p) => `${p}anything`)) {
      const denied = decide({ pathname: path, presentedToken: TOKEN });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason).toBe("loopback-only");
    }
  });

  it("SHI-311: a peer session container cannot reach the orchestrator-facing routes either", () => {
    // Same class, different route group: /terminal/start + /terminal/input is
    // command execution in another session's container, and PUT /secrets
    // rewrites its agent env.
    for (const path of ["/terminal/start", "/agent/message", "/secrets", "/agent/kill"]) {
      const denied = decide({ pathname: path });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason).toBe("bad-token");
    }
  });

  it("serves the container's own agent over loopback", () => {
    for (const path of ["/agent-ops/voice/note", "/present-files/x", "/services/list"]) {
      const allowed = decide({ pathname: path, remoteAddress: "127.0.0.1" });
      expect(allowed.allow, path).toBe(true);
      expect(allowed.reason).toBe("loopback");
    }
  });

  it("serves the orchestrator when it presents the session's token", () => {
    const allowed = decide({ pathname: "/agent/start", presentedToken: TOKEN });
    expect(allowed).toEqual({ allow: true, reason: "token" });
  });

  it("leaves /health open so container health probes work before any token exists", () => {
    expect(decide({ pathname: "/health", configuredToken: TOKEN })).toEqual({
      allow: true,
      reason: "unauthenticated-path",
    });
  });

  it("falls back to open for orchestrator routes when no token is configured", () => {
    // Deliberate: an older orchestrator creating a newer worker image would set
    // no SHIPIT_WORKER_TOKEN, and failing closed would 403 every call and brick
    // the session. This is exactly the pre-guard behavior.
    expect(decide({ pathname: "/agent/start", configuredToken: undefined })).toEqual({
      allow: true,
      reason: "no-token-configured",
    });
  });

  it("still closes the loopback-only routes when no token is configured", () => {
    // The fallback above must not reopen the reported hole.
    const denied = decide({ pathname: "/agent-ops/session/create", configuredToken: undefined });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe("loopback-only");
  });

  it("ignores the querystring-free path only — callers strip it before deciding", () => {
    expect(decide({ pathname: "/agent-ops/issue/view", remoteAddress: "127.0.0.1" }).allow).toBe(true);
  });

  it("exposes stable wire names for the header and env var", () => {
    // Both cross a process boundary (HTTP header / container env), so a rename
    // is a compatibility break, not a refactor.
    expect(WORKER_AUTH_HEADER).toBe("x-shipit-worker-token");
    expect(WORKER_TOKEN_ENV).toBe("SHIPIT_WORKER_TOKEN");
  });
});
