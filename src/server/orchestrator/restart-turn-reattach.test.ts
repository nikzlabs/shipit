/**
 * Unit tests for the post-restart reattach sweep (docs/240).
 *
 * The sweep is what makes adoption happen without a human in the loop: after a
 * restart it probes each rediscovered container and materializes a runner ONLY
 * for the ones still mid-turn. The properties worth pinning are the ones that
 * keep it cheap and safe — it must not wake idle sessions (that would start
 * compose stacks and installs for sessions nobody opened), and one unreachable
 * worker must not take the sweep down with it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { reattachInFlightTurns } from "./restart-turn-reattach.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { WorkerAgentStatus } from "../shared/types.js";

/** A stand-in worker that answers `/agent/status` with a canned payload. */
async function startFakeWorker(status: Partial<WorkerAgentStatus>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/agent/status")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: false, latestSseSeq: 0, ...status }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

interface Harness {
  deps: Parameters<typeof reattachInFlightTurns>[0];
  created: string[];
  resumed: string[];
}

function makeHarness(
  containers: { sessionId: string; workerUrl: string; status?: string }[],
  opts: { sessions?: Set<string>; existingRunners?: Set<string>; standby?: Set<string>; resumeResult?: boolean } = {},
): Harness {
  const created: string[] = [];
  const resumed: string[] = [];
  const sessions = opts.sessions ?? new Set(containers.map((c) => c.sessionId));

  const containerManager = {
    getAll: () => containers.map((c) => ({ ...c, status: c.status ?? "running" })),
    isStandby: (id: string) => opts.standby?.has(id) ?? false,
  } as unknown as SessionContainerManager;

  const runnerRegistry = {
    get: (id: string) => (opts.existingRunners?.has(id) ? ({} as SessionRunnerInterface) : undefined),
    getOrCreate: (id: string) => {
      created.push(id);
      return {
        resumeInFlightTurn: async () => {
          resumed.push(id);
          return opts.resumeResult ?? true;
        },
      } as unknown as SessionRunnerInterface;
    },
  } as unknown as SessionRunnerRegistry;

  const sessionManager = {
    get: (id: string) =>
      sessions.has(id) ? { id, workspaceDir: `/ws/${id}`, archived: false } : undefined,
  } as unknown as SessionManager;

  return {
    deps: { containerManager, runnerRegistry, sessionManager, defaultAgentId: "claude" },
    created,
    resumed,
  };
}

describe("reattachInFlightTurns", () => {
  const workers: { close: () => Promise<void> }[] = [];

  beforeEach(() => { workers.length = 0; });
  afterEach(async () => { for (const w of workers) await w.close(); });

  async function worker(status: Partial<WorkerAgentStatus>): Promise<string> {
    const w = await startFakeWorker(status);
    workers.push(w);
    return w.url;
  }

  it("reattaches a session whose worker still has a turn in flight", async () => {
    const url = await worker({ running: true, turnActive: true, turnStartSseSeq: 3, latestSseSeq: 9 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url }]);

    const adopted = await reattachInFlightTurns(h.deps);

    expect(adopted).toBe(1);
    expect(h.created).toEqual(["s1"]);
    expect(h.resumed).toEqual(["s1"]);
  });

  it("leaves an idle session untouched — no runner is created for it", async () => {
    // A resident streaming process with no live turn is idle, not running:
    // waking it would start its compose stack and install for nothing.
    const url = await worker({ running: true, turnActive: false, latestSseSeq: 9 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("skips standby containers, archived/unknown sessions, and sessions that already have a runner", async () => {
    const url = await worker({ running: true, turnActive: true });
    const h = makeHarness(
      [
        { sessionId: "standby", workerUrl: url },
        { sessionId: "unknown", workerUrl: url },
        { sessionId: "has-runner", workerUrl: url },
        { sessionId: "stopped", workerUrl: url, status: "exited" },
      ],
      {
        standby: new Set(["standby"]),
        sessions: new Set(["standby", "has-runner", "stopped"]),
        existingRunners: new Set(["has-runner"]),
      },
    );

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("keeps going when one worker is unreachable", async () => {
    const live = await worker({ running: true, turnActive: true });
    // Port 1 on loopback refuses instantly — a dead worker, not a hang.
    const h = makeHarness([
      { sessionId: "dead", workerUrl: "http://127.0.0.1:1" },
      { sessionId: "live", workerUrl: live },
    ]);

    expect(await reattachInFlightTurns(h.deps)).toBe(1);
    expect(h.created).toEqual(["live"]);
  });

  it("treats a legacy worker (no turnActive field) as having nothing to adopt", async () => {
    // An older worker image answers `{ running, latestSseSeq }` only. Waking a
    // runner off `running` alone would fire for every idle streaming session.
    const url = await worker({ running: true, latestSseSeq: 4 });
    const h = makeHarness([{ sessionId: "s1", workerUrl: url }]);

    expect(await reattachInFlightTurns(h.deps)).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("is a no-op without a container manager (local / test runtime)", async () => {
    const h = makeHarness([]);
    expect(await reattachInFlightTurns({ ...h.deps, containerManager: null })).toBe(0);
  });
});
