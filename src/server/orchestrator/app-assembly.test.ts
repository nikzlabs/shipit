import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestratorApp, serveStaticClient } from "./app-assembly.js";

describe("serveStaticClient cache headers", () => {
  let clientDir: string;

  beforeEach(() => {
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-client-"));
    fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><html></html>");
    fs.writeFileSync(path.join(clientDir, "service-worker.js"), "self.addEventListener('fetch',()=>{});");
    fs.mkdirSync(path.join(clientDir, "assets"));
    fs.writeFileSync(path.join(clientDir, "assets", "index-abc123.js"), "console.log(1)");
  });

  afterEach(() => {
    fs.rmSync(clientDir, { recursive: true, force: true });
  });

  it("serves index.html and the service worker with no-store", async () => {
    const app = await createOrchestratorApp();
    await serveStaticClient(app, clientDir, true);

    const html = await app.inject({ method: "GET", url: "/index.html" });
    expect(html.statusCode).toBe(200);
    expect(html.headers["cache-control"]).toContain("no-store");

    const sw = await app.inject({ method: "GET", url: "/service-worker.js" });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers["cache-control"]).toContain("no-store");

    await app.close();
  });

  it("applies no-store to the SPA fallback shell", async () => {
    const app = await createOrchestratorApp();
    await serveStaticClient(app, clientDir, true);

    const spa = await app.inject({ method: "GET", url: "/session/anything" });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers["cache-control"]).toContain("no-store");

    await app.close();
  });

  it("does not force no-store on hashed assets", async () => {
    const app = await createOrchestratorApp();
    await serveStaticClient(app, clientDir, true);

    const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"] ?? "").not.toContain("no-store");

    await app.close();
  });
});
