/**
 * The orchestrator's Dockerode factory — the ONE place `new Docker(...)` is
 * called, so the redirect guard below cannot be forgotten by a future call site.
 *
 * ## Crash safety (prod orchestrator crash, 2026-08-26)
 *
 * The orchestrator died with an unhandled `'error'` event on a raw
 * `ClientRequest` — `getaddrinfo ENOTFOUND containers` — during an archive
 * teardown. There is deliberately no `uncaughtException` handler
 * (`app-lifecycle.ts`), so that is a process kill. Nothing in `src/` dials a
 * host called `containers`; `docker-modem` synthesizes it:
 *
 *   1. On a **socketPath** dial there is no host, so `docker-modem`'s
 *      redirect-following wrapper formats the request URL as the bare string
 *      `"http:"` (`docker-modem/lib/http.js:44`).
 *   2. If the daemon answers **3xx with a `location` header**, it resolves the
 *      redirect against that empty base: `url.resolve("http:", "/containers/<id>/json")`
 *      → `"http:/containers/<id>/json"`.
 *   3. `http.get()` parses that with the WHATWG parser, which reads the single
 *      slash as an authority: `http://containers/<id>/json`. The FIRST PATH
 *      SEGMENT BECOMES THE HOSTNAME. Hence `containers`, on port 80.
 *   4. That second request is created at `docker-modem/lib/http.js:69` and gets
 *      **no `'error'` listener**: `Modem.buildRequest` attaches one only to the
 *      request it built (`modem.js:361`), and `redirect.clientRequest` keeps
 *      pointing at the first one (`http.js:52`). DNS fails, the event has no
 *      listener, the process dies — with no app frames in the stack, because no
 *      app frame created the request.
 *
 * Step 3 is why the hostname is `containers` and not `v1.51`: this client is
 * built without a `version`, so its paths carry no `/v1.xx/` prefix. (A
 * versioned client would instead throw `Invalid URL` out of the response
 * handler — the same crash by another name.)
 *
 * The daemon returns a 3xx here because its API router (gorilla/mux) answers any
 * non-canonical path with `301` + `Location: <cleaned path>` — so one dockerode
 * call made with an empty or slash-prefixed container id (`/containers//json`)
 * during the teardown race is enough. Which call that was is not pinned; it does
 * not need to be, because the guard covers every 3xx whatever provoked it.
 *
 * Note the dial that provoked it rejected *normally* the whole time — the modem
 * reports the 301 on its own `'response'` handler while the redirect is chased in
 * parallel — so the orphan request is the only symptom there ever was. That is
 * why the crash correlates with no error of its own in the log.
 *
 * **The guard**: refuse to follow redirects at all. A redirect is meaningless on
 * this client — it talks to a Unix socket, and "following" one means leaving the
 * socket for a TCP host invented out of a URL path. With `maxRedirects` at 0 the
 * second request is never created; `docker-modem` instead raises the failure on
 * the first request, which *does* have a listener, so the dial rejects like any
 * other Docker error and the caller's existing `catch` handles it.
 */

import { createRequire } from "node:module";
import Docker from "dockerode";

/**
 * `docker-modem`'s redirect wrapper reads its ceiling from a module-level
 * binding at request time (`lib/http.js:21`), not from per-request options —
 * `Modem.dial` never forwards a `maxRedirects` into the options it builds. So
 * the only lever is the module object itself. Deep-requiring it is safe: the
 * package publishes no `exports` map.
 */
const DOCKER_MODEM_HTTP = "docker-modem/lib/http";

let applied = false;

/**
 * Set `docker-modem`'s redirect ceiling to 0. Idempotent; safe to call before
 * every client construction.
 *
 * Applied at construction rather than at boot only for locality — the value is
 * read per request, so it takes effect for any client, whenever it was built.
 */
export function disableDockerModemRedirects(): void {
  if (applied) return;
  applied = true;
  try {
    const mod = createRequire(import.meta.url)(DOCKER_MODEM_HTTP) as { maxRedirects?: unknown };
    if (typeof mod.maxRedirects !== "number") {
      // Shape changed upstream. Say so rather than no-op in silence — the
      // co-located guard test is what turns this into a red build.
      console.warn(
        `[docker] ${DOCKER_MODEM_HTTP} has no numeric maxRedirects; `
        + "the ENOTFOUND-on-redirect crash guard is NOT active.",
      );
      return;
    }
    mod.maxRedirects = 0;
  } catch (err) {
    console.warn(`[docker] could not disable ${DOCKER_MODEM_HTTP} redirects:`, err);
  }
}

/**
 * Build a Dockerode client with the redirect guard applied.
 *
 * Use this instead of `new Docker(...)` everywhere in the orchestrator.
 */
export function createDockerClient(opts?: Docker.DockerOptions): Docker {
  disableDockerModemRedirects();
  return new Docker(opts);
}
