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
import { buildUpstreamHeaders } from "./preview-proxy.js";

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
