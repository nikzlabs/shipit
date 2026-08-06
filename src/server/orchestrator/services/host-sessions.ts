/**
 * docs/255 — host session INVENTORY for Ops sessions.
 *
 * An Ops session can already read the host's Docker state, the systemd journal
 * and the deployed ShipIt source, but until this module it could not answer the
 * single most common triage question: *which session produced this branch / PR /
 * container?* That answer lives in the orchestrator's `sessions` table; this
 * service is the read-only, Ops-gated projection of it.
 *
 * ## Metadata only — the boundary this module exists to hold
 *
 * {@link buildHostSessionView} is an explicit ALLOWLIST. It names every field it
 * emits, so a future column on `SessionInfo` is withheld by default rather than
 * leaking through a spread. What it deliberately does NOT emit:
 *
 *  - conversation replay, prompts, queued messages, or the latest assistant
 *    message text (the sibling `ChildSessionView` in `child-sessions.ts` does
 *    carry `latestAssistantMessage` — correct there, since a parent owns its
 *    child's output; wrong here, since this crosses into another user's session),
 *  - secrets, tokens, provider routes, env, or the agent session id,
 *  - `workspaceDir` and anything about workspace contents.
 *
 * An Ops session may see *that* a session exists and *what it owns*. It may not
 * read what was said inside it. Same posture as `shipit-source.ts`'s redaction.
 *
 * The Ops gate itself lives on the route (`api-routes-host-sessions.ts`), which
 * checks the server-authoritative `session.kind === "ops"` under the CALLER'S
 * OWN session path — so `api-container-guard.ts` keeps its shape untouched.
 */

import type { SessionInfo } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import { stripUrlCredentials } from "../git-utils.js";
import { ServiceError } from "./types.js";

/** Default number of sessions returned when the caller doesn't pass `limit`. */
export const DEFAULT_HOST_SESSION_LIMIT = 200;
/** Hard cap so a single inventory read can't flood the agent's context. */
export const MAX_HOST_SESSION_LIMIT = 500;

/**
 * Length of the session-id slice that both host-visible container-name shapes
 * embed: `agent-<slice>` (the session container, `container-lifecycle.ts`) and
 * `shipit-<slice>` (the session's Compose project, `compose-cli.ts`).
 */
const CONTAINER_ID_SLICE = 12;

/**
 * The metadata-only inventory record for one session. Every field here is
 * deliberate — see the module docstring before adding one.
 */
export interface HostSessionView {
  id: string;
  title: string;
  /** `"ops"` / `"sandbox"`, or undefined for an ordinary session. */
  kind?: "ops" | "sandbox";
  branch?: string;
  /** Repository the session is bound to. Empty string for a standalone session. */
  remoteUrl?: string;
  /** Session that spawned this one (docs/117), if any. */
  parentSessionId?: string;
  /** Top-level ancestor of the spawn tree (docs/201), if nested. */
  rootSessionId?: string;
  /** Message-group id of the parent turn that spawned it. */
  spawnedByTurn?: string;
  agentId?: string;
  model?: string;
  createdAt: string;
  lastUsedAt: string;
  mergedAt?: string;
  closedAt?: string;
  /** True when the user explicitly hid the session from the sidebar. */
  archived?: boolean;
  /** docs/161 disk tier: how much of the session is still on disk. */
  diskTier: "hot" | "light" | "evicted";
  warm?: boolean;
  pinned?: boolean;
  /**
   * The session container's name as it appears in `docker ps` and the host
   * journal. Derived, not stored — it is the reverse of the `container=` lookup
   * so an operator can go straight back to Docker with the answer.
   */
  containerName: string;
  /** Compose project name for the session's services (`shipit-<slice>`). */
  composeProject: string;
  /** Current PR snapshot. Number/url/state only — never title, body, or comments. */
  pr?: {
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    baseBranch: string;
    headBranch: string;
  };
  /** docs/202 breadcrumb: a PR this branch shipped before the current one. */
  previousPr?: { number: number; url: string };
}

/** Filters for {@link queryHostSessions}. All supplied filters must match (AND). */
export interface HostSessionQuery {
  branch?: string;
  pr?: number;
  container?: string;
  id?: string;
  /**
   * Include sessions the user explicitly hid (`userArchived`). Default false.
   *
   * Deliberately keyed on `userArchived` and NOT on `diskTier === "evicted"`:
   * those are orthogonal (docs/161 — "Disk tier is irrelevant to visibility"),
   * and eviction happens to ordinary live sessions on the idle ladder after a
   * few days. Hiding evicted rows by default would hide exactly the older
   * sessions a post-hoc triage question is usually about. Archiving sets both
   * flags, so `userArchived` is the strictly narrower — and correct — cut.
   */
  includeArchived?: boolean;
  /**
   * Include warm (ungraduated pool) sessions. Default false: they are
   * pre-provisioned shells with no branch, no PR and no user, so they are noise
   * in a triage listing. An explicit `id`/`container` lookup always resolves
   * them regardless, since naming a specific box IS asking about that box.
   */
  includeWarm?: boolean;
  limit?: number;
  /** Skip this many matches before applying `limit`. Pages past the cap. */
  offset?: number;
}

export interface HostSessionQueryResult {
  sessions: HostSessionView[];
  /** Total matches before `limit`/`offset` were applied. */
  total: number;
  /** True when more matches exist beyond this page. */
  truncated: boolean;
  /** `offset` to pass for the next page, or undefined when this is the last. */
  nextOffset?: number;
}

/**
 * A session id is a UUID, so any prefix of one is hex digits and hyphens, with
 * the first eight characters hex. Used to refuse names that CANNOT be a session
 * id rather than silently matching on them — see
 * {@link sessionIdPrefixFromContainerName}.
 */
const UUID_PREFIX_RE = /^[0-9a-f]{1,8}(-[0-9a-f]{0,4})*$/i;

/**
 * Reduce a host-visible container/volume/project name to the session-id prefix
 * it embeds, or null when the name cannot be one.
 *
 * Handles, in one rule, every name ShipIt itself generates:
 *   `/agent-83292266-744`              → `83292266-744` (docker inspect .Names)
 *   `agent-83292266-744`               → `83292266-744` (docker ps)
 *   `shipit-83292266-744-web-1`        → `83292266-744` (compose service)
 *   `shipit-83292266-744_node_modules` → `83292266-744` (compose volume)
 *   `83292266-7445-4a…`                → the id itself  (pasted from a log line)
 *
 * Both prefixes are stripped and the leading 12 characters kept, because that
 * is exactly `sessionId.slice(0, 12)` — the slice both namers use. A shorter
 * bare input (a truncated log line) is passed through and matches more broadly.
 *
 * The `UUID_PREFIX_RE` check on an UNPREFIXED name is the important part. A
 * project's own `docker-compose.yml` may set an explicit `container_name:` and
 * ShipIt's generated override does not remove it, so a service container can
 * appear in `docker ps` as an arbitrary string like `payments-db`. Without the
 * check, its first 12 characters would be read as a session-id prefix and could
 * `LIKE`-match a completely unrelated session — a confidently wrong answer,
 * which is worse than no answer for a surface whose whole point is to end
 * guesswork. Returning null lets the caller say so and point at the container's
 * `shipit-session-id` / `shipit-parent-session` label instead, which is
 * authoritative for exactly these containers.
 */
export function sessionIdPrefixFromContainerName(name: string): string | null {
  const trimmed = name.trim().replace(/^\/+/, "");
  const prefixed = trimmed.startsWith("agent-") || trimmed.startsWith("shipit-");
  let rest = trimmed;
  if (rest.startsWith("agent-")) rest = rest.slice("agent-".length);
  else if (rest.startsWith("shipit-")) rest = rest.slice("shipit-".length);
  rest = rest.slice(0, CONTAINER_ID_SLICE);
  if (rest.length === 0) return null;
  // A ShipIt-generated name is trusted by construction; anything else has to
  // actually look like a session id before we match on it.
  if (!prefixed && !UUID_PREFIX_RE.test(rest)) return null;
  return rest;
}

/** The session container name ShipIt gives `sessionId` (`container-lifecycle.ts`). */
export function containerNameForSession(sessionId: string): string {
  return `agent-${sessionId.slice(0, CONTAINER_ID_SLICE)}`;
}

/** The Compose project name ShipIt gives `sessionId`'s services (`compose-cli.ts`). */
export function composeProjectForSession(sessionId: string): string {
  return `shipit-${sessionId.slice(0, CONTAINER_ID_SLICE)}`;
}

/**
 * Project a `SessionInfo` (plus its persisted PR snapshot) down to the
 * metadata-only inventory record. ALLOWLIST — read the module docstring before
 * adding a field.
 */
export function buildHostSessionView(
  session: SessionInfo,
  prStatus: {
    prNumber: number;
    prUrl: string;
    prState: "open" | "merged" | "closed";
    baseBranch: string;
    headBranch: string;
  } | null,
): HostSessionView {
  const view: HostSessionView = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    diskTier: session.diskTier ?? "hot",
    containerName: containerNameForSession(session.id),
    composeProject: composeProjectForSession(session.id),
  };
  if (session.kind) view.kind = session.kind;
  if (session.branch) view.branch = session.branch;
  // `stripUrlCredentials` is NOT belt-and-suspenders here. The repo-wide
  // invariant is that a persisted origin carries no userinfo, but `setGitRemote`
  // (services/git.ts) writes the user-supplied URL through verbatim, so a
  // session row CAN hold `https://x-access-token:<pat>@github.com/o/r.git`.
  // Every other reader of `remoteUrl` shows it back to the session's OWN user;
  // this one shows it to a DIFFERENT session, which is precisely the boundary
  // req 8 draws around tokens. Strip at the crossing.
  if (session.remoteUrl) view.remoteUrl = stripUrlCredentials(session.remoteUrl);
  if (session.parentSessionId) view.parentSessionId = session.parentSessionId;
  if (session.rootSessionId) view.rootSessionId = session.rootSessionId;
  if (session.spawnedByTurn) view.spawnedByTurn = session.spawnedByTurn;
  if (session.agentId) view.agentId = session.agentId;
  if (session.model) view.model = session.model;
  if (session.mergedAt) view.mergedAt = session.mergedAt;
  if (session.closedAt) view.closedAt = session.closedAt;
  if (session.userArchived) view.archived = true;
  if (session.warm) view.warm = true;
  if (session.pinnedAt) view.pinned = true;
  if (prStatus) {
    view.pr = {
      number: prStatus.prNumber,
      url: prStatus.prUrl,
      state: prStatus.prState,
      baseBranch: prStatus.baseBranch,
      headBranch: prStatus.headBranch,
    };
  }
  // docs/202 breadcrumb — number + url only; `title` is on the stored shape but
  // is PR prose, and nothing in the inventory question needs it.
  if (session.previousMergedPr) {
    view.previousPr = {
      number: session.previousMergedPr.number,
      url: session.previousMergedPr.url,
    };
  }
  return view;
}

/**
 * Run an inventory query. With no filters this is the full host inventory
 * (non-archived, most recently used first); every supplied filter narrows it
 * further (AND). `includeArchived` / `includeWarm` widen it, and `offset` pages
 * past `limit` so an unbounded host is still fully enumerable.
 */
export function queryHostSessions(
  sessionManager: SessionManager,
  query: HostSessionQuery = {},
): HostSessionQueryResult {
  const limit = normalizeLimit(query.limit);
  const offset = normalizeOffset(query.offset);

  // Resolve the container name ONCE — it is both the candidate lookup and (when
  // some other filter is primary) the in-memory predicate, and a 400 for an
  // unparseable name must not depend on which branch happened to run.
  let containerPrefix: string | null = null;
  if (query.container !== undefined) {
    containerPrefix = sessionIdPrefixFromContainerName(query.container);
    if (!containerPrefix) {
      // A project's compose file can set an explicit `container_name:`, which
      // ShipIt's override does not rewrite — so this name is real but carries no
      // session id. Name the authoritative fallback rather than dead-ending: the
      // labels are on exactly the containers this branch can't parse.
      throw new ServiceError(
        400,
        `"${query.container}" doesn't contain a session id. If it is a service container ` +
          "with an explicit container_name, read the owner off its label instead: " +
          `docker inspect ${query.container} --format '{{index .Config.Labels "shipit-parent-session"}}' ` +
          "(or \"shipit-session-id\" for a session container), then pass that to --id.",
      );
    }
  }

  // An operator who named a specific box or id is asking about THAT session, so
  // a warm (pre-provisioned pool) session must still resolve. Keyed on the
  // filter being SUPPLIED, not on which lookup happened to be primary — else
  // `--branch X --id Y` would silently behave differently from `--id Y`.
  const explicitTarget = containerPrefix !== null || query.id !== undefined;

  // Pick the narrowest available lookup as the candidate set, then apply the
  // remaining filters in memory. Only ONE of these runs.
  let candidates: SessionInfo[];
  if (query.branch !== undefined) {
    candidates = sessionManager.findByBranch(query.branch);
  } else if (query.pr !== undefined) {
    candidates = sessionManager.findByPrNumber(query.pr);
  } else if (containerPrefix !== null) {
    candidates = sessionManager.findByIdPrefix(containerPrefix);
  } else if (query.id !== undefined) {
    candidates = sessionManager.findByIdPrefix(query.id);
  } else if (query.includeWarm) {
    candidates = sessionManager.listAllIncludingWarm();
  } else {
    candidates = sessionManager.listAll();
  }

  const prNumbers = query.pr;
  const matches = candidates.filter((s) => {
    if (s.warm && !explicitTarget && !query.includeWarm) return false;
    if (!query.includeArchived && s.userArchived) return false;
    // Remaining filters, for the axes the candidate lookup didn't cover.
    if (query.branch !== undefined && s.branch !== query.branch) return false;
    if (containerPrefix !== null && !s.id.startsWith(containerPrefix)) return false;
    if (query.id !== undefined && !s.id.startsWith(query.id)) return false;
    if (prNumbers !== undefined && !matchesPr(sessionManager, s, prNumbers)) return false;
    return true;
  });

  const page = matches.slice(offset, offset + limit);
  const sessions = page.map((s) => buildHostSessionView(s, sessionManager.getPrStatus(s.id)));
  const consumed = offset + sessions.length;
  const result: HostSessionQueryResult = {
    sessions,
    total: matches.length,
    truncated: consumed < matches.length,
  };
  // Only offer a next page when one genuinely exists, so a caller can loop on
  // `nextOffset` being present rather than recomputing the arithmetic.
  if (consumed < matches.length) result.nextOffset = consumed;
  return result;
}

/**
 * Whether `session` owns PR `prNumber`, per its current snapshot or its
 * previously-merged breadcrumb. Used when `pr` is a secondary filter (the
 * candidate set came from `branch`), so the primary-path SQL isn't duplicated
 * as the only source of truth.
 */
function matchesPr(sessionManager: SessionManager, session: SessionInfo, prNumber: number): boolean {
  if (session.previousMergedPr?.number === prNumber) return true;
  return sessionManager.getPrStatus(session.id)?.prNumber === prNumber;
}

/**
 * Clamp `limit` into `[1, MAX_HOST_SESSION_LIMIT]`. A missing / non-numeric
 * value falls back to the default rather than erroring — the shim passes the
 * flag through verbatim and a typo shouldn't dead-end a triage question.
 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_HOST_SESSION_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_HOST_SESSION_LIMIT);
}

/** Floor `offset` at 0. Same forgiving posture as {@link normalizeLimit}. */
function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}
