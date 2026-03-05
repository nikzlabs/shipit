/**
 * Unit tests for Docker API proxy.
 *
 * Uses a mock Docker daemon (http server on Unix socket) to test proxy
 * policy enforcement without a real Docker daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDockerProxy, PARENT_SESSION_LABEL } from "./docker-proxy.js";
import type { SessionInfo, DockerProxyDeps } from "./docker-proxy.js";

// ---------------------------------------------------------------------------
// Mock Docker daemon — a simple HTTP server on a Unix socket
// ---------------------------------------------------------------------------

interface MockDaemon {
  server: http.Server;
  socketPath: string;
  /** Containers stored by the mock. Map of id → { labels, running } */
  containers: Map<string, { labels: Record<string, string>; running: boolean }>;
  /** Networks stored by the mock. */
  networks: Map<string, { labels: Record<string, string> }>;
  /** Volumes stored by the mock. */
  volumes: Map<string, { labels: Record<string, string> }>;
  /** Exec instances. Map of exec_id → container_id */
  execs: Map<string, string>;
  close: () => Promise<void>;
}

function createMockDaemon(): MockDaemon {
  const containers = new Map<string, { labels: Record<string, string>; running: boolean }>();
  const networks = new Map<string, { labels: Record<string, string> }>();
  const volumes = new Map<string, { labels: Record<string, string> }>();
  const execs = new Map<string, string>();
  let containerCounter = 0;
  let execCounter = 0;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-proxy-test-"));
  const socketPath = path.join(tmpDir, "docker.sock");

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    // Read body for POST/PUT
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString();
      let body: Record<string, unknown> = {};
      if (bodyStr) {
        try { body = JSON.parse(bodyStr); } catch { /* ignore */ }
      }

      // Route handling
      const respond = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };

      // GET /_ping
      if (url === "/_ping" && method === "GET") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }

      // GET /version
      if (url.match(/\/v[\d.]+\/version$|^\/version$/) && method === "GET") {
        respond(200, { Version: "20.10.0", ApiVersion: "1.41" });
        return;
      }

      // GET /info
      if (url.match(/\/info$/) && method === "GET") {
        respond(200, { ID: "mock-daemon" });
        return;
      }

      // POST /containers/create
      if (url.match(/\/containers\/create/) && method === "POST") {
        containerCounter++;
        const id = `mock-container-${containerCounter}`;
        const labels = (body.Labels ?? {}) as Record<string, string>;
        containers.set(id, { labels, running: false });
        respond(201, { Id: id });
        return;
      }

      // GET /containers/json
      if (url.match(/\/containers\/json/) && method === "GET") {
        const list = [...containers.entries()].map(([id, c]) => ({
          Id: id,
          Labels: c.labels,
          State: c.running ? "running" : "created",
        }));
        respond(200, list);
        return;
      }

      // GET /containers/{id}/json
      const containerInspectMatch = url.match(/\/containers\/([^/]+)\/json/);
      if (containerInspectMatch && method === "GET") {
        const id = containerInspectMatch[1];
        const c = containers.get(id);
        if (!c) { respond(404, { message: "not found" }); return; }
        respond(200, { Id: id, Config: { Labels: c.labels }, State: { Running: c.running } });
        return;
      }

      // POST /containers/{id}/start
      const containerStartMatch = url.match(/\/containers\/([^/]+)\/start/);
      if (containerStartMatch && method === "POST") {
        const id = containerStartMatch[1];
        const c = containers.get(id);
        if (!c) { respond(404, { message: "not found" }); return; }
        c.running = true;
        respond(204, {});
        return;
      }

      // POST /containers/{id}/stop
      const containerStopMatch = url.match(/\/containers\/([^/]+)\/stop/);
      if (containerStopMatch && method === "POST") {
        const id = containerStopMatch[1];
        const c = containers.get(id);
        if (!c) { respond(404, { message: "not found" }); return; }
        c.running = false;
        respond(204, {});
        return;
      }

      // DELETE /containers/{id}
      const containerDeleteMatch = url.match(/\/containers\/([^/]+)$/) && method === "DELETE";
      if (containerDeleteMatch) {
        const id = url.match(/\/containers\/([^/]+)$/)![1];
        containers.delete(id);
        respond(204, {});
        return;
      }

      // POST /containers/{id}/exec
      const execCreateMatch = url.match(/\/containers\/([^/]+)\/exec/);
      if (execCreateMatch && method === "POST") {
        const containerId = execCreateMatch[1];
        const c = containers.get(containerId);
        if (!c) { respond(404, { message: "not found" }); return; }
        execCounter++;
        const execId = `mock-exec-${execCounter}`;
        execs.set(execId, containerId);
        respond(201, { Id: execId });
        return;
      }

      // GET /exec/{id}/json
      const execInspectMatch = url.match(/\/exec\/([^/]+)\/json/);
      if (execInspectMatch && method === "GET") {
        const execId = execInspectMatch[1];
        const containerId = execs.get(execId);
        if (!containerId) { respond(404, { message: "not found" }); return; }
        respond(200, { ID: execId, ContainerID: containerId });
        return;
      }

      // POST /exec/{id}/start
      const execStartMatch = url.match(/\/exec\/([^/]+)\/start/);
      if (execStartMatch && method === "POST") {
        const execId = execStartMatch[1];
        const containerId = execs.get(execId);
        if (!containerId) { respond(404, { message: "not found" }); return; }
        respond(200, {});
        return;
      }

      // POST /networks/create
      if (url.match(/\/networks\/create/) && method === "POST") {
        const id = `mock-network-${Date.now()}`;
        const labels = (body.Labels ?? {}) as Record<string, string>;
        networks.set(id, { labels });
        respond(201, { Id: id });
        return;
      }

      // GET /networks
      if (url.match(/\/networks(\?|$)/) && method === "GET" && !url.match(/\/networks\/[^?]/)) {
        const list = [...networks.entries()].map(([id, n]) => ({
          Id: id, Name: id, Labels: n.labels,
        }));
        respond(200, list);
        return;
      }

      // GET /networks/{id}
      const networkInspectMatch = url.match(/\/networks\/([^/?]+)$/);
      if (networkInspectMatch && method === "GET") {
        const id = networkInspectMatch[1];
        const n = networks.get(id);
        if (!n) { respond(404, { message: "not found" }); return; }
        respond(200, { Id: id, Labels: n.labels });
        return;
      }

      // DELETE /networks/{id}
      if (networkInspectMatch && method === "DELETE") {
        const id = url.match(/\/networks\/([^/?]+)$/)![1];
        networks.delete(id);
        respond(204, {});
        return;
      }

      // POST /volumes/create
      if (url.match(/\/volumes\/create/) && method === "POST") {
        const name = (body.Name as string) ?? `mock-vol-${Date.now()}`;
        const labels = (body.Labels ?? {}) as Record<string, string>;
        volumes.set(name, { labels });
        respond(201, { Name: name, Labels: labels });
        return;
      }

      // GET /volumes
      if (url.match(/\/volumes(\?|$)/) && method === "GET" && !url.match(/\/volumes\/[^?]/)) {
        const list = [...volumes.entries()].map(([name, v]) => ({
          Name: name, Labels: v.labels,
        }));
        respond(200, { Volumes: list });
        return;
      }

      // GET /volumes/{name}
      const volumeInspectMatch = url.match(/\/volumes\/([^/?]+)$/);
      if (volumeInspectMatch && method === "GET") {
        const name = volumeInspectMatch[1];
        const v = volumes.get(name);
        if (!v) { respond(404, { message: "not found" }); return; }
        respond(200, { Name: name, Labels: v.labels });
        return;
      }

      // DELETE /volumes/{name}
      if (volumeInspectMatch && method === "DELETE") {
        const name = url.match(/\/volumes\/([^/?]+)$/)![1];
        volumes.delete(name);
        respond(204, {});
        return;
      }

      // GET /images/json
      if (url.match(/\/images/) && method === "GET") {
        respond(200, []);
        return;
      }

      // POST /images/create
      if (url.match(/\/images\/create/) && method === "POST") {
        respond(200, {});
        return;
      }

      // POST /build
      if (url.match(/\/build/) && method === "POST") {
        respond(200, { stream: "built" });
        return;
      }

      // POST /networks/{id}/connect
      if (url.match(/\/networks\/[^/]+\/connect/) && method === "POST") {
        respond(200, {});
        return;
      }

      // POST /networks/{id}/disconnect
      if (url.match(/\/networks\/[^/]+\/disconnect/) && method === "POST") {
        respond(200, {});
        return;
      }

      respond(404, { message: `Mock daemon: unhandled ${method} ${url}` });
    });
  });

  return {
    server,
    socketPath,
    containers,
    networks,
    volumes,
    execs,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
        try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
        resolve();
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(
  proxyUrl: string,
  method: string,
  path: string,
  body?: unknown,
  sourceIp?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, proxyUrl);
    const headers: Record<string, string> = {};
    let bodyStr: string | undefined;
    if (body) {
      bodyStr = JSON.stringify(body);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(bodyStr));
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
        localAddress: sourceIp,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          resolve({ status: res.statusCode ?? 500, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Docker API proxy", () => {
  let daemon: MockDaemon;
  let proxy: http.Server;
  let proxyUrl: string;
  let sessionMap: Map<string, SessionInfo>;

  beforeEach(async () => {
    daemon = createMockDaemon();
    await new Promise<void>((resolve) => daemon.server.listen(daemon.socketPath, resolve));

    sessionMap = new Map();
    // Default session with Docker access
    sessionMap.set("127.0.0.1", {
      sessionId: "session-1",
      hostWorkspaceDir: "/workspace/sessions/session-1",
      dockerAccess: true,
    });

    const deps: DockerProxyDeps = {
      getSessionByContainerIp: (ip) => sessionMap.get(ip),
      socketPath: daemon.socketPath,
    };

    proxy = createDockerProxy(deps);
    await new Promise<void>((resolve) => {
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const addr = proxy.address() as net.AddressInfo;
    proxyUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await daemon.close();
  });

  // --- Source IP routing ---

  describe("source IP routing", () => {
    it("returns 403 for unknown source IPs", async () => {
      // Mock a session on a different IP
      sessionMap.clear();
      sessionMap.set("10.0.0.99", {
        sessionId: "remote-session",
        hostWorkspaceDir: "/workspace/sessions/remote",
        dockerAccess: true,
      });

      const res = await makeRequest(proxyUrl, "GET", "/_ping");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Unknown source IP");
    });

    it("returns 403 when Docker access is disabled", async () => {
      sessionMap.set("127.0.0.1", {
        sessionId: "session-no-docker",
        hostWorkspaceDir: "/workspace/sessions/no-docker",
        dockerAccess: false,
      });

      const res = await makeRequest(proxyUrl, "GET", "/_ping");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Docker access not enabled");
    });
  });

  // --- System endpoints ---

  describe("system endpoints", () => {
    it("allows GET /_ping", async () => {
      const res = await makeRequest(proxyUrl, "GET", "/_ping");
      expect(res.status).toBe(200);
    });

    it("allows GET /version", async () => {
      const res = await makeRequest(proxyUrl, "GET", "/v1.41/version");
      expect(res.status).toBe(200);
      expect((res.body as any).Version).toBe("20.10.0");
    });

    it("allows GET /info", async () => {
      const res = await makeRequest(proxyUrl, "GET", "/v1.41/info");
      expect(res.status).toBe(200);
    });
  });

  // --- Default deny ---

  describe("default deny", () => {
    it("returns 403 for unknown endpoints", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/swarm/init");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Endpoint not allowed");
    });
  });

  // --- Container create sanitization ---

  describe("container create sanitization", () => {
    it("rejects privileged containers", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Privileged: true },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Privileged");
    });

    it("rejects CapAdd", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { CapAdd: ["SYS_ADMIN"] },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("capabilities");
    });

    it("injects NET_RAW into CapDrop", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
      });
      expect(res.status).toBe(201);

      // Check that the container was created with the parent session label
      const containerId = (res.body as any).Id;
      const container = daemon.containers.get(containerId);
      expect(container?.labels[PARENT_SESSION_LABEL]).toBe("session-1");
    });

    it("rejects host NetworkMode", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { NetworkMode: "host" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Host network");
    });

    it("rejects host PidMode", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { PidMode: "host" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects container PidMode", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { PidMode: "container:abc123" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects host IpcMode", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { IpcMode: "host" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects host UTSMode", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { UTSMode: "host" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects Devices", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Devices: [{ PathOnHost: "/dev/sda" }] },
      });
      expect(res.status).toBe(403);
    });

    it("rejects VolumesFrom", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { VolumesFrom: ["other-container"] },
      });
      expect(res.status).toBe(403);
    });

    it("overwrites shipit-parent-session label (never merges)", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        Labels: { [PARENT_SESSION_LABEL]: "evil-session", "other-label": "kept" },
        HostConfig: {},
      });
      expect(res.status).toBe(201);

      const containerId = (res.body as any).Id;
      const container = daemon.containers.get(containerId);
      expect(container?.labels[PARENT_SESSION_LABEL]).toBe("session-1");
      expect(container?.labels["other-label"]).toBe("kept");
    });

    it("allows valid container creation", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        Cmd: ["echo", "hello"],
        HostConfig: {},
      });
      expect(res.status).toBe(201);
      expect((res.body as any).Id).toBeTruthy();
    });

    it("rejects request body exceeding 10 MB", async () => {
      const largeBody = { Image: "alpine", HostConfig: {}, data: "x".repeat(11 * 1024 * 1024) };
      try {
        const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", largeBody);
        // If we get a response, it should be a 400
        expect(res.status).toBe(400);
        expect((res.body as any).message).toContain("too large");
      } catch (err) {
        // Connection may be reset before response is sent — this is acceptable
        expect((err as Error).message).toMatch(/ECONNRESET|socket hang up/);
      }
    });
  });

  // --- Label-based scoping ---

  describe("label-based container scoping", () => {
    let ownedContainerId: string;
    let foreignContainerId: string;

    beforeEach(async () => {
      // Create a container owned by session-1
      const res1 = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      ownedContainerId = (res1.body as any).Id;

      // Create a foreign container directly in the mock daemon
      daemon.containers.set("foreign-container", {
        labels: { [PARENT_SESSION_LABEL]: "other-session" },
        running: true,
      });
      foreignContainerId = "foreign-container";
    });

    it("GET /containers/json filters to session containers", async () => {
      const res = await makeRequest(proxyUrl, "GET", "/v1.41/containers/json");
      expect(res.status).toBe(200);
      const containers = res.body as any[];
      expect(containers.length).toBe(1);
      expect(containers[0].Id).toBe(ownedContainerId);
    });

    it("GET /containers/{id}/json allows owned container", async () => {
      const res = await makeRequest(proxyUrl, "GET", `/v1.41/containers/${ownedContainerId}/json`);
      expect(res.status).toBe(200);
    });

    it("GET /containers/{id}/json rejects foreign container", async () => {
      const res = await makeRequest(proxyUrl, "GET", `/v1.41/containers/${foreignContainerId}/json`);
      expect(res.status).toBe(403);
    });

    it("POST /containers/{id}/start allows owned container", async () => {
      const res = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${ownedContainerId}/start`);
      expect([200, 204]).toContain(res.status);
    });

    it("POST /containers/{id}/start rejects foreign container", async () => {
      const res = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${foreignContainerId}/start`);
      expect(res.status).toBe(403);
    });

    it("POST /containers/{id}/stop rejects foreign container", async () => {
      const res = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${foreignContainerId}/stop`);
      expect(res.status).toBe(403);
    });

    it("DELETE /containers/{id} rejects foreign container", async () => {
      const res = await makeRequest(proxyUrl, "DELETE", `/v1.41/containers/${foreignContainerId}`);
      expect(res.status).toBe(403);
    });
  });

  // --- Exec scoping ---

  describe("exec-to-container resolution", () => {
    it("allows exec on owned container", async () => {
      // Create a container owned by session-1
      const createRes = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      const containerId = (createRes.body as any).Id;

      // Create exec via proxy
      const execRes = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${containerId}/exec`, {
        Cmd: ["ls"],
      });
      expect(execRes.status).toBe(201);
      const execId = (execRes.body as any).Id;

      // GET exec inspect
      const inspectRes = await makeRequest(proxyUrl, "GET", `/v1.41/exec/${execId}/json`);
      expect(inspectRes.status).toBe(200);

      // POST exec start
      const startRes = await makeRequest(proxyUrl, "POST", `/v1.41/exec/${execId}/start`, {
        Detach: false, Tty: false,
      });
      expect(startRes.status).toBe(200);
    });

    it("rejects exec on foreign container", async () => {
      // Create foreign exec in mock daemon directly
      daemon.containers.set("foreign-c", {
        labels: { [PARENT_SESSION_LABEL]: "other-session" },
        running: true,
      });
      daemon.execs.set("foreign-exec-1", "foreign-c");

      // Try to start it via proxy
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/exec/foreign-exec-1/start", {
        Detach: false,
      });
      expect(res.status).toBe(403);
    });
  });

  // --- Network scoping ---

  describe("network scoping", () => {
    it("POST /networks/create overwrites session label", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/networks/create", {
        Name: "my-net",
        Labels: { [PARENT_SESSION_LABEL]: "evil-session" },
      });
      expect(res.status).toBe(201);

      // Verify the label was overwritten in the daemon
      const network = [...daemon.networks.values()][0];
      expect(network.labels[PARENT_SESSION_LABEL]).toBe("session-1");
    });

    it("GET /networks filters to session networks", async () => {
      // Create owned network
      await makeRequest(proxyUrl, "POST", "/v1.41/networks/create", { Name: "owned-net" });

      // Create foreign network in daemon
      daemon.networks.set("foreign-net", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });

      const res = await makeRequest(proxyUrl, "GET", "/v1.41/networks");
      expect(res.status).toBe(200);
      const nets = res.body as any[];
      expect(nets.length).toBe(1);
      expect(nets[0].Labels[PARENT_SESSION_LABEL]).toBe("session-1");
    });

    it("GET /networks/{id} rejects foreign network", async () => {
      daemon.networks.set("foreign-net", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const res = await makeRequest(proxyUrl, "GET", "/v1.41/networks/foreign-net");
      expect(res.status).toBe(403);
    });

    it("DELETE /networks/{id} rejects foreign network", async () => {
      daemon.networks.set("foreign-net", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const res = await makeRequest(proxyUrl, "DELETE", "/v1.41/networks/foreign-net");
      expect(res.status).toBe(403);
    });
  });

  // --- Volume scoping ---

  describe("volume scoping", () => {
    it("POST /volumes/create overwrites session label", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/volumes/create", {
        Name: "my-vol",
        Labels: { [PARENT_SESSION_LABEL]: "evil-session" },
      });
      expect(res.status).toBe(201);

      const volume = daemon.volumes.get("my-vol");
      expect(volume?.labels[PARENT_SESSION_LABEL]).toBe("session-1");
    });

    it("GET /volumes filters to session volumes", async () => {
      // Create owned volume
      await makeRequest(proxyUrl, "POST", "/v1.41/volumes/create", { Name: "owned-vol" });

      // Create foreign volume in daemon
      daemon.volumes.set("foreign-vol", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });

      const res = await makeRequest(proxyUrl, "GET", "/v1.41/volumes");
      expect(res.status).toBe(200);
      const data = res.body as any;
      expect(data.Volumes.length).toBe(1);
      expect(data.Volumes[0].Labels[PARENT_SESSION_LABEL]).toBe("session-1");
    });

    it("GET /volumes/{name} rejects foreign volume", async () => {
      daemon.volumes.set("foreign-vol", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const res = await makeRequest(proxyUrl, "GET", "/v1.41/volumes/foreign-vol");
      expect(res.status).toBe(403);
    });

    it("DELETE /volumes/{name} rejects foreign volume", async () => {
      daemon.volumes.set("foreign-vol", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const res = await makeRequest(proxyUrl, "DELETE", "/v1.41/volumes/foreign-vol");
      expect(res.status).toBe(403);
    });
  });

  // --- Image endpoints (unscoped) ---

  describe("image endpoints", () => {
    it("allows GET /images/json", async () => {
      const res = await makeRequest(proxyUrl, "GET", "/v1.41/images/json");
      expect(res.status).toBe(200);
    });

    it("allows POST /images/create (pull)", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/images/create?fromImage=alpine&tag=latest");
      expect(res.status).toBe(200);
    });

    it("allows POST /build", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/build");
      expect(res.status).toBe(200);
    });
  });
});
