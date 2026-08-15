import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  corsHeadersFor,
  isAllowedOrigin,
  isAllowedCrossSiteNavigation,
  isAllowedWithoutOrigin,
  isBrowserRequest,
  isGuardedRequest,
  isOriginGuardedPath,
  isTrustedRequestHost,
  isWebSocketOriginAllowed,
  selfHostsFrom,
  markPreviewProxyRegistered,
  parseOriginHost,
  readOriginPolicyFromEnv,
  registerOriginGuard,
  type OriginPolicy,
} from "./api-origin-guard.js";

const BARE: OriginPolicy = { extraOrigins: [], devClientPort: null };

/**
 * planning#378 — a deployment reached at a **public domain**, which is the one
 * case that must declare itself: `shipit.example.com` is registrable, so
 * nothing about the name proves it is ShipIt's rather than an attacker's.
 * The tests below that use that hostname are about the *origin* boundary, so
 * they run under the declaration and let the host boundary have its own
 * describe block.
 */
const DECLARED: OriginPolicy = {
  extraOrigins: [{ host: "shipit.example.com", protocol: null }],
  devClientPort: null,
};

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
    const policy: OriginPolicy = {
      extraOrigins: [{ host: "shipit.example.com", protocol: null }],
      devClientPort: null,
    };
    expect(isAllowedOrigin("https://shipit.example.com", ["internal-upstream:4123"], policy)).toBe(true);
    expect(isAllowedOrigin("http://shipit.example.com", ["internal-upstream:4123"], policy)).toBe(true);
  });

  it("honours a scheme the operator wrote in SHIPIT_ALLOWED_ORIGINS", () => {
    // Configuring `https://x` must not quietly also trust `http://x`.
    const policy: OriginPolicy = {
      extraOrigins: [{ host: "shipit.example.com", protocol: "https:" }],
      devClientPort: null,
    };
    expect(isAllowedOrigin("https://shipit.example.com", ["upstream:4123"], policy)).toBe(true);
    expect(isAllowedOrigin("http://shipit.example.com", ["upstream:4123"], policy)).toBe(false);
  });

  it("refuses an http origin on a request that arrived over https", () => {
    // Scheme confusion: an HTTP page on the same name is not the same origin.
    expect(isAllowedOrigin(
      "http://shipit.example.com", ["shipit.example.com"], BARE, { requestIsSecure: true },
    )).toBe(false);
    expect(isAllowedOrigin(
      "https://shipit.example.com", ["shipit.example.com"], BARE, { requestIsSecure: true },
    )).toBe(true);
    // With no TLS signal, scheme stays ignored — a proxy that terminates TLS
    // without setting `X-Forwarded-Proto` must not break the whole product.
    expect(isAllowedOrigin(
      "http://shipit.example.com", ["shipit.example.com"], BARE,
    )).toBe(true);
  });

  it("treats loopback spellings as the same hostname for the dev-port rule", () => {
    const dev: OriginPolicy = { extraOrigins: [], devClientPort: "3000" };
    expect(isAllowedOrigin("http://127.0.0.1:3000", ["localhost:3001"], dev)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", ["127.0.0.1:3001"], dev)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:3000", ["localhost:3001"], dev)).toBe(true);
    // Still not a general hostname wildcard.
    expect(isAllowedOrigin("http://evil.example:3000", ["localhost:3001"], dev)).toBe(false);
  });
});

describe("isAllowedCrossSiteNavigation", () => {
  const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

  it("allows an opted-in route reached by a redirect from another site", () => {
    expect(isAllowedCrossSiteNavigation("GET", NAV, { crossOriginNavigation: true })).toBe(true);
  });

  it("refuses a route that did not opt in", () => {
    expect(isAllowedCrossSiteNavigation("GET", NAV, {})).toBe(false);
    expect(isAllowedCrossSiteNavigation("GET", NAV, undefined)).toBe(false);
  });

  it("refuses anything that is not a top-level document GET", () => {
    const cfg = { crossOriginNavigation: true };
    expect(isAllowedCrossSiteNavigation("POST", NAV, cfg)).toBe(false);
    expect(isAllowedCrossSiteNavigation("GET", { "sec-fetch-mode": "cors" }, cfg)).toBe(false);
    expect(isAllowedCrossSiteNavigation(
      "GET", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }, cfg,
    )).toBe(false);
    expect(isAllowedCrossSiteNavigation("GET", {}, cfg)).toBe(false);
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
    expect(policy.extraOrigins).toEqual([
      { host: "a.example.com", protocol: "https:" },
      { host: "b.example.com:8443", protocol: null },
    ]);
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
    expect(corsHeadersFor("https://shipit.example.com", { host: "shipit.example.com" }, DECLARED))
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
      { host: "shipit.example.com", origin: "https://shipit.example.com" }, DECLARED,
    )).toBe(true);
    expect(isWebSocketOriginAllowed(
      { host: "shipit.example.com", origin: "https://a--5173.shipit.example.com" }, DECLARED,
    )).toBe(false);
    expect(isWebSocketOriginAllowed(
      { host: "shipit.example.com", origin: "https://evil.example" }, DECLARED,
    )).toBe(false);
  });

  it("refuses a rebound handshake, which agrees with itself on the attacker's name", () => {
    expect(isWebSocketOriginAllowed(
      { host: "rebind.evil.example:4123", origin: "http://rebind.evil.example:4123" }, BARE,
    )).toBe(false);
    // The `ws` npm client sends no Origin and is still a non-browser caller.
    expect(isWebSocketOriginAllowed({ host: "rebind.evil.example:4123" }, BARE)).toBe(true);
  });
});

describe("isTrustedRequestHost", () => {
  it("trusts every hostname docs/254 supports, with nothing configured", () => {
    // Loopback, a LAN address and a tailnet address — all IP literals, so
    // serving a page from one of them means holding the address.
    expect(isTrustedRequestHost("127.0.0.1:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("192.168.1.20:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("100.83.12.47:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("[::1]:4123", BARE)).toBe(true);
    // localhost and the RFC-reserved suffixes.
    expect(isTrustedRequestHost("localhost:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("shipit.localhost", BARE)).toBe(true);
    // MagicDNS (deployment/vps/tailscale.sh serves the app on this).
    expect(isTrustedRequestHost("shipit.tail1a2b3c.ts.net", BARE)).toBe(true);
    // The sslip.io preview host, dashed and dotted, bare and prefixed.
    expect(isTrustedRequestHost("100-83-12-47.sslip.io:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("100.83.12.47.sslip.io:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("a--5173.100-83-12-47.sslip.io:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("100-83-12-47.nip.io", BARE)).toBe(true);
    // A dotless name — what a reverse proxy leaves behind, and not registrable.
    expect(isTrustedRequestHost("shipit:4123", BARE)).toBe(true);
  });

  it("refuses a registrable domain nobody declared — the rebinding shape", () => {
    expect(isTrustedRequestHost("rebind.evil.example:4123", BARE)).toBe(false);
    expect(isTrustedRequestHost("shipit.example.com", BARE)).toBe(false);
    // A look-alike of a self-describing name: the labels left of the suffix
    // must actually spell an address, or the name proves nothing.
    expect(isTrustedRequestHost("evil.sslip.io.evil.example", BARE)).toBe(false);
    expect(isTrustedRequestHost("notanip.sslip.io", BARE)).toBe(false);
    // ...and of the reserved suffixes.
    expect(isTrustedRequestHost("ts.net.evil.example", BARE)).toBe(false);
    // `.local` is reserved but ANSWERED BY mDNS, so any host on the link can
    // claim a name and re-point it. Reserved-ness is not the test.
    expect(isTrustedRequestHost("macbook.local:4123", BARE)).toBe(false);
    expect(isTrustedRequestHost("localhost.evil.example", BARE)).toBe(false);
  });

  it("trusts a public domain once the operator declares it", () => {
    expect(isTrustedRequestHost("shipit.example.com", DECLARED)).toBe(true);
    // The port is not part of "is this name ours".
    expect(isTrustedRequestHost("shipit.example.com:8443", DECLARED)).toBe(true);
    expect(isTrustedRequestHost("other.example.com", DECLARED)).toBe(false);
  });

  it("reads Host alone — X-Forwarded-Host is the attacker's to set here", () => {
    // A rebound request is SAME ORIGIN, so it may set any non-forbidden header
    // with no preflight. `Host` is forbidden; `X-Forwarded-Host` is not.
    expect(isTrustedRequestHost("rebind.evil.example", BARE)).toBe(false);
    const headers = { host: "rebind.evil.example", "x-forwarded-host": "localhost:4123" };
    expect(corsHeadersFor("http://rebind.evil.example", headers, BARE)).toEqual({});
  });

  it("sees through spellings of the same name", () => {
    // Uppercase, and the root-anchored trailing dot browsers pass through.
    expect(isTrustedRequestHost("LocalHost:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("localhost.:4123", BARE)).toBe(true);
    expect(isTrustedRequestHost("100-83-12-47.sslip.io.", BARE)).toBe(true);
    expect(isTrustedRequestHost("ShipIt.Example.COM", DECLARED)).toBe(true);
    // Normalizing must not widen it: the dot does not launder a foreign name.
    expect(isTrustedRequestHost("rebind.evil.example.", BARE)).toBe(false);
  });

  it("leaves a caller that sends no Host at all to the container guard", () => {
    expect(isTrustedRequestHost(undefined, BARE)).toBe(true);
    expect(isTrustedRequestHost("", BARE)).toBe(true);
  });
});

describe("isBrowserRequest", () => {
  it("is true for anything carrying Origin or Sec-Fetch-Site", () => {
    expect(isBrowserRequest({ origin: "http://localhost:4123" })).toBe(true);
    expect(isBrowserRequest({ "sec-fetch-site": "same-origin" })).toBe(true);
  });

  it("is false for a session container's CLI, which sends neither", () => {
    expect(isBrowserRequest({ host: "shipit:4123" })).toBe(false);
    expect(isBrowserRequest({})).toBe(false);
  });
});

describe("registerOriginGuard — hook behavior", () => {
  async function makeApp(policy: OriginPolicy = BARE, withPreviewProxy = false) {
    const app = Fastify({ logger: false });
    registerOriginGuard(app, policy);
    if (withPreviewProxy) markPreviewProxyRegistered(app);
    app.get("/api/bootstrap", async () => ({ ok: true }));
    app.post("/api/egress/hosts", async () => ({ ok: true }));
    app.get(
      "/api/mcp-servers/oauth/callback",
      { config: { crossOriginNavigation: true } },
      async () => ({ ok: true }),
    );
    app.get("/anything", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it("allows a same-origin call and reflects the origin", async () => {
    const app = await makeApp(DECLARED);
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
    const app = await makeApp(DECLARED);
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
    const app = await makeApp(DECLARED);
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

  it("lets an OAuth provider redirect the browser onto the opted-in callback", async () => {
    // The provider's redirect is a cross-site top-level navigation and is the
    // route's ONLY normal caller. The route authenticates the landing itself
    // (one-time `state`), which is why the exemption is safe.
    const app = await makeApp(DECLARED);
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/oauth/callback?code=C&state=S",
      headers: {
        host: "shipit.example.com",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("does not let the exemption become a general cross-origin hole", async () => {
    const app = await makeApp();
    // A cross-origin fetch() at the same path is not a navigation.
    const fetched = await app.inject({
      method: "GET",
      url: "/api/mcp-servers/oauth/callback?code=C&state=S",
      headers: {
        host: "shipit.example.com",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    });
    expect(fetched.statusCode).toBe(403);

    // And a route that did not opt in gets nothing from the navigation shape.
    const other = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: {
        host: "shipit.example.com",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    expect(other.statusCode).toBe(403);
    await app.close();
  });

  it("refuses an http origin when the proxy says the request arrived over https", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      headers: {
        host: "shipit.example.com",
        "x-forwarded-proto": "https",
        origin: "http://shipit.example.com",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
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
    const app = await makeApp(DECLARED);
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

  it("refuses a rebound request, which the origin comparison cannot see", async () => {
    // planning#378 — the attacker's page is served from a name they control
    // that has since re-resolved to this instance, so `Origin` and `Host` agree
    // perfectly. Every same-origin test passes; the hostname is what gives it
    // away.
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      headers: {
        host: "rebind.evil.example:4123",
        origin: "http://rebind.evil.example:4123",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().hint).toContain("SHIPIT_ALLOWED_ORIGINS");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("refuses a rebound GET, which carries no Origin at all", async () => {
    // A same-origin GET omits `Origin`, and a rebound fetch IS same-origin —
    // so `Sec-Fetch-Site` is the only thing marking it as a browser.
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "rebind.evil.example:4123", "sec-fetch-site": "same-origin" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("does not let a rebound request forge its way past on X-Forwarded-Host", async () => {
    // Same-origin requests need no preflight, so the page CAN set this header.
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      headers: {
        host: "rebind.evil.example:4123",
        "x-forwarded-host": "localhost:4123",
        "x-forwarded-proto": "https",
        origin: "http://rebind.evil.example:4123",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("leaves a non-browser caller at an unknown Host alone", async () => {
    // A reverse proxy's health check, a script, a session container's CLI: no
    // browser headers, nothing to gain from rebinding a name.
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "shipit.example.com" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("leaves non-API paths reachable at any Host, so the UI still loads", async () => {
    // The refusal must not turn into a blank page with no explanation: the SPA
    // is served, its first API call 403s with the hint, and the server logs it.
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/anything",
      headers: { host: "shipit.example.com", "sec-fetch-site": "same-origin" },
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
