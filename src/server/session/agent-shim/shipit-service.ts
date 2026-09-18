
import { asString, fail, parseFlags, success } from "./shim-common.js";
import { REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

interface ServiceRow {
  name: string;
  status?: string;
  port?: number;
  preview?: string;
  url?: string;
  error?: string;
  alreadyRunning?: boolean;
}

interface ComposeFailureRow {
  kind: "refused" | "malformed";
  message: string;
}

interface DependencyGapRow {
  reason: string;
  message: string;
}

function toDependencyGap(value: unknown): DependencyGapRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const message = asString(obj.message);
  if (!message) return undefined;
  return { reason: asString(obj.reason) || "unknown", message };
}

function toFailure(value: unknown): ComposeFailureRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const message = asString(obj.message);
  if (!message) return undefined;
  return { kind: obj.kind === "refused" ? "refused" : "malformed", message };
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

function renderFailure(failure: ComposeFailureRow): string {
  if (failure.kind === "refused") {
    return (
      "ShipIt refused this project's compose file, so none of its services are defined:\n\n" +
      `  ${failure.message}\n\n` +
      "Edit the compose file `shipit.yaml` declares to satisfy that rule — see /shipit-docs/compose.md."
    );
  }
  return (
    "ShipIt could not read this project's compose file, so none of its services are defined:\n\n" +
    `  ${failure.message}`
  );
}

function renderTable(
  rows: ServiceRow[],
  failure?: ComposeFailureRow,
  dependencies?: DependencyGapRow,
): string {
  const withGap = (text: string) =>
    dependencies ? `${text}\n\nDependencies: ${dependencies.message}` : text;

  if (rows.length === 0) {
    if (failure) return withGap(renderFailure(failure));
    return withGap("No services defined. Add them to docker-compose.yml — see /shipit-docs/compose.md.");
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
  // Old or plugin service rows can remain when the current project file is refused.
  if (failure) out.push(`\n${renderFailure(failure)}`);
  return withGap(out.join("\n"));
}

function renderResult(verb: string, row: ServiceRow): string {
  if (row.alreadyRunning) {
    const where = row.url ? ` at ${row.url}` : "";
    return `${row.name} is already running${where} — nothing to do.`;
  }
  const status = row.status ?? "unknown";
  const parts = [status === verb ? `${row.name}: ${status}` : `${row.name}: ${status} (${verb})`];
  if (row.url) parts.push(`url: ${row.url}`);
  if (row.error) parts.push(`error: ${row.error}`);
  return parts.join("\n");
}

function parseTimeout(raw: string | undefined, io: RunDeps["io"], cmd: string): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(io, `${cmd}: --timeout must be a positive number of seconds.`);
  }
  return seconds * 1000;
}

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

function serviceError(
  res: { status: number; body: Record<string, unknown> },
  fallback: string,
): string {
  // Unknown services return 500; 404 means the worker lacks the route.
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


export async function handleServiceList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  rejectUnsupported(parsed, deps.io, "shipit service list");

  const res = await deps.call("GET", "/services/list", undefined, deps.env);
  if (res.status !== 200) {
    fail(deps.io, serviceError(res, "Failed to list services"));
  }
  const rows = Array.isArray(res.body.services) ? res.body.services.map(toRow) : [];
  const failure = toFailure(res.body.failure);
  const dependencies = toDependencyGap(res.body.dependencies);
  success(
    deps.io,
    parsed.booleans.has("json")
      ? JSON.stringify(
          { services: rows, ...(failure ? { failure } : {}), ...(dependencies ? { dependencies } : {}) },
          null,
          2,
        )
      : renderTable(rows, failure, dependencies),
  );
}


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

  // Cold builds can exceed fetch's 300s timeout; the worker owns the deadline.
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
  success(deps.io, logs.trim().length > 0 ? logs : `(no logs for ${name})`);
}
