import { describe, it, expect } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allocateDeadLoopbackPort } from "./container-test-helpers.js";

const OWN_FILE = fileURLToPath(import.meta.url);
const TESTS_DIR = path.dirname(OWN_FILE);

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
    expect(elapsed).toBeLessThan(1000);
  });

  it("dead port also refuses on other loopback addresses used by fixtures", async () => {
    const port = await allocateDeadLoopbackPort();
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
