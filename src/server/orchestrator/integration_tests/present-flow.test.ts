/**
 * End-to-end integration test for the `present` tool pipeline (docs/093).
 *
 * Drives the full server-side path with a REAL session worker (no Docker):
 *
 *   worker POST /agent-ops/present/submit
 *     → worker stores in its PresentBuffer + broadcasts a `present_content` SSE
 *     → ContainerSessionRunner's SSE client receives it (handleSSEEvent)
 *     → runner translates it into a `present_content` WS message + caches it
 *
 * Listening on `runner.on("message")` captures the exact `WsServerMessage` the
 * orchestrator relays to every attached viewer — i.e. what a TestClient would
 * receive as `WsPresentContentMessage`. We assert the translated message shape,
 * the runner's `presentations` cache (the authoritative source the
 * `present_state` replay reads on viewer attach), and the `present_cleared`
 * path via the worker's LRU eviction.
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
 * Write the artifact to a temp file and POST its absolute path to the worker's
 * file-based submit broker (docs/188). The worker reads the file back into the
 * `content` field, so downstream assertions on `content` still hold. `mimeType`
 * is forwarded only when explicitly set (it overrides extension inference);
 * omitting it exercises the inference path.
 */
async function submitPresent(
  workerUrl: string,
  body: { content: string; mimeType?: string; title?: string; replaceId?: string },
): Promise<{ presentId: string; status: string; filePath: string }> {
  const filePath = path.join(tmpDir, `artifact-${fileCounter++}.${extForMime(body.mimeType)}`);
  await writeFile(filePath, body.content, "utf8");
  const res = await fetch(`${workerUrl}/agent-ops/present/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file: filePath,
      ...(body.mimeType !== undefined ? { mimeType: body.mimeType } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.replaceId !== undefined ? { replaceId: body.replaceId } : {}),
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
      // Treat the temp dir as the workspace so artifacts submitted from it count
      // as in-workspace (drives the `inWorkspace` flag the UI uses to hide Save).
      workspaceDir: tmpDir,
      // Shrink the memory backstop so the eviction path is reachable in a test
      // (production default is 256 MB — never hit by real sessions). There is no
      // per-artifact or entry-count cap to exercise anymore.
      presentBufferOptions: { maxTotalBytes: 40 },
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
    expect(msg.content).toBe("<h1>Chart</h1>");
    expect(msg.mimeType).toBe("text/html");
    expect(msg.title).toBe("Sales Chart");
    // The presented file path rides through verbatim so the header can show it.
    expect(msg.filePath).toBe(filePath);
    // The artifact was written under the worker's workspaceDir (the temp dir),
    // so it's flagged in-workspace — the UI hides Save for it.
    expect(msg.inWorkspace).toBe(true);
    expect(typeof msg.createdAt).toBe("string");
    expect(msg.replaceId).toBeUndefined();

    // The runner caches the entry — this is what `present_state` replays to a
    // viewer that attaches after the tool fired (index.ts attachToRunner reads
    // runner.presentations).
    expect(runner.presentations).toHaveLength(1);
    expect(runner.presentations[0]).toMatchObject({
      presentId,
      content: "<h1>Chart</h1>",
      mimeType: "text/html",
      title: "Sales Chart",
      filePath,
      inWorkspace: true,
    });
  });

  it("flags an artifact outside the workspace as not in-workspace", async () => {
    // Write the file to a sibling temp dir that is NOT the worker's workspaceDir,
    // then submit its absolute path — it resolves outside the workspace.
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
      expect(msg.inWorkspace).toBe(false);
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

  it("revises in place via replaceId and clears the superseded id", async () => {
    const first = await submitPresent(workerUrl, {
      content: "<p>v1</p>",
      mimeType: "text/html",
      title: "Mockup v1",
    });
    await waitFor(() => presentContentMsgs().length >= 1, 3000, "first present_content");

    const second = await submitPresent(workerUrl, {
      content: "<p>v2</p>",
      mimeType: "text/html",
      title: "Mockup v2",
      replaceId: first.presentId,
    });
    // The revision yields a new presentId distinct from the one it replaces.
    expect(second.presentId).not.toBe(first.presentId);

    await waitFor(
      () => presentContentMsgs().some((m) => m.presentId === second.presentId),
      3000,
      "revision present_content",
    );

    const revision = presentContentMsgs().find((m) => m.presentId === second.presentId)!;
    expect(revision.replaceId).toBe(first.presentId);
    expect(revision.content).toBe("<p>v2</p>");

    // The worker also broadcasts a present_cleared for the superseded id.
    await waitFor(
      () => presentClearedMsgs().some((m) => m.presentId === first.presentId),
      3000,
      "present_cleared for superseded id",
    );

    // Cache holds exactly one entry: the revision replaced the original in place
    // (the trailing clear for the now-absent old id is a no-op).
    expect(runner.presentations).toHaveLength(1);
    expect(runner.presentations[0].presentId).toBe(second.presentId);
    expect(runner.presentations[0].content).toBe("<p>v2</p>");
  });

  it("emits present_cleared and LRU-evicts the oldest only when the memory backstop is exceeded", async () => {
    // The worker's backstop is shrunk to 40 bytes in beforeEach (production
    // default is 256 MB). Four 10-byte artifacts sit exactly at budget; a fifth
    // pushes over and evicts the oldest. There is no per-artifact size cap and
    // no entry-count cap — only this byte ceiling bounds the buffer.
    const first = await submitPresent(workerUrl, { content: "0123456789", mimeType: "text/plain" });
    for (let i = 1; i < 4; i++) {
      await submitPresent(workerUrl, { content: "0123456789", mimeType: "text/plain" });
    }
    await waitFor(() => presentContentMsgs().length >= 4, 5000, "4 present_content messages");
    expect(runner.presentations).toHaveLength(4);

    // The fifth submission pushes total bytes over the 40-byte backstop, forcing
    // eviction of the oldest (first) entry.
    const evictor = await submitPresent(workerUrl, { content: "0123456789", mimeType: "text/plain" });

    await waitFor(
      () => presentClearedMsgs().some((m) => m.presentId === first.presentId),
      3000,
      "present_cleared for evicted oldest entry",
    );

    const cleared = presentClearedMsgs().find((m) => m.presentId === first.presentId)!;
    expect(cleared.type).toBe("present_cleared");
    expect(cleared.sessionId).toBe("present-session");

    // Buffer holds four entries: oldest dropped, newest present.
    expect(runner.presentations).toHaveLength(4);
    expect(runner.presentations.some((p) => p.presentId === first.presentId)).toBe(false);
    expect(runner.presentations.some((p) => p.presentId === evictor.presentId)).toBe(true);
  });
});
