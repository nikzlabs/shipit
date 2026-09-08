import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import {
  describeDrift,
  fingerprintOf,
  frameDelayMs,
  parseResponseFile,
  serializeResponse,
  splitSseFrames,
} from "./proxy.mjs";

/**
 * The record/replay proxy of docs/296 plan §2, exercised as a process: replay
 * against the committed fixture cassette, record against a local fake upstream
 * (the framing of `/persist/harness-probe/fake-api.mjs`, which the proxy
 * replaced). Nothing here reaches the network.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY = join(HERE, "proxy.mjs");
const FIXTURE_CASSETTE = join(HERE, "__fixtures__", "cassette");

interface RunningProxy {
  child: ChildProcess;
  port: number;
  stderr: () => string;
  url: (path: string) => string;
}

async function startProxy(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunningProxy> {
  const child = spawn(process.execPath, [PROXY, ...args, "--port", "0", "--host", "127.0.0.1"], {
    env: { ...process.env, DEMO_PROXY_ANTHROPIC_API_KEY: undefined, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n")) resolve(Number(line));
    });
    child.on("exit", (code) => reject(new Error(`proxy exited with ${code}: ${err}`)));
  });
  return { child, port, stderr: () => err, url: (path) => `http://127.0.0.1:${port}${path}` };
}

function stopProxy(p: RunningProxy | undefined): Promise<void> {
  if (!p || p.child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    p.child.once("exit", () => resolve());
    p.child.kill("SIGTERM");
  });
}

/** Runs the proxy expecting it to refuse at startup; resolves with exit code + stderr. */
function runUntilExit(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROXY, ...args, "--port", "0"], {
      env: { ...process.env, DEMO_PROXY_ANTHROPIC_API_KEY: undefined, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

const fixtureBody = (lane: string, n: string): Buffer =>
  parseResponseFile(readFileSync(join(FIXTURE_CASSETTE, lane, `${n}.sse`))).body;

const messagesRequest = (p: RunningProxy, headers: Record<string, string>, body: unknown = {}) =>
  fetch(p.url("/v1/messages?beta=true"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const DUMMY = { "x-api-key": "sk-ant-demo" };
const BEARER = { authorization: "Bearer oauth-token" };

describe("pure helpers", () => {
  it("splits SSE frames so that rejoining them reproduces the bytes", () => {
    const body = Buffer.from("event: a\ndata: {}\n\nevent: b\r\ndata: {}\r\n\r\ntrailing");
    const frames = splitSseFrames(body);
    expect(frames.map((f) => f.toString())).toEqual(["event: a\ndata: {}\n\n", "event: b\r\ndata: {}\r\n\r\n", "trailing"]);
    expect(Buffer.concat(frames).equals(body)).toBe(true);
  });

  it("paces text deltas at cps, tool-input JSON at 4x, everything else immediately", () => {
    const frame = (data: unknown) => Buffer.from(`event: x\ndata: ${JSON.stringify(data)}\n\n`);
    const text = frame({ type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(120) } });
    const tool = frame({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "x".repeat(120) } });
    const other = frame({ type: "message_start" });
    expect(frameDelayMs(text, 120)).toBe(1000);
    expect(frameDelayMs(tool, 120)).toBe(250);
    expect(frameDelayMs(other, 120)).toBe(0);
    expect(frameDelayMs(Buffer.from("data: not json\n\n"), 120)).toBe(0);
  });

  it("round-trips a response through the cassette file format, dropping framing headers", () => {
    const body = Buffer.from("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    const file = serializeResponse(200, { "Content-Type": "text/event-stream", "transfer-encoding": "chunked", "x-multi": ["a", "b"] }, body);
    const parsed = parseResponseFile(file);
    expect(parsed.status).toBe(200);
    expect(parsed.headers).toEqual({ "content-type": "text/event-stream", "x-multi": ["a", "b"] });
    expect(parsed.body.equals(body)).toBe(true);
  });

  it("fingerprints the fields the probe logged and names what drifted", () => {
    const fp = fingerprintOf(Buffer.from(JSON.stringify({ model: "m", messages: [1, 2], tools: [1], stream: true })));
    expect(fp).toEqual({ model: "m", messages: 2, tools: 1, bodyBytes: 56, stream: true });
    expect(describeDrift(fp, fp)).toBeNull();
    expect(describeDrift(fp, { ...fp, messages: 3, bodyBytes: 999 })).toBe('messages: recorded=2 got=3');
  });
});

describe("replay mode", () => {
  let fast: RunningProxy | undefined;
  beforeAll(async () => {
    fast = await startProxy(["--replay", FIXTURE_CASSETTE, "--pace-chars-per-second", "1000000"]);
  });
  afterAll(() => stopProxy(fast));

  it("answers lane request n with <lane>/NNN.sse, counting each lane separately, then 400 when exhausted", async () => {
    const p = fast!;
    const first = await messagesRequest(p, DUMMY, { model: "claude-fixture", messages: [1], tools: [1, 2], stream: true });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(first.headers.get("request-id")).toBe("req_fixture");
    expect(Buffer.from(await first.arrayBuffer()).equals(fixtureBody("x-api-key", "001"))).toBe(true);

    // The bearer lane has its own counter: its first request is bearer/001, not x-api-key/002.
    const bearer = await messagesRequest(p, BEARER, { model: "claude-fixture", messages: [1], stream: true });
    expect(bearer.status).toBe(200);
    expect(Buffer.from(await bearer.arrayBuffer()).equals(fixtureBody("bearer", "001"))).toBe(true);

    // The cassette recorded request 2 with three messages; this take sends two. Drift, but still answered.
    const second = await messagesRequest(p, DUMMY, { model: "claude-fixture", messages: [1, 2], tools: [1, 2], stream: true });
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer()).equals(fixtureBody("x-api-key", "002"))).toBe(true);

    const third = await messagesRequest(p, DUMMY);
    expect(third.status).toBe(400);
    expect(await third.json()).toMatchObject({ error: { message: expect.stringContaining("exhausted") as string } });

    const bearerExhausted = await messagesRequest(p, BEARER);
    expect(bearerExhausted.status).toBe(400);

    // Drift was logged as a warning but every request above was still answered.
    expect(p.stderr()).not.toContain("cassette drift lane=x-api-key n=1");
    expect(p.stderr()).toContain("cassette drift lane=x-api-key n=2: messages: recorded=3 got=2");
    expect(p.stderr()).toMatch(/replay lane=x-api-key n=1 POST \/v1\/messages\?beta=true 200 \d+ms/);
    expect(p.stderr()).toMatch(/replay lane=bearer n=1 POST \/v1\/messages\?beta=true 200 \d+ms/);
  });

  it("answers HEAD /api/hello with 200 and anything else with 404 JSON", async () => {
    const p = fast!;
    const hello = await fetch(p.url("/api/hello"), { method: "HEAD" });
    expect(hello.status).toBe(200);
    const other = await fetch(p.url("/v1/models"));
    expect(other.status).toBe(404);
    expect(other.headers.get("content-type")).toBe("application/json");
    expect(await other.json()).toMatchObject({ error: { type: "not_found" } });
    const postElsewhere = await fetch(p.url("/v1/complete"), { method: "POST", body: "{}" });
    expect(postElsewhere.status).toBe(404);
  });

  it("refuses a lane the cassette never recorded with 401", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "demo-proxy-lane-"));
    let p: RunningProxy | undefined;
    try {
      // Only the x-api-key lane exists in this cassette.
      const { cpSync } = await import("node:fs");
      cpSync(join(FIXTURE_CASSETTE, "x-api-key"), join(dir, "x-api-key"), { recursive: true });
      p = await startProxy(["--replay", dir]);
      const res = await messagesRequest(p, BEARER);
      expect(res.status).toBe(401);
    } finally {
      await stopProxy(p);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("paces a 240-char text delta at 120 cps over at least 1.5 s", async () => {
    const p = await startProxy(["--replay", FIXTURE_CASSETTE]);
    try {
      const started = Date.now();
      const res = await messagesRequest(p, DUMMY);
      const body = Buffer.from(await res.arrayBuffer());
      const elapsed = Date.now() - started;
      expect(body.equals(fixtureBody("x-api-key", "001"))).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(1500);
    } finally {
      await stopProxy(p);
    }
  });

  it("survives a client that disconnects mid-stream and keeps serving", async () => {
    const p = await startProxy(["--replay", FIXTURE_CASSETTE]);
    try {
      const controller = new AbortController();
      const pending = fetch(p.url("/v1/messages"), {
        method: "POST",
        headers: { "content-type": "application/json", ...DUMMY },
        body: "{}",
        signal: controller.signal,
      });
      const res = await pending;
      // Headers are in; the 240-char delta is still being paced. Walk away.
      await new Promise((r) => setTimeout(r, 200));
      controller.abort();
      await expect(res.arrayBuffer()).rejects.toThrow();

      // The proxy is still up and the lane counter advanced past the abandoned take.
      const next = await messagesRequest(p, DUMMY);
      expect(next.status).toBe(200);
      expect(Buffer.from(await next.arrayBuffer()).equals(fixtureBody("x-api-key", "002"))).toBe(true);
      expect(p.child.exitCode).toBeNull();

      // The abandoned take was settled the moment the client left — its log line is
      // already there, well before the 2 s the 240-char delta would have taken to pace.
      expect(p.stderr()).toMatch(/replay lane=x-api-key n=1 POST \/v1\/messages 200 \d+ms client disconnected after \d+\/\d+ frames/);
    } finally {
      await stopProxy(p);
    }
  });
});

describe("record mode", () => {
  interface Seen {
    headers: http.IncomingHttpHeaders;
    body: string;
    url: string;
  }
  const seen: Seen[] = [];
  let upstream: http.Server;
  let upstreamUrl: string;
  const REPLY = "hi";
  const sseBody = (model: string) =>
    [
      ["message_start", { type: "message_start", message: { id: "msg_fake_0001", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }],
    ]
      .map(([event, data]) => `event: ${event as string}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");

  beforeAll(async () => {
    // The fake vendor API of the harness probe, reduced to what record mode needs.
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ headers: req.headers, body, url: req.url ?? "" });
        if (req.headers["x-api-key"] === "sk-ant-demo") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "authentication_error", message: "dummy key reached upstream" } }));
          return;
        }
        let parsed: { model?: string } = {};
        try {
          parsed = JSON.parse(body) as { model?: string };
        } catch {
          parsed = {};
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_upstream_1", connection: "keep-alive" });
        res.end(sseBody(parsed.model ?? "claude-fake"));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

  it("refuses to start without DEMO_PROXY_ANTHROPIC_API_KEY", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "demo-proxy-rec-"));
    try {
      const { code, stderr } = await runUntilExit(["--record", dir, "--upstream", upstreamUrl]);
      expect(code).not.toBe(0);
      expect(stderr).toContain("DEMO_PROXY_ANTHROPIC_API_KEY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swaps the dummy key, forwards everything else verbatim, and saves the take per lane", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "demo-proxy-rec-"));
    let p: RunningProxy | undefined;
    try {
      p = await startProxy(["--record", dir, "--upstream", upstreamUrl], { DEMO_PROXY_ANTHROPIC_API_KEY: "sk-ant-real" });
      seen.length = 0;

      const body = { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }], tools: [{}, {}], stream: true };
      const res = await messagesRequest(
        p,
        { ...DUMMY, "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219", "user-agent": "claude-cli/2.1.252", "accept-encoding": "gzip, deflate, br, zstd" },
        body,
      );
      expect(res.status).toBe(200);
      const got = Buffer.from(await res.arrayBuffer());
      expect(got.toString()).toBe(sseBody("claude-opus-5"));
      expect(res.headers.get("request-id")).toBe("req_upstream_1");

      // What the upstream saw: our key, their headers, their body and path.
      expect(seen).toHaveLength(1);
      const [up] = seen;
      expect(up.url).toBe("/v1/messages?beta=true");
      expect(up.headers["x-api-key"]).toBe("sk-ant-real");
      expect(up.headers["anthropic-version"]).toBe("2023-06-01");
      expect(up.headers["anthropic-beta"]).toBe("claude-code-20250219");
      expect(up.headers["user-agent"]).toBe("claude-cli/2.1.252");
      expect(up.headers["accept-encoding"]).toBe("identity");
      expect(up.headers.authorization).toBeUndefined();
      expect(JSON.parse(up.body)).toEqual(body);

      // The bearer lane is passthrough: the header reaches the upstream untouched, and no key is invented.
      const bearer = await messagesRequest(p, BEARER, { model: "claude-opus-5", messages: [{}], stream: true });
      expect(bearer.status).toBe(200);
      await bearer.arrayBuffer();
      expect(seen).toHaveLength(2);
      expect(seen[1].headers.authorization).toBe("Bearer oauth-token");
      expect(seen[1].headers["x-api-key"]).toBeUndefined();

      // Saved layout: <lane>/NNN.sse (status, headers, body verbatim) + fingerprints.jsonl.
      expect(readdirSync(join(dir, "x-api-key"))).toEqual(["001.sse"]);
      expect(readdirSync(join(dir, "bearer"))).toEqual(["001.sse"]);
      const saved = parseResponseFile(readFileSync(join(dir, "x-api-key", "001.sse")));
      expect(saved.status).toBe(200);
      expect(saved.headers["content-type"]).toBe("text/event-stream");
      expect(saved.headers["request-id"]).toBe("req_upstream_1");
      expect(saved.headers.connection).toBeUndefined();
      expect(saved.body.equals(got)).toBe(true);
      const fingerprints = readFileSync(join(dir, "fingerprints.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(fingerprints).toEqual([
        { lane: "x-api-key", n: 1, model: "claude-opus-5", messages: 1, tools: 2, bodyBytes: JSON.stringify(body).length, stream: true },
        { lane: "bearer", n: 1, model: "claude-opus-5", messages: 1, tools: 0, bodyBytes: expect.any(Number) as number, stream: true },
      ]);
      expect(p.stderr()).toMatch(/record lane=x-api-key n=1 POST \/v1\/messages\?beta=true 200 \d+ms/);

      // A recorded cassette replays: the same request gets the same bytes back with no drift.
      await stopProxy(p);
      p = await startProxy(["--replay", dir]);
      const replayed = await messagesRequest(p, DUMMY, body);
      expect(replayed.status).toBe(200);
      expect(Buffer.from(await replayed.arrayBuffer()).equals(got)).toBe(true);
      expect(p.stderr()).not.toContain("drift");
    } finally {
      await stopProxy(p);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards a chunked request with a content-length and no transfer-encoding", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "demo-proxy-rec-"));
    let p: RunningProxy | undefined;
    try {
      p = await startProxy(["--record", dir, "--upstream", upstreamUrl], { DEMO_PROXY_ANTHROPIC_API_KEY: "sk-ant-real" });
      seen.length = 0;
      const body = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }], stream: true });
      // node:http with no content-length and a streamed body sends Transfer-Encoding: chunked.
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: p!.port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", ...DUMMY } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.write(body.slice(0, 10));
        req.write(body.slice(10));
        req.end();
      });
      expect(status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].headers["transfer-encoding"]).toBeUndefined();
      expect(seen[0].headers["content-length"]).toBe(String(Buffer.byteLength(body)));
      expect(seen[0].body).toBe(body);
    } finally {
      await stopProxy(p);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to record over an existing take", async () => {
    const { code, stderr } = await runUntilExit(["--record", FIXTURE_CASSETTE, "--upstream", upstreamUrl], {
      DEMO_PROXY_ANTHROPIC_API_KEY: "sk-ant-real",
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("already holds");
    expect(existsSync(join(FIXTURE_CASSETTE, "x-api-key", "003.sse"))).toBe(false);
  });
});
