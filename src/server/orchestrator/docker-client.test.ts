import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createDockerClient, disableDockerModemRedirects } from "./docker-client.js";

interface SeenRequest {
  socketPath?: string;
  hostname?: string;
  url?: string;
}

let seen: SeenRequest[];
let restoreRequest: () => void;

function watchRequests(): void {
  const original = http.request.bind(http);
  const spy = vi.spyOn(http, "request").mockImplementation(((...args: Parameters<typeof http.request>) => {
    const req = original(...(args as Parameters<typeof http.request>));
    req.on("error", () => { /* prevent a regression from killing the test runner */ });
    const target: unknown = args[0];
    if (typeof target === "string") seen.push({ url: target });
    else if (target instanceof URL) seen.push({ url: target.href });
    else {
      const opts = target as http.RequestOptions;
      seen.push({ socketPath: opts.socketPath, hostname: opts.hostname ?? opts.host ?? undefined });
    }
    return req;
  }) as typeof http.request);
  restoreRequest = () => spy.mockRestore();
}

function startRedirectingDaemon(): { socketPath: string; listening: Promise<void>; close: () => Promise<void> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-client-test-"));
  const socketPath = path.join(dir, "docker.sock");
  const server = http.createServer((_req, res) => {
    res.writeHead(301, { Location: "/containers/abc/json" });
    res.end();
  });
  const listening = new Promise<void>((resolve) => server.once("listening", () => resolve()));
  server.listen(socketPath);
  return {
    socketPath,
    listening,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

let daemon: ReturnType<typeof startRedirectingDaemon>;

beforeEach(async () => {
  seen = [];
  watchRequests();
  daemon = startRedirectingDaemon();
  await daemon.listening;
});

afterEach(async () => {
  restoreRequest();
  await daemon.close();
});

describe("createDockerClient", () => {
  it("does not open a second request when the daemon answers 3xx with a Location", async () => {
    const docker = createDockerClient({ socketPath: daemon.socketPath });

    await expect(docker.getContainer("abc").inspect()).rejects.toThrow(/Max redirects exceeded/);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.socketPath).toBe(daemon.socketPath);
  });
});

describe("the upstream defect the guard exists for", () => {
  // An upstream fix will fail this test and may make our guard unnecessary.
  it("follows the redirect to a hostname parsed out of the Docker API path", async () => {
    const modemHttp = createRequire(import.meta.url)("docker-modem/lib/http") as { maxRedirects: number };
    disableDockerModemRedirects();
    const guarded = modemHttp.maxRedirects;
    expect(guarded).toBe(0);

    modemHttp.maxRedirects = 5;
    try {
      const docker = createDockerClient({ socketPath: daemon.socketPath });
      void docker.getContainer("abc").inspect().catch(() => { /* reported separately */ });

      await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5_000 });
    } finally {
      modemHttp.maxRedirects = guarded;
    }

    expect(seen[1]?.url).toBe("http:/containers/abc/json");
    expect(new URL(seen[1]!.url!).hostname).toBe("containers");
  });
});
