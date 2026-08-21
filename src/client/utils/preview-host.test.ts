import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreviewHost, suggestWildcardHost } from "./preview-host.js";

// jsdom defaults window.location.protocol to "http:". Tests that care about the
// non-override protocol pass-through stub it explicitly.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolvePreviewHost (docs/216)", () => {
  it("returns the app host unchanged for a Cloudflare custom domain", () => {
    // tailnetPreviewHost is set, but the page isn't a .ts.net host → no override.
    expect(resolvePreviewHost("shipit.example.com", "100-64-1-2.sslip.io")).toEqual({
      host: "shipit.example.com",
      protocol: "http:",
    });
  });

  it("returns the app host unchanged when browsing sslip.io directly", () => {
    // location is already the sslip host (not .ts.net) → falls through, no override.
    expect(resolvePreviewHost("100-64-1-2.sslip.io", "100-64-1-2.sslip.io")).toEqual({
      host: "100-64-1-2.sslip.io",
      protocol: "http:",
    });
  });

  it("overrides to the sslip host (forced http:) when browsing a MagicDNS .ts.net host", () => {
    expect(resolvePreviewHost("node.tailnet.ts.net", "100-64-1-2.sslip.io")).toEqual({
      host: "100-64-1-2.sslip.io",
      protocol: "http:",
    });
  });

  it("matches .ts.net case-insensitively and strips the port before the suffix check", () => {
    expect(resolvePreviewHost("Node.Tailnet.TS.NET:8443", "100-64-1-2.sslip.io")).toEqual({
      host: "100-64-1-2.sslip.io",
      protocol: "http:",
    });
  });

  it("does not override a .ts.net host when no sslip host is advertised (fallback)", () => {
    // Forwarder not configured → tailnetPreviewHost null → previews stay on .ts.net.
    expect(resolvePreviewHost("node.tailnet.ts.net", null)).toEqual({
      host: "node.tailnet.ts.net",
      protocol: "http:",
    });
  });

  it("leaves localhost dev untouched", () => {
    expect(resolvePreviewHost("localhost:3000", null)).toEqual({
      host: "localhost:3000",
      protocol: "http:",
    });
  });

  it("VITE_API_HOST takes precedence over the tailnet override", () => {
    // Even on a .ts.net page with an advertised sslip host, the dev override wins
    // and keeps the page protocol — this is why the VPS prod image must leave
    // VITE_API_HOST unset for the override to govern previews.
    vi.stubEnv("VITE_API_HOST", "localhost:3001");
    expect(resolvePreviewHost("node.tailnet.ts.net", "100-64-1-2.sslip.io")).toEqual({
      host: "localhost:3001",
      protocol: "http:",
    });
  });
});

describe("suggestWildcardHost (docs/254-local-bind-and-tailnet-access req 8)", () => {
  it("suggests the dashed sslip.io form for a Tailscale address", () => {
    // The local-install-over-Tailscale case: the raw IP can't carry preview
    // subdomains, but its sslip.io form resolves right back to the same host.
    expect(suggestWildcardHost("100.83.12.47:4123")).toBe("100-83-12-47.sslip.io:4123");
  });

  it("suggests the dashed form for a LAN address, preserving the port", () => {
    expect(suggestWildcardHost("192.168.1.5:3000")).toBe("192-168-1-5.sslip.io:3000");
  });

  it("omits the port suffix when the host carries none", () => {
    expect(suggestWildcardHost("100.83.12.47")).toBe("100-83-12-47.sslip.io");
  });

  it("suggests nothing for loopback, which already works as localhost", () => {
    // buildSubdomainUrl normalizes 127.x to `localhost`, so previews already
    // work here — suggesting sslip.io would be a downgrade, not a fix.
    expect(suggestWildcardHost("127.0.0.1:4123")).toBeNull();
  });

  it("suggests nothing for a host that already works", () => {
    expect(suggestWildcardHost("shipit.example.com")).toBeNull();
    expect(suggestWildcardHost("localhost:4123")).toBeNull();
  });

  it("suggests nothing for IPv6 literals, which have no one-step fix", () => {
    // Not a claim that IPv6 is unfixable — sslip.io serves dashed IPv6 names too.
    // It is out of scope (see the helper docstring), and this pins that choice so
    // a future change to it is deliberate rather than accidental.
    expect(suggestWildcardHost("[2001:db8::1]:4123")).toBeNull();
    expect(suggestWildcardHost("[::1]:4123")).toBeNull();
  });

  it("rejects dotted-quad lookalikes rather than emitting a bogus host", () => {
    // Four numeric octets shaped like an IP but out of range — a hostname, not an
    // address, so the sslip.io mapping wouldn't resolve to anything.
    expect(suggestWildcardHost("999.1.1.1:4123")).toBeNull();
  });
});
