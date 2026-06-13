/**
 * Focused unit test for `runPreInstall` — the warm-pool pre-install executor
 * that the docs/178 trust gate sits in front of.
 *
 * The trust *gate* itself (skip `runPreInstall` for an untrusted remote) lives
 * inside the standby-creation callback in `warmSessionForRepo` and is covered
 * structurally by the `repoStore.isTrusted` unit tests + the standby flow
 * staying green. This file covers the other half: that when pre-install *does*
 * run, it forwards exactly the repo's resolved `agent.install` commands to the
 * worker — and, crucially for the gate's intent, that an empty/absent install
 * config never touches the worker at all (nothing executes).
 *
 * We stand up a real HTTP worker stub (mirroring `sse-client.test.ts`) instead
 * of mocking `workerInstall`, so the test exercises the genuine HTTP path the
 * warm flow uses against `session-worker.ts`'s `/install` + `/install/status`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPreInstall } from "./warm-pool-manager.js";

interface InstallRequest {
  method: string;
  url: string;
  body: unknown;
}

interface WorkerStub {
  url: string;
  requests: InstallRequest[];
  /** Reply for `POST /install`. Defaults to `{ started: false }` (no poll). */
  installReply: Record<string, unknown>;
  /** Replies pulled in order for each `GET /install/status`. */
  statusReplies: Record<string, unknown>[];
  close: () => Promise<void>;
}

async function startWorkerStub(): Promise<WorkerStub> {
  // Build the worker object up front so the request handler closes over the
  // SAME mutable object the test tweaks (`worker.installReply = …`); spreading
  // into a fresh return value would leave the handler reading stale defaults.
  const worker = {
    url: "",
    requests: [] as InstallRequest[],
    installReply: { started: false } as Record<string, unknown>,
    statusReplies: [] as Record<string, unknown>[],
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (c: string) => { raw += c; });
    req.on("end", () => {
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      worker.requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      const respond = (payload: Record<string, unknown>) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/install") {
        respond(worker.installReply);
      } else if (req.method === "GET" && req.url === "/install/status") {
        respond(worker.statusReplies.shift() ?? { running: false, lastResult: { ok: true } });
      } else {
        res.writeHead(404).end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no server address");

  worker.url = `http://127.0.0.1:${addr.port}`;
  worker.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return worker;
}

describe("runPreInstall (warm-pool pre-install executor)", () => {
  let tmpDir: string;
  let worker: WorkerStub;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "warm-preinstall-"));
    worker = await startWorkerStub();
  });

  afterEach(async () => {
    await worker.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const writeInstall = (commands: string[]) => {
    const lines = commands.map((c) => `    - ${c}`).join("\n");
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), `agent:\n  install:\n${lines}\n`);
  };

  it("forwards the repo's resolved agent.install commands to the worker /install", async () => {
    writeInstall(["npm ci", "npm run build"]);

    await runPreInstall(tmpDir, worker.url, "sess-1");

    const install = worker.requests.find((r) => r.url === "/install");
    expect(install).toBeDefined();
    expect(install?.method).toBe("POST");
    expect(install?.body).toEqual({ commands: ["npm ci", "npm run build"] });
  });

  it("never touches the worker when there is no install config (nothing executes)", async () => {
    // No shipit.yaml at all → resolveShipitConfig yields an empty install list.
    await runPreInstall(tmpDir, worker.url, "sess-2");
    expect(worker.requests).toHaveLength(0);
  });

  it("never touches the worker when agent.install is empty", async () => {
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent:\n  install: []\n");
    await runPreInstall(tmpDir, worker.url, "sess-3");
    expect(worker.requests).toHaveLength(0);
  });

  it("short-circuits without polling status when the worker reports skipped (marker present)", async () => {
    writeInstall(["npm ci"]);
    worker.installReply = { skipped: true };

    await runPreInstall(tmpDir, worker.url, "sess-4");

    expect(worker.requests.some((r) => r.url === "/install")).toBe(true);
    // skipped => no status poll
    expect(worker.requests.some((r) => r.url === "/install/status")).toBe(false);
  });

  it("polls /install/status to completion once the worker reports started", async () => {
    writeInstall(["npm ci"]);
    worker.installReply = { started: true };
    // First poll still running, second poll done — exercises the loop.
    worker.statusReplies = [
      { running: true },
      { running: false, lastResult: { ok: true } },
    ];

    await runPreInstall(tmpDir, worker.url, "sess-5");

    const statusPolls = worker.requests.filter((r) => r.url === "/install/status");
    expect(statusPolls.length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});
