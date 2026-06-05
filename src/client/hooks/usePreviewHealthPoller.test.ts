import { describe, expect, it } from "vitest";
import { buildSubdomainUrl, computePreviewUrl } from "./usePreviewHealthPoller.js";
import type { PreviewStatus } from "../components/PreviewFrame.js";

const preview: PreviewStatus = {
  running: true,
  port: 3000,
  url: "/preview/session-a/3000/",
  source: "detected",
};

describe("buildSubdomainUrl", () => {
  it("builds preview subdomains for localhost", () => {
    expect(buildSubdomainUrl("session-a", 3000, "localhost:3001")).toBe(
      "http://session-a--3000.localhost:3001/",
    );
  });

  it("builds preview subdomains for regular DNS hosts", () => {
    expect(buildSubdomainUrl("session-a", 3000, "shipit.example.com")).toBe(
      "http://session-a--3000.shipit.example.com/",
    );
  });

  it("builds subdomains for dotless and Tailscale hosts (no auto/always mode anymore)", () => {
    // The `auto`/`always` mode was removed (docs/175): subdomain routing is the
    // only container-preview path, so these hosts always get a subdomain URL.
    // Whether it resolves is the deployment's wildcard-DNS responsibility — e.g.
    // Tailscale's `dns-subdomain-resolve` MagicDNS capability.
    expect(buildSubdomainUrl("session-a", 3000, "shipit:4123")).toBe(
      "http://session-a--3000.shipit:4123/",
    );
    expect(buildSubdomainUrl("session-a", 3000, "shipit.tailnet.ts.net")).toBe(
      "http://session-a--3000.shipit.tailnet.ts.net/",
    );
    expect(buildSubdomainUrl("session-a", 3000, "shipit.tailnet.beta.tailscale.net")).toBe(
      "http://session-a--3000.shipit.tailnet.beta.tailscale.net/",
    );
  });

  it("returns null for raw IPv4 hosts that cannot carry a wildcard subdomain", () => {
    expect(buildSubdomainUrl("session-a", 3000, "100.64.1.2:4123")).toBeNull();
    expect(buildSubdomainUrl("session-a", 3000, "192.168.1.5:3000")).toBeNull();
  });

  it("returns null for non-loopback IPv6 literal hosts (bracketed form)", () => {
    // window.location.host gives IPv6 bracketed: "[2001:db8::1]:8080".
    // Must be null (not a mangled "[2001:db8…" hostname) so the empty-state fires.
    expect(buildSubdomainUrl("session-a", 3000, "[2001:db8::1]:8080")).toBeNull();
    expect(buildSubdomainUrl("session-a", 3000, "[fe80::1]")).toBeNull();
  });

  it("normalizes loopback IPs to localhost rather than rejecting them", () => {
    expect(buildSubdomainUrl("session-a", 3000, "127.0.0.1:3001")).toBe(
      "http://session-a--3000.localhost:3001/",
    );
    // IPv6 loopback, the bracketed form the browser actually reports.
    expect(buildSubdomainUrl("session-a", 3000, "[::1]:3000")).toBe(
      "http://session-a--3000.localhost:3000/",
    );
    expect(buildSubdomainUrl("session-a", 3000, "[::1]")).toBe(
      "http://session-a--3000.localhost/",
    );
  });
});

describe("computePreviewUrl", () => {
  it("returns the subdomain URL for a container preview on a resolvable host", () => {
    expect(computePreviewUrl("session-a", 3000, preview, "shipit:4123")).toEqual({
      url: "http://session-a--3000.shipit:4123/",
      containerMode: true,
    });
  });

  it("returns null for a container preview when no subdomain can be built (raw-IP host)", () => {
    // null = "no working preview URL for this host" → PreviewFrame shows the
    // empty-state instead of rendering a broken iframe.
    expect(computePreviewUrl("session-a", 3000, preview, "192.168.1.5:4123")).toBeNull();
    expect(computePreviewUrl("session-a", 3000, preview, "[2001:db8::1]:8080")).toBeNull();
  });

  it("uses http://localhost:<port> for a non-container (in-process) preview", () => {
    const local: PreviewStatus = { running: true, port: 5173, url: "http://localhost:5173", source: "vite" };
    expect(computePreviewUrl("session-a", 5173, local, "localhost:3001")).toEqual({
      url: "http://localhost:5173",
      containerMode: false,
    });
  });

  it("returns null when the preview is not running", () => {
    expect(computePreviewUrl("session-a", 3000, { ...preview, running: false }, "localhost:3001")).toBeNull();
  });
});
