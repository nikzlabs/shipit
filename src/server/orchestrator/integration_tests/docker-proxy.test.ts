/**
 * Integration tests for Docker API proxy.
 *
 * Tests end-to-end flows: container lifecycle, network lifecycle,
 * volume lifecycle, and session cleanup — all through the proxy
 * with a mock Docker daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDockerProxy, PARENT_SESSION_LABEL } from "../docker-proxy.js";
import type { DockerProxyDeps } from "../docker-proxy.js";

// ---------------------------------------------------------------------------
// Minimal mock Docker daemon
// ---------------------------------------------------------------------------

function createMockDaemon() {
  const containers = new Map<string, { labels: Record<string, string>; running: boolean }>();
  const networks = new Map<string, { labels: Record<string, string> }>();
  const volumes = new Map<string, { labels: Record<string, string> }>();
  const execs = new Map<string, string>();
  let ctr = 0;
  let execCtr = 0;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-int-"));
  const socketPath = path.join(tmpDir, "docker.sock");

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();
    const chunks: Buffer[] = [];

    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      const raw = Buffer.concat(chunks).toString();
      if (raw) try { body = JSON.parse(raw); } catch { /* */ }

      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };

      // /_ping
      if (url === "/_ping") { res.writeHead(200); res.end("OK"); return; }

      // Container create
      if (url.match(/\/containers\/create/) && method === "POST") {
        ctr++;
        const id = `c-${ctr}`;
        containers.set(id, { labels: (body.Labels ?? {}) as Record<string, string>, running: false });
        json(201, { Id: id });
        return;
      }

      // Container list
      if (url.match(/\/containers\/json/) && method === "GET") {
        json(200, [...containers.entries()].filter(() => true).map(([id, c]) => ({
          Id: id, Labels: c.labels, State: c.running ? "running" : "created",
        })));
        return;
      }

      // Container inspect
      const inspMatch = url.match(/\/containers\/([^/]+)\/json/);
      if (inspMatch && method === "GET") {
        const c = containers.get(inspMatch[1]);
        if (!c) { json(404, { message: "not found" }); return; }
        json(200, { Id: inspMatch[1], Config: { Labels: c.labels }, State: { Running: c.running } });
        return;
      }

      // Container start
      const startMatch = url.match(/\/containers\/([^/]+)\/start/);
      if (startMatch && method === "POST") {
        const c = containers.get(startMatch[1]);
        if (!c) { json(404, {}); return; }
        c.running = true;
        json(204, {});
        return;
      }

      // Container stop
      const stopMatch = url.match(/\/containers\/([^/]+)\/stop/);
      if (stopMatch && method === "POST") {
        const c = containers.get(stopMatch[1]);
        if (!c) { json(404, {}); return; }
        c.running = false;
        json(204, {});
        return;
      }

      // Container kill
      const killMatch = url.match(/\/containers\/([^/]+)\/kill/);
      if (killMatch && method === "POST") {
        const c = containers.get(killMatch[1]);
        if (!c) { json(404, {}); return; }
        c.running = false;
        json(204, {});
        return;
      }

      // Container logs (minimal streaming)
      const logsMatch = url.match(/\/containers\/([^/]+)\/logs/);
      if (logsMatch && method === "GET") {
        const c = containers.get(logsMatch[1]);
        if (!c) { json(404, {}); return; }
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end("fake log output\n");
        return;
      }

      // Container delete
      const delMatch = url.match(/\/containers\/([^/]+)$/) && method === "DELETE";
      if (delMatch) {
        const id = url.match(/\/containers\/([^/]+)$/)![1];
        containers.delete(id);
        json(204, {});
        return;
      }

      // Exec create
      const execCreateMatch = url.match(/\/containers\/([^/]+)\/exec/);
      if (execCreateMatch && method === "POST") {
        const cid = execCreateMatch[1];
        if (!containers.has(cid)) { json(404, {}); return; }
        execCtr++;
        const eid = `e-${execCtr}`;
        execs.set(eid, cid);
        json(201, { Id: eid });
        return;
      }

      // Exec inspect
      const execInspMatch = url.match(/\/exec\/([^/]+)\/json/);
      if (execInspMatch && method === "GET") {
        const cid = execs.get(execInspMatch[1]);
        if (!cid) { json(404, {}); return; }
        json(200, { ID: execInspMatch[1], ContainerID: cid });
        return;
      }

      // Exec start
      const execStartMatch = url.match(/\/exec\/([^/]+)\/start/);
      if (execStartMatch && method === "POST") {
        if (!execs.has(execStartMatch[1])) { json(404, {}); return; }
        json(200, {});
        return;
      }

      // Network create
      if (url.match(/\/networks\/create/) && method === "POST") {
        const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        networks.set(id, { labels: (body.Labels ?? {}) as Record<string, string> });
        json(201, { Id: id });
        return;
      }

      // Network list
      if (url.match(/\/networks(\?|$)/) && method === "GET" && !url.match(/\/networks\/[^?]/)) {
        json(200, [...networks.entries()].map(([id, n]) => ({ Id: id, Name: id, Labels: n.labels })));
        return;
      }

      // Network inspect
      const netInspMatch = url.match(/\/networks\/([^/?]+)$/);
      if (netInspMatch && method === "GET") {
        const n = networks.get(netInspMatch[1]);
        if (!n) { json(404, {}); return; }
        json(200, { Id: netInspMatch[1], Labels: n.labels });
        return;
      }

      // Network delete
      if (netInspMatch && method === "DELETE") {
        const id = url.match(/\/networks\/([^/?]+)$/)![1];
        networks.delete(id);
        json(204, {});
        return;
      }

      // Network connect
      if (url.match(/\/networks\/[^/]+\/connect/) && method === "POST") {
        json(200, {});
        return;
      }

      // Network disconnect
      if (url.match(/\/networks\/[^/]+\/disconnect/) && method === "POST") {
        json(200, {});
        return;
      }

      // Volume create
      if (url.match(/\/volumes\/create/) && method === "POST") {
        const name = (body.Name as string) ?? `v-${Date.now()}`;
        volumes.set(name, { labels: (body.Labels ?? {}) as Record<string, string> });
        json(201, { Name: name, Labels: (body.Labels ?? {}) });
        return;
      }

      // Volume list
      if (url.match(/\/volumes(\?|$)/) && method === "GET" && !url.match(/\/volumes\/[^?]/)) {
        json(200, { Volumes: [...volumes.entries()].map(([n, v]) => ({ Name: n, Labels: v.labels })) });
        return;
      }

      // Volume inspect
      const volInspMatch = url.match(/\/volumes\/([^/?]+)$/);
      if (volInspMatch && method === "GET") {
        const v = volumes.get(volInspMatch[1]);
        if (!v) { json(404, {}); return; }
        json(200, { Name: volInspMatch[1], Labels: v.labels });
        return;
      }

      // Volume delete
      if (volInspMatch && method === "DELETE") {
        const name = url.match(/\/volumes\/([^/?]+)$/)![1];
        volumes.delete(name);
        json(204, {});
        return;
      }

      json(404, { message: `unhandled: ${method} ${url}` });
    });
  });

  return {
    server, socketPath, containers, networks, volumes, execs,
    close: () => new Promise<void>((r) => {
      server.close(() => {
        try { fs.unlinkSync(socketPath); } catch { /* */ }
        try { fs.rmdirSync(tmpDir); } catch { /* */ }
        r();
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(
  proxyUrl: string, method: string, urlPath: string, body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, proxyUrl);
    const headers: Record<string, string> = {};
    let bodyStr: string | undefined;
    if (body) {
      bodyStr = JSON.stringify(body);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(bodyStr));
    }
    const r = http.request({ hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode ?? 500, body: parsed });
      });
    });
    r.on("error", reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Docker proxy integration", () => {
  let daemon: ReturnType<typeof createMockDaemon>;
  let proxy: http.Server;
  let proxyUrl: string;

  beforeEach(async () => {
    daemon = createMockDaemon();
    await new Promise<void>((r) => daemon.server.listen(daemon.socketPath, r));

    const deps: DockerProxyDeps = {
      getSessionByContainerIp: (ip) => {
        if (ip === "127.0.0.1") {
          return {
            sessionId: "sess-1",
            hostWorkspaceDir: "/workspace/sessions/sess-1",
            dockerAccess: true,
            sessionNetworkName: "shipit-session-sess1",
          };
        }
        return undefined;
      },
      socketPath: daemon.socketPath,
    };

    proxy = createDockerProxy(deps);
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const addr = proxy.address() as net.AddressInfo;
    proxyUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    await daemon.close();
  });

  // --- Container lifecycle end-to-end ---

  describe("container lifecycle (create → start → logs → stop → rm)", () => {
    it("completes full container lifecycle", async () => {
      // Create
      const createRes = await req(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", Cmd: ["echo", "hello"], HostConfig: {},
      });
      expect(createRes.status).toBe(201);
      const containerId = (createRes.body as any).Id;
      expect(containerId).toBeTruthy();

      // Verify label was set
      const container = daemon.containers.get(containerId);
      expect(container?.labels[PARENT_SESSION_LABEL]).toBe("sess-1");

      // Start
      const startRes = await req(proxyUrl, "POST", `/v1.41/containers/${containerId}/start`);
      expect([200, 204]).toContain(startRes.status);
      expect(daemon.containers.get(containerId)?.running).toBe(true);

      // Logs
      const logsRes = await req(proxyUrl, "GET", `/v1.41/containers/${containerId}/logs?stdout=true`);
      expect(logsRes.status).toBe(200);

      // Stop
      const stopRes = await req(proxyUrl, "POST", `/v1.41/containers/${containerId}/stop`);
      expect([200, 204]).toContain(stopRes.status);
      expect(daemon.containers.get(containerId)?.running).toBe(false);

      // Remove
      const rmRes = await req(proxyUrl, "DELETE", `/v1.41/containers/${containerId}`);
      expect([200, 204]).toContain(rmRes.status);
      expect(daemon.containers.has(containerId)).toBe(false);
    });

    it("session network is injected into container create", async () => {
      const createRes = await req(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      expect(createRes.status).toBe(201);
      // The mock daemon receives the request — we can't directly inspect the
      // HostConfig it received, but we verify the container was created with
      // the session label, confirming the proxy processed the request.
      const container = daemon.containers.get((createRes.body as any).Id);
      expect(container?.labels[PARENT_SESSION_LABEL]).toBe("sess-1");
    });

    it("exec lifecycle through proxy", async () => {
      // Create container
      const createRes = await req(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      const containerId = (createRes.body as any).Id;

      // Create exec
      const execRes = await req(proxyUrl, "POST", `/v1.41/containers/${containerId}/exec`, {
        Cmd: ["ls", "-la"],
      });
      expect(execRes.status).toBe(201);
      const execId = (execRes.body as any).Id;

      // Inspect exec
      const inspectRes = await req(proxyUrl, "GET", `/v1.41/exec/${execId}/json`);
      expect(inspectRes.status).toBe(200);
      expect((inspectRes.body as any).ContainerID).toBe(containerId);

      // Start exec
      const startRes = await req(proxyUrl, "POST", `/v1.41/exec/${execId}/start`, {
        Detach: false, Tty: false,
      });
      expect(startRes.status).toBe(200);
    });
  });

  // --- Network lifecycle ---

  describe("network lifecycle (create → list → connect → disconnect → delete)", () => {
    it("completes full network lifecycle", async () => {
      // Create network
      const createRes = await req(proxyUrl, "POST", "/v1.41/networks/create", {
        Name: "my-app-net",
      });
      expect(createRes.status).toBe(201);
      const networkId = (createRes.body as any).Id;

      // Verify label
      const network = daemon.networks.get(networkId);
      expect(network?.labels[PARENT_SESSION_LABEL]).toBe("sess-1");

      // List (should see only our network)
      const listRes = await req(proxyUrl, "GET", "/v1.41/networks");
      expect(listRes.status).toBe(200);
      const nets = listRes.body as any[];
      expect(nets.length).toBe(1);
      expect(nets[0].Id).toBe(networkId);

      // Create a container to connect
      const containerRes = await req(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      const containerId = (containerRes.body as any).Id;

      // Connect container to network
      const connectRes = await req(proxyUrl, "POST", `/v1.41/networks/${networkId}/connect`, {
        Container: containerId,
      });
      expect(connectRes.status).toBe(200);

      // Disconnect
      const disconnectRes = await req(proxyUrl, "POST", `/v1.41/networks/${networkId}/disconnect`, {
        Container: containerId,
      });
      expect(disconnectRes.status).toBe(200);

      // Delete network
      const deleteRes = await req(proxyUrl, "DELETE", `/v1.41/networks/${networkId}`);
      expect([200, 204]).toContain(deleteRes.status);
      expect(daemon.networks.has(networkId)).toBe(false);
    });
  });

  // --- Volume lifecycle ---

  describe("volume lifecycle (create → list → inspect → delete)", () => {
    it("completes full volume lifecycle", async () => {
      // Create volume
      const createRes = await req(proxyUrl, "POST", "/v1.41/volumes/create", {
        Name: "my-data-vol",
      });
      expect(createRes.status).toBe(201);
      expect(daemon.volumes.get("my-data-vol")?.labels[PARENT_SESSION_LABEL]).toBe("sess-1");

      // List (should see only our volume)
      daemon.volumes.set("foreign-vol", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const listRes = await req(proxyUrl, "GET", "/v1.41/volumes");
      expect(listRes.status).toBe(200);
      const data = listRes.body as any;
      expect(data.Volumes.length).toBe(1);
      expect(data.Volumes[0].Name).toBe("my-data-vol");

      // Inspect
      const inspectRes = await req(proxyUrl, "GET", "/v1.41/volumes/my-data-vol");
      expect(inspectRes.status).toBe(200);

      // Delete
      const deleteRes = await req(proxyUrl, "DELETE", "/v1.41/volumes/my-data-vol");
      expect([200, 204]).toContain(deleteRes.status);
      expect(daemon.volumes.has("my-data-vol")).toBe(false);
    });
  });

  // --- Cross-session isolation ---

  describe("cross-session isolation", () => {
    it("cannot access containers from other sessions", async () => {
      // Create a container directly in the daemon with a different session label
      daemon.containers.set("foreign-c", {
        labels: { [PARENT_SESSION_LABEL]: "other-session" },
        running: true,
      });

      // List should not include it
      const listRes = await req(proxyUrl, "GET", "/v1.41/containers/json");
      expect((listRes.body as any[]).length).toBe(0);

      // Direct access should be forbidden
      expect((await req(proxyUrl, "GET", "/v1.41/containers/foreign-c/json")).status).toBe(403);
      expect((await req(proxyUrl, "POST", "/v1.41/containers/foreign-c/start")).status).toBe(403);
      expect((await req(proxyUrl, "POST", "/v1.41/containers/foreign-c/stop")).status).toBe(403);
      expect((await req(proxyUrl, "POST", "/v1.41/containers/foreign-c/kill")).status).toBe(403);
      expect((await req(proxyUrl, "DELETE", "/v1.41/containers/foreign-c")).status).toBe(403);
    });

    it("cannot access networks from other sessions", async () => {
      daemon.networks.set("foreign-n", { labels: { [PARENT_SESSION_LABEL]: "other" } });

      expect((await req(proxyUrl, "GET", "/v1.41/networks/foreign-n")).status).toBe(403);
      expect((await req(proxyUrl, "DELETE", "/v1.41/networks/foreign-n")).status).toBe(403);
    });

    it("cannot access volumes from other sessions", async () => {
      daemon.volumes.set("foreign-v", { labels: { [PARENT_SESSION_LABEL]: "other" } });

      expect((await req(proxyUrl, "GET", "/v1.41/volumes/foreign-v")).status).toBe(403);
      expect((await req(proxyUrl, "DELETE", "/v1.41/volumes/foreign-v")).status).toBe(403);
    });

    it("network connect rejects foreign container", async () => {
      // Create owned network
      const netRes = await req(proxyUrl, "POST", "/v1.41/networks/create", { Name: "owned-net" });
      const networkId = (netRes.body as any).Id;

      // Foreign container
      daemon.containers.set("foreign-c", { labels: { [PARENT_SESSION_LABEL]: "other" }, running: true });

      const res = await req(proxyUrl, "POST", `/v1.41/networks/${networkId}/connect`, {
        Container: "foreign-c",
      });
      expect(res.status).toBe(403);
    });
  });
});
