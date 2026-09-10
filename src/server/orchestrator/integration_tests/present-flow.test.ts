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

async function waitFor(fn: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

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

async function fetchRaw(workerUrl: string, presentId: string): Promise<{ content: string; mimeType: string }> {
  const res = await fetch(`${workerUrl}/present/${presentId}/raw`);
  expect(res.ok).toBe(true);
  return (await res.json()) as { content: string; mimeType: string };
}

async function submitPresent(
  workerUrl: string,
  body: { content: string; mimeType?: string; title?: string; file?: string },
): Promise<{ presentId: string; status: string; filePath: string }> {
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

let tmpDir: string;
let fileCounter = 0;

describe("Integration: present tool pipeline (worker → SSE → runner WS)", () => {
  let worker: SessionWorker;
  let workerUrl: string;
  let runner: ContainerSessionRunner;
  let messages: WsServerMessage[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "present-flow-"));
    fileCounter = 0;
    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
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

    // Let SSE connect before the first presentation is broadcast.
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
    expect(msg.sessionId).toBe("present-session");
    expect(msg.presentId).toBe(presentId);
    expect(msg.mimeType).toBe("text/html");
    expect(msg.title).toBe("Sales Chart");
    expect(msg.filePath).toBe(filePath);
    expect(typeof msg.createdAt).toBe("string");
    expect((msg as { content?: unknown }).content).toBeUndefined();

    expect(runner.presentations).toHaveLength(1);
    expect(runner.presentations[0]).toMatchObject({
      presentId,
      mimeType: "text/html",
      title: "Sales Chart",
      filePath,
    });
    expect((runner.presentations[0] as { content?: unknown }).content).toBeUndefined();

    expect(await fetchRaw(workerUrl, presentId)).toMatchObject({
      content: "<h1>Chart</h1>",
      mimeType: "text/html",
    });
  });

  it("presents an artifact that lives outside the workspace", async () => {
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
    expect(second.presentId).toBe(first.presentId);

    await waitFor(
      () => presentContentMsgs().some((m) => m.title === "Mockup v2"),
      3000,
      "updated present_content",
    );

    expect(presentClearedMsgs()).toHaveLength(0);

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
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { presentId } = await submitPresent(workerUrl, { content: `entry-${i}`, mimeType: "text/plain" });
      ids.push(presentId);
    }
    await waitFor(() => presentContentMsgs().length >= 25, 5000, "25 present_content messages");

    expect(runner.presentations).toHaveLength(25);
    expect(runner.presentations.map((p) => p.presentId)).toEqual(ids);
    expect(presentClearedMsgs()).toHaveLength(0);
  });
});

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

    const a = await startWorker();
    const runnerA = makeRunner(a.url);
    await new Promise((r) => setTimeout(r, 200));
    const presentId = await submit(a.url, filePath, "<h1>kept</h1>");
    await waitFor(() => presentStore.list("restart-session").length === 1, 3000, "persisted");

    const persisted = presentStore.list("restart-session")[0];
    expect(persisted.presentId).toBe(presentId);
    expect(persisted.resolvedPath).toBe(filePath);

    runnerA.dispose({ force: true });
    await a.worker.stop();

    const b = await startWorker();
    const runnerB = makeRunner(b.url);
    await new Promise((r) => setTimeout(r, 100));

    expect(runnerB.presentations.map((p) => p.presentId)).toEqual([presentId]);

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

    await rm(filePath, { force: true });

    const b = await startWorker();
    const runnerB = makeRunner(b.url);
    await new Promise((r) => setTimeout(r, 100));

    expect(runnerB.presentations.map((p) => p.presentId)).toEqual([presentId]);
    await expect(runnerB.proxyPresentRaw(presentId)).rejects.toThrow();

    runnerB.dispose({ force: true });
    await b.worker.stop();
  });
});

describe("Integration: inline presentations (docs/280)", () => {
  let dbManager: DatabaseManager;
  let presentStore: PresentStore;
  let work: string;
  let worker: SessionWorker;
  let workerUrl: string;
  let runner: ContainerSessionRunner;
  let messages: WsServerMessage[];
  // Capture history writes; this fixture does not persist transcript rows.
  let appended: { presentInline?: { presentId: string; filePath: string } }[];

  beforeEach(async () => {
    dbManager = new DatabaseManager(":memory:");
    presentStore = new PresentStore(dbManager);
    work = await mkdtemp(path.join(os.tmpdir(), "present-inline-"));
    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      workspaceDir: work,
    });
    const address = await worker.start();
    workerUrl = `http://127.0.0.1:${Number(/:(\d+)$/.exec(address)?.[1] ?? 0)}`;

    appended = [];
    runner = new ContainerSessionRunner({
      sessionId: "inline-session",
      sessionDir: "/tmp/present-inline-test",
      defaultAgentId: "claude",
      workerUrl,
      presentStore,
      chatHistoryManager: {
        replaceInProgress: () => {},
        append: (_sessionId, message) => {
          appended.push(message as (typeof appended)[number]);
        },
      },
    });
    messages = [];
    runner.on("message", (m: WsServerMessage) => messages.push(m));
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    runner.dispose({ force: true });
    await worker.stop();
    dbManager.close();
    await rm(work, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 50));
  });

  async function present(file: string, content: string, inline?: boolean): Promise<void> {
    await writeFile(file, content, "utf8");
    const res = await fetch(`${workerUrl}/agent-ops/present/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, ...(inline !== undefined ? { inline } : {}) }),
    });
    expect(res.ok).toBe(true);
  }

  function cards(): Extract<WsServerMessage, { type: "present_inline_card" }>[] {
    return messages.filter(
      (m): m is Extract<WsServerMessage, { type: "present_inline_card" }> =>
        m.type === "present_inline_card",
    );
  }

  it("emits no card for an ordinary present", async () => {
    await present(path.join(work, "plain.html"), "<h1>plain</h1>");
    await waitFor(() => presentStore.list("inline-session").length === 1, 3000, "recorded");
    expect(cards()).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });

  it("emits and persists one card, and still adds the artifact to the carousel", async () => {
    const file = path.join(work, "chart.html");
    await present(file, "<h1>chart</h1>", true);
    await waitFor(() => cards().length === 1, 3000, "card");

    const card = cards()[0].card;
    expect(card.filePath).toBe(file);
    expect(card.mimeType).toBe("text/html");
    expect(runner.presentations.map((p) => p.presentId)).toEqual([card.presentId]);
    expect(runner.presentations[0].inline).toBe(true);
    expect(appended.map((m) => m.presentInline?.presentId)).toEqual([card.presentId]);
  });

  it("refreshes the artifact rather than stacking a second card on re-present", async () => {
    const file = path.join(work, "iterate.html");
    await present(file, "<h1>v1</h1>", true);
    await waitFor(() => cards().length === 1, 3000, "first card");

    await present(file, "<h1>v2</h1>", true);
    await present(file, "<h1>v3</h1>");
    await waitFor(
      () => messages.filter((m) => m.type === "present_content").length === 3,
      3000,
      "three content updates",
    );

    expect(cards()).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(presentStore.list("inline-session")[0].inline).toBe(true);
  });

  it("promotes an already-presented artifact when it is later presented inline", async () => {
    const file = path.join(work, "promote.svg");
    await present(file, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await waitFor(() => presentStore.list("inline-session").length === 1, 3000, "recorded");
    expect(cards()).toHaveLength(0);

    await present(file, "<svg xmlns='http://www.w3.org/2000/svg'/>", true);
    await waitFor(() => cards().length === 1, 3000, "card");
    expect(cards()[0].card.mimeType).toBe("image/svg+xml");
  });

  it("does not re-emit the card for a re-present after a container restart", async () => {
    const file = path.join(work, "restart.html");
    await present(file, "<h1>kept</h1>", true);
    await waitFor(() => cards().length === 1, 3000, "card");

    runner.dispose({ force: true });
    await worker.stop();
    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      workspaceDir: work,
    });
    const address = await worker.start();
    workerUrl = `http://127.0.0.1:${Number(/:(\d+)$/.exec(address)?.[1] ?? 0)}`;
    const restartedCards: WsServerMessage[] = [];
    runner = new ContainerSessionRunner({
      sessionId: "inline-session",
      sessionDir: "/tmp/present-inline-test",
      defaultAgentId: "claude",
      workerUrl,
      presentStore,
      chatHistoryManager: {
        replaceInProgress: () => {},
        append: (_sessionId, message) => {
          appended.push(message as (typeof appended)[number]);
        },
      },
    });
    runner.on("message", (m: WsServerMessage) => restartedCards.push(m));
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    await present(file, "<h1>kept v2</h1>", true);
    await waitFor(
      () => restartedCards.some((m) => m.type === "present_content"),
      3000,
      "content after restart",
    );
    expect(restartedCards.filter((m) => m.type === "present_inline_card")).toHaveLength(0);
    expect(appended).toHaveLength(1);
  });
});
