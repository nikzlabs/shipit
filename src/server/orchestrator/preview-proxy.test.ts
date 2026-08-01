/**
 * Unit tests for `buildUpstreamHeaders` — the forwarded-header logic that lets
 * the preview proxy hand the upstream a loopback `Host` while still telling
 * frameworks (Gradio, etc.) the browser-facing host so they compute a public
 * root URL the browser can actually reach.
 *
 * Regression guard for the "Gradio preview calls localhost:7860 and fails with
 * ERR_CONNECTION_REFUSED" bug.
 */

import { describe, it, expect } from "vitest";
import { AGENT_INTERFACE_SDK_MARKER } from "../shared/agent-interface-sdk/bootstrap.js";
import { allowPreviewBootstrapInCsp, buildUpstreamHeaders, injectPreviewBootstrap } from "./preview-proxy.js";

describe("buildUpstreamHeaders", () => {
  it("rewrites Host to loopback for the upstream", () => {
    const out = buildUpstreamHeaders(
      { host: "abc--7860.localhost:3001" },
      7860,
    );
    expect(out.host).toBe("localhost:7860");
  });

  it("preserves the browser-facing host in X-Forwarded-Host", () => {
    const out = buildUpstreamHeaders(
      { host: "abc--7860.localhost:3001" },
      7860,
    );
    // Gradio derives its public root URL from this; without it the frontend
    // would call localhost:7860 (the user's machine in a browser session).
    expect(out["x-forwarded-host"]).toBe("abc--7860.localhost:3001");
  });

  it("defaults X-Forwarded-Proto to http when none is present", () => {
    const out = buildUpstreamHeaders({ host: "abc--7860.localhost:3001" }, 7860);
    expect(out["x-forwarded-proto"]).toBe("http");
  });

  it("does not downgrade an upstream-provided https proto", () => {
    const out = buildUpstreamHeaders(
      {
        host: "localhost:3001",
        "x-forwarded-host": "preview.shipit.example.com",
        "x-forwarded-proto": "https",
      },
      7860,
    );
    // An ingress that terminated TLS already set these — they must win so
    // Gradio emits https:// URLs and the browser doesn't hit mixed content.
    expect(out["x-forwarded-proto"]).toBe("https");
    expect(out["x-forwarded-host"]).toBe("preview.shipit.example.com");
    expect(out.host).toBe("localhost:7860");
  });

  it("omits X-Forwarded-Host when there is no host to forward", () => {
    const out = buildUpstreamHeaders({}, 7860);
    expect(out["x-forwarded-host"]).toBeUndefined();
    expect(out.host).toBe("localhost:7860");
  });

  it("leaves other headers untouched", () => {
    const out = buildUpstreamHeaders(
      { host: "abc--7860.localhost:3001", "user-agent": "test", cookie: "a=b" },
      7860,
    );
    expect(out["user-agent"]).toBe("test");
    expect(out.cookie).toBe("a=b");
  });
});

describe("injectPreviewBootstrap", () => {
  it("injects the shared SDK immediately after head", () => {
    const html = injectPreviewBootstrap("<!doctype html><html><head><title>App</title></head></html>");
    expect(html).toContain(`<head><script>`);
    expect(html).toContain(AGENT_INTERFACE_SDK_MARKER);
    expect(html.indexOf(AGENT_INTERFACE_SDK_MARKER)).toBeLessThan(html.indexOf("<title>"));
  });

  it("prepends scripts when HTML has no head", () => {
    expect(injectPreviewBootstrap("<main>App</main>")).toMatch(/^<script>/);
  });

  it("does not inject a second SDK into an already-instrumented document", () => {
    const once = injectPreviewBootstrap("<html><head></head></html>");
    const twice = injectPreviewBootstrap(once);
    expect(twice.split(AGENT_INTERFACE_SDK_MARKER)).toHaveLength(2);
  });
});

describe("allowPreviewBootstrapInCsp", () => {
  it("replaces script-src none with exact injected-script hashes", () => {
    const result = allowPreviewBootstrapInCsp("default-src 'self'; script-src 'none'; connect-src 'self'");
    expect(result).not.toContain("script-src 'none'");
    expect(result.match(/'sha256-[^']+'/g)).toHaveLength(2);
    expect(result).toContain("connect-src 'self'");
  });

  it("adds a script directive when only default-src exists", () => {
    expect(allowPreviewBootstrapInCsp("default-src 'none'")).toMatch(/script-src 'sha256-/);
  });
});
