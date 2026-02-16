import net from "node:net";

/**
 * Common dev server ports to scan, ordered by likelihood.
 *
 * Notable ports and their typical frameworks:
 *   3001  - Next.js (fallback when 3000 is taken), Create React App
 *   4000  - Various (Phoenix, custom Express)
 *   4200  - Angular CLI
 *   5000  - Flask, .NET
 *   5173  - Vite (default)
 *   5174  - Vite (fallback)
 *   8000  - Django, Python http.server
 *   8080  - Common alternative HTTP (Spring Boot, Vue CLI)
 *   8888  - Jupyter, custom servers
 *
 * Port 3000 is excluded by default because ShipIt's own Fastify server uses it.
 */
export const DEFAULT_SCAN_PORTS = [3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8888];

/** How long to wait for a TCP connection before considering the port closed. */
const CONNECT_TIMEOUT_MS = 300;

/**
 * Check whether a single TCP port is accepting connections on localhost.
 *
 * Opens a TCP connection with a short timeout. Resolves `true` if the
 * connection succeeds (port is listening), `false` otherwise. The socket
 * is immediately destroyed after the check.
 */
export function checkPort(port: number, host = "127.0.0.1"): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host, timeout: CONNECT_TIMEOUT_MS });

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Scan a list of ports and return which ones are listening.
 *
 * @param ports       - Ports to check (defaults to DEFAULT_SCAN_PORTS)
 * @param excludePorts - Ports to skip (e.g., the Fastify server port, managed Vite port)
 * @returns Array of ports that are accepting connections, in scan order.
 */
export async function scanPorts(
  ports: number[] = DEFAULT_SCAN_PORTS,
  excludePorts: number[] = [],
): Promise<number[]> {
  const excludeSet = new Set(excludePorts);
  const toCheck = ports.filter((p) => !excludeSet.has(p));

  // Check all ports concurrently for speed
  const results = await Promise.all(
    toCheck.map(async (port) => ({ port, open: await checkPort(port) })),
  );

  return results.filter((r) => r.open).map((r) => r.port);
}
