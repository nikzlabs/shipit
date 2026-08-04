/**
 * Guards against the dogfooding self-kill hazard (prod incident 2026-07-25,
 * session 6e1e22fa): integration tests build real in-process orchestrators
 * around fake-Docker container fixtures, and the resulting
 * ContainerSessionRunners fire real HTTP (env-prep secret pushes, SSE
 * connects, /agent/start) at the fixture's worker URL.
 *
 * When this suite runs inside a ShipIt session container, 127.0.0.1:9100 is
 * the session's OWN live worker — the persistent-409 recovery
 * (container-session-runner.ts, docs/142 Problem B2) then POSTs /agent/kill
 * and SIGTERMs the very agent running vitest, mid-turn. Bridge IPs (172.18.x)
 * are no safer: in-container they can be live NEIGHBOR session workers, and
 * in some CI network namespaces they blackhole on a 12s timeout.
 *
 * Fixtures must use loopback IPs + a dead ephemeral port from
 * allocateDeadLoopbackPort() (container-test-helpers.ts). This file checks
 * both the helper's contract (instant connection refusal — the fast-fail
 * property that motivated loopback in the first place) and, as a static
 * tripwire, that no test in this directory reintroduces the production
 * worker port or a bridge IP into a fixture.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allocateDeadLoopbackPort } from "./container-test-helpers.js";

const OWN_FILE = fileURLToPath(import.meta.url);
const TESTS_DIR = path.dirname(OWN_FILE);

/** Attempt a TCP connect; resolve with the failure mode. */
function tryConnect(host: string, port: number, timeoutMs: number): Promise<"refused" | "connected" | "timeout"> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve("timeout");
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve("connected");
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve("refused");
    });
  });
}

describe("allocateDeadLoopbackPort", () => {
  it("returns a port that refuses connections instantly (fast-fail preserved)", async () => {
    const port = await allocateDeadLoopbackPort();
    expect(port).toBeGreaterThan(0);

    const started = Date.now();
    const outcome = await tryConnect("127.0.0.1", port, 2000);
    const elapsed = Date.now() - started;

    expect(outcome).toBe("refused");
    // The whole point of loopback fixtures is instant ECONNREFUSED, not a
    // multi-second blackhole timeout.
    expect(elapsed).toBeLessThan(1000);
  });

  it("dead port also refuses on other loopback addresses used by fixtures", async () => {
    const port = await allocateDeadLoopbackPort();
    // Fixtures hand out distinct 127.0.0.x IPs per fake container; all of
    // 127/8 is the loopback interface on Linux, so the dead port must refuse
    // there too.
    const outcome = await tryConnect("127.0.0.3", port, 2000);
    expect(outcome).toBe("refused");
  });
});

describe("no fixture points at a potentially-live worker address", () => {
  const testFiles = fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.ts") && path.join(TESTS_DIR, f) !== OWN_FILE);

  it("no integration test hardcodes the production worker port 9100 as a fixture workerPort", () => {
    const offenders: string[] = [];
    for (const file of testFiles) {
      const src = fs.readFileSync(path.join(TESTS_DIR, file), "utf-8");
      if (/workerPort:\s*9100\b/.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      "Fixture workerPort must come from allocateDeadLoopbackPort() — 9100 is the LIVE session worker when the suite runs inside a ShipIt session container",
    ).toEqual([]);
  });

  it("no fake-Docker fixture assigns a bridge-network IP", () => {
    const offenders: string[] = [];
    // Matches IP assignments like `const ip = "172.18...` or `ip = \`172.18...`
    // without tripping on prose mentions of 172.18 in comments.
    const bridgeIpAssignment = /\bip\s*[:=]\s*[`"']172\.18\./;
    for (const file of testFiles) {
      const src = fs.readFileSync(path.join(TESTS_DIR, file), "utf-8");
      if (bridgeIpAssignment.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      "Fake-container IPs must be loopback (127.0.0.x) — bridge IPs can be live neighbor session workers in-container, and blackhole in some CI namespaces",
    ).toEqual([]);
  });
});
