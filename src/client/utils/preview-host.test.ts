import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreviewHost } from "./preview-host.js";

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
