import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { checkPort, scanPorts, DEFAULT_SCAN_PORTS } from "./port-scanner.js";

/**
 * Spin up a TCP server on an ephemeral port. Returns the server and its port.
 */
function createTestServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("Could not determine server port"));
      }
    });
    server.on("error", reject);
  });
}

/**
 * Get a port that is guaranteed to be closed by binding to an ephemeral port
 * and immediately closing the server. This avoids fragile arithmetic like
 * `port + 5000` which can overflow the valid port range (1–65535).
 */
async function getClosedPort(): Promise<number> {
  const { server, port } = await createTestServer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("port-scanner", () => {
  describe("checkPort", () => {
    let server: net.Server;
    let openPort: number;

    beforeEach(async () => {
      const result = await createTestServer();
      server = result.server;
      openPort = result.port;
    });

    afterEach(() => {
      server.close();
    });

    it("returns true for a port that is listening", async () => {
      const result = await checkPort(openPort);
      expect(result).toBe(true);
    });

    it("returns false for a port that is not listening", async () => {
      const closedPort = await getClosedPort();
      const result = await checkPort(closedPort);
      expect(result).toBe(false);
    });

    it("returns false after server is closed", async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const result = await checkPort(openPort);
      expect(result).toBe(false);
    });
  });

  describe("scanPorts", () => {
    let server1: net.Server;
    let server2: net.Server;
    let port1: number;
    let port2: number;

    beforeEach(async () => {
      const r1 = await createTestServer();
      const r2 = await createTestServer();
      server1 = r1.server;
      server2 = r2.server;
      port1 = r1.port;
      port2 = r2.port;
    });

    afterEach(() => {
      server1.close();
      server2.close();
    });

    it("returns ports that are listening", async () => {
      const closedPort = await getClosedPort();
      const result = await scanPorts([port1, port2, closedPort]);
      expect(result).toContain(port1);
      expect(result).toContain(port2);
      expect(result).not.toContain(closedPort);
    });

    it("excludes ports in the excludePorts list", async () => {
      const result = await scanPorts([port1, port2], [port1]);
      expect(result).not.toContain(port1);
      expect(result).toContain(port2);
    });

    it("returns empty array when no ports are listening", async () => {
      const closed1 = await getClosedPort();
      const closed2 = await getClosedPort();
      const result = await scanPorts([closed1, closed2]);
      expect(result).toEqual([]);
    });

    it("preserves scan order in results", async () => {
      // Ensure port2 comes before port1 in the scan list
      const result = await scanPorts([port2, port1]);
      expect(result[0]).toBe(port2);
      expect(result[1]).toBe(port1);
    });

    it("returns empty array for empty port list", async () => {
      const result = await scanPorts([]);
      expect(result).toEqual([]);
    });
  });

  describe("DEFAULT_SCAN_PORTS", () => {
    it("contains the expected common dev server ports", () => {
      expect(DEFAULT_SCAN_PORTS).toContain(3001);
      expect(DEFAULT_SCAN_PORTS).toContain(5173);
      expect(DEFAULT_SCAN_PORTS).toContain(8080);
      expect(DEFAULT_SCAN_PORTS).toContain(8000);
    });

    it("does not include port 3000 (ShipIt server default)", () => {
      expect(DEFAULT_SCAN_PORTS).not.toContain(3000);
    });
  });
});
