import { createRequire } from "node:module";
import Docker from "dockerode";

// docker-modem reads this module's ceiling per request; dial ignores per-request overrides.
const DOCKER_MODEM_HTTP = "docker-modem/lib/http";

let applied = false;

// Unix-socket redirects can become TCP requests with no error listener, crashing the process.
export function disableDockerModemRedirects(): void {
  if (applied) return;
  try {
    const mod = createRequire(import.meta.url)(DOCKER_MODEM_HTTP) as { maxRedirects?: unknown };
    if (typeof mod.maxRedirects !== "number") {
      console.warn(
        `[docker] ${DOCKER_MODEM_HTTP} has no numeric maxRedirects; `
        + "the ENOTFOUND-on-redirect crash guard is NOT active.",
      );
      return;
    }
    mod.maxRedirects = 0;
    applied = true;
  } catch (err) {
    console.warn(`[docker] could not disable ${DOCKER_MODEM_HTTP} redirects:`, err);
  }
}

export function createDockerClient(opts?: Docker.DockerOptions): Docker {
  disableDockerModemRedirects();
  return new Docker(opts);
}
