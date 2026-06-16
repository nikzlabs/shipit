/**
 * `shipit source *` handlers (docs/162) — read-only ShipIt source browsing,
 * Ops sessions only.
 *
 * Each handler brokers a GET against the worker's `/agent-ops/source/*` routes
 * and renders a stable text block (or `--json` passthrough). Source access is
 * strictly read-only; mutation happens through a spawned `--shipit-source` fix
 * session, never against the source snapshot directly. The dispatch + the
 * rejected-subcommand gate live in `shipit.ts`.
 */

import {
  asString,
  fail,
  parseFlags,
  success,
} from "./shim-common.js";
import { REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

export async function handleSourceStatus(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source status: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const res = await deps.call("GET", "/agent-ops/source/status", undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read source status"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  if (res.body.available !== true) {
    fail(deps.io, asString(res.body.reason) || "ShipIt source is unavailable.", 1);
  }
  const lines = [
    `available:  true`,
    `ref:        ${asString(res.body.ref)}`,
    `exact:      ${res.body.exact === true}`,
    `ref-source: ${asString(res.body.refSource) || "unknown"}`,
  ];
  if (res.body.remoteUrl) lines.push(`remote:     ${asString(res.body.remoteUrl)}`);
  if (res.body.exact !== true) {
    lines.push(
      "",
      "NOTE: this ref is approximate (the source checkout's HEAD, not the exact",
      "deployed build). `shipit session create --shipit-source` needs --approximate.",
    );
  }
  success(deps.io, lines.join("\n"));
}

export async function handleSourceTree(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source tree: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const path = parsed.positional[0] ?? "";
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await deps.call("GET", `/agent-ops/source/tree${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list source tree"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const entries = (res.body.entries as Record<string, unknown>[] | undefined) ?? [];
  if (entries.length === 0) {
    success(deps.io, `(empty: ${asString(res.body.path) || "."} @ ${asString(res.body.ref).slice(0, 12)})`);
    return;
  }
  const lines = entries.map((e) =>
    `${e.type === "dir" ? "dir " : "file"}  ${asString(e.name)}${e.type === "dir" ? "/" : ""}`,
  );
  if (res.body.truncated === true) lines.push("… (truncated)");
  success(deps.io, lines.join("\n"));
}

export async function handleSourceSearch(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--path": "path" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source search: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const query = parsed.positional[0];
  if (!query) {
    fail(deps.io, 'shipit source search: a query is required, e.g. shipit source search "ContainerSessionRunner".');
  }
  const params = new URLSearchParams({ q: query });
  if (parsed.values.path) params.set("path", parsed.values.path);
  const res = await deps.call("GET", `/agent-ops/source/search?${params.toString()}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to search source"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const matches = (res.body.matches as Record<string, unknown>[] | undefined) ?? [];
  if (matches.length === 0) {
    success(deps.io, `No matches for "${query}".`);
    return;
  }
  const lines = matches.map((m) => `${asString(m.path)}:${asString(m.line)}:${asString(m.text)}`);
  if (res.body.truncated === true) lines.push("… (truncated; narrow with --path)");
  success(deps.io, lines.join("\n"));
}

export async function handleSourceCat(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source cat: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const path = parsed.positional[0];
  if (!path) {
    fail(deps.io, "shipit source cat: a file path is required, e.g. shipit source cat src/server/orchestrator/index.ts.");
  }
  const res = await deps.call("GET", `/agent-ops/source/cat?path=${encodeURIComponent(path)}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read source file"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const content = asString(res.body.content);
  deps.io.stdout(content.endsWith("\n") ? content : `${content}\n`);
  if (res.body.truncated === true) deps.io.stderr("… (truncated; file exceeds the source cat size cap)\n");
  deps.io.exit(0);
}

export async function handleSourceLog(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--limit": "limit" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source log: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const params = new URLSearchParams();
  const path = parsed.positional[0];
  if (path) params.set("path", path);
  if (parsed.values.limit) params.set("limit", parsed.values.limit);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await deps.call("GET", `/agent-ops/source/log${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read source history"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const commits = (res.body.commits as Record<string, unknown>[] | undefined) ?? [];
  if (commits.length === 0) {
    success(deps.io, `(no commits${path ? ` touching ${path}` : ""})`);
    return;
  }
  const lines = commits.map((c) =>
    `${asString(c.shortHash)}  ${asString(c.date).slice(0, 10)}  ${asString(c.author)}  ${asString(c.subject)}`,
  );
  if (res.body.truncated === true) lines.push("… (truncated; pass --limit to widen)");
  success(deps.io, lines.join("\n"));
}

export async function handleSourceBlame(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source blame: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const path = parsed.positional[0];
  if (!path) {
    fail(deps.io, "shipit source blame: a file path is required, e.g. shipit source blame src/server/orchestrator/index.ts.");
  }
  const res = await deps.call("GET", `/agent-ops/source/blame?path=${encodeURIComponent(path)}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to blame source file"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const lines = (res.body.lines as Record<string, unknown>[] | undefined) ?? [];
  const out = lines.map((l) =>
    `${asString(l.shortHash)}  ${asString(l.line).padStart(5)}  ${asString(l.text)}`,
  );
  if (res.body.truncated === true) out.push("… (truncated)");
  success(deps.io, out.join("\n"));
}

export async function handleSourceShow(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source show: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const commit = parsed.positional[0];
  if (!commit) {
    fail(deps.io, "shipit source show: a commit is required, e.g. shipit source show abc123 [PATH].");
  }
  const params = new URLSearchParams({ commit });
  const path = parsed.positional[1];
  if (path) params.set("path", path);
  const res = await deps.call("GET", `/agent-ops/source/show?${params.toString()}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to show source commit"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const content = asString(res.body.content);
  deps.io.stdout(content.endsWith("\n") ? content : `${content}\n`);
  if (res.body.truncated === true) deps.io.stderr("… (truncated; diff exceeds the source show size cap)\n");
  deps.io.exit(0);
}
