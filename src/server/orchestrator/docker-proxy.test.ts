import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDockerProxy, PARENT_SESSION_LABEL } from "./docker-proxy.js";
import type { SessionInfo, DockerProxyDeps } from "./docker-proxy.js";
import { SESSION_CPU_SHARES } from "./container-config-builder.js";

interface MockDaemon {
  server: http.Server;
  socketPath: string;
  containers: Map<string, { labels: Record<string, string>; running: boolean; hostConfig?: Record<string, unknown> }>;
  networks: Map<string, { labels: Record<string, string> }>;
  volumes: Map<string, { labels: Record<string, string> }>;
  /** exec_id → container_id */
  execs: Map<string, string>;
  onServe?: (method: string, url: string) => void;
  close: () => Promise<void>;
}

function createMockDaemon(): MockDaemon {
  const containers = new Map<string, { labels: Record<string, string>; running: boolean; hostConfig?: Record<string, unknown> }>();
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
    daemon.onServe?.(method, url);

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString();
      let body: Record<string, unknown> = {};
      if (bodyStr) {
        try { body = JSON.parse(bodyStr); } catch { /* ignore */ }
      }

      const respond = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };

      const contentType = req.headers["content-type"] ?? "";
      const expectsJson = (method === "POST" || method === "PUT") && bodyStr && !(/\/build/.exec(url));
      if (expectsJson && !contentType.includes("application/json")) {
        respond(400, { message: `Content-Type must be application/json, got: ${contentType}` });
        return;
      }

      if (url === "/_ping" && method === "GET") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }

      if ((/\/v[\d.]+\/version$|^\/version$/.exec(url)) && method === "GET") {
        respond(200, { Version: "20.10.0", ApiVersion: "1.41" });
        return;
      }

      if ((/\/info$/.exec(url)) && method === "GET") {
        respond(200, { ID: "mock-daemon" });
        return;
      }

      if ((/\/containers\/create/.exec(url)) && method === "POST") {
        containerCounter++;
        const id = `mock-container-${containerCounter}`;
        const labels = (body.Labels ?? {}) as Record<string, string>;
        const hostConfig = (body.HostConfig ?? {}) as Record<string, unknown>;
        containers.set(id, { labels, running: false, hostConfig });
        respond(201, { Id: id });
        return;
      }

      if ((/\/containers\/json/.exec(url)) && method === "GET") {
        const list = [...containers.entries()].map(([id, c]) => ({
          Id: id,
          Labels: c.labels,
          State: c.running ? "running" : "created",
        }));
        respond(200, list);
        return;
      }

      const containerInspectMatch = /\/containers\/([^/]+)\/json/.exec(url);
      if (containerInspectMatch && method === "GET") {
        const id = containerInspectMatch[1];
        const c = containers.get(id);
        if (!c) { respond(404, { message: "not found" }); return; }
        respond(200, {
          Id: id,
          Config: { Labels: c.labels },
          State: { Running: c.running },
          ...(c.hostConfig ? { HostConfig: c.hostConfig } : {}),
        });
        return;
      }

      const containerStartMatch = /\/containers\/([^/]+)\/start/.exec(url);
      if (containerStartMatch && method === "POST") {
        const id = containerStartMatch[1];
        const c = containers.get(id);
        if (!c) { respond(404, { message: "not found" }); return; }
        c.running = true;
        respond(204, {});
        return;
      }

      const containerRestartMatch = /\/containers\/([^/]+)\/restart/.exec(url);
      if (containerRestartMatch && method === "POST") {
        const id = containerRestartMatch[1];
        const c = containers.get(id);
        if (!c) { respond(404, { message: "not found" }); return; }
        c.running = true;
        respond(204, {});
        return;
      }

      const containerStopMatch = /\/containers\/([^/]+)\/stop/.exec(url);
      if (containerStopMatch && method === "POST") {
        const id = containerStopMatch[1];
        const c = containers.get(id);
        if (!c) { respond(404, { message: "not found" }); return; }
        c.running = false;
        respond(204, {});
        return;
      }

      const containerDeleteMatch = (/\/containers\/([^/]+)$/.exec(url)) && method === "DELETE";
      if (containerDeleteMatch) {
        const id = /\/containers\/([^/]+)$/.exec(url)![1];
        containers.delete(id);
        respond(204, {});
        return;
      }

      const execCreateMatch = /\/containers\/([^/]+)\/exec/.exec(url);
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

      const execInspectMatch = /\/exec\/([^/]+)\/json/.exec(url);
      if (execInspectMatch && method === "GET") {
        const execId = execInspectMatch[1];
        const containerId = execs.get(execId);
        if (!containerId) { respond(404, { message: "not found" }); return; }
        respond(200, { ID: execId, ContainerID: containerId });
        return;
      }

      const execStartMatch = /\/exec\/([^/]+)\/start/.exec(url);
      if (execStartMatch && method === "POST") {
        const execId = execStartMatch[1];
        const containerId = execs.get(execId);
        if (!containerId) { respond(404, { message: "not found" }); return; }
        respond(200, {});
        return;
      }

      if ((/\/networks\/create/.exec(url)) && method === "POST") {
        const id = `mock-network-${Date.now()}`;
        const labels = (body.Labels ?? {}) as Record<string, string>;
        networks.set(id, { labels });
        respond(201, { Id: id });
        return;
      }

      if ((/\/networks(\?|$)/.exec(url)) && method === "GET" && !(/\/networks\/[^?]/.exec(url))) {
        const list = [...networks.entries()].map(([id, n]) => ({
          Id: id, Name: id, Labels: n.labels,
        }));
        respond(200, list);
        return;
      }

      const networkInspectMatch = /\/networks\/([^/?]+)$/.exec(url);
      if (networkInspectMatch && method === "GET") {
        const id = networkInspectMatch[1];
        const n = networks.get(id);
        if (!n) { respond(404, { message: "not found" }); return; }
        respond(200, { Id: id, Labels: n.labels });
        return;
      }

      if (networkInspectMatch && method === "DELETE") {
        const id = /\/networks\/([^/?]+)$/.exec(url)![1];
        networks.delete(id);
        respond(204, {});
        return;
      }

      if ((/\/volumes\/create/.exec(url)) && method === "POST") {
        const name = (body.Name as string) ?? `mock-vol-${Date.now()}`;
        const labels = (body.Labels ?? {}) as Record<string, string>;
        volumes.set(name, { labels });
        respond(201, { Name: name, Labels: labels });
        return;
      }

      if ((/\/volumes(\?|$)/.exec(url)) && method === "GET" && !(/\/volumes\/[^?]/.exec(url))) {
        const list = [...volumes.entries()].map(([name, v]) => ({
          Name: name, Labels: v.labels,
        }));
        respond(200, { Volumes: list });
        return;
      }

      const volumeInspectMatch = /\/volumes\/([^/?]+)$/.exec(url);
      if (volumeInspectMatch && method === "GET") {
        const name = volumeInspectMatch[1];
        const v = volumes.get(name);
        if (!v) { respond(404, { message: "not found" }); return; }
        respond(200, { Name: name, Labels: v.labels });
        return;
      }

      if (volumeInspectMatch && method === "DELETE") {
        const name = /\/volumes\/([^/?]+)$/.exec(url)![1];
        volumes.delete(name);
        respond(204, {});
        return;
      }

      if ((/\/images/.exec(url)) && method === "GET") {
        respond(200, []);
        return;
      }

      if ((/\/images\/create/.exec(url)) && method === "POST") {
        respond(200, {});
        return;
      }

      if ((/\/build/.exec(url)) && method === "POST") {
        respond(200, { stream: "built" });
        return;
      }

      if ((/\/networks\/[^/]+\/connect/.exec(url)) && method === "POST") {
        respond(200, {});
        return;
      }

      if ((/\/networks\/[^/]+\/disconnect/.exec(url)) && method === "POST") {
        respond(200, {});
        return;
      }

      respond(404, { message: `Mock daemon: unhandled ${method} ${url}` });
    });
  });

  const daemon: MockDaemon = {
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
  return daemon;
}

function makeRequest(
  proxyUrl: string,
  method: string,
  path: string,
  body?: unknown,
  sourceIp?: string,
  extraHeaders?: Record<string, string>,
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
    Object.assign(headers, extraHeaders);

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

describe("Docker API proxy", () => {
  let daemon: MockDaemon;
  let proxy: http.Server;
  let proxyUrl: string;
  let sessionMap: Map<string, SessionInfo>;
  let openBrackets: number;
  let bracketOpensSeen: number;

  beforeEach(async () => {
    daemon = createMockDaemon();
    await new Promise<void>((resolve) => daemon.server.listen(daemon.socketPath, resolve));

    sessionMap = new Map();
    sessionMap.set("127.0.0.1", {
      sessionId: "session-1",
      hostWorkspaceDir: "/workspace/sessions/session-1",
      dockerAccess: true,
    });

    openBrackets = 0;
    bracketOpensSeen = 0;
    const deps: DockerProxyDeps = {
      getSessionByContainerIp: (ip) => sessionMap.get(ip),
      socketPath: daemon.socketPath,
      stackName: "shipit-a",
      onTopologyChange: () => {
        openBrackets++;
        bracketOpensSeen++;
        return () => { openBrackets--; };
      },
    };

    proxy = createDockerProxy(deps);
    await new Promise<void>((resolve) => {
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const addr = proxy.address() as AddressInfo;
    proxyUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await daemon.close();
  });

  describe("source IP routing", () => {
    it("returns 403 for unknown source IPs", async () => {
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

  describe("default deny", () => {
    it("returns 403 for unknown endpoints", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/swarm/init");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Endpoint not allowed");
    });

    // Below 1.24 the daemon reads HostConfig from a container start, which no route checks. Go
    // compares the version component by component, so "1.2.3" and "1" are both below 1.24 to the
    // daemon however many components they carry.
    it.each(["/v1.23", "/v1.2.3", "/v1", "/v0.99"])("returns 403 for API version %s", async (prefix) => {
      const res = await makeRequest(proxyUrl, "POST", `${prefix}/containers/mock-container-1/start`, {
        Privileged: true, Binds: ["/:/host"],
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("minimum v1.24");
      expect(daemon.containers.get("mock-container-1")?.running).toBeFalsy();
    });

    it("allows the API versions a current client negotiates", async () => {
      for (const prefix of ["/v1.24", "/v1.41", "/v1.51", "/v2.0", ""]) {
        const res = await makeRequest(proxyUrl, "GET", `${prefix}/version`);
        expect(res.status, prefix).toBe(200);
      }
    });
  });

  describe("container-topology brackets", () => {
    async function openWhileServing(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; open: number }> {
      let seen = -1;
      daemon.onServe = () => { seen = openBrackets; };
      const res = await makeRequest(proxyUrl, method, path, body);
      daemon.onServe = undefined;
      return { status: res.status, open: seen };
    }

    async function createContainer(): Promise<string> {
      const created = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", { Image: "alpine" });
      bracketOpensSeen = 0;
      return (created.body as { Id: string }).Id;
    }

    it("holds one across a container START, which is when code begins running", async () => {
      const id = await createContainer();

      const { status, open } = await openWhileServing("POST", `/v1.41/containers/${id}/start`);

      expect(status).toBe(204);
      expect(open).toBe(1);
      expect(openBrackets).toBe(0);
    });

    it("holds one across a restart, which can hand out a new address", async () => {
      const id = await createContainer();

      const { open } = await openWhileServing("POST", `/v1.41/containers/${id}/restart`);

      expect(open).toBe(1);
      expect(openBrackets).toBe(0);
    });

    it("holds one across a network connect, which gives a container a new address", async () => {
      const id = await createContainer();
      const net = await makeRequest(proxyUrl, "POST", "/v1.41/networks/create", { Name: "n1" });
      const netId = (net.body as { Id: string }).Id;
      bracketOpensSeen = 0;

      const { open } = await openWhileServing("POST", `/v1.41/networks/${netId}/connect`, { Container: id });

      expect(open).toBe(1);
      expect(openBrackets).toBe(0);
    });

    it("opens nothing for a create — a created container runs nothing and holds no address", async () => {
      bracketOpensSeen = 0;
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", { Image: "alpine" });

      expect(res.status).toBe(201);
      expect(bracketOpensSeen).toBe(0);
    });

    it("opens nothing for reads, or for mutations that only remove", async () => {
      const id = await createContainer();

      await makeRequest(proxyUrl, "GET", "/_ping");
      await makeRequest(proxyUrl, "GET", "/v1.41/containers/json");
      await makeRequest(proxyUrl, "POST", `/v1.41/containers/${id}/stop`);
      await makeRequest(proxyUrl, "DELETE", `/v1.41/containers/${id}`);

      expect(bracketOpensSeen).toBe(0);
    });

    it("opens nothing for a start the label check refuses", async () => {
      daemon.containers.set("foreign", { labels: { [PARENT_SESSION_LABEL]: "other-session" }, running: false });
      bracketOpensSeen = 0;

      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/foreign/start");

      expect(res.status).toBe(403);
      expect(bracketOpensSeen).toBe(0);
    });
  });

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

    it("injects NET_RAW into CapDrop and sets parent session label", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
      });
      expect(res.status).toBe(201);

      const containerId = (res.body as any).Id;
      const container = daemon.containers.get(containerId);
      expect(container?.labels[PARENT_SESSION_LABEL]).toBe("session-1");
      expect(container?.hostConfig?.CapDrop).toContain("NET_RAW");
    });

    it("rejects host NetworkMode", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { NetworkMode: "host" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("NetworkMode");
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

    it("rejects container NetworkMode (namespace sharing)", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { NetworkMode: "container:foreign-container-id" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("NetworkMode");
    });

    it("rejects Devices", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Devices: [{ PathOnHost: "/dev/sda" }] },
      });
      expect(res.status).toBe(403);
    });

    it("strips Sysctls from HostConfig", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Sysctls: { "net.ipv4.ip_forward": "1" } },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.Sysctls).toBeUndefined();
    });

    it("strips UsernsMode from HostConfig", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { UsernsMode: "host" },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.UsernsMode).toBeUndefined();
    });

    it("strips Runtime from HostConfig", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Runtime: "nvidia" },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.Runtime).toBeUndefined();
    });

    it("rejects unknown mount types", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Mounts: [{ Type: "npipe", Source: "\\\\.\\pipe\\docker", Target: "/pipe" }] },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("not allowed");
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

    // planning#584: the stop scripts and boot sweeps select by the stack label, so a session's
    // own `docker run` must carry it or it outlives them.
    it("overwrites the stack label with the instance's own", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        Labels: { "shipit-stack": "shipit-b" },
        HostConfig: {},
      });
      expect(res.status).toBe(201);
      expect(daemon.containers.get((res.body as any).Id)?.labels["shipit-stack"]).toBe("shipit-a");
    });

    it("rejects bind mounts outside session workspace", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Binds: ["/etc/passwd:/etc/passwd:ro"] },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("outside session workspace");
    });

    it("rejects bind Mounts outside session workspace", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Mounts: [{ Type: "bind", Source: "/etc", Target: "/mnt" }] },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("outside session workspace");
    });

    it.each([
      ["Devices", [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/sda" }]],
      ["DeviceCgroupRules", ["b 8:* rwm"]],
      ["DeviceRequests", [{ Driver: "nvidia", Count: -1 }]],
    ])("rejects HostConfig.%s", async (field, value) => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { [field]: value },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Device mappings");
      expect(daemon.containers.size).toBe(0);
    });

    // Container create is a volume-create surface too, so the DriverOpts rule POST /volumes/create
    // enforces has to hold here: `local` + `o=bind,device=` is a host bind under another name.
    it("rejects a volume mount whose DriverConfig binds a host path", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {
          Mounts: [{
            Type: "volume",
            Target: "/data",
            VolumeOptions: {
              DriverConfig: { Name: "local", Options: { type: "none", o: "bind", device: "/etc" } },
            },
          }],
        },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("DriverConfig options are not allowed");
    });

    it("rejects a VolumeOptions alias on a volume mount", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {
          Mounts: [{
            Type: "volume",
            Target: "/host",
            volumeoptions: { DriverConfig: { Options: { device: "/" } } },
          }],
        },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
      expect(daemon.containers.size).toBe(0);
    });

    it("allows an anonymous volume mount with no driver options", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Mounts: [{ Type: "volume", Target: "/data" }] },
      });
      expect(res.status).toBe(201);
    });

    it("rejects a volume mount on a non-local driver", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {
          Mounts: [{ Type: "volume", Target: "/data", VolumeOptions: { DriverConfig: { Name: "nfs" } } }],
        },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("is not allowed");
    });

    it("strips VolumeDriver, which picks the driver for the image's own volumes", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { VolumeDriver: "some-plugin" },
      });
      expect(res.status).toBe(201);
      expect(daemon.containers.get((res.body as any).Id)?.hostConfig?.VolumeDriver).toBeUndefined();
    });

    it("strips SecurityOpt and CgroupParent", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { SecurityOpt: ["no-new-privileges"], CgroupParent: "/custom" },
      });
      expect(res.status).toBe(201);
      const container = daemon.containers.get((res.body as any).Id);
      expect(container?.hostConfig?.SecurityOpt).toBeUndefined();
      expect(container?.hostConfig?.CgroupParent).toBeUndefined();
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

    it("injects session network when sessionNetworkName is set", async () => {
      sessionMap.set("127.0.0.1", {
        sessionId: "session-1",
        hostWorkspaceDir: "/workspace/sessions/session-1",
        dockerAccess: true,
        sessionNetworkName: "shipit-session-abc123",
      });
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
      });
      expect(res.status).toBe(201);
      const container = daemon.containers.get((res.body as any).Id);
      expect(container?.hostConfig?.NetworkMode).toBe("shipit-session-abc123");
    });

    it("rejects NetworkMode naming a network owned by another session", async () => {
      daemon.networks.set("orchestrator-net", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { NetworkMode: "orchestrator-net" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("does not belong to this session");
    });

    it("rejects NetworkMode naming a network the proxy cannot see (e.g. orchestrator network)", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { NetworkMode: "shipit_default" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("does not belong to this session");
    });

    it("allows NetworkMode naming the session's own named network", async () => {
      daemon.networks.set("shipit-session-abc123", { labels: { [PARENT_SESSION_LABEL]: "session-1" } });
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { NetworkMode: "shipit-session-abc123" },
      });
      expect(res.status).toBe(201);
      const container = daemon.containers.get((res.body as any).Id);
      expect(container?.hostConfig?.NetworkMode).toBe("shipit-session-abc123");
    });

    it("rejects NetworkingConfig.EndpointsConfig naming a foreign network", async () => {
      daemon.networks.set("orchestrator-net", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
        NetworkingConfig: { EndpointsConfig: { "orchestrator-net": {} } },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("does not belong to this session");
    });

    it("rejects NetworkingConfig.EndpointsConfig naming a built-in network", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
        NetworkingConfig: { EndpointsConfig: { bridge: {} } },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("not allowed via NetworkingConfig");
    });

    it("allows NetworkingConfig.EndpointsConfig naming the session's own network", async () => {
      daemon.networks.set("shipit-session-abc123", { labels: { [PARENT_SESSION_LABEL]: "session-1" } });
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
        NetworkingConfig: { EndpointsConfig: { "shipit-session-abc123": {} } },
      });
      expect(res.status).toBe(201);
    });

    it("rejects request body exceeding 10 MB", async () => {
      const largeBody = { Image: "alpine", HostConfig: {}, data: "x".repeat(11 * 1024 * 1024) };
      try {
        const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", largeBody);
        expect(res.status).toBe(400);
        expect((res.body as any).message).toContain("too large");
      } catch (err) {
        expect((err as Error).message).toMatch(/ECONNRESET|socket hang up|EPIPE/);
      }
    });
  });

  describe("unsupported container endpoints", () => {
    it("blocks POST /containers/{id}/rename with clear message", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/my-container/rename?name=new-name");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("rename");
    });

    it("blocks POST /containers/{id}/update with clear message", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/my-container/update");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("update");
    });
  });

  describe("label-based container scoping", () => {
    let ownedContainerId: string;
    let foreignContainerId: string;

    beforeEach(async () => {
      const res1 = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      ownedContainerId = (res1.body as any).Id;

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

  describe("exec-to-container resolution", () => {
    it("allows exec on owned container", async () => {
      const createRes = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      const containerId = (createRes.body as any).Id;

      const execRes = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${containerId}/exec`, {
        Cmd: ["ls"],
      });
      expect(execRes.status).toBe(201);
      const execId = (execRes.body as any).Id;

      const inspectRes = await makeRequest(proxyUrl, "GET", `/v1.41/exec/${execId}/json`);
      expect(inspectRes.status).toBe(200);

      const startRes = await makeRequest(proxyUrl, "POST", `/v1.41/exec/${execId}/start`, {
        Detach: false, Tty: false,
      });
      expect(startRes.status).toBe(200);
    });

    it("rejects exec on foreign container", async () => {
      daemon.containers.set("foreign-c", {
        labels: { [PARENT_SESSION_LABEL]: "other-session" },
        running: true,
      });
      daemon.execs.set("foreign-exec-1", "foreign-c");

      const res = await makeRequest(proxyUrl, "POST", "/v1.41/exec/foreign-exec-1/start", {
        Detach: false,
      });
      expect(res.status).toBe(403);
    });

    it("rejects exec create with Privileged", async () => {
      const createRes = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      const containerId = (createRes.body as any).Id;

      const res = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${containerId}/exec`, {
        Cmd: ["ls"], Privileged: true,
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Privileged");
      expect(daemon.execs.size).toBe(0);
    });

    it("rejects exec create with a lowercase Privileged alias", async () => {
      const createRes = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine", HostConfig: {},
      });
      const containerId = (createRes.body as any).Id;

      const res = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${containerId}/exec`, {
        Cmd: ["ls"], privileged: true,
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
      expect(daemon.execs.size).toBe(0);
    });
  });

  // Docker matches JSON keys to Go struct fields case-insensitively, so a field spelled in any
  // other casing is honoured by the daemon and invisible to every check here (planning#607).
  describe("ambiguous field casing", () => {
    it("control: the checks read exact property names, so a lowercase body reaches none of them", () => {
      const body = { Image: "alpine", HostConfig: { privileged: true, binds: ["/:/host"] } };
      const hostConfig = body.HostConfig as Record<string, unknown>;

      expect(hostConfig.Privileged).toBeUndefined();
      expect(hostConfig.Binds).toBeUndefined();
    });

    it("rejects a lowercase HostConfig alias on container create", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        hostconfig: { Privileged: true },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
      expect((res.body as any).message).toContain("HostConfig");
      expect(daemon.containers.size).toBe(0);
    });

    it("rejects the privileged + binds escape the sanitizer could not see", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { privileged: true, binds: ["/:/host"] },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
      expect(daemon.containers.size).toBe(0);
    });

    it.each([
      ["capadd", { capadd: ["SYS_ADMIN"] }],
      ["CAPADD", { CAPADD: ["SYS_ADMIN"] }],
      ["devices", { devices: [{ PathOnHost: "/dev/sda" }] }],
      ["volumesfrom", { volumesfrom: ["other"] }],
      ["networkmode", { networkmode: "host" }],
      ["pidmode", { pidmode: "host" }],
      ["ipcmode", { ipcmode: "host" }],
      ["usernsmode", { usernsmode: "host" }],
      ["securityopt", { securityopt: ["seccomp=unconfined"] }],
      ["runtime", { runtime: "sysbox-runc" }],
      ["Capdrop", { Capdrop: [] }],
      ["pidslimit", { pidslimit: -1 }],
    ])("rejects HostConfig.%s", async (_name, hostConfig) => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: hostConfig,
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
      expect(daemon.containers.size).toBe(0);
    });

    it("rejects an alias nested in Mounts", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Mounts: [{ Type: "bind", Target: "/w", Source: "/tmp" }, { type: "bind", source: "/" }] },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("HostConfig.Mounts[1].type");
      expect(daemon.containers.size).toBe(0);
    });

    it("rejects a Labels alias that would overwrite the ownership label", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
        labels: { [PARENT_SESSION_LABEL]: "other-session" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
    });

    it("accepts a canonical body whose label and sysctl names collide with guarded fields", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        Labels: { type: "web", source: "compose", privileged: "no" },
        HostConfig: { Sysctls: { binds: "1" }, Mounts: [{ Type: "tmpfs", Target: "/scratch" }] },
      });
      expect(res.status).toBe(201);
    });

    it("rejects a lowercase driveropts on volume create", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/volumes/create", {
        Name: "escape-vol",
        driveropts: { type: "none", o: "bind", device: "/etc" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
      expect(daemon.volumes.size).toBe(0);
    });

    it("rejects a lowercase driver on volume create", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/volumes/create", {
        Name: "nfs-vol",
        driver: "nfs",
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
      expect(daemon.volumes.size).toBe(0);
    });

    it("rejects a lowercase container alias on network connect", async () => {
      const createRes = await makeRequest(proxyUrl, "POST", "/v1.41/networks/create", { Name: "my-net" });
      const networkId = (createRes.body as any).Id;
      daemon.containers.set("foreign-c", {
        labels: { [PARENT_SESSION_LABEL]: "other-session" },
        running: true,
      });

      const res = await makeRequest(proxyUrl, "POST", `/v1.41/networks/${networkId}/connect`, {
        container: "foreign-c",
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
    });

    it("rejects a Labels alias on network create", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/networks/create", {
        Name: "my-net",
        labels: { [PARENT_SESSION_LABEL]: "evil-session" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("Ambiguous field casing");
      expect(daemon.networks.size).toBe(0);
    });
  });

  describe("network scoping", () => {
    it("POST /networks/create overwrites session label", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/networks/create", {
        Name: "my-net",
        Labels: { [PARENT_SESSION_LABEL]: "evil-session" },
      });
      expect(res.status).toBe(201);

      const network = [...daemon.networks.values()][0];
      expect(network.labels[PARENT_SESSION_LABEL]).toBe("session-1");
      expect(network.labels["shipit-stack"]).toBe("shipit-a");
    });

    it("GET /networks filters to session networks", async () => {
      await makeRequest(proxyUrl, "POST", "/v1.41/networks/create", { Name: "owned-net" });

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

    it("POST /networks/{id}/connect rejects foreign network", async () => {
      daemon.networks.set("foreign-net", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const createRes = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
      });
      const containerId = (createRes.body as any).Id;

      const res = await makeRequest(proxyUrl, "POST", "/v1.41/networks/foreign-net/connect", {
        Container: containerId,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("volume scoping", () => {
    it("POST /volumes/create overwrites session label", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/volumes/create", {
        Name: "my-vol",
        Labels: { [PARENT_SESSION_LABEL]: "evil-session" },
      });
      expect(res.status).toBe(201);

      const volume = daemon.volumes.get("my-vol");
      expect(volume?.labels[PARENT_SESSION_LABEL]).toBe("session-1");
      expect(volume?.labels["shipit-stack"]).toBe("shipit-a");
    });

    it("rejects volume create with DriverOpts (host-path escape)", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/volumes/create", {
        Name: "escape-vol",
        Driver: "local",
        DriverOpts: { type: "none", o: "bind", device: "/etc" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("DriverOpts");
    });

    it("rejects volume create with non-local driver", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/volumes/create", {
        Name: "nfs-vol",
        Driver: "nfs",
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("driver");
    });

    it("GET /volumes filters to session volumes", async () => {
      await makeRequest(proxyUrl, "POST", "/v1.41/volumes/create", { Name: "owned-vol" });

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

  describe("resource limit enforcement", () => {
    beforeEach(() => {
      sessionMap.set("127.0.0.1", {
        sessionId: "session-1",
        hostWorkspaceDir: "/workspace/sessions/session-1",
        dockerAccess: true,
        resourceLimits: {
          memory: 512 * 1024 * 1024,
          cpuQuota: 200_000,
          pidsLimit: 1024,
        },
      });
    });

    it("caps negative Memory values (Docker uses -1 for unlimited)", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Memory: -1 },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.Memory).toBe(512 * 1024 * 1024);
    });

    it("caps negative CpuQuota values", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { CpuQuota: -1 },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.CpuQuota).toBe(200_000);
    });

    it("caps negative PidsLimit values", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { PidsLimit: -1 },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.PidsLimit).toBe(1024);
    });

    it("lowers a sibling's default CpuShares to the session weight", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: {},
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.CpuShares).toBe(SESSION_CPU_SHARES);
    });

    it("caps an inflated CpuShares that would outweigh the orchestrator", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { CpuShares: 100_000 },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.CpuShares).toBe(SESSION_CPU_SHARES);
    });

    it("leaves a CpuShares already below the session weight alone", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { CpuShares: 64 },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.CpuShares).toBe(64);
    });

    it("caps inflated CpuPeriod to prevent effective CPU limit bypass", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { CpuPeriod: 1_000_000 },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.CpuPeriod).toBe(100_000);
    });

    it("caps resource values that exceed session limits", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/create", {
        Image: "alpine",
        HostConfig: { Memory: 8 * 1024 * 1024 * 1024, CpuQuota: 1_000_000, PidsLimit: 65535 },
      });
      expect(res.status).toBe(201);
      const hc = daemon.containers.get((res.body as any).Id)?.hostConfig;
      expect(hc?.Memory).toBe(512 * 1024 * 1024);
      expect(hc?.CpuQuota).toBe(200_000);
      expect(hc?.PidsLimit).toBe(1024);
    });
  });

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

    it("allows a harmless POST /build networkmode", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/build?t=app&networkmode=none");
      expect(res.status).toBe(200);
    });

    it("blocks POST /build?networkmode=host", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/build?t=app&networkmode=host");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("NetworkMode host/container is not allowed");
    });

    it("blocks POST /build sharing another container's namespace", async () => {
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/build?networkmode=container%3Aorchestrator");
      expect(res.status).toBe(403);
    });

    it("blocks a form-encoded POST /build, which could override the query", async () => {
      const res = await makeRequest(
        proxyUrl, "POST", "/v1.41/build?remote=http://example.invalid/ctx&networkmode=none",
        undefined, undefined, { "content-type": "application/x-www-form-urlencoded" },
      );
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("is not allowed for a build");

      const multipart = await makeRequest(
        proxyUrl, "POST", "/v1.41/build", undefined, undefined,
        { "content-type": "multipart/form-data; boundary=xyz" },
      );
      expect(multipart.status).toBe(403);
    });

    it("allows a build sending its context as a tar", async () => {
      const res = await makeRequest(
        proxyUrl, "POST", "/v1.41/build?t=app", undefined, undefined,
        { "content-type": "application/x-tar" },
      );
      expect(res.status).toBe(200);
    });

    it("blocks POST /build on a network the session does not own", async () => {
      daemon.networks.set("foreign-net", { labels: { [PARENT_SESSION_LABEL]: "other-session" } });
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/build?networkmode=foreign-net");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("does not belong to this session");
    });

    it("allows POST /build on a network the session owns", async () => {
      const created = await makeRequest(proxyUrl, "POST", "/v1.41/networks/create", { Name: "owned-net" });
      const netId = (created.body as any).Id as string;
      const res = await makeRequest(proxyUrl, "POST", `/v1.41/build?networkmode=${netId}`);
      expect(res.status).toBe(200);
    });

    it("blocks DELETE /images/{id} (shared resource protection)", async () => {
      const res = await makeRequest(proxyUrl, "DELETE", "/v1.41/images/alpine:latest");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("shared resources");
    });
  });

  // planning#601: the check `realpath`-resolved the requested path and Docker then mounted the
  // original string, so a symlink swap between the two reached anything on the host — the
  // group-writable overlay dep base (docs/183) above all. These run against a real workspace on
  // disk: with a `hostWorkspaceDir` that does not exist, every bind is refused for the wrong reason.
  describe("bind mount path pinning", () => {
    let root: string;
    let workspace: string;
    /** Stands in for the group-writable overlay base: outside the workspace, on the same host. */
    let base: string;

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "docker-proxy-bind-")));
      workspace = path.join(root, "workspace");
      base = path.join(root, "dep-base");
      fs.mkdirSync(path.join(workspace, "project", "data"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "other", "data"), { recursive: true });
      fs.mkdirSync(path.join(base, "data"), { recursive: true });
      sessionMap.set("127.0.0.1", {
        sessionId: "session-1",
        hostWorkspaceDir: workspace,
        dockerAccess: true,
      });
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    function create(hostConfig: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
      return makeRequest(proxyUrl, "POST", "/v1.41/containers/create", { Image: "alpine", HostConfig: hostConfig });
    }

    function storedBinds(id: string): string[] {
      return (daemon.containers.get(id)?.hostConfig?.Binds ?? []) as string[];
    }

    it("forwards the resolved path, so Docker mounts what was checked", async () => {
      fs.symlinkSync(path.join(workspace, "project", "data"), path.join(workspace, "link"));

      const res = await create({ Binds: [`${workspace}/link:/app:rw`] });
      expect(res.status).toBe(201);
      expect(storedBinds((res.body as any).Id)).toEqual([`${workspace}/project/data:/app:rw`]);
    });

    it("pins a Mounts[] bind source the same way", async () => {
      fs.symlinkSync(path.join(workspace, "project", "data"), path.join(workspace, "link"));

      const res = await create({
        Mounts: [{ Type: "bind", Source: `${workspace}/link`, Target: "/app" }],
      });
      expect(res.status).toBe(201);
      const mounts = daemon.containers.get((res.body as any).Id)?.hostConfig?.Mounts as any[];
      expect(mounts[0].Source).toBe(`${workspace}/project/data`);
    });

    it("leaves an already-canonical bind byte-identical", async () => {
      const bind = `${workspace}/project/data:/app:ro`;
      const res = await create({ Binds: [bind] });
      expect(res.status).toBe(201);
      expect(storedBinds((res.body as any).Id)).toEqual([bind]);
    });

    it("mounts the checked target when the symlink is swapped after the check", async () => {
      const link = path.join(workspace, "link");
      fs.symlinkSync(path.join(workspace, "project", "data"), link);
      const res = await create({ Binds: [`${link}:/app:rw`] });
      expect(res.status).toBe(201);
      const id = (res.body as any).Id as string;

      fs.unlinkSync(link);
      fs.symlinkSync(base, link);

      // Control: the string the pre-fix proxy forwarded now names the base, so Docker would have
      // mounted the base read-write.
      expect(fs.realpathSync(link)).toBe(base);

      const started = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${id}/start`);
      expect(started.status).toBe(204);
      expect(storedBinds(id)).toEqual([`${workspace}/project/data:/app:rw`]);
      expect(daemon.containers.get(id)?.running).toBe(true);
    });

    it("refuses to start when a directory on the checked path became a symlink out of the workspace", async () => {
      const res = await create({ Binds: [`${workspace}/project/data:/app:rw`] });
      expect(res.status).toBe(201);
      const id = (res.body as any).Id as string;

      fs.renameSync(path.join(workspace, "project"), path.join(workspace, "project-moved"));
      fs.symlinkSync(base, path.join(workspace, "project"));

      // Control: the stored path — which create checked and pinned — now resolves into the base.
      expect(fs.realpathSync(`${workspace}/project/data`)).toBe(path.join(base, "data"));

      const started = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${id}/start`);
      expect(started.status).toBe(403);
      expect((started.body as any).message).toContain("outside session workspace");
      expect(daemon.containers.get(id)?.running).toBe(false);
    });

    it("refuses to start when the checked path resolves elsewhere inside the workspace", async () => {
      const res = await create({ Binds: [`${workspace}/project/data:/app:rw`] });
      const id = (res.body as any).Id as string;

      fs.renameSync(path.join(workspace, "project"), path.join(workspace, "project-moved"));
      fs.symlinkSync(path.join(workspace, "other"), path.join(workspace, "project"));

      const started = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${id}/start`);
      expect(started.status).toBe(403);
      expect((started.body as any).message).toContain("no longer resolves");
    });

    // A restart mounts only after the stop completes, and a container that traps its stop signal
    // decides when that is — the check would clear a path the session then has time to swap.
    it("refuses to restart a container that has a host bind", async () => {
      const res = await create({
        Mounts: [{ Type: "bind", Source: `${workspace}/project/data`, Target: "/app" }],
      });
      const id = (res.body as any).Id as string;
      await makeRequest(proxyUrl, "POST", `/v1.41/containers/${id}/start`);

      const restarted = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${id}/restart`);
      expect(restarted.status).toBe(403);
      expect((restarted.body as any).message).toContain("stop it and start it instead");
    });

    it("restarts a container that has no host bind", async () => {
      const res = await create({});
      const id = (res.body as any).Id as string;
      const restarted = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${id}/restart`);
      expect(restarted.status).toBe(204);
    });

    // Docker restarts on its own policy, with no request for the proxy to check.
    it("refuses a restart policy on a container that has a host bind", async () => {
      const res = await create({
        Binds: [`${workspace}/project/data:/app:rw`],
        RestartPolicy: { Name: "always" },
      });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("RestartPolicy");
    });

    it("allows a restart policy when nothing from the host is mounted", async () => {
      const res = await create({ RestartPolicy: { Name: "unless-stopped" } });
      expect(res.status).toBe(201);
    });

    it("refuses a bind whose resolved path contains a colon", async () => {
      fs.mkdirSync(path.join(workspace, "od:d"));
      fs.symlinkSync(path.join(workspace, "od:d"), path.join(workspace, "link"));
      const res = await create({ Binds: [`${workspace}/link:/app:rw`] });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("containing");
    });

    it("fails closed when the inspect carries no HostConfig", async () => {
      daemon.containers.set("legacy", { labels: { [PARENT_SESSION_LABEL]: "session-1" }, running: false });
      const res = await makeRequest(proxyUrl, "POST", "/v1.41/containers/legacy/start");
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("HostConfig");
    });

    it("still starts a container whose paths are unchanged", async () => {
      const res = await create({ Binds: [`${workspace}/project/data:/app:rw`] });
      const id = (res.body as any).Id as string;
      const started = await makeRequest(proxyUrl, "POST", `/v1.41/containers/${id}/start`);
      expect(started.status).toBe(204);
    });

    it("still refuses a bind that resolves outside the workspace at create", async () => {
      fs.symlinkSync(base, path.join(workspace, "escape"));
      const res = await create({ Binds: [`${workspace}/escape:/app:rw`] });
      expect(res.status).toBe(403);
      expect((res.body as any).message).toContain("outside session workspace");
    });
  });
});
