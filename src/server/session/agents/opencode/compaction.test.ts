/**
 * docs/276 — OpenCode compaction over the transient server.
 *
 * The behaviour worth guarding is not "it makes an HTTP call", it is the two
 * ways this can lie:
 *
 *  - The server announces a port that is NOT the one we asked for (`--port 0`
 *    resolves to OpenCode's fixed 4096, and to a random port when 4096 is
 *    taken), so a hard-coded port would work on a clean box and fail exactly
 *    when a user already has OpenCode running.
 *  - `summarize` can answer 200 with a body that is not `true`, which is the
 *    server accepting the request and declining the work. Reporting that as a
 *    compaction would put a "Context compacted" card over a silent no-op —
 *    the failure mode docs/276 set out to rule out for the CATALOGUE, and the
 *    same one applies to the implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { compactOpencodeSession } from "./compaction.js";

/** A scriptable stand-in for the spawned `opencode serve`. */
class FakeServer extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 5150;
  kill = vi.fn(() => true);

  /** Reproduce the CLI's real readiness line. */
  announce(port: number): void {
    this.stdout.emit("data", Buffer.from("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n"));
    this.stdout.emit("data", Buffer.from(`opencode server listening on http://127.0.0.1:${String(port)}\n`));
  }
}

interface Harness {
  server: FakeServer;
  spawnArgs: string[];
  spawnEnv: Record<string, string>;
  run: () => Promise<void>;
}

function makeHarness(overrides?: { env?: Record<string, string> }): Harness {
  const server = new FakeServer();
  const captured: { args: string[]; env: Record<string, string> } = { args: [], env: {} };
  return {
    server,
    get spawnArgs() { return captured.args; },
    get spawnEnv() { return captured.env; },
    run: () =>
      compactOpencodeSession({
        sessionId: "ses_fe0ab426dffe3pXp0bV6EZNNfo",
        modelId: "anthropic/claude-sonnet-4",
        cwd: "/workspace",
        env: overrides?.env ?? { OPENCODE_CONFIG: "/tmp/cfg.json", HOME: "/home/shipit" },
        spawnFn: (_cmd, args, opts) => {
          captured.args = args;
          captured.env = (opts.env ?? {}) as Record<string, string>;
          return server as unknown as ChildProcess;
        },
      }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: string, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) } as Response;
}

describe("compactOpencodeSession", () => {
  it("POSTs summarize at the port the server ANNOUNCES, not the one requested", async () => {
    const h = makeHarness();
    fetchMock.mockResolvedValue(jsonResponse("true"));
    const done = h.run();
    // We ask for `--port 0`; OpenCode answers with a concrete port that may be
    // 4096 or, when that is taken, an arbitrary ephemeral one.
    expect(h.spawnArgs).toEqual(["serve", "--port", "0", "--hostname", "127.0.0.1"]);
    h.server.announce(34439);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:34439/session/ses_fe0ab426dffe3pXp0bV6EZNNfo/summarize");
    expect(init.method).toBe("POST");
    // The route rejects a body without these with HTTP 400 `Missing key
    // ["providerID"]`; the provider is always ShipIt's own block.
    expect(JSON.parse(init.body as string)).toEqual({
      providerID: "shipit",
      modelID: "anthropic/claude-sonnet-4",
    });
  });

  it("hands the server the SAME env as a turn, or it cannot authenticate", async () => {
    const env = { OPENCODE_CONFIG: "/tmp/turn-cfg.json", OPENCODE_PROVIDER_API_KEY: "sk-secret", HOME: "/home/shipit" };
    const h = makeHarness({ env });
    fetchMock.mockResolvedValue(jsonResponse("true"));
    const done = h.run();
    h.server.announce(4096);
    await done;
    // The provider block lives in OPENCODE_CONFIG and the credential is the
    // only thing that lets the summarization model run.
    expect(h.spawnEnv).toMatchObject(env);
  });

  it("kills the transient server on success", async () => {
    const h = makeHarness();
    fetchMock.mockResolvedValue(jsonResponse("true"));
    const done = h.run();
    h.server.announce(4096);
    await done;
    expect(h.server.kill).toHaveBeenCalled();
  });

  it("REJECTS a 200 whose body is not `true` — an accepted request that did no work", async () => {
    const h = makeHarness();
    fetchMock.mockResolvedValue(jsonResponse("false"));
    const done = h.run();
    h.server.announce(4096);
    await expect(done).rejects.toThrow(/did not confirm compaction/);
    // Still cleaned up — a failure must not leak a server.
    expect(h.server.kill).toHaveBeenCalled();
  });

  it("rejects with the server's status and body on an HTTP error", async () => {
    const h = makeHarness();
    fetchMock.mockResolvedValue(
      jsonResponse('{"name":"BadRequest","data":{"message":"Missing key [\\"providerID\\"]"}}', 400),
    );
    const done = h.run();
    h.server.announce(4096);
    await expect(done).rejects.toThrow(/HTTP 400.*providerID/s);
  });

  it("rejects, quoting stderr, when the server dies before it is ready", async () => {
    const h = makeHarness();
    const done = h.run();
    h.server.stderr.emit("data", Buffer.from("EADDRINUSE: port unavailable\n"));
    h.server.emit("exit", 1);
    await expect(done).rejects.toThrow(/exited \(code 1\) before it was ready.*EADDRINUSE/s);
    // fetch is never reached, so a dead server cannot look like a no-op success.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when the binary cannot be spawned at all", async () => {
    const h = makeHarness();
    const done = h.run();
    h.server.emit("error", new Error("spawn opencode ENOENT"));
    await expect(done).rejects.toThrow(/could not start the compaction server.*ENOENT/s);
  });
});
