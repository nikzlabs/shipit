import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_PATHS,
  LOOPBACK_ONLY_PREFIXES,
  WORKER_AUTH_HEADER,
  WORKER_TOKEN_ENV,
  decideWorkerRequest,
  generateWorkerToken,
  isLifecyclePath,
  isLoopbackAddress,
  isLoopbackOnlyPath,
  normalizePeerAddress,
  routerPathname,
  tokensMatch,
} from "./worker-auth.js";

const TOKEN = "a".repeat(64);
const OTHER_SESSION_IP = "172.18.0.7";

function decide(over: Partial<Parameters<typeof decideWorkerRequest>[0]>) {
  return decideWorkerRequest({
    url: "/agent/status",
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
    expect(isLoopbackOnlyPath("/present/abc123/raw")).toBe(false);
    expect(isLoopbackOnlyPath("/agent/start")).toBe(false);
    expect(isLoopbackOnlyPath("/agent/permission/resolve")).toBe(false);
  });
});

describe("isLifecyclePath", () => {
  it("covers every route that starts, stops or steers the resident agent", () => {
    for (const path of [
      "/agent/start",
      "/agent/interrupt",
      "/agent/kill",
      "/agent/spawn",
      "/agent/stdin",
      "/agent/message",
      "/agent/permission-mode",
      "/agent/compact",
      "/agent/permission/resolve",
    ]) {
      expect(isLifecyclePath(path), path).toBe(true);
    }
    expect(LIFECYCLE_PATHS.size).toBe(9);
  });

  it("excludes the status probe and anything outside the exact set", () => {
    for (const path of [
      "/agent/status",
      "/agent-ops/agent/spawn",
      "/agent/startle",
      "/services/list",
      "/health",
      "/present-files/x",
    ]) {
      expect(isLifecyclePath(path), path).toBe(false);
    }
  });

  it("strips a trailing slash so the guard and the router agree on membership", () => {
    expect(isLifecyclePath("/agent/kill/")).toBe(true);
    expect(isLifecyclePath("/")).toBe(false);
  });

  it("sees through percent-encoding, which the router decodes before matching", () => {
    for (const path of ["/agent/%6bill", "/agent/%6Bill", "/%61gent/start", "/agent/%73tart"]) {
      expect(isLifecyclePath(path), path).toBe(true);
    }
    expect(isLoopbackOnlyPath("/%61gent-ops/voice/note")).toBe(true);
  });

  it("does not over-decode: %2F stays encoded, as it does in the router", () => {
    expect(isLifecyclePath("/agent%2Fkill")).toBe(false);
    expect(isLifecyclePath("/services/list")).toBe(false);
  });

  it("survives a malformed escape instead of throwing", () => {
    expect(() => isLifecyclePath("/agent/%zz")).not.toThrow();
    expect(isLifecyclePath("/agent/%zz")).toBe(false);
    expect(() => isLoopbackOnlyPath("/agent-ops/%zz")).not.toThrow();
    expect(isLoopbackOnlyPath("/agent-ops/%zz")).toBe(true);
  });
});

describe("routerPathname", () => {
  it("cuts at a fragment, which the router treats as a delimiter", () => {
    expect(routerPathname("/agent/kill#x")).toBe("/agent/kill");
    expect(routerPathname("/agent/kill?a=1#x")).toBe("/agent/kill");
    expect(routerPathname("/agent/kill?a=1")).toBe("/agent/kill");
  });

  it("strips an absolute-form request target, as FULL_PATH_REGEXP does", () => {
    expect(routerPathname("http://127.0.0.1:9100/agent/kill")).toBe("/agent/kill");
    expect(routerPathname("https://host/agent/start?a=1")).toBe("/agent/start");
  });

  it("leaves `;` alone — useSemicolonDelimiter is off, so those paths 404", () => {
    expect(routerPathname("/agent/kill;x=1")).toBe("/agent/kill;x=1");
  });

  it("is idempotent on an already-derived pathname", () => {
    for (const p of ["/agent/kill", "/", "/present-files/a%20b", "/agent/%6bill"]) {
      expect(routerPathname(p), p).toBe(p);
    }
  });

  it("does not treat a delimiter at position 0 as a cut, mirroring the router", () => {
    expect(routerPathname("?x")).toBe("?x");
    expect(routerPathname("")).toBe("/");
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
  it("planning#313: a peer session container cannot reach /agent-ops even with a valid token", () => {
    for (const path of LOOPBACK_ONLY_PREFIXES.map((p) => `${p}anything`)) {
      const denied = decide({ url: path, presentedToken: TOKEN });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason).toBe("loopback-only");
    }
  });

  it("planning#313: a peer session container cannot reach the orchestrator-facing routes either", () => {
    for (const path of ["/terminal/start", "/secrets", "/files/read"]) {
      const denied = decide({ url: path });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason).toBe("bad-token");
    }

    for (const path of ["/agent/message", "/agent/kill"]) {
      const denied = decide({ url: path });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason, path).toBe("lifecycle-needs-token");
    }
  });

  it("serves the container's own agent over loopback", () => {
    for (const path of ["/agent-ops/voice/note", "/present-files/x", "/services/list"]) {
      const allowed = decide({ url: path, remoteAddress: "127.0.0.1" });
      expect(allowed.allow, path).toBe(true);
      expect(allowed.reason).toBe("loopback");
    }
  });

  it("serves the orchestrator when it presents the session's token", () => {
    const allowed = decide({ url: "/agent/start", presentedToken: TOKEN });
    expect(allowed).toEqual({ allow: true, reason: "token" });
  });

  it("leaves /health open so container health probes work before any token exists", () => {
    expect(decide({ url: "/health", configuredToken: TOKEN })).toEqual({
      allow: true,
      reason: "unauthenticated-path",
    });
  });

  it("planning#421: refuses every remote caller when no token is configured", () => {
    for (const url of ["/agent/start", "/install", "/terminal/start", "/secrets"]) {
      expect(decide({ url, configuredToken: undefined }), url).toEqual({
        allow: false,
        reason: "no-token-configured",
      });
    }
  });

  it("planning#421: a tokenless worker refuses /install from a peer container", () => {
    const denied = decide({
      url: "/install",
      remoteAddress: "172.18.0.9",
      configuredToken: undefined,
    });
    expect(denied.allow).toBe(false);
  });

  it("planning#421: a tokenless worker still serves its own agent over loopback", () => {
    expect(decide({ url: "/agent/start", remoteAddress: "127.0.0.1", configuredToken: undefined }))
      .toEqual({ allow: true, reason: "loopback" });
  });

  it("still closes the loopback-only routes when no token is configured", () => {
    const denied = decide({ url: "/agent-ops/session/create", configuredToken: undefined });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe("loopback-only");
  });

  it("ignores the querystring-free path only — callers strip it before deciding", () => {
    expect(decide({ url: "/agent-ops/issue/view", remoteAddress: "127.0.0.1" }).allow).toBe(true);
  });

  it("planning#241: loopback is NOT enough for any lifecycle route", () => {
    for (const path of LIFECYCLE_PATHS) {
      const denied = decide({ url: path, remoteAddress: "127.0.0.1" });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason, path).toBe("lifecycle-needs-token");
    }
  });

  it("planning#241: a fragment or absolute-form target cannot smuggle a lifecycle route past", () => {
    for (const url of [
      "/agent/kill#x",
      "/agent/start#x",
      "/agent/%6bill#x",
      "http://127.0.0.1:9100/agent/kill",
      "http://127.0.0.1:9100/agent/%6bill",
    ]) {
      const denied = decide({ url, remoteAddress: "127.0.0.1" });
      expect(denied.allow, url).toBe(false);
      expect(denied.reason, url).toBe("lifecycle-needs-token");
    }
  });

  it("planning#313: an absolute-form target cannot smuggle past the loopback-only rule", () => {
    const denied = decide({
      url: "http://127.0.0.1:9100/agent-ops/voice/note",
      presentedToken: TOKEN,
    });
    expect(denied).toEqual({ allow: false, reason: "loopback-only" });
  });

  it("planning#241: a loopback caller presenting the wrong token is refused too", () => {
    const denied = decide({
      url: "/agent/kill",
      remoteAddress: "127.0.0.1",
      presentedToken: "c".repeat(64),
    });
    expect(denied).toEqual({ allow: false, reason: "lifecycle-needs-token" });
  });

  it("planning#241: the incident shape — a stray in-container /agent/start never reaches the 409", () => {
    for (const path of ["/agent/start", "/agent/kill"]) {
      const denied = decide({ url: path, remoteAddress: "127.0.0.1", presentedToken: undefined });
      expect(denied.allow, path).toBe(false);
    }
  });

  it("planning#241: the orchestrator's lifecycle calls still pass, from the bridge or loopback", () => {
    for (const remoteAddress of [OTHER_SESSION_IP, "127.0.0.1"]) {
      const allowed = decide({ url: "/agent/start", remoteAddress, presentedToken: TOKEN });
      expect(allowed, remoteAddress).toEqual({ allow: true, reason: "token" });
    }
  });

  it("planning#241: leaves /agent/status and the rest of the loopback surface alone", () => {
    for (const path of ["/agent/status", "/services/list", "/agent-ops/issue/list", "/present-files/x"]) {
      const allowed = decide({ url: path, remoteAddress: "127.0.0.1" });
      expect(allowed.allow, path).toBe(true);
      expect(allowed.reason, path).toBe("loopback");
    }
  });

  it("planning#241: an unconfigured worker keeps its lifecycle behavior on LOOPBACK only", () => {
    const own = decide({ url: "/agent/start", remoteAddress: "127.0.0.1", configuredToken: undefined });
    expect(own.allow).toBe(true);

    const peer = decide({ url: "/agent/start", remoteAddress: OTHER_SESSION_IP, configuredToken: undefined });
    expect(peer).toEqual({ allow: false, reason: "no-token-configured" });
  });

  it("exposes stable wire names for the header and env var", () => {
    expect(WORKER_AUTH_HEADER).toBe("x-shipit-worker-token");
    expect(WORKER_TOKEN_ENV).toBe("SHIPIT_WORKER_TOKEN");
  });
});
