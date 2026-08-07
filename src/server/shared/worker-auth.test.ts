/**
 * planning#313 — policy tests for the worker trust boundary. These cover
 * `decideWorkerRequest` and its helpers directly; the Fastify wiring is covered
 * in `session/worker-auth-guard.test.ts`.
 */

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

/** Shorthand for a decision with sensible defaults. */
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
    // `/present/:id/raw` is how the orchestrator reads an artifact for the
    // Present tab — it must stay reachable off-container.
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
      "/agent/cancel",
      "/agent/stdin",
      "/agent/message",
      "/agent/permission-mode",
      "/agent/compact",
      "/agent/permission/resolve",
    ]) {
      expect(isLifecyclePath(path), path).toBe(true);
    }
    // A literal list can only catch a typo in the set, never a route added to
    // `AgentController` and forgotten here — that is pinned against the real
    // route table in `session/worker-auth-guard.test.ts`.
    expect(LIFECYCLE_PATHS.size).toBe(10);
  });

  it("excludes the status probe and anything outside the exact set", () => {
    for (const path of [
      "/agent/status", // health/adoption probe — must stay open on loopback
      "/agent-ops/agent/spawn", // the broker; a different group entirely
      "/agent/startle", // exact match, not a prefix
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
    // `POST /agent/%6bill` reaches the /agent/kill handler; comparing the raw
    // URL alone was a live bypass.
    for (const path of ["/agent/%6bill", "/agent/%6Bill", "/%61gent/start", "/agent/%73tart"]) {
      expect(isLifecyclePath(path), path).toBe(true);
    }
    expect(isLoopbackOnlyPath("/%61gent-ops/voice/note")).toBe(true);
  });

  it("does not over-decode: %2F stays encoded, as it does in the router", () => {
    // `decodeURI` leaves reserved characters alone, which is why `/agent%2Fkill`
    // does NOT reach the kill handler — denying it would be a guard that
    // disagrees with the router in the other direction.
    expect(isLifecyclePath("/agent%2Fkill")).toBe(false);
    expect(isLifecyclePath("/services/list")).toBe(false);
  });

  it("survives a malformed escape instead of throwing", () => {
    // `decodeURI("%zz")` throws a URIError. The router answers 400 without
    // routing, so the raw spelling is the only one that could have matched — but
    // an exception here would surface as a 500 from the auth hook.
    expect(() => isLifecyclePath("/agent/%zz")).not.toThrow();
    expect(isLifecyclePath("/agent/%zz")).toBe(false);
    expect(() => isLoopbackOnlyPath("/agent-ops/%zz")).not.toThrow();
    expect(isLoopbackOnlyPath("/agent-ops/%zz")).toBe(true);
  });
});

describe("routerPathname", () => {
  it("cuts at a fragment, which the router treats as a delimiter", () => {
    // The guard used to split only on `?`. `POST /agent/kill#x` then classified
    // as the unprotected `/agent/kill#x` while Fastify dispatched it to the
    // /agent/kill handler — a live bypass on a real socket (app.inject
    // normalizes it away, which is why an inject-only probe missed it).
    expect(routerPathname("/agent/kill#x")).toBe("/agent/kill");
    expect(routerPathname("/agent/kill?a=1#x")).toBe("/agent/kill");
    expect(routerPathname("/agent/kill?a=1")).toBe("/agent/kill");
  });

  it("strips an absolute-form request target, as FULL_PATH_REGEXP does", () => {
    expect(routerPathname("http://127.0.0.1:9100/agent/kill")).toBe("/agent/kill");
    expect(routerPathname("https://host/agent/start?a=1")).toBe("/agent/start");
  });

  it("leaves `;` alone — useSemicolonDelimiter is off, so those paths 404", () => {
    // Splitting here would deny paths the router never routes, and would also
    // truncate a legitimate /present-files/<id> containing a semicolon.
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
  it("SHI-311: a peer session container cannot reach /agent-ops even with a valid token", () => {
    // The regression proper. Session A learns B's container name, dials
    // agent-<b>:9100 and POSTs a broker route; B's worker would relay it with
    // B's own SESSION_ID injected.
    for (const path of LOOPBACK_ONLY_PREFIXES.map((p) => `${p}anything`)) {
      const denied = decide({ url: path, presentedToken: TOKEN });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason).toBe("loopback-only");
    }
  });

  it("SHI-311: a peer session container cannot reach the orchestrator-facing routes either", () => {
    // Same class, different route group: /terminal/start + /terminal/input is
    // command execution in another session's container, and PUT /secrets
    // rewrites its agent env.
    for (const path of ["/terminal/start", "/secrets", "/files/read"]) {
      const denied = decide({ url: path });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason).toBe("bad-token");
    }

    // The lifecycle routes are refused for the same peer, under planning#241's rule
    // rather than this one — a stricter reason for a strictly narrower group, so
    // the planning#313 guarantee is unchanged.
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

  it("falls back to open for orchestrator routes when no token is configured", () => {
    // Deliberate: an older orchestrator creating a newer worker image would set
    // no SHIPIT_WORKER_TOKEN, and failing closed would 403 every call and brick
    // the session. This is exactly the pre-guard behavior.
    expect(decide({ url: "/agent/start", configuredToken: undefined })).toEqual({
      allow: true,
      reason: "no-token-configured",
    });
  });

  it("still closes the loopback-only routes when no token is configured", () => {
    // The fallback above must not reopen the reported hole.
    const denied = decide({ url: "/agent-ops/session/create", configuredToken: undefined });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe("loopback-only");
  });

  it("ignores the querystring-free path only — callers strip it before deciding", () => {
    expect(decide({ url: "/agent-ops/issue/view", remoteAddress: "127.0.0.1" }).allow).toBe(true);
  });

  it("SHI-239: loopback is NOT enough for any lifecycle route", () => {
    // The carve-out from the blanket loopback allow. Being inside the container
    // identifies the caller; it does not authorize it to touch the live agent.
    for (const path of LIFECYCLE_PATHS) {
      const denied = decide({ url: path, remoteAddress: "127.0.0.1" });
      expect(denied.allow, path).toBe(false);
      expect(denied.reason, path).toBe("lifecycle-needs-token");
    }
  });

  it("SHI-239: a fragment or absolute-form target cannot smuggle a lifecycle route past", () => {
    // Both reproduced against a real server on a real socket before the fix:
    // every one of these was served 200 by the /agent/kill handler.
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

  it("SHI-311: an absolute-form target cannot smuggle past the loopback-only rule", () => {
    // A trailing fragment can't defeat prefix matching, but the absolute form
    // can: the whole URL fails `startsWith("/agent-ops/")`, so before the fix a
    // token-bearing peer fell through to the token check and was served — while
    // the documented invariant is that a token does NOT open these routes.
    const denied = decide({
      url: "http://127.0.0.1:9100/agent-ops/voice/note",
      presentedToken: TOKEN,
    });
    expect(denied).toEqual({ allow: false, reason: "loopback-only" });
  });

  it("SHI-239: a loopback caller presenting the wrong token is refused too", () => {
    const denied = decide({
      url: "/agent/kill",
      remoteAddress: "127.0.0.1",
      presentedToken: "c".repeat(64),
    });
    expect(denied).toEqual({ allow: false, reason: "lifecycle-needs-token" });
  });

  it("SHI-239: the incident shape — a stray in-container /agent/start never reaches the 409", () => {
    // The 2026-07-25 self-kill: an integration-test fixture's
    // ContainerSessionRunner POSTed /agent/start at 127.0.0.1:9100, the live
    // worker answered 409 "Agent already running" twice, and the runner's
    // persistent-409 recovery cleared the "stale" agent with /agent/kill —
    // SIGTERMing the agent running vitest. The runner looks its token up by
    // worker base URL, so for a foreign URL it presents none; both legs are now
    // refused at the guard, ahead of any handler that could 409.
    for (const path of ["/agent/start", "/agent/kill"]) {
      const denied = decide({ url: path, remoteAddress: "127.0.0.1", presentedToken: undefined });
      expect(denied.allow, path).toBe(false);
    }
  });

  it("SHI-239: the orchestrator's lifecycle calls still pass, from the bridge or loopback", () => {
    for (const remoteAddress of [OTHER_SESSION_IP, "127.0.0.1"]) {
      const allowed = decide({ url: "/agent/start", remoteAddress, presentedToken: TOKEN });
      expect(allowed, remoteAddress).toEqual({ allow: true, reason: "token" });
    }
  });

  it("SHI-239: leaves /agent/status and the rest of the loopback surface alone", () => {
    // Over-broad prefix matching here would break the health/adoption probe and
    // the agent's own service + present routes.
    for (const path of ["/agent/status", "/services/list", "/agent-ops/issue/list", "/present-files/x"]) {
      const allowed = decide({ url: path, remoteAddress: "127.0.0.1" });
      expect(allowed.allow, path).toBe(true);
      expect(allowed.reason, path).toBe("loopback");
    }
  });

  it("SHI-239: an unconfigured worker keeps its old lifecycle behavior", () => {
    // Same fallback as the orchestrator-facing routes: in-process tests build a
    // SessionWorker with no token and drive /agent/start over loopback, and a
    // mid-deploy skew must degrade rather than fail to start turns.
    for (const remoteAddress of ["127.0.0.1", OTHER_SESSION_IP]) {
      const allowed = decide({ url: "/agent/start", remoteAddress, configuredToken: undefined });
      expect(allowed.allow, remoteAddress).toBe(true);
    }
  });

  it("exposes stable wire names for the header and env var", () => {
    // Both cross a process boundary (HTTP header / container env), so a rename
    // is a compatibility break, not a refactor.
    expect(WORKER_AUTH_HEADER).toBe("x-shipit-worker-token");
    expect(WORKER_TOKEN_ENV).toBe("SHIPIT_WORKER_TOKEN");
  });
});
