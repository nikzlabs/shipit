/**
 * End-to-end integration test for the `present` tool pipeline (docs/093).
 *
 * Drives the full server-side path with a REAL session worker (no Docker):
 *
 *   worker POST /agent-ops/present/submit
 *     → worker records metadata in its PresentRegistry + broadcasts a
 *       `present_content` SSE (metadata only — no bytes)
 *     → ContainerSessionRunner's SSE client receives it (handleSSEEvent)
 *     → runner translates it into a `present_content` WS message + caches metadata
 *
 * Listening on `runner.on("message")` captures the exact `WsServerMessage` the
 * orchestrator relays to every attached viewer — i.e. what a TestClient would
 * receive as `WsPresentContentMessage`. We assert the translated message shape,
 * the runner's `presentations` metadata cache (the authoritative source the
 * `present_state` replay reads on viewer attach), the `present_cleared` path via
 * a revision, and the lazy byte-read via the worker's `/present/:id/raw` route.
 *
 * Mirrors the real-worker harness from container-agent-wiring.test.ts so no new
 * fake-worker infra is needed — the live SessionWorker already registers the
 * present endpoints + SSE broadcaster.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams, PermissionMode } from "../../shared/types.js";
import type {
  WsServerMessage,
  WsPresentContentMessage,
  WsPresentClearedMessage,
} from "../../shared/types.js";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { DatabaseManager } from "../../shared/database.js";
import { PresentStore } from "../present-store.js";

// ---------------------------------------------------------------------------
// Minimal agent stub (the worker requires an agentFactory; the present path
// never spawns it).
// ---------------------------------------------------------------------------

class FakeWorkerAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "claude";
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };
  readonly isStreaming = false;
  run(_params: AgentRunParams): void {}
  writeStdin(_data: string): void {}
  sendUserMessage(_text: string): void {}
  interrupt(): void {}
  kill(): void {}
  writeMcpConfig(): { mcpConfigPath?: string; runtimeEnv?: Record<string, string>; cleanup?: () => void } {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(fn: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

/** Pick a file extension that infers (or matches) the given MIME type. */
function extForMime(mimeType: string | undefined): string {
  switch (mimeType) {
    case "text/plain":
      return "txt";
    case "image/svg+xml":
      return "svg";
    case undefined:
    case "text/html":
    default:
      return "html";
  }
}

/**
 * Fetch an artifact's raw bytes from the worker's lazy disk-read endpoint —
 * the same `{ content, mimeType }` the orchestrator proxies to the Present tab.
 * Metadata rides the WS messages; bytes are only ever read on demand here.
 */
async function fetchRaw(workerUrl: string, presentId: string): Promise<{ content: string; mimeType: string }> {
  const res = await fetch(`${workerUrl}/present/${presentId}/raw`);
  expect(res.ok).toBe(true);
  return (await res.json()) as { content: string; mimeType: string };
}

/**
 * Write the artifact to a temp file and POST its absolute path to the worker's
 * file-based submit broker (docs/188). The worker records only the path; bytes
 * are read from disk on demand (see {@link fetchRaw}). `mimeType` is forwarded
 * only when explicitly set (it overrides extension inference); omitting it
 * exercises the inference path.
 */
async function submitPresent(
  workerUrl: string,
  body: { content: string; mimeType?: string; title?: string; file?: string },
): Promise<{ presentId: string; status: string; filePath: string }> {
  // A fixed `file` re-presents the same path (in-place update); otherwise each
  // submission gets a fresh path → a distinct presentId → a new carousel entry.
  const filePath = body.file ?? path.join(tmpDir, `artifact-${fileCounter++}.${extForMime(body.mimeType)}`);
  await writeFile(filePath, body.content, "utf8");
  const res = await fetch(`${workerUrl}/agent-ops/present/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file: filePath,
      ...(body.mimeType !== undefined ? { mimeType: body.mimeType } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
    }),
  });
  expect(res.ok).toBe(true);
  const json = (await res.json()) as { presentId: string; status: string };
  return { ...json, filePath };
}

/** Temp dir holding the artifact files each submission writes. */
let tmpDir: string;
/** Monotonic counter so each submission writes a uniquely-named file. */
let fileCounter = 0;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: present tool pipeline (worker → SSE → runner WS)", () => {
  let worker: SessionWorker;
  let workerUrl: string;
  let runner: ContainerSessionRunner;
  /** Every WS message the runner broadcast to viewers, in order. */
  let messages: WsServerMessage[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "present-flow-"));
    fileCounter = 0;
    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      // Treat the temp dir as the workspace so submitted artifacts resolve there.
      workspaceDir: tmpDir,
    });
    const address = await worker.start();
    const port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
    workerUrl = `http://127.0.0.1:${port}`;

    runner = new ContainerSessionRunner({
      sessionId: "present-session",
      sessionDir: "/tmp/present-test",
      defaultAgentId: "claude",
      workerUrl,
    });
    messages = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));

    // attachViewer() starts the SSE connection to the worker. Give it a beat to
    // connect so the first broadcast is delivered (mirrors container-agent-wiring).
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    runner.dispose({ force: true });
    await worker.stop();
    await rm(tmpDir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 50));
  });

  function presentContentMsgs(): WsPresentContentMessage[] {
    return messages.filter((m): m is WsPresentContentMessage => m.type === "present_content");
  }
  function presentClearedMsgs(): WsPresentClearedMessage[] {
    return messages.filter((m): m is WsPresentClearedMessage => m.type === "present_cleared");
  }

  it("translates a worker submit into a present_content WS message and caches it", async () => {
    const { presentId, filePath } = await submitPresent(workerUrl, {
      content: "<h1>Chart</h1>",
      mimeType: "text/html",
      title: "Sales Chart",
    });

    await waitFor(() => presentContentMsgs().length >= 1, 3000, "present_content WS message");

    const msg = presentContentMsgs()[0];
    expect(msg.type).toBe("present_content");
    expect(msg.sessionId).toBe("present-session"); // runner's id, not the worker's env
    expect(msg.presentId).toBe(presentId);
    expect(msg.mimeType).toBe("text/html");
    expect(msg.title).toBe("Sales Chart");
    // The presented file path rides through verbatim so the header can show it.
    expect(msg.filePath).toBe(filePath);
    expect(typeof msg.createdAt).toBe("string");
    // The WS message carries NO bytes — content is fetched lazily from disk.
    expect((msg as { content?: unknown }).content).toBeUndefined();

    // The runner caches metadata only — this is what `present_state` replays to
    // a viewer that attaches after the tool fired (index.ts attachToRunner reads
    // runner.presentations).
    expect(runner.presentations).toHaveLength(1);
    expect(runner.presentations[0]).toMatchObject({
      presentId,
      mimeType: "text/html",
      title: "Sales Chart",
      filePath,
    });
    expect((runner.presentations[0] as { content?: unknown }).content).toBeUndefined();

    // The bytes are served on demand from disk via the raw endpoint.
    expect(await fetchRaw(workerUrl, presentId)).toMatchObject({
      content: "<h1>Chart</h1>",
      mimeType: "text/html",
    });
  });

  it("presents an artifact that lives outside the workspace", async () => {
    // Write the file to a sibling temp dir that is NOT the worker's workspaceDir,
    // then submit its absolute path. The path rides through verbatim and the
    // bytes are still served on demand — there is no in/out-of-workspace concept.
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "present-outside-"));
    const outsidePath = path.join(outsideDir, "throwaway.html");
    await writeFile(outsidePath, "<p>throwaway</p>", "utf8");
    try {
      const res = await fetch(`${workerUrl}/agent-ops/present/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: outsidePath, mimeType: "text/html" }),
      });
      expect(res.ok).toBe(true);
      const { presentId } = (await res.json()) as { presentId: string };

      await waitFor(
        () => presentContentMsgs().some((m) => m.presentId === presentId),
        3000,
        "present_content for outside-workspace artifact",
      );
      const msg = presentContentMsgs().find((m) => m.presentId === presentId)!;
      expect(msg.filePath).toBe(outsidePath);
      expect((await fetchRaw(workerUrl, presentId)).content).toBe("<p>throwaway</p>");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("infers text/html from the .html extension when mimeType is omitted", async () => {
    const { presentId } = await submitPresent(workerUrl, { content: "<p>no mime</p>" });
    await waitFor(() => presentContentMsgs().length >= 1, 3000, "present_content");
    const msg = presentContentMsgs().find((m) => m.presentId === presentId)!;
    expect(msg.mimeType).toBe("text/html");
  });

  it("rejects a submit whose file does not exist", async () => {
    const res = await fetch(`${workerUrl}/agent-ops/present/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: path.join(tmpDir, "does-not-exist.html") }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Could not read file");
  });

  it("re-presenting the same file updates the entry in place under the same id", async () => {
    const samePath = path.join(tmpDir, "mockup.html");
    const first = await submitPresent(workerUrl, {
      content: "<p>v1</p>",
      mimeType: "text/html",
      title: "Mockup v1",
      file: samePath,
    });
    await waitFor(() => presentContentMsgs().length >= 1, 3000, "first present_content");

    const second = await submitPresent(workerUrl, {
      content: "<p>v2</p>",
      mimeType: "text/html",
      title: "Mockup v2",
      file: samePath,
    });
    // Identity is the path: re-presenting the same file yields the SAME id (no
    // explicit replace flag), so the entry updates in place.
    expect(second.presentId).toBe(first.presentId);

    await waitFor(
      () => presentContentMsgs().some((m) => m.title === "Mockup v2"),
      3000,
      "updated present_content",
    );

    // No per-id present_cleared is emitted — there is nothing to supersede.
    expect(presentClearedMsgs()).toHaveLength(0);

    // Cache holds exactly one entry under the stable id, with the new bytes.
    expect(runner.presentations).toHaveLength(1);
    expect(runner.presentations[0].presentId).toBe(first.presentId);
    expect(runner.presentations[0].title).toBe("Mockup v2");
    expect((await fetchRaw(workerUrl, first.presentId)).content).toBe("<p>v2</p>");
  });

  it("presenting two distinct files keeps both as separate carousel entries", async () => {
    const a = await submitPresent(workerUrl, { content: "<p>a</p>", mimeType: "text/html", title: "A" });
    const b = await submitPresent(workerUrl, { content: "<p>b</p>", mimeType: "text/html", title: "B" });
    expect(a.presentId).not.toBe(b.presentId);
    await waitFor(
      () => runner.presentations.length >= 2,
      3000,
      "both present_content entries cached",
    );
    expect(runner.presentations.map((p) => p.presentId)).toEqual([a.presentId, b.presentId]);
  });

  it("keeps every presented artifact — no size or count eviction", async () => {
    // The registry holds only metadata, so there is nothing to cap: submit a
    // batch and assert they ALL stay cached, none evicted, none cleared.
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { presentId } = await submitPresent(workerUrl, { content: `entry-${i}`, mimeType: "text/plain" });
      ids.push(presentId);
    }
    await waitFor(() => presentContentMsgs().length >= 25, 5000, "25 present_content messages");

    expect(runner.presentations).toHaveLength(25);
    expect(runner.presentations.map((p) => p.presentId)).toEqual(ids);
    // No spontaneous clears — the only present_cleared paths are revision + full clear.
    expect(presentClearedMsgs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Durable persistence across a container restart (docs/093)
//
// A runner constructed with a PresentStore persists each present_content to the
// store and seeds its cache from the store at construction. After a simulated
// restart (fresh worker, empty registry) a NEW runner over the SAME store still
// carries the presentation (so `present_state` replays it) and can serve the
// bytes again — re-registering the artifact with the fresh worker on the first
// raw-read miss. A throwaway whose file is gone surfaces a graceful 404.
// ---------------------------------------------------------------------------

describe("Integration: present persistence across container restart", () => {
  let dbManager: DatabaseManager;
  let presentStore: PresentStore;
  let work: string;

  beforeEach(async () => {
    dbManager = new DatabaseManager(":memory:");
    presentStore = new PresentStore(dbManager);
    work = await mkdtemp(path.join(os.tmpdir(), "present-restart-"));
  });

  afterEach(async () => {
    dbManager.close();
    await rm(work, { recursive: true, force: true });
  });

  async function startWorker(): Promise<{ worker: SessionWorker; url: string }> {
    const worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      workspaceDir: work,
    });
    const address = await worker.start();
    const port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
    return { worker, url: `http://127.0.0.1:${port}` };
  }

  function makeRunner(url: string): ContainerSessionRunner {
    const runner = new ContainerSessionRunner({
      sessionId: "restart-session",
      sessionDir: "/tmp/present-restart-test",
      defaultAgentId: "claude",
      workerUrl: url,
      presentStore,
    });
    runner.attachViewer();
    return runner;
  }

  async function submit(url: string, file: string, content: string): Promise<string> {
    await writeFile(file, content, "utf8");
    const res = await fetch(`${url}/agent-ops/present/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, mimeType: "text/html" }),
    });
    expect(res.ok).toBe(true);
    return ((await res.json()) as { presentId: string }).presentId;
  }

  it("persists a presentation and re-serves it after a fresh-worker restart", async () => {
    const filePath = path.join(work, "committed.html");

    // --- Before restart: present an artifact on worker A. ---
    const a = await startWorker();
    const runnerA = makeRunner(a.url);
    await new Promise((r) => setTimeout(r, 200));
    const presentId = await submit(a.url, filePath, "<h1>kept</h1>");
    await waitFor(() => presentStore.list("restart-session").length === 1, 3000, "persisted");

    const persisted = presentStore.list("restart-session")[0];
    expect(persisted.presentId).toBe(presentId);
    expect(persisted.resolvedPath).toBe(filePath); // re-serve target after restart

    runnerA.dispose({ force: true });
    await a.worker.stop();

    // --- Restart: worker B is fresh (empty registry); the file is still on disk
    // (it's a "committed workspace file"). A NEW runner over the same store. ---
    const b = await startWorker();
    const runnerB = makeRunner(b.url);
    await new Promise((r) => setTimeout(r, 100));

    // Seeded from the store → `present_state` would replay it.
    expect(runnerB.presentations.map((p) => p.presentId)).toEqual([presentId]);

    // The fresh worker's registry is empty, so the first raw read 404s; the
    // runner re-registers from the persisted resolvedPath and retries.
    const raw = await runnerB.proxyPresentRaw(presentId);
    expect(raw.content).toBe("<h1>kept</h1>");
    expect(raw.mimeType).toBe("text/html");

    runnerB.dispose({ force: true });
    await b.worker.stop();
  });

  it("surfaces a graceful error when the source file is gone after restart", async () => {
    const filePath = path.join(work, "throwaway.html");

    const a = await startWorker();
    const runnerA = makeRunner(a.url);
    await new Promise((r) => setTimeout(r, 200));
    const presentId = await submit(a.url, filePath, "<p>temp</p>");
    await waitFor(() => presentStore.list("restart-session").length === 1, 3000, "persisted");
    runnerA.dispose({ force: true });
    await a.worker.stop();

    // Simulate a /tmp throwaway that did NOT survive the restart.
    await rm(filePath, { force: true });

    const b = await startWorker();
    const runnerB = makeRunner(b.url);
    await new Promise((r) => setTimeout(r, 100));

    // Metadata still seeds the tab, but serving the bytes fails gracefully
    // (re-register succeeds, the on-disk read 404s) → the Present tab shows its
    // "no longer available" placeholder rather than crashing.
    expect(runnerB.presentations.map((p) => p.presentId)).toEqual([presentId]);
    await expect(runnerB.proxyPresentRaw(presentId)).rejects.toThrow();

    runnerB.dispose({ force: true });
    await b.worker.stop();
  });
});
