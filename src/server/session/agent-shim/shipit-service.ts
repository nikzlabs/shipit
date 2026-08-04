/**
 * `shipit service` handlers — Compose service control for the agent (docs/238).
 *
 * A project's `docker-compose.yml` routinely declares services the agent needs
 * but that don't start on their own: a Postgres it has to migrate, a Redis it
 * has to flush, an Android emulator it has to `adb` into. Those are
 * `x-shipit-preview: manual` (the default for any service without `ports`), and
 * the docs used to describe starting them as "the user clicks Start in the UI" —
 * an inversion of ShipIt's own principle that chat is the input surface and the
 * AGENT is the actor. This module makes the verb the agent's.
 *
 * The underlying bridge (worker `/services/*` → SSE → orchestrator
 * `ServiceManager`) predates this and is unchanged; what was missing was a
 * discoverable, correct front end. `curl http://localhost:9100/services/start`
 * still works — it's simply no longer the documented path.
 *
 * Two mechanics are specific to this surface and load-bearing:
 *
 *   1. `start`/`restart` go over the UNBOUNDED transport (`call(..., 0)`), the
 *      same one `shipit agent run` uses. They cover a `docker compose up -d
 *      --build`, so a cold image pull runs for minutes; undici's default 300s
 *      headersTimeout would abort the request with the opaque "fetch failed"
 *      while the start was still in flight. The worker's own per-action deadline
 *      (service-request-timeouts.ts) is the real ceiling.
 *   2. A timeout is NOT a failure. The worker giving up on the callback doesn't
 *      cancel the orchestrator's `docker compose up`, so the copy says "still
 *      running" and names the recovery command instead of implying the service
 *      is dead.
 *
 * The `shipit service` dispatch lives in `shipit.ts`.
 */

import { asString, fail, parseFlags, success } from "./shim-common.js";
import { REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

/** Shape of a service row as returned by the bridge's `list`/mutation actions. */
interface ServiceRow {
  name: string;
  status?: string;
  port?: number;
  preview?: string;
  url?: string;
  error?: string;
  alreadyRunning?: boolean;
}

function toRow(value: unknown): ServiceRow {
  const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    name: asString(obj.name),
    status: asString(obj.status) || undefined,
    port: typeof obj.port === "number" ? obj.port : undefined,
    preview: asString(obj.preview) || undefined,
    url: asString(obj.url) || undefined,
    error: asString(obj.error) || undefined,
    alreadyRunning: obj.alreadyRunning === true,
  };
}

/**
 * Render the service list as an aligned table.
 *
 * Deliberately one call, everything: the agent needs to know in a single read
 * what exists, what's up, and where to point `curl`/`browser_navigate` — so
 * `URL` (the agent-reachable containerIp:port, not the user's preview origin)
 * is a column rather than something to go derive. Per-service errors are
 * appended as their own lines instead of being dropped, since "why is this
 * service in `error`" is the whole reason the agent is looking.
 */
function renderTable(rows: ServiceRow[]): string {
  if (rows.length === 0) {
    return "No services defined. Add them to docker-compose.yml — see /shipit-docs/compose.md.";
  }
  const header = ["NAME", "STATUS", "PREVIEW", "PORT", "URL"];
  const body = rows.map((r) => [
    r.name,
    r.status ?? "unknown",
    r.preview ?? "",
    r.port !== undefined ? String(r.port) : "",
    r.url ?? "",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i].length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd();

  const out = [line(header), ...body.map(line)];
  for (const r of rows) {
    if (r.error) out.push(`\n${r.name}: ${r.error}`);
  }
  return out.join("\n");
}

/** One-line summary for a mutation result. */
function renderResult(verb: string, row: ServiceRow): string {
  if (row.alreadyRunning) {
    const where = row.url ? ` at ${row.url}` : "";
    return `${row.name} is already running${where} — nothing to do.`;
  }
  const status = row.status ?? "unknown";
  // "db: stopped (stopped)" reads as a stutter; name the verb only when it adds
  // information (a `start` that landed on `running`, a `restart` that didn't).
  const parts = [status === verb ? `${row.name}: ${status}` : `${row.name}: ${status} (${verb})`];
  if (row.url) parts.push(`url: ${row.url}`);
  if (row.error) parts.push(`error: ${row.error}`);
  return parts.join("\n");
}

/** Parse `--timeout SECONDS` into milliseconds. */
function parseTimeout(raw: string | undefined, io: RunDeps["io"], cmd: string): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(io, `${cmd}: --timeout must be a positive number of seconds.`);
  }
  return seconds * 1000;
}

/** Resolve the single positional service name, or fail with usage. */
function requireName(positional: string[], io: RunDeps["io"], cmd: string): string {
  const name = positional[0];
  if (!name) {
    fail(io, `${cmd}: a service name is required. Run \`shipit service list\` to see the services defined in docker-compose.yml.`);
  }
  return name;
}

function rejectUnsupported(parsed: { unsupported: string[] }, io: RunDeps["io"], cmd: string): void {
  if (parsed.unsupported.length > 0) {
    fail(io, `Unsupported flag for ${cmd}: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
}

/**
 * Turn a bridge error into an actionable message.
 *
 * The two failures the agent actually hits both have a specific next step, and
 * saying so is the difference between recovering and retrying blindly.
 */
function serviceError(
  res: { status: number; body: Record<string, unknown> },
  fallback: string,
): string {
  // A 404 here is Fastify's "no such route", not "no such service" — an unknown
  // service comes back as a 500 carrying `Unknown service: x` from the
  // orchestrator. So it means this container's worker predates the endpoint,
  // which otherwise surfaces as a bare, unactionable "Not Found".
  if (res.status === 404) {
    return (
      `${fallback}: this session's worker doesn't support that operation (it predates it).\n\n` +
      "Fall back to the ShipIt API for now (unbraced $VAR so this pastes cleanly):\n" +
      '  curl -s "http://$SHIPIT_HOST:$SHIPIT_PORT/api/sessions/$SHIPIT_SESSION_ID/services"\n' +
      '  curl -s "http://$SHIPIT_HOST:$SHIPIT_PORT/api/sessions/$SHIPIT_SESSION_ID/services/NAME/logs?lines=100"'
    );
  }
  const message = formatError(res, fallback);
  if (/No compose stack/i.test(message)) {
    return `${message}\n\nThis project has no docker-compose.yml (or shipit.yaml doesn't point at one). See /shipit-docs/compose.md to add one.`;
  }
  if (/Unknown service/i.test(message)) {
    return `${message}\n\nRun \`shipit service list\` to see the services defined in docker-compose.yml.`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function handleServiceList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  rejectUnsupported(parsed, deps.io, "shipit service list");

  const res = await deps.call("GET", "/services/list", undefined, deps.env);
  if (res.status !== 200) {
    fail(deps.io, serviceError(res, "Failed to list services"));
  }
  const rows = Array.isArray(res.body.services) ? res.body.services.map(toRow) : [];
  success(deps.io, parsed.booleans.has("json") ? JSON.stringify({ services: rows }, null, 2) : renderTable(rows));
}

// ---------------------------------------------------------------------------
// start / restart — the long, unbounded ones
// ---------------------------------------------------------------------------

async function runLongMutation(
  action: "start" | "restart",
  args: string[],
  deps: RunDeps,
): Promise<void> {
  const cmd = `shipit service ${action}`;
  const parsed = parseFlags(args, {
    values: { "--timeout": "timeout" },
    booleans: { "--json": "json" },
  });
  rejectUnsupported(parsed, deps.io, cmd);

  const name = requireName(parsed.positional, deps.io, cmd);
  const timeoutMs = parseTimeout(parsed.values.timeout, deps.io, cmd);

  // timeoutMs: 0 on the transport = explicitly unbounded (Node http, not undici
  // fetch). See the module docstring — a cold `up --build` outlives fetch's
  // non-disableable 300s headers timeout.
  const res = await deps.call(
    "POST",
    `/services/${action}`,
    timeoutMs !== undefined ? { name, timeoutMs } : { name },
    deps.env,
    0,
  );
  if (res.status !== 200) {
    fail(deps.io, serviceError(res, `Failed to ${action} service ${name}`));
  }

  const row = toRow({ ...res.body, name: asString(res.body.name) || name });
  if (parsed.booleans.has("json")) {
    success(deps.io, JSON.stringify(row, null, 2));
  }
  // A service left in `error` is a failed start, and must exit non-zero — the
  // pre-238 bridge reported a hardcoded "running" here and the agent proceeded
  // against a dead container.
  if (row.status === "error") {
    fail(
      deps.io,
      `${name} failed to ${action}: ${row.error ?? "unknown error"}\n\n` +
        `Read the output with \`shipit service logs ${name}\`.`,
    );
  }
  success(deps.io, renderResult(action === "start" ? "started" : "restarted", row));
}

export function handleServiceStart(args: string[], deps: RunDeps): Promise<void> {
  return runLongMutation("start", args, deps);
}

export function handleServiceRestart(args: string[], deps: RunDeps): Promise<void> {
  return runLongMutation("restart", args, deps);
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

export async function handleServiceStop(args: string[], deps: RunDeps): Promise<void> {
  const cmd = "shipit service stop";
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  rejectUnsupported(parsed, deps.io, cmd);
  const name = requireName(parsed.positional, deps.io, cmd);

  const res = await deps.call("POST", "/services/stop", { name }, deps.env);
  if (res.status !== 200) {
    fail(deps.io, serviceError(res, `Failed to stop service ${name}`));
  }
  const row = toRow({ ...res.body, name: asString(res.body.name) || name });
  success(
    deps.io,
    parsed.booleans.has("json") ? JSON.stringify(row, null, 2) : renderResult("stopped", row),
  );
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

export async function handleServiceLogs(args: string[], deps: RunDeps): Promise<void> {
  const cmd = "shipit service logs";
  const parsed = parseFlags(args, {
    values: { "--lines": "lines", "-n": "lines" },
    booleans: { "--json": "json" },
  });
  rejectUnsupported(parsed, deps.io, cmd);
  const name = requireName(parsed.positional, deps.io, cmd);

  let query = `?name=${encodeURIComponent(name)}`;
  if (parsed.values.lines !== undefined) {
    const lines = Number.parseInt(parsed.values.lines, 10);
    if (!Number.isFinite(lines) || lines <= 0) {
      fail(deps.io, `${cmd}: --lines must be a positive number.`);
    }
    query += `&lines=${lines}`;
  }

  const res = await deps.call("GET", `/services/logs${query}`, undefined, deps.env);
  if (res.status !== 200) {
    fail(deps.io, serviceError(res, `Failed to read logs for service ${name}`));
  }
  const logs = asString(res.body.logs);
  if (parsed.booleans.has("json")) {
    success(deps.io, JSON.stringify({ name, logs }, null, 2));
  }
  // An empty log is a real answer, not an error — a `stopped` service that never
  // started has nothing to say, and a bare blank line would read as a bug.
  success(deps.io, logs.trim().length > 0 ? logs : `(no logs for ${name})`);
}
