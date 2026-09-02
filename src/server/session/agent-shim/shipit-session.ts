/**
 * `shipit session *` handlers — agent-driven session management.
 *
 * `create` spawns a sibling/child session; `list`/`view`/`message`/`wait`/
 * `archive`/`notify-on-merge` coordinate the children this session spawned.
 * Each handler brokers through the worker's `/agent-ops/session/*` routes; the
 * worker injects this container's session id as the parent so the agent can
 * only manage sessions it spawned. The dispatch + the rejected-subcommand gate
 * live in `shipit.ts`.
 *
 * `wait` (docs/182) owns its own resilient, resumable segment loop with an
 * overall deadline, so a parent agent never has to script its own retry loop.
 */

import {
  asString,
  fail,
  isTransientStatus,
  parseFlags,
  readBodyFromFileOrStdin,
  success,
} from "./shim-common.js";
import { INLINE_PROMPT_FLAGS, REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

/**
 * Server-enforced cap on `shipit session wait --timeout`. The shim mirrors
 * the orchestrator's `MAX_WAIT_FOR_CHILD_IDLE_MS` so a flag-side check can
 * reject obvious typos (`--timeout 99999h`) without a round-trip.
 */
const MAX_WAIT_TIMEOUT_SECS = 60 * 60; // 1 hour

/**
 * docs/182 — resilient-wait tuning. The shim owns the overall deadline and
 * drives a segment loop beneath it, so each network leg is short and a reset
 * costs one retried segment rather than the whole wait.
 */
const WAIT_DEFAULT_OVERALL_SECS = 5 * 60; // matches the server's old default
const WAIT_SEGMENT_SECS = 25; // bounded server segment (keepalive-friendly)
const WAIT_INITIAL_BACKOFF_MS = 500;
const WAIT_MAX_BACKOFF_MS = 8_000;
/** Per-request abort budget: one segment plus margin for the server's resolve. */
const WAIT_REQUEST_MARGIN_MS = 10_000;

/** Exit codes for `shipit session wait` (docs/182 distinguishable outcomes). */
const WAIT_EXIT_IDLE = 0;
const WAIT_EXIT_TIMED_OUT = 1;
const WAIT_EXIT_ERROR = 3;

/**
 * Inline prompt flags the agent might reach for out of muscle memory. We
 * intentionally do NOT accept them: a prompt passed on the command line gets
 * mangled the moment it contains backticks or `$(...)`, which the shell
 * evaluates before the shim ever sees the value. The prompt must come from a
 * file (or stdin via `--prompt-file -`), exactly like the `gh` shim's
 * `--body-file`. Detected here so the agent gets a redirect, not a generic
 * "unsupported flag" error.
 */
const INLINE_PROMPT_REDIRECT = `shipit session create: inline prompt flags (-p/--prompt/-m) are not supported.
Pass the prompt via --prompt-file FILE, or --prompt-file - to read it from stdin,
so backticks and $(...) in the prompt are not evaluated by the shell. Use a
single-quoted heredoc, exactly like \`gh pr create --body-file -\`:

  shipit session create --prompt-file - --title "..." <<'EOF'
  Your prompt here, with \`backticks\` and $(literal) preserved verbatim.
  EOF`;

/**
 * Shared 404 copy for the parent→child routes. Deliberately does NOT
 * disambiguate "wrong parent" from "not found" — that's the orchestrator's
 * cross-tenancy contract, and the shim must not leak what the server withholds.
 */
const CHILD_NOT_FOUND = "Spawned session not found, or not a descendant of this parent.";

/**
 * docs/233 — the id form of `view`/`message`/`wait` is descendant-scoped, so
 * passing your OWN id 404s. That dead end is exactly what planning#243 reported, so
 * every such 404 points at the command that does resolve self.
 */
const WHOAMI_HINT =
  "To see THIS session (its parent, siblings, and children), run `shipit session whoami`.";

export async function handleSessionCreate(args: string[], deps: RunDeps): Promise<void> {
  // Catch inline prompt flags before generic flag parsing so the agent gets a
  // targeted redirect to --prompt-file instead of a vague "unsupported flag".
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
      // docs/264-agent-roles req 16 — the SAME target vocabulary `shipit agent run` takes:
      // a role by name, any subset of its parameters as overrides, or all five
      // named. `--agent`/`--model` are two of those five and keep working
      // exactly as they did; `--role`, `--service`, `--billing-mode` and
      // `--effort` are new here — a child session could not say a service, a
      // billing mode or a reasoning level at all before this.
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
      // docs/205 — spawn a completely separate (parentless) session: no
      // linkage, no sidebar nesting, no coordination, no chat card.
      "--detached": "detached",
      // docs/264-agent-roles req 20 — decline the role this session is running,
      // which the child would otherwise inherit whole. The child still inherits
      // the parameters; what it does not inherit is the brief.
      "--no-role": "noRole",
      // docs/162 — Ops-only: target the ShipIt source repo, branched off the
      // exact deployed commit the Ops session inspected.
      "--shipit-source": "shipitSource",
      // docs/162 — allow spawning even when the inspected source ref is only
      // approximate (checkout HEAD, not the exact build commit).
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
  // docs/205 — a ShipIt fix session is inherently tracked (it's coordinated and
  // opens a PR against the ShipIt repo under an incident packet), so detaching
  // it makes no sense. Reject the combination rather than silently ignoring one.
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
  // Defensive client-side validation — the orchestrator also enforces these,
  // but failing fast on the shim side avoids a network round-trip.
  if (prompt.length > 50_000) {
    fail(deps.io, "shipit session create: the prompt exceeds 50,000 characters.");
  }
  // A title is REQUIRED for every spawn: the spawning agent already knows what
  // the session is for and is the best-placed namer, so it must name the
  // session explicitly rather than leaning on an AI naming round-trip. Fail
  // fast here with a clear message; the orchestrator (`spawnChildSession`)
  // enforces this authoritatively too. The `--shipit-source` path gets a
  // fix-specific message because its diagnosis is wrapped in a verbose incident
  // packet (docs/162) and can never double as the session name.
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

  // docs/264-agent-roles req 16 — the shared vocabulary, in the wire names both spawn
  // commands use, so one server-side parser reads both bodies. `--billing-mode`
  // is checked here for the same reason `agent run` checks it: it is the one
  // field with a closed value set the shim can reject without the catalogue,
  // which buys a message instead of a round trip. Everything else — an unknown
  // role, a model this install does not have, a level the harness does not
  // declare — is resolved server-side, whose refusal names the roles or the
  // parameter. The shim buys a message for what it can know and does not pretend
  // to know the rest.
  const billingMode = parsed.values.billingMode;
  if (billingMode !== undefined && billingMode !== "sub" && billingMode !== "key") {
    fail(
      deps.io,
      `shipit session create: --billing-mode must be "sub" (a subscription) or "key" (a metered API key), not "${billingMode}".`,
    );
  }
  // docs/264-agent-roles req 20 — `--role` and `--no-role` are contradictory
  // statements about the same thing, so the pair is refused rather than resolved
  // by precedence: a caller that wrote both had one of the two in mind, and
  // guessing which one runs a child on a brief it may have meant to decline.
  if (parsed.booleans.has("noRole") && parsed.values.role !== undefined) {
    fail(
      deps.io,
      "shipit session create: --no-role and --role name opposite things. Pass --role NAME to run "
        + "that role, or --no-role to decline the role this session is running.",
    );
  }
  const payload: Record<string, unknown> = { prompt };
  if (parsed.values.title) payload.title = parsed.values.title;
  // `!== undefined`, NOT a truthiness test — the same rule `shipit agent run`
  // states at its own payload builder, and for the same reason: a flag the
  // caller passed with an empty value is something they TRIED to say, and
  // dropping it here would run the *bare* role (or the bare inheritance)
  // instead, which is the dropped override req 10 forbids. It rides along and
  // the server refuses it by name, so both commands answer `--model=""`
  // identically — one parser, one refusal rule (req 16).
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

  // Plain-text rendering. Keep this stable — the agent learns to parse it.
  const session = (res.body.session ?? {}) as Record<string, unknown>;
  const lines = [
    `session-id: ${asString(res.body.sessionId)}`,
    `branch:     ${asString(res.body.branch)}`,
    `status:     ${asString(res.body.status) || "running"}`,
  ];
  // docs/264-agent-roles req 14 — say which role started it, and that this is where the
  // role's involvement ends: the child routes like any other session afterwards,
  // so a later "why is it on a different model?" has its answer up front.
  if (session.originRoleName) {
    lines.push(
      `role:       ${asString(session.originRoleName)} (starting point only — the session routes on its own from here)`,
    );
  }
  // docs/205 — make it unmistakable that a detached spawn is severed: the agent
  // must not expect to `wait`/`view`/`message` it afterward.
  if (parsed.booleans.has("detached")) {
    lines.push("detached:   yes (separate session — not a child; cannot be waited on, viewed, or messaged from here)");
  }
  success(deps.io, lines.join("\n"));
}

/**
 * Read the new session's prompt from a file path, or from stdin when the path
 * is `-`. Mirrors the `gh` shim's `resolveBody` so the two shims read external
 * content the same way. Exits non-zero with a helpful message when the file
 * can't be read.
 */
async function readPromptFile(promptFile: string, deps: RunDeps): Promise<string> {
  return readBodyFromFileOrStdin(promptFile, deps.io, "shipit session create", "prompt file");
}

/**
 * docs/255 — the host-inventory query shared by `shipit session find` and
 * `shipit session list --all`. Both are Ops-only; the orchestrator's 403 is
 * surfaced verbatim, so the shim carries no second copy of the gate.
 */
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

/**
 * The "there is more" footer. Names the exact next command rather than saying
 * "pass --limit", because the server caps `limit` — past the cap, paging with
 * `--offset` is the ONLY way to reach the rest, and a hint that suggests
 * otherwise sends the agent in a loop against a ceiling it cannot raise.
 */
function moreLine(total: number, nextOffset: number | undefined, noun: string): string {
  const base = `… ${total} ${noun} in total.`;
  return nextOffset === undefined ? base : `${base} Next page: --offset ${nextOffset}`;
}

/** Render one inventory record as an aligned, scannable text block. */
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

/**
 * Read a PR number out of what an operator actually has in hand: `1744`,
 * `#1744`, or a PR URL in any of its real forms.
 *
 * The `/pull/<n>` branch is checked FIRST and is why this isn't a one-liner. A
 * plain "trailing digits" match reads `…/pull/1744/files` as no match at all
 * and — worse — `…/pull/1744?x=1` as PR **1**, silently looking up the wrong
 * PR. Both URLs are ordinary things to paste out of a browser.
 */
function parsePrNumber(raw: string): string | undefined {
  const value = raw.trim();
  const fromUrl = /\/pull\/(\d+)(?:[/?#]|$)/.exec(value)?.[1];
  if (fromUrl) return fromUrl;
  // Not a PR URL: accept `1744` or `#1744`, anchored so a stray number inside
  // some other string can't be mistaken for the PR.
  return /^#?(\d+)$/.exec(value)?.[1];
}

/**
 * docs/255 — `shipit session find --branch|--pr|--container|--id`.
 *
 * The one-step answer to "which session produced this?", for an Ops session
 * triaging a branch, a PR, or a container name lifted from `docker ps` or the
 * host journal. Metadata only: the orchestrator never returns another session's
 * conversation, prompts, secrets, or workspace contents.
 */
export async function handleSessionFind(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--branch": "branch",
      "--pr": "pr",
      "--container": "container",
      "--id": "id",
      // Muscle-memory alias. It maps onto the SAME `id=` query param — the
      // route deliberately doesn't take a `session=` filter, because that is
      // the param name `api-container-guard.ts` reads as a SCOPE.
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

/**
 * docs/264 — `shipit session logs <session-id> [--since t] [--until t]
 * [--lines N] [--json]`.
 *
 * Ops-only. Returns another session's orchestrator lifecycle lines — auto-push
 * outcomes, container recovery, idle disposal, agent process lifecycle. It is
 * NOT the session's Logs panel: the server returns only lines whose whole text
 * is one ShipIt itself authored, so agent output, preview errors, install
 * output, and any line quoting workspace or raw error text are withheld. No
 * flag reaches them; withheld lines are reported as a count, broken down by the
 * ShipIt-authored SHAPE of the producer that wrote them — never by anything
 * taken from the withheld lines themselves.
 *
 * Read from the durable store, so a session whose container is already gone
 * still answers. The orchestrator's 403 is surfaced verbatim — the shim carries
 * no second copy of the Ops gate.
 */
export async function handleSessionLogs(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--since": "since", "-S": "since",
      "--until": "until", "-U": "until",
      "--lines": "lines", "-n": "lines",
      // Muscle-memory alias for the positional id.
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
  // `withheldTotal` is every withheld line; `withheldUnclassified` is the
  // residue ShipIt could not name. Fall back to the older field name so a shim
  // talking to an orchestrator that predates the breakdown still reports a
  // total rather than silently printing nothing.
  const unclassified = Number(res.body.withheldUnclassified ?? 0);
  const withheld = Number(res.body.withheldTotal ?? unclassified);
  const byShape = (res.body.withheldByShape as { shape?: unknown; count?: unknown }[] | undefined) ?? [];
  const header = [
    `session:   ${asString(res.body.title) || "(untitled)"} (${asString(res.body.sessionId)})`,
    `container: ${asString(res.body.containerName)}`,
    `disk:      ${asString(res.body.diskTier)}${res.body.archived === true ? " (archived)" : ""}`,
    `entries:   ${entries.length}${res.body.truncated === true ? ` of ${asString(res.body.total)} (oldest dropped — raise --lines)` : ""}`,
  ];
  // Never silent: these lines exist and were deliberately not returned. Most
  // carry workspace or raw error text and never will be — but this count is also
  // the only signal that a producer's wording drifted off its template.
  if (withheld > 0) {
    header.push(
      `withheld:  ${withheld} server line(s) not on the ops-safe template list `
        + "(they carry workspace or raw error text). Read them with the operator in the session's UI.",
    );
    // A bare total is not actionable — 384 reads the same whether it is one
    // chatty producer or the one line that drifted off its template. The
    // breakdown is ShipIt's own labels and counts; no part of a withheld line
    // is in it. `unclassified` is listed last and is the number to watch: it is
    // where a NEW or drifted producer shows up.
    const parts = [
      ...byShape.map((s) => `${asString(s.shape)} ×${Number(s.count ?? 0)}`),
      ...(unclassified > 0 ? [`unclassified ×${unclassified}`] : []),
    ];
    if (parts.length > 0) header.push(`  by shape: ${parts.join(", ")}`);
  }
  if (entries.length === 0) {
    // An empty window and a pruned history look identical in the output but mean
    // opposite things, so never let the caller guess which one they are reading.
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

  // docs/255 — the host-inventory flags only mean anything alongside `--all`.
  // Refuse rather than ignore: `shipit session list --include-warm` would
  // otherwise quietly return the children list, which looks like a successful
  // answer to a question it never asked.
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

  // docs/255 — `--all` switches to the HOST inventory (Ops-only). Without it the
  // command is unchanged: this session's own spawned children, and nothing else.
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
  // docs/233 — a bare `view` used to be an error, which left a session with no
  // way to look at ITSELF (the id form is descendant-scoped, so passing your own
  // id 404s). Treat it as `whoami`: describe this session and its cohort.
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
  // Surface the resolved backend/model so the agent can confirm which model the
  // child actually runs on, rather than relying on the child's self-report.
  if (child.agent) {
    lines.push(`agent:      ${asString(child.agent)}`);
  }
  if (child.model) {
    lines.push(`model:      ${asString(child.model)}`);
  }
  // docs/264-agent-roles req 14 — what STARTED it, beside what it runs on now. The two can
  // legitimately differ: a role hands a child its opening tuple and stops being
  // involved, so a child may have moved on through ordinary routing.
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

/** A terminal or transport classification of one child's wait. */
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
  /** The last server response body (for `--json` passthrough). */
  body: Record<string, unknown>;
  /** Set when transport errors were swallowed during the wait. */
  lastTransportError?: string;
  /** Human message for not-found / http-error outcomes. */
  errorMessage?: string;
}

/**
 * Map a server wait response to a normalized outcome. New servers send an
 * explicit `outcome`; legacy responses are derived from `idle` / `timedOut`.
 * An unrecognized 2xx is treated as `pending` so the loop keeps polling
 * (bounded by the overall deadline) rather than returning a wrong terminal.
 */
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

/**
 * docs/182 — wait on a single child with a resumable segment loop. Each
 * iteration issues a bounded server segment; on `pending` it re-issues, and on
 * a transient transport failure it backs off and retries — all beneath the
 * overall `deadline`. Only a genuine terminal condition (idle / error /
 * archived) or the deadline (`timed-out`) ends the loop. Never throws.
 */
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
      // Transport failure is NEVER an outcome — swallow and retry with backoff.
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

    // 2xx — reset backoff and act on the outcome.
    backoff = WAIT_INITIAL_BACKOFF_MS;
    lastBody = res.body;
    const outcome = normalizeServerOutcome(res.body);
    if (outcome === "pending") continue;
    if (outcome === "timed-out") break; // legacy server timed out; honor the deadline below
    return {
      id,
      outcome,
      child: (res.body.child as Record<string, unknown> | null) ?? null,
      body: res.body,
      ...(lastTransportError ? { lastTransportError } : {}),
    };
  }

  // Overall deadline exhausted (or a legacy server reported timed-out).
  return {
    id,
    outcome: "timed-out",
    child: (lastBody.child as Record<string, unknown> | null) ?? null,
    body: lastBody,
    ...(lastTransportError ? { lastTransportError } : {}),
  };
}

/** Map a single wait outcome to its process exit code. */
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
      return 1; // not-found / http-error
  }
}

/**
 * `shipit session wait <id...> [--timeout SECONDS] [--any|--all] [--json]`.
 *
 * docs/182 — resilient, level-triggered, resumable wait with distinguishable
 * outcomes. A single call is the robust unit: the shim owns the overall deadline
 * and absorbs transport resets beneath it, so a parent agent never has to script
 * its own retry loop. Multiple ids fan out over the same resilient single-wait
 * with one shared deadline (`--any` = first finisher, `--all` = every child).
 */
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

  // Defense-in-depth client-side validation. The orchestrator also enforces.
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

  // Single id — the common case. Preserve the legacy text/JSON shape.
  if (ids.length === 1) {
    const result = await waitForChildOnce(ids[0], deadline, deps);
    renderSingleWait(result, deps, json);
    return;
  }

  // Multi id (docs/182 §F) — fan out over the resilient single-wait, sharing
  // one overall deadline so `--timeout` bounds the whole call, not each child.
  const mode: "any" | "all" = parsed.booleans.has("any") ? "any" : "all";
  if (mode === "any") {
    const winner = await waitAnyChild(ids, deadline, deps);
    renderMultiWait([winner], ids, mode, deps, json);
    return;
  }
  const results = await Promise.all(ids.map((id) => waitForChildOnce(id, deadline, deps)));
  renderMultiWait(results, ids, mode, deps, json);
}

/**
 * `--any` — resolve as soon as the first listed child reaches a terminal
 * (non-timed-out) outcome; if none do before the shared deadline, resolve with
 * the first (timed-out) result. Returns the winner so the parent can act on it
 * and wait on the rest.
 */
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

/** Render a single-child wait result (text or JSON) and exit. */
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

/**
 * Aggregate exit code for a multi-child wait: any reaching error (3) takes
 * precedence, then any not-found/http-error/timed-out (1), else idle (0).
 */
function aggregateExitCode(results: SingleWaitResult[]): number {
  if (results.some((r) => r.outcome === "error")) return WAIT_EXIT_ERROR;
  if (results.some((r) => exitCodeForWait(r.outcome) !== WAIT_EXIT_IDLE)) return WAIT_EXIT_TIMED_OUT;
  return WAIT_EXIT_IDLE;
}

/** Render a multi-child wait (`--any` winner, or `--all` results) and exit. */
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

/**
 * `shipit session notify-on-merge <child-id> [--json]` (docs/196) —
 * or `shipit session notify-on-merge --self [--json]` (docs/239).
 *
 * Arms an async watch: when the PR merges (or closes without merging), the
 * orchestrator wakes a session with a queued, self-describing system turn — no
 * blocking wait. Returns immediately ("armed"); the turn ends here and the woken
 * session resumes event-driven, possibly days later.
 *
 * With `--self` the watched PR is THIS session's own, and this session is what
 * gets woken. There is deliberately no follow-up payload: the transcript already
 * holds the plan, and the wake prompt says to continue it. Re-arming after the
 * next PR opens is how a multi-PR chain continues — nothing re-arms on the
 * agent's behalf.
 */
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

/**
 * docs/239 — the `--self` half of `notify-on-merge`. Always REPLACES any
 * previous self-watch, so a re-arm mid-chain is the normal case, not an error.
 * The one refusal is "no open PR for this branch", which the orchestrator
 * phrases (including the "if it already merged, just keep going" hint).
 */
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

// ---- Upward coordination (docs/233, planning#243) ----

/** Valid `--severity` values, mirrored from the orchestrator's service. */
const REPORT_SEVERITIES = ["fyi", "warn", "blocker"];
/** Valid `--to` target. Sibling delivery is deliberately unavailable. */
const REPORT_TARGETS = ["parent"];
/** Mirrors `MAX_REPORT_BODY_CHARS`; checked here to save a round-trip. */
const MAX_REPORT_BODY_CHARS = 10_000;

/**
 * `shipit session rename --title "<new title>" [--json]` (docs/250).
 *
 * Retitles THIS session. Takes no session id — the worker injects the calling
 * container's own id, so an agent can only ever rename itself (requirement 3).
 *
 * The title a session is given at the start comes from its first message, so a
 * session that goes on to do several rounds of work keeps a name describing only
 * the first. Renaming is what keeps the sidebar honest past the first PR.
 *
 * The one refusal is "the user renamed this session by hand", which is final —
 * the orchestrator phrases it, and the right response is to leave the name alone.
 */
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
  // A positional argument here is almost always a session id the agent tried to
  // pass out of muscle memory from the parent→child subcommands. Say so, rather
  // than silently renaming the wrong thing... which it can't, but the agent
  // doesn't know that.
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

/**
 * `shipit session whoami [--json]` (docs/233).
 *
 * Resolves the CALLING session — id, title, branch, status — plus its parent,
 * its read-only sibling topology, and any children it spawned. Before this, a
 * spawned session had no way to answer "who am I and
 * who am I working alongside?": `view <own-id>` is descendant-scoped and 404s,
 * and `list` only shows sessions the caller itself spawned.
 */
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

/** One `id  status  branch  title` peer row, shared by the sibling/child lists. */
function formatPeer(peer: Record<string, unknown>): string {
  return [
    asString(peer.id),
    asString(peer.status) || "idle",
    asString(peer.branch) || "(no branch)",
    asString(peer.title),
  ].join("\t");
}

/**
 * `shipit session report -b TEXT | --body-file FILE [--severity S] [--subject T]
 * [--to parent] [--json]` (docs/233).
 *
 * The upward push channel. The report lands in each recipient's transcript as a
 * persisted card AND as a queued system turn, so the recipient AGENT is woken
 * rather than having to go and look. The recipient is derived server-side from
 * this session's parent linkage — there is no `--to <session-id>` and no
 * sibling/cohort broadcast. The parent is the coordination hub.
 *
 * Exits 1 when no recipient's agent could be woken (the card is still posted, so
 * the human record survives); the per-recipient outcome is always printed.
 */
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
