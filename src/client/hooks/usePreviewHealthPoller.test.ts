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

  it("falls back for raw IP, MagicDNS, and Tailscale HTTPS names", () => {
    expect(buildSubdomainUrl("session-a", 3000, "100.64.1.2:4123")).toBeNull();
    expect(buildSubdomainUrl("session-a", 3000, "shipit:4123")).toBeNull();
    expect(buildSubdomainUrl("session-a", 3000, "shipit.tailnet.ts.net")).toBeNull();
    expect(buildSubdomainUrl("session-a", 3000, "shipit.tailnet.beta.tailscale.net")).toBeNull();
  });

  it("forces preview subdomains for MagicDNS and Tailscale HTTPS names when configured", () => {
    expect(buildSubdomainUrl("session-a", 3000, "shipit:4123", "always")).toBe(
      "http://session-a--3000.shipit:4123/",
    );
    expect(buildSubdomainUrl("session-a", 3000, "shipit.tailnet.ts.net", "always")).toBe(
      "http://session-a--3000.shipit.tailnet.ts.net/",
    );
  });
});

describe("computePreviewUrl", () => {
  it("uses the path proxy when preview subdomains are not resolvable", () => {
    expect(computePreviewUrl("session-a", 3000, preview, "shipit:4123")).toEqual({
      url: "/preview/session-a/3000/",
      containerMode: true,
    });
  });

  it("uses forced preview subdomains when configured", () => {
    expect(computePreviewUrl("session-a", 3000, preview, "shipit:4123", "always")).toEqual({
      url: "http://session-a--3000.shipit:4123/",
      containerMode: true,
    });
  });
});
