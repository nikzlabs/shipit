import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  corsHeadersFor,
  isAllowedOrigin,
  isAllowedWithoutOrigin,
  isGuardedRequest,
  isOriginGuardedPath,
  isWebSocketOriginAllowed,
  selfHostsFrom,
  markPreviewProxyRegistered,
  parseOriginHost,
  readOriginPolicyFromEnv,
  registerOriginGuard,
  type OriginPolicy,
} from "./api-origin-guard.js";

const BARE: OriginPolicy = { extraOrigins: [], devClientPort: null };

describe("parseOriginHost", () => {
  it("returns the lowercased host[:port]", () => {
    expect(parseOriginHost("https://ShipIt.Example.com")).toBe("shipit.example.com");
    expect(parseOriginHost("http://localhost:3000")).toBe("localhost:3000");
  });

  it("rejects the opaque origin a sandboxed iframe sends", () => {
    expect(parseOriginHost("null")).toBeNull();
  });

  it("rejects non-http(s) and unparseable origins", () => {
    expect(parseOriginHost("file://")).toBeNull();
    expect(parseOriginHost("chrome-extension://abcdef")).toBeNull();
    expect(parseOriginHost("not a url")).toBeNull();
    expect(parseOriginHost("")).toBeNull();
  });
});

describe("isAllowedOrigin", () => {
  it("allows the request's own host, whatever hostname that is", () => {
    // docs/254 — loopback, a tailnet IP and a public domain are all correct at
    // once, because "same origin" is derived from Host rather than configured.
    expect(isAllowedOrigin("http://localhost:4123", ["localhost:4123"], BARE)).toBe(true);
    expect(isAllowedOrigin("http://100.83.12.47:4123", ["100.83.12.47:4123"], BARE)).toBe(true);
    expect(isAllowedOrigin("https://shipit.example.com", ["shipit.example.com"], BARE)).toBe(true);
  });

  it("ignores the scheme, so an HTTPS-terminating proxy still matches", () => {
    expect(isAllowedOrigin("https://shipit.example.com", ["shipit.example.com"], BARE)).toBe(true);
  });

  it("refuses a preview subdomain of the same host", () => {
    // The attack shape in planning#370: same SITE, different ORIGIN.
    expect(
      isAllowedOrigin(
        "https://98f05156-7e64-422d-81bc-ba677fda60e0--5173.shipit.example.com",
        ["shipit.example.com"],
        BARE,
      ),
    ).toBe(false);
  });

  it("refuses an unrelated site and an opaque origin", () => {
    expect(isAllowedOrigin("https://evil.example", ["shipit.example.com"], BARE)).toBe(false);
    expect(isAllowedOrigin("null", ["shipit.example.com"], BARE)).toBe(false);
  });

  it("refuses a suffix look-alike", () => {
    expect(isAllowedOrigin("https://notshipit.example.com", ["shipit.example.com"], BARE)).toBe(false);
    expect(isAllowedOrigin("https://shipit.example.com.evil.test", ["shipit.example.com"], BARE)).toBe(false);
  });

  it("allows the dev client on the configured Vite port, same hostname only", () => {
    const dev: OriginPolicy = { extraOrigins: [], devClientPort: "3000" };
    expect(isAllowedOrigin("http://localhost:3000", ["localhost:3001"], dev)).toBe(true);
    // A different hostname on the dev port is still not ours.
    expect(isAllowedOrigin("http://evil.example:3000", ["localhost:3001"], dev)).toBe(false);
    // Any other port on the right hostname is not the dev client.
    expect(isAllowedOrigin("http://localhost:3002", ["localhost:3001"], dev)).toBe(false);
  });

  it("has no dev-port hole when CLIENT_DEV_PORT is unset", () => {
    expect(isAllowedOrigin("http://localhost:3000", ["localhost:3001"], BARE)).toBe(false);
  });

  it("handles IPv6 hosts in the dev-port rule", () => {
    const dev: OriginPolicy = { extraOrigins: [], devClientPort: "3000" };
    expect(isAllowedOrigin("http://[::1]:3000", ["[::1]:3001"], dev)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:3002", ["[::1]:3001"], dev)).toBe(false);
  });

  it("allows a configured extra origin", () => {
    const policy: OriginPolicy = { extraOrigins: ["shipit.example.com"], devClientPort: null };
    expect(isAllowedOrigin("https://shipit.example.com", ["internal-upstream:4123"], policy)).toBe(true);
  });
});

describe("readOriginPolicyFromEnv", () => {
  it("is empty by default", () => {
    expect(readOriginPolicyFromEnv({})).toEqual({ extraOrigins: [], devClientPort: null });
  });

  it("normalizes SHIPIT_ALLOWED_ORIGINS entries with or without a scheme", () => {
    const policy = readOriginPolicyFromEnv({
      SHIPIT_ALLOWED_ORIGINS: "https://A.example.com, b.example.com:8443 ,",
    });
    expect(policy.extraOrigins).toEqual(["a.example.com", "b.example.com:8443"]);
  });

  it("reads CLIENT_DEV_PORT only when it is numeric", () => {
    expect(readOriginPolicyFromEnv({ CLIENT_DEV_PORT: "3000" }).devClientPort).toBe("3000");
    expect(readOriginPolicyFromEnv({ CLIENT_DEV_PORT: "nope" }).devClientPort).toBeNull();
  });
});

describe("isAllowedWithoutOrigin", () => {
  it("allows a caller that sends no Sec-Fetch-Site at all (a session container)", () => {
    expect(isAllowedWithoutOrigin(undefined)).toBe(true);
  });

  it("allows same-origin fetches and direct navigations", () => {
    expect(isAllowedWithoutOrigin("same-origin")).toBe(true);
    expect(isAllowedWithoutOrigin("none")).toBe(true);
  });

  it("refuses same-site, which is what a preview page sends", () => {
    expect(isAllowedWithoutOrigin("same-site")).toBe(false);
    expect(isAllowedWithoutOrigin("cross-site")).toBe(false);
  });
});

describe("isOriginGuardedPath", () => {
  it("covers the API and WebSocket surfaces", () => {
    expect(isOriginGuardedPath("/api/bootstrap")).toBe(true);
    expect(isOriginGuardedPath("/api")).toBe(true);
    expect(isOriginGuardedPath("/ws/sessions/abc")).toBe(true);
  });

  it("leaves the SPA and its assets alone so cross-site navigation still works", () => {
    expect(isOriginGuardedPath("/")).toBe(false);
    expect(isOriginGuardedPath("/session/abc")).toBe(false);
    expect(isOriginGuardedPath("/assets/index-abc123.js")).toBe(false);
    expect(isOriginGuardedPath("/apinot")).toBe(false);
  });
});

describe("isGuardedRequest", () => {
  it("sees through a percent-encoded path", () => {
    expect(isGuardedRequest("/%61pi/bootstrap", undefined)).toBe(true);
    expect(isGuardedRequest("/api%2fbootstrap", undefined)).toBe(true);
    expect(isGuardedRequest("/%77s/sessions/abc", undefined)).toBe(true);
  });

  it("falls back to the raw path when the encoding is malformed", () => {
    expect(isGuardedRequest("/api/files/%E0%A4%A", undefined)).toBe(true);
    expect(isGuardedRequest("/assets/%E0%A4%A", undefined)).toBe(false);
  });

  it("guards on the matched route even if the path somehow does not", () => {
    expect(isGuardedRequest("/something", "/api/sessions/:id/history")).toBe(true);
  });

  it("ignores the query string", () => {
    expect(isGuardedRequest("/api/events?x=1", undefined)).toBe(true);
    expect(isGuardedRequest("/index.html?next=/api/x", undefined)).toBe(false);
  });
});

describe("selfHostsFrom", () => {
  it("counts both the browser-facing X-Forwarded-Host and the Host header", () => {
    // ShipIt's own preview proxy rewrites Host and moves the browser's name
    // into X-Forwarded-Host — the shape the dogfood inner instance is reached in.
    expect(selfHostsFrom({
      host: "localhost:3000",
      "x-forwarded-host": "abc--3000.nikz.win",
    })).toEqual(["abc--3000.nikz.win", "localhost:3000"]);
  });

  it("takes the left-most entry of a chained X-Forwarded-Host", () => {
    expect(selfHostsFrom({ "x-forwarded-host": "Outer.example, inner.internal" }))
      .toEqual(["outer.example"]);
  });

  it("is just the Host header when no proxy set one", () => {
    expect(selfHostsFrom({ host: "ShipIt.example.com" })).toEqual(["shipit.example.com"]);
    expect(selfHostsFrom({})).toEqual([]);
  });
});

describe("corsHeadersFor", () => {
  it("reflects only an allowed origin", () => {
    expect(corsHeadersFor("https://shipit.example.com", { host: "shipit.example.com" }, BARE))
      .toMatchObject({
        "Access-Control-Allow-Origin": "https://shipit.example.com",
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
      });
  });

  it("sends nothing for a foreign origin", () => {
    expect(corsHeadersFor("https://evil.example", { host: "shipit.example.com" }, BARE)).toEqual({});
    expect(corsHeadersFor(undefined, { host: "shipit.example.com" }, BARE)).toEqual({});
  });
});

describe("isWebSocketOriginAllowed", () => {
  it("allows a handshake with no Origin (a non-browser client)", () => {
    expect(isWebSocketOriginAllowed({ host: "shipit.example.com" }, BARE)).toBe(true);
  });

  it("allows the same origin and refuses a preview / foreign one", () => {
    expect(isWebSocketOriginAllowed(
      { host: "shipit.example.com", origin: "https://shipit.example.com" }, BARE,
    )).toBe(true);
    expect(isWebSocketOriginAllowed(
      { host: "shipit.example.com", origin: "https://a--5173.shipit.example.com" }, BARE,
    )).toBe(false);
    expect(isWebSocketOriginAllowed(
      { host: "shipit.example.com", origin: "https://evil.example" }, BARE,
    )).toBe(false);
  });
});

describe("registerOriginGuard — hook behavior", () => {
  async function makeApp(policy: OriginPolicy = BARE, withPreviewProxy = false) {
    const app = Fastify({ logger: false });
    registerOriginGuard(app, policy);
    if (withPreviewProxy) markPreviewProxyRegistered(app);
    app.get("/api/bootstrap", async () => ({ ok: true }));
    app.post("/api/egress/hosts", async () => ({ ok: true }));
    app.get("/anything", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it("allows a same-origin call and reflects the origin", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      headers: {
        host: "shipit.example.com",
        origin: "https://shipit.example.com",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://shipit.example.com");
    await app.close();
  });

  it("refuses a mutating call from a preview page, and reflects nothing", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      headers: {
        host: "shipit.example.com",
        origin: "https://98f05156-7e64-422d-81bc-ba677fda60e0--5173.shipit.example.com",
        "sec-fetch-site": "same-site",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("refuses a READ from a foreign origin too, so responses can't be exfiltrated", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: {
        host: "shipit.example.com",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("refuses a no-Origin sub-resource load from another site", async () => {
    // `<img src="https://shipit/api/...">` from a preview page: no Origin
    // header, but Sec-Fetch-Site gives it away.
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "shipit.example.com", "sec-fetch-site": "same-site" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows a container-style call that carries no browser headers", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "shipit:4123" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows a same-origin GET, which sends no Origin header", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "shipit.example.com", "sec-fetch-site": "same-origin" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("refuses a percent-encoded spelling of an API path", async () => {
    // find-my-way decodes static segments when it resolves the route, so
    // `/%61pi/bootstrap` REACHES the `/api/bootstrap` handler while
    // `request.url` still reads `/%61pi/…`. A raw prefix test would miss it.
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/%61pi/bootstrap",
      headers: { host: "shipit.example.com", origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("leaves non-API paths open to cross-site navigation", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/anything",
      headers: {
        host: "shipit.example.com",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("answers a preflight from an allowed origin with 204 + headers", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/egress/hosts",
      headers: { host: "shipit.example.com", origin: "https://shipit.example.com" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  it("fails a preflight from a foreign origin", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/egress/hosts",
      headers: { host: "shipit.example.com", origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("steps aside for preview hosts when the preview proxy is registered", async () => {
    const app = await makeApp(BARE, true);
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: {
        host: "98f05156-7e64-422d-81bc-ba677fda60e0--5173.shipit.example.com",
        "sec-fetch-site": "cross-site",
      },
    });
    // The previewed app owns this path; the proxy hook hijacks it in the real
    // app, so the guard must not refuse it first.
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("still guards a preview-shaped Host when no preview proxy is registered", async () => {
    // Local mode (the dogfood inner instance) has no proxy — a forged Host must
    // not be a way around the check.
    const app = await makeApp(BARE, false);
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: {
        host: "98f05156-7e64-422d-81bc-ba677fda60e0--5173.shipit.example.com",
        origin: "https://evil.example",
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("keeps the dogfood inner instance working behind the outer preview proxy", async () => {
    // The inner orchestrator (RUNTIME_MODE=local, no proxy of its own) is
    // reached THROUGH the outer instance's preview proxy, which rewrites Host
    // to the container port and puts the browser's origin in X-Forwarded-Host.
    // Comparing Origin against Host alone would 403 every write from the inner
    // UI.
    const app = await makeApp(BARE, false);
    const browserHost = "98f05156-7e64-422d-81bc-ba677fda60e0--3000.nikz.win";
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      headers: {
        host: "localhost:3000",
        "x-forwarded-host": browserHost,
        origin: `https://${browserHost}`,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("still refuses a foreign origin when a proxy set X-Forwarded-Host", async () => {
    const app = await makeApp(BARE, false);
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      headers: {
        host: "localhost:3000",
        "x-forwarded-host": "shipit.example.com",
        origin: "https://evil.example",
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
