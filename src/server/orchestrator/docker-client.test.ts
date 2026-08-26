/**
 * Guard tests for the `docker-modem` redirect crash (prod orchestrator kill,
 * 2026-08-26 — see `docker-client.ts`).
 *
 * A fake daemon on a Unix socket answers `301` + `Location: /containers/<id>/json`,
 * which is what the real daemon's router returns for any non-canonical path. The
 * question both tests ask is the same: does a SECOND `ClientRequest` get created
 * for a TCP host synthesized out of that path?
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createDockerClient, disableDockerModemRedirects } from "./docker-client.js";

/** One request the process actually opened, described by how it was addressed. */
interface SeenRequest {
  socketPath?: string;
  hostname?: string;
  /** Set when `http.request` was called with a URL string (the redirect path). */
  url?: string;
}

let seen: SeenRequest[];
let restoreRequest: () => void;

/**
 * Record every `ClientRequest` the process opens, and latch a swallowing
 * `'error'` listener on each.
 *
 * The swallow is what makes a REGRESSION show up as a failed assertion instead
 * of a dead test runner: the request this guards against is created with no
 * listener at all, so its DNS failure would otherwise take the whole vitest
 * process down exactly as it took the orchestrator down.
 *
 * Spying on `http.request` catches the redirect too, even though it is issued as
 * `http.get`: `docker-modem`'s wrapper reaches the native module through
 * `Object.getPrototypeOf(h).request`, i.e. a live property lookup on this same
 * module object.
 */
function watchRequests(): void {
  const original = http.request.bind(http);
  const spy = vi.spyOn(http, "request").mockImplementation(((...args: Parameters<typeof http.request>) => {
    const req = original(...(args as Parameters<typeof http.request>));
    req.on("error", () => { /* test-only latch — see docstring */ });
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

/** A daemon that answers every request with the router's canonicalizing 301. */
function startRedirectingDaemon(): { socketPath: string; close: () => Promise<void> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-client-test-"));
  const socketPath = path.join(dir, "docker.sock");
  const server = http.createServer((_req, res) => {
    res.writeHead(301, { Location: "/containers/abc/json" });
    res.end();
  });
  server.listen(socketPath);
  return {
    socketPath,
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

beforeEach(() => {
  seen = [];
  watchRequests();
  daemon = startRedirectingDaemon();
});

afterEach(async () => {
  restoreRequest();
  await daemon.close();
});

describe("createDockerClient", () => {
  it("does not open a second request when the daemon answers 3xx with a Location", async () => {
    const docker = createDockerClient({ socketPath: daemon.socketPath });

    await expect(docker.getContainer("abc").inspect()).rejects.toThrow(/Max redirects exceeded/);

    // The whole point: exactly one request, and it stayed on the Unix socket.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.socketPath).toBe(daemon.socketPath);
  });

  it("reports the redirect on the first request, which has an error listener", async () => {
    const docker = createDockerClient({ socketPath: daemon.socketPath });

    // A rejected promise — an ordinary Docker error the caller's `catch` sees —
    // is the entire behavioural difference from a process kill.
    await expect(docker.getContainer("abc").inspect()).rejects.toBeInstanceOf(Error);
  });
});

describe("the upstream defect the guard exists for", () => {
  /**
   * Re-arms `docker-modem`'s redirect following and shows what it does. This
   * FAILS if the guard is removed from `createDockerClient` — and it also fails
   * if `docker-modem` ever fixes this upstream, which is the signal to drop the
   * guard rather than carry it forever.
   */
  it("follows the redirect to a hostname parsed out of the Docker API path", async () => {
    const modemHttp = createRequire(import.meta.url)("docker-modem/lib/http") as { maxRedirects: number };
    disableDockerModemRedirects(); // ensure the module is loaded/patched first
    const guarded = modemHttp.maxRedirects;
    expect(guarded).toBe(0);

    modemHttp.maxRedirects = 5; // upstream default
    try {
      const docker = createDockerClient({ socketPath: daemon.socketPath });
      // The dial itself still rejects (the modem reports the 301 on its own
      // `'response'` handler), which is why the crash left no correlated error
      // in the logs. The orphan request is raised in parallel, so watch for it
      // rather than awaiting the dial.
      void docker.getContainer("abc").inspect().catch(() => { /* reported separately */ });

      await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5_000 });
    } finally {
      modemHttp.maxRedirects = guarded;
    }

    // `url.resolve("http:", "/containers/abc/json")` — the single slash is read
    // as an authority, so the first path segment becomes the host.
    expect(seen[1]?.url).toBe("http:/containers/abc/json");
    expect(new URL(seen[1]!.url!).hostname).toBe("containers");
  });
});
