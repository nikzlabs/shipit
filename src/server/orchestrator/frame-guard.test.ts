import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorApp, serveStaticClient } from "./app-assembly.js";
import { markPreviewProxyRegistered } from "./api-origin-guard.js";

describe("frame guard on the served app", () => {
  let clientDir: string;

  beforeEach(() => {
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-frame-guard-"));
    fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><html></html>");
  });

  afterEach(() => {
    fs.rmSync(clientDir, { recursive: true, force: true });
  });

  it("refuses framing of the SPA shell — the document a clickjack would frame", async () => {
    const app = await createOrchestratorApp(undefined, "containerized");
    await serveStaticClient(app, clientDir, true);

    for (const url of ["/index.html", "/session/anything"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }

    await app.close();
  });

  it("refuses framing of API responses; the origin guard's own 403 short-circuits ahead of it", async () => {
    const app = await createOrchestratorApp(
      { extraOrigins: [], devClientPort: null },
      "containerized",
    );
    app.get("/api/thing", async () => ({ ok: true }));

    const ok = await app.inject({ method: "GET", url: "/api/thing" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-security-policy"]).toBe("frame-ancestors 'none'");

    const refused = await app.inject({
      method: "GET",
      url: "/api/thing",
      headers: { host: "shipit.example.com", origin: "https://evil.example" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.headers["x-frame-options"]).toBeUndefined();

    await app.close();
  });

  it("sends nothing in local mode, so the outer instance can frame the dogfood UI", async () => {
    const app = await createOrchestratorApp(undefined, "local");
    await serveStaticClient(app, clientDir, true);

    const res = await app.inject({ method: "GET", url: "/index.html" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.headers["x-frame-options"]).toBeUndefined();

    await app.close();
  });

  it("leaves preview responses alone — the preview pane frames those on purpose", async () => {
    const app = await createOrchestratorApp(undefined, "containerized");
    markPreviewProxyRegistered(app);
    app.get("/anything", async () => ({ ok: true }));

    const preview = await app.inject({
      method: "GET",
      url: "/anything",
      headers: { host: "11111111-2222-3333-4444-555555555555--5173.shipit.example.com" },
    });
    expect(preview.headers["content-security-policy"]).toBeUndefined();
    expect(preview.headers["x-frame-options"]).toBeUndefined();

    await app.close();
  });

  it("does not let a forged preview Host opt a runtime WITHOUT the proxy out of the header", async () => {
    const app = await createOrchestratorApp(undefined, "containerized");
    app.get("/anything", async () => ({ ok: true }));

    const forged = await app.inject({
      method: "GET",
      url: "/anything",
      headers: { host: "11111111-2222-3333-4444-555555555555--5173.shipit.example.com" },
    });
    expect(forged.headers["x-frame-options"]).toBe("DENY");

    await app.close();
  });
});
