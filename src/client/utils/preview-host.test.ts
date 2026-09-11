import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreviewHost, suggestWildcardHost } from "./preview-host.js";

// jsdom defaults window.location.protocol to "http:". Tests that care about the
// non-override protocol pass-through stub it explicitly.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolvePreviewHost (docs/216)", () => {
  it("returns the app host unchanged for a Cloudflare custom domain", () => {

    expect(resolvePreviewHost("shipit.example.com", "100-64-1-2.sslip.io")).toEqual({
      host: "shipit.example.com",
      protocol: "http:",
    });
  });

  it("returns the app host unchanged when browsing sslip.io directly", () => {

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

    // and keeps the page protocol — this is why the VPS prod image must leave

    vi.stubEnv("VITE_API_HOST", "localhost:3001");
    expect(resolvePreviewHost("node.tailnet.ts.net", "100-64-1-2.sslip.io")).toEqual({
      host: "localhost:3001",
      protocol: "http:",
    });
  });
});

describe("suggestWildcardHost (docs/254-local-bind-and-tailnet-access req 8)", () => {
  it("suggests the dashed sslip.io form for a Tailscale address", () => {

    expect(suggestWildcardHost("100.83.12.47:4123")).toBe("100-83-12-47.sslip.io:4123");
  });

  it("suggests the dashed form for a LAN address, preserving the port", () => {
    expect(suggestWildcardHost("192.168.1.5:3000")).toBe("192-168-1-5.sslip.io:3000");
  });

  it("omits the port suffix when the host carries none", () => {
    expect(suggestWildcardHost("100.83.12.47")).toBe("100-83-12-47.sslip.io");
  });

  it("suggests nothing for loopback, which already works as localhost", () => {

    expect(suggestWildcardHost("127.0.0.1:4123")).toBeNull();
  });

  it("suggests nothing for a host that already works", () => {
    expect(suggestWildcardHost("shipit.example.com")).toBeNull();
    expect(suggestWildcardHost("localhost:4123")).toBeNull();
  });

  it("suggests nothing for IPv6 literals, which have no one-step fix", () => {

    expect(suggestWildcardHost("[2001:db8::1]:4123")).toBeNull();
    expect(suggestWildcardHost("[::1]:4123")).toBeNull();
  });

  it("rejects dotted-quad lookalikes rather than emitting a bogus host", () => {

    expect(suggestWildcardHost("999.1.1.1:4123")).toBeNull();
  });
});
