/**
 * Unit tests for the shared shim plumbing in `shim-common.ts`.
 *
 * Focus: `readBodyFromFileOrStdin` / `readStdin` must fail fast (not hang) when
 * `--prompt-file -` / `--body-file -` is passed with no piped stdin — the
 * production bug where `shipit agent run --prompt-file -` blocked forever on a
 * TTY/never-EOF stdin. The TTY check is the primary guard; the idle-timeout
 * backstop covers a non-TTY pipe that never reaches EOF.
 */

import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callBroker, readBodyFromFileOrStdin, readStdin, type ShimIO } from "./shim-common.js";

function makeIO() {
  let stderr = "";
  let exitCode: number | null = null;
  const io: ShimIO = {
    stdout: () => {},
    stderr: (text) => {
      stderr += text;
    },
    exit: (code) => {
      exitCode = code;
      throw new Error("__shim_exit__");
    },
  };
  return {
    io,
    get stderr() {
      return stderr;
    },
    get exitCode() {
      return exitCode;
    },
  };
}

/** A fake non-TTY stdin carrying `content`, then EOF. */
function pipedStdin(content: string): NodeJS.ReadStream {
  const s = Readable.from([content]) as unknown as NodeJS.ReadStream;
  s.isTTY = false as never;
  return s;
}

/** A fake TTY stdin (nothing will ever be written). */
function ttyStdin(): NodeJS.ReadStream {
  const s = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
  s.isTTY = true as never;
  return s;
}

describe("readBodyFromFileOrStdin", () => {
  it("fails fast with guidance when source is '-' and stdin is a TTY (does not hang)", async () => {
    const cap = makeIO();
    await expect(
      readBodyFromFileOrStdin("-", cap.io, "shipit agent run", "prompt file", ttyStdin()),
    ).rejects.toThrow("__shim_exit__");
    expect(cap.exitCode).toBe(2);
    expect(cap.stderr).toContain("shipit agent run: no prompt on stdin");
    expect(cap.stderr).toContain("--prompt-file - <<'EOF'");
  });

  it("derives the wording from `noun` for body-file callers", async () => {
    const cap = makeIO();
    await expect(
      readBodyFromFileOrStdin("-", cap.io, "gh pr create", "body file", ttyStdin()),
    ).rejects.toThrow("__shim_exit__");
    expect(cap.stderr).toContain("gh pr create: no body on stdin");
    expect(cap.stderr).toContain("--body-file - <<'EOF'");
  });

  it("returns piped stdin content unchanged when source is '-' (real pipe)", async () => {
    const cap = makeIO();
    const body = "line one\n`backtick` and $(cmd) stay literal\n";
    const result = await readBodyFromFileOrStdin(
      "-",
      cap.io,
      "shipit agent run",
      "prompt file",
      pipedStdin(body),
    );
    expect(result).toBe(body);
    expect(cap.exitCode).toBeNull();
  });

  it("reads from a file path unaffected by the stdin guard", async () => {
    const cap = makeIO();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "shim-common-"));
    const file = path.join(dir, "prompt.md");
    await fsp.writeFile(file, "from a file");
    // Pass a TTY stdin to prove the file path never touches it.
    const result = await readBodyFromFileOrStdin(
      file,
      cap.io,
      "shipit agent run",
      "prompt file",
      ttyStdin(),
    );
    expect(result).toBe("from a file");
    expect(cap.exitCode).toBeNull();
  });
});

describe("callBroker", () => {
  // Regression: `shipit agent run` passes timeoutMs: 0 so the long-lived spawn
  // leg uses Node http, not undici's `fetch` (default 300s headersTimeout →
  // "fetch failed" → misreported as an unreachable worker).
  it("routes an unbounded (timeoutMs: 0) call over Node http, not global fetch", async () => {
    const seen: { method?: string; url?: string; body: string } = { body: "" };
    const server = http.createServer((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        seen.body = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "success", text: "ok" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await callBroker(
        "POST",
        "/agent-ops/agent/spawn",
        { agentId: "codex", prompt: "review", depth: 0 },
        { workerUrl: `http://127.0.0.1:${port}` },
        0,
      );
      expect(res).toEqual({ status: 200, body: { status: "success", text: "ok" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/agent-ops/agent/spawn");
      expect(JSON.parse(seen.body)).toMatchObject({ agentId: "codex", prompt: "review" });
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("surfaces a connection failure on the unbounded path as status 0 with a worker-unreachable message", async () => {
    // Port 1 is closed → ECONNREFUSED. The message includes the cause code so a
    // transport failure is no longer opaque.
    const res = await callBroker(
      "POST",
      "/agent-ops/agent/spawn",
      { agentId: "codex", prompt: "x", depth: 0 },
      { workerUrl: "http://127.0.0.1:1" },
      0,
    );
    expect(res.status).toBe(0);
    expect(res.body.error).toContain("Could not reach the ShipIt session worker");
  });
});

describe("readStdin", () => {
  it("rejects after the idle timeout when nothing arrives and there is no EOF", async () => {
    const stalled = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
    await expect(readStdin(stalled, 20)).rejects.toThrow("no input received on stdin");
  });

  it("resolves with content once stdin reaches EOF", async () => {
    const result = await readStdin(pipedStdin("hello world"), 1000);
    expect(result).toBe("hello world");
  });
});
