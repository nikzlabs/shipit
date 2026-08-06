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
  /** Include user-archived / evicted sessions. Default false. */
  includeArchived?: boolean;
  limit?: number;
}

export interface HostSessionQueryResult {
  sessions: HostSessionView[];
  /** Total matches before `limit` was applied. */
  total: number;
  /** True when `total > sessions.length`. */
  truncated: boolean;
}

/**
 * Reduce a host-visible container/volume/project name to the session-id prefix
 * it embeds, or null when nothing usable is left.
 *
 * Handles, in one rule, every shape an operator has in hand:
 *   `/agent-83292266-744`            → `83292266-744`   (docker inspect .Names)
 *   `agent-83292266-744`             → `83292266-744`   (docker ps)
 *   `shipit-83292266-744-web-1`      → `83292266-744`   (compose service)
 *   `shipit-83292266-744_node_modules` → `83292266-744` (compose volume)
 *   `83292266-7445-4a…`              → the id itself    (pasted from a log line)
 *
 * Both prefixes are stripped and the leading 12 characters kept, because that
 * is exactly `sessionId.slice(0, 12)` — the slice both namers use. A shorter
 * input (a truncated log line) is passed through as-is and simply matches more
 * broadly.
 */
export function sessionIdPrefixFromContainerName(name: string): string | null {
  let rest = name.trim().replace(/^\/+/, "");
  if (rest.startsWith("agent-")) rest = rest.slice("agent-".length);
  else if (rest.startsWith("shipit-")) rest = rest.slice("shipit-".length);
  rest = rest.slice(0, CONTAINER_ID_SLICE);
  return rest.length > 0 ? rest : null;
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
  if (session.remoteUrl) view.remoteUrl = session.remoteUrl;
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
 * (non-warm, non-archived, most recently used first); every supplied filter
 * narrows it further (AND).
 *
 * Warm (ungraduated pool) sessions are excluded unless matched explicitly by id
 * or container name — they are pre-provisioned shells with no branch, no PR and
 * no user, so they are noise in a triage listing but should still resolve when
 * an operator hands us a specific container name.
 */
export function queryHostSessions(
  sessionManager: SessionManager,
  query: HostSessionQuery = {},
): HostSessionQueryResult {
  const limit = normalizeLimit(query.limit);

  // Resolve the container name ONCE — it is both the candidate lookup and (when
  // some other filter is primary) the in-memory predicate, and a 400 for an
  // unparseable name must not depend on which branch happened to run.
  let containerPrefix: string | null = null;
  if (query.container !== undefined) {
    containerPrefix = sessionIdPrefixFromContainerName(query.container);
    if (!containerPrefix) {
      throw new ServiceError(400, `Could not read a session id out of container name "${query.container}".`);
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
  } else {
    candidates = sessionManager.listAll();
  }

  const prNumbers = query.pr;
  const matches = candidates.filter((s) => {
    if (s.warm && !explicitTarget) return false;
    if (!query.includeArchived && s.userArchived) return false;
    // Remaining filters, for the axes the candidate lookup didn't cover.
    if (query.branch !== undefined && s.branch !== query.branch) return false;
    if (containerPrefix !== null && !s.id.startsWith(containerPrefix)) return false;
    if (query.id !== undefined && !s.id.startsWith(query.id)) return false;
    if (prNumbers !== undefined && !matchesPr(sessionManager, s, prNumbers)) return false;
    return true;
  });

  const sessions = matches
    .slice(0, limit)
    .map((s) => buildHostSessionView(s, sessionManager.getPrStatus(s.id)));
  return { sessions, total: matches.length, truncated: matches.length > sessions.length };
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
