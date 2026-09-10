import {
  asString,
  fail,
  isTransientStatus,
  parseFlags,
  readBodyFromFileOrStdin,
  success,
} from "./shim-common.js";
import { INLINE_PROMPT_FLAGS, REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

const MAX_WAIT_TIMEOUT_SECS = 60 * 60;

const WAIT_DEFAULT_OVERALL_SECS = 5 * 60;
const WAIT_SEGMENT_SECS = 25;
const WAIT_INITIAL_BACKOFF_MS = 500;
const WAIT_MAX_BACKOFF_MS = 8_000;
const WAIT_REQUEST_MARGIN_MS = 10_000;

const WAIT_EXIT_IDLE = 0;
const WAIT_EXIT_TIMED_OUT = 1;
const WAIT_EXIT_ERROR = 3;

const INLINE_PROMPT_REDIRECT = `shipit session create: inline prompt flags (-p/--prompt/-m) are not supported.
Pass the prompt via --prompt-file FILE, or --prompt-file - to read it from stdin,
so backticks and $(...) in the prompt are not evaluated by the shell. Use a
single-quoted heredoc, exactly like \`gh pr create --body-file -\`:

  shipit session create --prompt-file - --title "..." <<'EOF'
  Your prompt here, with \`backticks\` and $(literal) preserved verbatim.
  EOF`;

// Do not disclose whether an inaccessible child exists.
const CHILD_NOT_FOUND = "Spawned session not found, or not a descendant of this parent.";

const WHOAMI_HINT =
  "To see THIS session (its parent, siblings, and children), run `shipit session whoami`.";

export async function handleSessionCreate(args: string[], deps: RunDeps): Promise<void> {
  const usedInline = args.some(
    (a) =>
      INLINE_PROMPT_FLAGS.includes(a) ||
      a.startsWith("--prompt=") ||
      a.startsWith("--message="),
  );
  if (usedInline) {
    fail(deps.io, INLINE_PROMPT_REDIRECT);
  }

  const parsed = parseFlags(args, {
    values: {
      "--prompt-file": "promptFile", "-f": "promptFile", "-F": "promptFile",
      "-t": "title", "--title": "title",
      "--role": "role",
      "--agent": "agent",
      "--model": "model",
      "--service": "service",
      "--billing-mode": "billingMode",
      "--effort": "effort",
      "--turn": "turn",
      "--repo": "repo", "-R": "repo",
      "--owner": "owner",
    },
    booleans: {
      "--json": "json",
      "--detached": "detached",
      "--no-role": "noRole",
      "--shipit-source": "shipitSource",
      "--approximate": "approximate",
    },
  });

  if ("repo" in parsed.values || "owner" in parsed.values) {
    fail(
      deps.io,
      "shipit session create does not support --repo/--owner. Spawned sessions inherit the parent's repo (or use --shipit-source in an Ops session).",
    );
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session create: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("approximate") && !parsed.booleans.has("shipitSource")) {
    fail(deps.io, "shipit session create: --approximate only applies with --shipit-source.");
  }
  if (parsed.booleans.has("detached") && parsed.booleans.has("shipitSource")) {
    fail(deps.io, "shipit session create: --detached cannot be combined with --shipit-source.");
  }
  const promptFile = parsed.values.promptFile;
  if (!promptFile) {
    fail(
      deps.io,
      "shipit session create: --prompt-file is required (a file, or `-` for stdin, holding the initial user message for the new session).",
    );
  }
  const prompt = await readPromptFile(promptFile, deps);
  if (prompt.trim().length === 0) {
    fail(
      deps.io,
      "shipit session create: the prompt is empty. --prompt-file must hold the initial user message for the new session.",
    );
  }
  if (prompt.length > 50_000) {
    fail(deps.io, "shipit session create: the prompt exceeds 50,000 characters.");
  }
  if (!(parsed.values.title ?? "").trim()) {
    fail(
      deps.io,
      parsed.booleans.has("shipitSource")
        ? "shipit session create --shipit-source requires --title: give the fix session a short, " +
            "human-readable name describing what it fixes."
        : "shipit session create requires --title: give the session a short, " +
            "human-readable name describing what it's for.",
    );
  }

  const billingMode = parsed.values.billingMode;
  if (billingMode !== undefined && billingMode !== "sub" && billingMode !== "key") {
    fail(
      deps.io,
      `shipit session create: --billing-mode must be "sub" (a subscription) or "key" (a metered API key), not "${billingMode}".`,
    );
  }
  if (parsed.booleans.has("noRole") && parsed.values.role !== undefined) {
    fail(
      deps.io,
      "shipit session create: --no-role and --role name opposite things. Pass --role NAME to run "
        + "that role, or --no-role to decline the role this session is running.",
    );
  }
  const payload: Record<string, unknown> = { prompt };
  if (parsed.values.title) payload.title = parsed.values.title;
  // Forward empty overrides so the server rejects them instead of inheriting defaults.
  if (parsed.values.role !== undefined) payload.role = parsed.values.role;
  if (parsed.booleans.has("noRole")) payload.noRole = true;
  if (parsed.values.agent !== undefined) payload.agentId = parsed.values.agent;
  if (parsed.values.model !== undefined) payload.modelId = parsed.values.model;
  if (parsed.values.service !== undefined) payload.serviceId = parsed.values.service;
  if (billingMode !== undefined) payload.billingMode = billingMode;
  if (parsed.values.effort !== undefined) payload.reasoningEffort = parsed.values.effort;
  if (parsed.values.turn) payload.spawnedByTurn = parsed.values.turn;
  if (parsed.booleans.has("detached")) payload.detached = true;
  if (parsed.booleans.has("shipitSource")) payload.shipitSource = true;
  if (parsed.booleans.has("approximate")) payload.approximateSource = true;

  const res = await deps.call("POST", "/agent-ops/session/create", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to create spawned session"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }

  const session = (res.body.session ?? {}) as Record<string, unknown>;
  const lines = [
    `session-id: ${asString(res.body.sessionId)}`,
    `branch:     ${asString(res.body.branch)}`,
    `status:     ${asString(res.body.status) || "running"}`,
  ];
  if (session.originRoleName) {
    lines.push(
      `role:       ${asString(session.originRoleName)} (starting point only — the session routes on its own from here)`,
    );
  }
  if (parsed.booleans.has("detached")) {
    lines.push("detached:   yes (separate session — not a child; cannot be waited on, viewed, or messaged from here)");
  }
  success(deps.io, lines.join("\n"));
}

async function readPromptFile(promptFile: string, deps: RunDeps): Promise<string> {
  return readBodyFromFileOrStdin(promptFile, deps.io, "shipit session create", "prompt file");
}

async function runHostSessionQuery(
  params: URLSearchParams,
  deps: RunDeps,
  label: string,
): Promise<{
  sessions: Record<string, unknown>[];
  truncated: boolean;
  total: number;
  nextOffset?: number;
}> {
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await deps.call("GET", `/agent-ops/session/host-sessions${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, label), 1);
  }
  const nextOffset = Number(res.body.nextOffset);
  return {
    sessions: (res.body.sessions as Record<string, unknown>[] | undefined) ?? [],
    truncated: res.body.truncated === true,
    total: Number(res.body.total ?? 0),
    ...(Number.isFinite(nextOffset) ? { nextOffset } : {}),
  };
}

function moreLine(total: number, nextOffset: number | undefined, noun: string): string {
  const base = `… ${total} ${noun} in total.`;
  return nextOffset === undefined ? base : `${base} Next page: --offset ${nextOffset}`;
}

function renderHostSession(s: Record<string, unknown>): string {
  const lines = [
    `${asString(s.title) || "(untitled)"} (${asString(s.id)})`,
    `  kind:      ${asString(s.kind) || "session"}`,
    `  branch:    ${asString(s.branch) || "(no branch)"}`,
    `  repo:      ${asString(s.remoteUrl) || "(standalone)"}`,
    `  container: ${asString(s.containerName)}`,
    `  created:   ${asString(s.createdAt)}`,
    `  last-used: ${asString(s.lastUsedAt)}`,
    `  disk:      ${asString(s.diskTier)}${s.archived === true ? " (archived)" : ""}`,
  ];
  if (s.parentSessionId) lines.push(`  parent:    ${asString(s.parentSessionId)}`);
  if (s.rootSessionId) lines.push(`  root:      ${asString(s.rootSessionId)}`);
  if (s.agentId) lines.push(`  agent:     ${asString(s.agentId)}${s.model ? ` / ${asString(s.model)}` : ""}`);
  const pr = s.pr as Record<string, unknown> | undefined;
  if (pr) {
    lines.push(`  pr:        #${asString(pr.number)} ${asString(pr.state)} ${asString(pr.url)}`);
    lines.push(`             ${asString(pr.headBranch)} → ${asString(pr.baseBranch)}`);
  }
  const prev = s.previousPr as Record<string, unknown> | undefined;
  if (prev) lines.push(`  prev-pr:   #${asString(prev.number)} ${asString(prev.url)}`);
  if (s.mergedAt) lines.push(`  merged:    ${asString(s.mergedAt)}`);
  if (s.closedAt) lines.push(`  closed:    ${asString(s.closedAt)}`);
  return lines.join("\n");
}

function parsePrNumber(raw: string): string | undefined {
  const value = raw.trim();
  const fromUrl = /\/pull\/(\d+)(?:[/?#]|$)/.exec(value)?.[1];
  if (fromUrl) return fromUrl;
  return /^#?(\d+)$/.exec(value)?.[1];
}

export async function handleSessionFind(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--branch": "branch",
      "--pr": "pr",
      "--container": "container",
      "--id": "id",
      // `session` is reserved for scope checks; send this filter as `id`.
      "--session": "id",
      "--limit": "limit",
      "--offset": "offset",
    },
    booleans: {
      "--json": "json",
      "--include-archived": "includeArchived",
      "--include-warm": "includeWarm",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session find: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const params = new URLSearchParams();
  if (parsed.values.branch) params.set("branch", parsed.values.branch);
  if (parsed.values.container) params.set("container", parsed.values.container);
  if (parsed.values.id) params.set("id", parsed.values.id);
  if (parsed.values.pr) {
    const digits = parsePrNumber(parsed.values.pr);
    if (!digits) {
      fail(deps.io, `shipit session find: could not read a PR number from "${parsed.values.pr}".`);
    }
    params.set("pr", digits);
  }
  if (params.toString() === "") {
    fail(
      deps.io,
      "shipit session find: one of --branch, --pr, --container or --id is required.\n" +
        "For the whole inventory, run `shipit session list --all`.",
    );
  }
  if (parsed.booleans.has("includeArchived")) params.set("includeArchived", "true");
  if (parsed.booleans.has("includeWarm")) params.set("includeWarm", "true");
  if (parsed.values.limit) params.set("limit", parsed.values.limit);
  if (parsed.values.offset) params.set("offset", parsed.values.offset);

  const result = await runHostSessionQuery(params, deps, "Failed to look up host sessions");
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(result.sessions)}\n`);
    deps.io.exit(0);
    return;
  }
  if (result.sessions.length === 0) {
    success(
      deps.io,
      "No matching session.\nArchived sessions are excluded by default — retry with --include-archived.",
    );
    return;
  }
  const blocks = result.sessions.map(renderHostSession);
  if (result.truncated) blocks.push(moreLine(result.total, result.nextOffset, "matches"));
  success(deps.io, blocks.join("\n\n"));
}

export async function handleSessionLogs(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--since": "since", "-S": "since",
      "--until": "until", "-U": "until",
      "--lines": "lines", "-n": "lines",
      "--id": "id", "--session": "id",
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session logs: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const target = parsed.positional[0] ?? parsed.values.id;
  if (!target) {
    fail(
      deps.io,
      "shipit session logs: a session id is required, e.g. `shipit session logs 7bc72326`.\n" +
        "Resolve one first with `shipit session find --branch|--pr|--container|--id`.",
    );
  }

  const params = new URLSearchParams({ target });
  if (parsed.values.since) params.set("since", parsed.values.since);
  if (parsed.values.until) params.set("until", parsed.values.until);
  if (parsed.values.lines) params.set("lines", parsed.values.lines);

  const res = await deps.call(
    "GET",
    `/agent-ops/session/host-session-logs?${params.toString()}`,
    undefined,
    deps.env,
  );
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read session logs"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }

  const entries = (res.body.entries as Record<string, unknown>[] | undefined) ?? [];
  // Older servers return only withheldUnclassified.
  const unclassified = Number(res.body.withheldUnclassified ?? 0);
  const withheld = Number(res.body.withheldTotal ?? unclassified);
  const byShape = (res.body.withheldByShape as { shape?: unknown; count?: unknown }[] | undefined) ?? [];
  const header = [
    `session:   ${asString(res.body.title) || "(untitled)"} (${asString(res.body.sessionId)})`,
    `container: ${asString(res.body.containerName)}`,
    `disk:      ${asString(res.body.diskTier)}${res.body.archived === true ? " (archived)" : ""}`,
    `entries:   ${entries.length}${res.body.truncated === true ? ` of ${asString(res.body.total)} (oldest dropped — raise --lines)` : ""}`,
  ];
  if (withheld > 0) {
    header.push(
      `withheld:  ${withheld} server line(s) not on the ops-safe template list `
        + "(they carry workspace or raw error text). Read them with the operator in the session's UI.",
    );
    const parts = [
      ...byShape.map((s) => `${asString(s.shape)} ×${Number(s.count ?? 0)}`),
      ...(unclassified > 0 ? [`unclassified ×${unclassified}`] : []),
    ];
    if (parts.length > 0) header.push(`  by shape: ${parts.join(", ")}`);
  }
  if (entries.length === 0) {
    header.push(
      "",
      res.body.logsRetained === true
        ? "No server-source log entries in this window. Widen it with --since, or drop --since entirely."
        : "This session has no durable logs on disk — they are removed when a session is archived, "
          + "deleted, or fully reset. Absence here is NOT evidence that nothing happened.",
    );
    success(deps.io, header.join("\n"));
    return;
  }
  const lines = entries.map((e) => `${asString(e.ts)}  ${asString(e.text)}`);
  success(deps.io, [...header, "", ...lines].join("\n"));
}

export async function handleSessionList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--turn": "turn", "--limit": "limit", "--offset": "offset" },
    booleans: {
      "--json": "json",
      "--all": "all",
      "--include-archived": "includeArchived",
      "--include-warm": "includeWarm",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const hostOnlyFlags = [
    ...(parsed.booleans.has("includeWarm") ? ["--include-warm"] : []),
    ...(parsed.booleans.has("includeArchived") ? ["--include-archived"] : []),
    ...(parsed.values.offset ? ["--offset"] : []),
  ];
  if (!parsed.booleans.has("all") && hostOnlyFlags.length > 0) {
    fail(
      deps.io,
      `shipit session list: ${hostOnlyFlags[0]} only applies to the host inventory.\n` +
        "Add --all (Ops sessions only), or drop the flag to list this session's children.",
    );
  }

  if (parsed.booleans.has("all")) {
    const params = new URLSearchParams();
    if (parsed.booleans.has("includeArchived")) params.set("includeArchived", "true");
    if (parsed.booleans.has("includeWarm")) params.set("includeWarm", "true");
    if (parsed.values.limit) params.set("limit", parsed.values.limit);
    if (parsed.values.offset) params.set("offset", parsed.values.offset);
    const result = await runHostSessionQuery(params, deps, "Failed to list host sessions");
    if (parsed.booleans.has("json")) {
      deps.io.stdout(`${JSON.stringify(result.sessions)}\n`);
      deps.io.exit(0);
      return;
    }
    if (result.sessions.length === 0) {
      success(deps.io, "No sessions on this host.");
      return;
    }
    const lines = result.sessions.map((s) =>
      [
        asString(s.id),
        asString(s.kind) || "session",
        asString(s.branch) || "(no branch)",
        s.pr ? `#${asString((s.pr as Record<string, unknown>).number)}` : "-",
        asString(s.title),
      ].join("\t"),
    );
    if (result.truncated) lines.push(moreLine(result.total, result.nextOffset, "sessions"));
    success(deps.io, lines.join("\n"));
    return;
  }

  const turn = parsed.values.turn;
  const qs = turn ? `?turn=${encodeURIComponent(turn)}` : "";
  const res = await deps.call("GET", `/agent-ops/session/list${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list spawned sessions"), 1);
  }
  const children = (res.body.children as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(children)}\n`);
    deps.io.exit(0);
    return;
  }
  if (children.length === 0) {
    success(deps.io, "No spawned sessions for this parent.");
    return;
  }
  const lines = children.map((c) =>
    [
      asString(c.id),
      asString(c.status) || "idle",
      asString(c.branch) || "(no branch)",
      asString(c.title),
    ].join("\t"),
  );
  success(deps.io, lines.join("\n"));
}

export async function handleSessionView(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {},
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const id = parsed.positional[0];
  if (!id) {
    await handleSessionWhoami(args, deps);
    return;
  }

  const res = await deps.call(
    "GET",
    `/agent-ops/session/view/${encodeURIComponent(id)}`,
    undefined,
    deps.env,
  );
  if (res.status === 404) {
    fail(deps.io, `${CHILD_NOT_FOUND}\n${WHOAMI_HINT}`, 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to view spawned session"), 1);
  }
  const child = res.body.child as Record<string, unknown> | null;
  if (!child) {
    fail(deps.io, "Spawned session not found.", 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(child)}\n`);
    deps.io.exit(0);
    return;
  }
  const lines = [
    `${asString(child.title)} (${asString(child.id)})`,
    `status:     ${asString(child.status) || "idle"}`,
    `branch:     ${asString(child.branch) || "(no branch)"}`,
    `queue:      ${asString(child.queueLength) || "0"}`,
    `spawned-at: ${asString(child.spawnedAt)}`,
  ];
  if (child.agent) {
    lines.push(`agent:      ${asString(child.agent)}`);
  }
  if (child.model) {
    lines.push(`model:      ${asString(child.model)}`);
  }
  if (child.originRoleName) {
    lines.push(`role:       ${asString(child.originRoleName)} (at creation)`);
  }
  if (child.spawnedByTurn) {
    lines.push(`turn:       ${asString(child.spawnedByTurn)}`);
  }
  if (child.latestAssistantMessage) {
    lines.push("", asString(child.latestAssistantMessage));
  }
  success(deps.io, lines.join("\n"));
}

export async function handleSessionMessage(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-m": "text", "--message": "text",
      "-p": "text", "--prompt": "text",
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session message: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const id = parsed.positional[0];
  if (!id) {
    fail(deps.io, "shipit session message: child session id is required.");
  }
  const text = parsed.values.text;
  if (!text) {
    fail(deps.io, "shipit session message: -m/--message is required (the prompt text to send).");
  }
  if (text.length > 50_000) {
    fail(deps.io, "shipit session message: --message exceeds 50,000 characters.");
  }

  const res = await deps.call(
    "POST",
    `/agent-ops/session/message/${encodeURIComponent(id)}`,
    { text },
    deps.env,
  );
  if (res.status === 404) {
    fail(deps.io, `${CHILD_NOT_FOUND}\n${WHOAMI_HINT}`, 1);
  }
  if (res.status === 409 && res.body.reason === "resolved") {
    if (parsed.booleans.has("json")) {
      deps.io.stdout(`${JSON.stringify(res.body)}\n`);
      deps.io.exit(1);
      return;
    }
    fail(deps.io, asString(res.body.error), 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to send message to spawned session"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const queuePosition = Number(res.body.queuePosition ?? 0);
  const enqueued = res.body.enqueued === true;
  const lines = [
    `session-id: ${id}`,
    `delivered:  ${enqueued ? `queued (position ${queuePosition})` : "starting turn"}`,
  ];
  success(deps.io, lines.join("\n"));
}

type WaitTerminal =
  | "idle"
  | "error"
  | "archived"
  | "timed-out"
  | "not-found"
  | "http-error";

interface SingleWaitResult {
  id: string;
  outcome: WaitTerminal;
  child: Record<string, unknown> | null;
  body: Record<string, unknown>;
  lastTransportError?: string;
  errorMessage?: string;
}

// Unknown 2xx responses remain pending; they do not prove the child finished.
function normalizeServerOutcome(
  body: Record<string, unknown>,
): "idle" | "error" | "archived" | "pending" | "timed-out" {
  const o = body.outcome;
  if (o === "idle" || o === "error" || o === "archived" || o === "pending" || o === "timed-out") {
    return o;
  }
  if (body.timedOut === true) return "timed-out";
  if (body.idle === true) return "idle";
  return "pending";
}

async function waitForChildOnce(
  id: string,
  deadline: number,
  deps: RunDeps,
): Promise<SingleWaitResult> {
  let backoff = WAIT_INITIAL_BACKOFF_MS;
  let lastTransportError: string | undefined;
  let lastBody: Record<string, unknown> = {};

  while (deps.now() < deadline) {
    const remainingMs = deadline - deps.now();
    const segSecs = Math.max(1, Math.min(WAIT_SEGMENT_SECS, Math.ceil(remainingMs / 1000)));
    const overallSecs = Math.max(1, Math.ceil(remainingMs / 1000));
    const path =
      `/agent-ops/session/wait/${encodeURIComponent(id)}` +
      `?timeout=${overallSecs}&segment=${segSecs}`;
    const res = await deps.call(
      "GET",
      path,
      undefined,
      deps.env,
      segSecs * 1000 + WAIT_REQUEST_MARGIN_MS,
    );

    if (res.status === 404) {
      return {
        id,
        outcome: "not-found",
        child: null,
        body: res.body,
        errorMessage: `${CHILD_NOT_FOUND}\n${WHOAMI_HINT}`,
        ...(lastTransportError ? { lastTransportError } : {}),
      };
    }
    if (isTransientStatus(res.status)) {
      lastTransportError = formatError(res, "transport error reaching the ShipIt orchestrator");
      const sleepMs = Math.min(backoff, Math.max(0, deadline - deps.now()));
      if (sleepMs <= 0) break;
      await deps.sleep(sleepMs);
      backoff = Math.min(backoff * 2, WAIT_MAX_BACKOFF_MS);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        id,
        outcome: "http-error",
        child: null,
        body: res.body,
        errorMessage: formatError(res, "Failed to wait on spawned session"),
        ...(lastTransportError ? { lastTransportError } : {}),
      };
    }

    backoff = WAIT_INITIAL_BACKOFF_MS;
    lastBody = res.body;
    const outcome = normalizeServerOutcome(res.body);
    if (outcome === "pending") continue;
    if (outcome === "timed-out") break;
    return {
      id,
      outcome,
      child: (res.body.child as Record<string, unknown> | null) ?? null,
      body: res.body,
      ...(lastTransportError ? { lastTransportError } : {}),
    };
  }

  return {
    id,
    outcome: "timed-out",
    child: (lastBody.child as Record<string, unknown> | null) ?? null,
    body: lastBody,
    ...(lastTransportError ? { lastTransportError } : {}),
  };
}

function exitCodeForWait(outcome: WaitTerminal): number {
  switch (outcome) {
    case "idle":
    case "archived":
      return WAIT_EXIT_IDLE;
    case "error":
      return WAIT_EXIT_ERROR;
    case "timed-out":
      return WAIT_EXIT_TIMED_OUT;
    default:
      return 1;
  }
}

export async function handleSessionWait(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--timeout": "timeout", "-T": "timeout" },
    booleans: { "--json": "json", "--any": "any", "--all": "all" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session wait: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const ids = parsed.positional;
  if (ids.length === 0) {
    fail(deps.io, "shipit session wait: child session id is required.");
  }
  if (parsed.booleans.has("any") && parsed.booleans.has("all")) {
    fail(deps.io, "shipit session wait: --any and --all are mutually exclusive.");
  }

  let overallSecs = WAIT_DEFAULT_OVERALL_SECS;
  if (parsed.values.timeout) {
    const n = Number(parsed.values.timeout);
    if (!Number.isFinite(n) || n <= 0) {
      fail(deps.io, "shipit session wait: --timeout must be a positive number of seconds.");
    }
    overallSecs = Math.min(Math.floor(n), MAX_WAIT_TIMEOUT_SECS);
  }

  const json = parsed.booleans.has("json");
  const deadline = deps.now() + overallSecs * 1000;

  if (ids.length === 1) {
    const result = await waitForChildOnce(ids[0], deadline, deps);
    renderSingleWait(result, deps, json);
    return;
  }

  const mode: "any" | "all" = parsed.booleans.has("any") ? "any" : "all";
  if (mode === "any") {
    const winner = await waitAnyChild(ids, deadline, deps);
    renderMultiWait([winner], ids, mode, deps, json);
    return;
  }
  const results = await Promise.all(ids.map((id) => waitForChildOnce(id, deadline, deps)));
  renderMultiWait(results, ids, mode, deps, json);
}

function waitAnyChild(ids: string[], deadline: number, deps: RunDeps): Promise<SingleWaitResult> {
  return new Promise<SingleWaitResult>((resolve) => {
    let done = false;
    const tasks = ids.map(async (id) => {
      const r = await waitForChildOnce(id, deadline, deps);
      if (!done && r.outcome !== "timed-out") {
        done = true;
        resolve(r);
      }
      return r;
    });
    void (async () => {
      const all = await Promise.all(tasks);
      if (done) return;
      done = true;
      resolve(all[0]);
    })();
  });
}

function renderSingleWait(result: SingleWaitResult, deps: RunDeps, json: boolean): void {
  if (result.outcome === "not-found") {
    fail(deps.io, result.errorMessage ?? "Spawned session not found.", 1);
  }
  if (result.outcome === "http-error") {
    fail(deps.io, result.errorMessage ?? "Failed to wait on spawned session.", 1);
  }

  if (json) {
    const out = {
      ...result.body,
      outcome: result.outcome,
      ...(result.lastTransportError ? { lastTransportError: result.lastTransportError } : {}),
    };
    deps.io.stdout(`${JSON.stringify(out)}\n`);
    deps.io.exit(exitCodeForWait(result.outcome));
    return;
  }

  const child = result.child;
  const idle = result.outcome === "idle" || result.outcome === "archived";
  const timedOut = result.outcome === "timed-out";
  const lines = [
    `${asString(child?.title)} (${asString(child?.id)})`,
    `status:     ${asString(child?.status) || "idle"}`,
    `branch:     ${asString(child?.branch) || "(no branch)"}`,
    `queue:      ${asString(child?.queueLength) || "0"}`,
    `outcome:    ${result.outcome}`,
    `idle:       ${idle}`,
    `timed-out:  ${timedOut}`,
  ];
  if (result.lastTransportError) {
    lines.push(`note:       transport retried (${result.lastTransportError})`);
  }
  if (child?.latestAssistantMessage) {
    lines.push("", asString(child.latestAssistantMessage));
  }
  deps.io.stdout(`${lines.join("\n")}\n`);
  deps.io.exit(exitCodeForWait(result.outcome));
}

function aggregateExitCode(results: SingleWaitResult[]): number {
  if (results.some((r) => r.outcome === "error")) return WAIT_EXIT_ERROR;
  if (results.some((r) => exitCodeForWait(r.outcome) !== WAIT_EXIT_IDLE)) return WAIT_EXIT_TIMED_OUT;
  return WAIT_EXIT_IDLE;
}

function renderMultiWait(
  results: SingleWaitResult[],
  ids: string[],
  mode: "any" | "all",
  deps: RunDeps,
  json: boolean,
): void {
  const exit = mode === "any" ? exitCodeForWait(results[0].outcome) : aggregateExitCode(results);

  if (json) {
    const out = {
      mode,
      ids,
      results: results.map((r) => ({
        id: r.id,
        outcome: r.outcome,
        child: r.child,
        ...(r.lastTransportError ? { lastTransportError: r.lastTransportError } : {}),
      })),
    };
    deps.io.stdout(`${JSON.stringify(out)}\n`);
    deps.io.exit(exit);
    return;
  }

  const lines: string[] = [];
  if (mode === "any") {
    const w = results[0];
    lines.push(`first-finished: ${w.id}`);
    lines.push(`outcome:        ${w.outcome}`);
    const remaining = ids.filter((id) => id !== w.id);
    if (remaining.length > 0) {
      lines.push(`still-waiting:   ${remaining.join(", ")}`);
    }
  } else {
    for (const r of results) {
      lines.push(`${r.id}\t${r.outcome}`);
    }
  }
  deps.io.stdout(`${lines.join("\n")}\n`);
  deps.io.exit(exit);
}

export async function handleSessionArchive(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {},
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session archive: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const id = parsed.positional[0];
  if (!id) {
    fail(deps.io, "shipit session archive: child session id is required.");
  }

  const res = await deps.call(
    "POST",
    `/agent-ops/session/archive/${encodeURIComponent(id)}`,
    {},
    deps.env,
  );
  if (res.status === 404) {
    fail(deps.io, `${CHILD_NOT_FOUND}\n${WHOAMI_HINT}`, 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to archive spawned session"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  success(deps.io, `session-id: ${id}\narchived:   true`);
}

export async function handleSessionNotifyOnMerge(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {},
    booleans: { "--json": "json", "--self": "self" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session notify-on-merge: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  if (parsed.booleans.has("self")) {
    if (parsed.positional[0]) {
      fail(
        deps.io,
        "shipit session notify-on-merge --self takes no session id — it always watches this session's own PR.",
      );
    }
    await armSelfMergeWatch(parsed.booleans.has("json"), deps);
    return;
  }

  const id = parsed.positional[0];
  if (!id) {
    fail(deps.io, "shipit session notify-on-merge: child session id is required (or use --self).");
  }

  const res = await deps.call(
    "POST",
    `/agent-ops/session/notify-on-merge/${encodeURIComponent(id)}`,
    {},
    deps.env,
  );
  if (res.status === 404) {
    fail(deps.io, `${CHILD_NOT_FOUND}\n${WHOAMI_HINT}`, 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to register merge watch"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const already = res.body.alreadyArmed === true;
  success(
    deps.io,
    `session-id:      ${id}\nnotify-on-merge: ${already ? "already armed" : "armed"}`,
  );
}

async function armSelfMergeWatch(json: boolean, deps: RunDeps): Promise<void> {
  const res = await deps.call("POST", "/agent-ops/session/notify-on-merge-self", {}, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to arm self merge-watch"), 1);
  }
  if (json) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const prNumber = res.body.prNumber as number | undefined;
  const replaced = res.body.replaced === true;
  success(
    deps.io,
    `notify-on-merge: ${replaced ? "re-armed" : "armed"} (self)\n`
    + `watching:        PR #${prNumber ?? "?"}\n`
    + "on merge:        this session is woken with a turn. Run `shipit branch reset-to-base` first,\n"
    + "                 then continue; re-arm after opening the next PR if more work remains.",
  );
}

const REPORT_SEVERITIES = ["fyi", "warn", "blocker"];
const REPORT_TARGETS = ["parent"];
const MAX_REPORT_BODY_CHARS = 10_000;

export async function handleSessionRename(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--title": "title" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session rename: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const title = parsed.values.title;
  if (!title) {
    fail(deps.io, 'shipit session rename: --title is required, e.g. shipit session rename --title "Add billing"');
  }
  if (parsed.positional.length > 0) {
    fail(
      deps.io,
      "shipit session rename takes no session id — it always renames THIS session. "
        + "You cannot rename another session, including one you spawned.",
    );
  }

  const res = await deps.call("POST", "/agent-ops/session/rename", { title }, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to rename this session"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const from = asString(res.body.previousTitle);
  const to = asString(res.body.title);
  success(
    deps.io,
    from && from !== to
      ? `renamed: ${from}\n     ->: ${to}`
      : `title:   ${to} (unchanged)`,
  );
}

export async function handleSessionWhoami(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { values: {}, booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session whoami: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const res = await deps.call("GET", "/agent-ops/session/cohort", undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to resolve this session"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }

  const self = (res.body.self ?? {}) as Record<string, unknown>;
  const parent = res.body.parent as Record<string, unknown> | undefined;
  const siblings = (res.body.siblings as Record<string, unknown>[] | undefined) ?? [];
  const children = (res.body.children as Record<string, unknown>[] | undefined) ?? [];

  const lines = [
    `session:  ${asString(self.title)} (${asString(self.id)})`,
    `status:   ${asString(self.status) || "idle"}`,
    `branch:   ${asString(self.branch) || "(no branch)"}`,
  ];
  lines.push(
    parent
      ? `parent:   ${asString(parent.title)} (${asString(parent.id)})`
      : "parent:   (none — this session is top-level or was spawned --detached; `shipit session report` is unavailable)",
  );
  if (res.body.rootSessionId && res.body.rootSessionId !== (parent?.id ?? "")) {
    lines.push(`root:     ${asString(res.body.rootSessionId)}`);
  }
  lines.push("", `siblings: ${siblings.length === 0 ? "(none)" : ""}`);
  for (const s of siblings) lines.push(`  ${formatPeer(s)}`);
  lines.push(`children: ${children.length === 0 ? "(none)" : ""}`);
  for (const c of children) lines.push(`  ${formatPeer(c)}`);
  success(deps.io, lines.join("\n"));
}

function formatPeer(peer: Record<string, unknown>): string {
  return [
    asString(peer.id),
    asString(peer.status) || "idle",
    asString(peer.branch) || "(no branch)",
    asString(peer.title),
  ].join("\t");
}

export async function handleSessionReport(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-b": "body", "--body": "body", "-m": "body", "--message": "body",
      "-F": "bodyFile", "--body-file": "bodyFile",
      "--subject": "subject", "-t": "subject", "--title": "subject",
      "--severity": "severity", "-s": "severity",
      "--to": "to",
    },
    booleans: { "--json": "json", "--cohort": "cohort" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session report: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const body = parsed.values.bodyFile
    ? await readBodyFromFileOrStdin(parsed.values.bodyFile, deps.io, "shipit session report", "report body")
    : parsed.values.body;
  if (!body?.trim()) {
    fail(
      deps.io,
      "shipit session report: -b/--body (or --body-file -) is required — the report text to push to your parent.",
    );
  }
  if (body.length > MAX_REPORT_BODY_CHARS) {
    fail(
      deps.io,
      `shipit session report: the body exceeds ${MAX_REPORT_BODY_CHARS.toLocaleString()} characters. ` +
        "A report is a note that has to travel; put the long form in your PR body and summarize it here.",
    );
  }

  const severity = parsed.values.severity ?? "fyi";
  if (!REPORT_SEVERITIES.includes(severity)) {
    fail(
      deps.io,
      `shipit session report: unknown --severity '${severity}'. Valid: ${REPORT_SEVERITIES.join(", ")}.`,
    );
  }
  if (parsed.booleans.has("cohort")) {
    fail(
      deps.io,
      "shipit session report: --cohort is not allowed. Child sessions can report only to their parent.",
    );
  }
  const to = parsed.values.to ?? "parent";
  if (!REPORT_TARGETS.includes(to)) {
    fail(
      deps.io,
      `shipit session report: unknown --to '${to}'. Valid: ${REPORT_TARGETS.join(", ")}. ` +
        "Child sessions cannot message siblings or target an arbitrary session id.",
    );
  }

  const payload: Record<string, unknown> = { body, severity, to };
  if (parsed.values.subject) payload.subject = parsed.values.subject;

  const res = await deps.call("POST", "/agent-ops/session/report", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to deliver the report"), 1);
  }

  const recipients = (res.body.recipients as Record<string, unknown>[] | undefined) ?? [];
  const wokenCount = recipients.filter((r) => r.woken === true).length;

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(wokenCount > 0 ? 0 : 1);
    return;
  }

  const lines = [
    `report-id: ${asString(res.body.reportId)}`,
    `severity:  ${asString(res.body.severity)}`,
    `to:        ${asString(res.body.to)}`,
    `delivered: ${wokenCount}/${recipients.length} recipient(s) woken`,
  ];
  for (const r of recipients) {
    const outcome = r.woken === true
      ? "woken"
      : `NOT woken (${asString(r.error) || "unknown error"}) — the card was still posted in its chat`;
    lines.push(`  parent ${asString(r.title)} (${asString(r.sessionId)}): ${outcome}`);
  }
  deps.io.stdout(`${lines.join("\n")}\n`);
  deps.io.exit(wokenCount > 0 ? 0 : 1);
}
