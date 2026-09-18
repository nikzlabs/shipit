import type { SessionInfo } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import { ServiceError } from "./types.js";

export const DEFAULT_HOST_SESSION_LIMIT = 200;
export const MAX_HOST_SESSION_LIMIT = 500;

const CONTAINER_ID_SLICE = 12;

export interface HostSessionView {
  id: string;
  title: string;
  kind?: "ops" | "sandbox";
  branch?: string;
  remoteUrl?: string;
  parentSessionId?: string;
  rootSessionId?: string;
  spawnedByTurn?: string;
  agentId?: string;
  model?: string;
  createdAt: string;
  lastUsedAt: string;
  mergedAt?: string;
  closedAt?: string;
  archived?: boolean;
  diskTier: "hot" | "light" | "evicted";
  warm?: boolean;
  pinned?: boolean;
  containerName: string;
  composeProject: string;
  pr?: {
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    baseBranch: string;
    headBranch: string;
  };
  previousPr?: { number: number; url: string };
}

export interface HostSessionQuery {
  branch?: string;
  pr?: number;
  container?: string;
  id?: string;
  /** User archiving only; disk eviction does not hide a session. */
  includeArchived?: boolean;
  /** Explicit id/container lookups include warm sessions regardless. */
  includeWarm?: boolean;
  limit?: number;
  offset?: number;
}

export interface HostSessionQueryResult {
  sessions: HostSessionView[];
  total: number;
  truncated: boolean;
  nextOffset?: number;
}

/** Custom names can mimic these prefixes; container labels remain authoritative. */
export function sessionIdPrefixFromContainerName(name: string): string | null {
  const trimmed = name.trim().replace(/^\/+/, "");
  let rest: string;
  if (trimmed.startsWith("agent-")) rest = trimmed.slice("agent-".length);
  else if (trimmed.startsWith("shipit-")) rest = trimmed.slice("shipit-".length);
  else return null;
  rest = rest.slice(0, CONTAINER_ID_SLICE);
  return rest.length > 0 ? rest : null;
}

export function containerNameForSession(sessionId: string): string {
  return `agent-${sessionId.slice(0, CONTAINER_ID_SLICE)}`;
}

export function composeProjectForSession(sessionId: string): string {
  return `shipit-${sessionId.slice(0, CONTAINER_ID_SLICE)}`;
}

export function sanitizeRemoteUrlForInventory(raw: string): string | undefined {
  const url = raw.trim();
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    // Tokens can appear in arbitrary query parameters or fragments.
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    // Drop through the last @; malformed or scp-style userinfo may contain another @.
    const at = url.lastIndexOf("@");
    if (at === -1) return url;
    const rest = url.slice(at + 1);
    return rest.length > 0 ? rest : undefined;
  }
}

/** Allowlist metadata across sessions. Do not spread session rows, credentials, or conversation content. */
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
  const remoteUrl = session.remoteUrl ? sanitizeRemoteUrlForInventory(session.remoteUrl) : undefined;
  if (remoteUrl) view.remoteUrl = remoteUrl;
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
  if (session.previousMergedPr) {
    view.previousPr = {
      number: session.previousMergedPr.number,
      url: session.previousMergedPr.url,
    };
  }
  return view;
}

export function queryHostSessions(
  sessionManager: SessionManager,
  query: HostSessionQuery = {},
): HostSessionQueryResult {
  const limit = normalizeLimit(query.limit);
  const offset = normalizeOffset(query.offset);

  // Validate even when another filter supplies the candidate set.
  let containerPrefix: string | null = null;
  if (query.container !== undefined) {
    containerPrefix = sessionIdPrefixFromContainerName(query.container);
    if (!containerPrefix) {
      throw new ServiceError(
        400,
        `"${query.container}" is not a ShipIt-generated container name ` +
          "(expected agent-<id> or shipit-<id>-<service>-N). " +
          "If it is a session id, pass it to --id. If it is a service container with an " +
          "explicit container_name, read the owner off its label: " +
          `docker inspect ${query.container} --format '{{index .Config.Labels "shipit-parent-session"}}' ` +
          "(or \"shipit-session-id\" for a session container), then pass that to --id.",
      );
    }
  }

  const explicitTarget = containerPrefix !== null || query.id !== undefined;

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
    if (query.branch !== undefined && s.branch !== query.branch) return false;
    if (containerPrefix !== null && !s.id.startsWith(containerPrefix)) return false;
    if (query.id !== undefined && !s.id.startsWith(query.id)) return false;
    if (prNumbers !== undefined && !matchesPr(sessionManager, s, prNumbers)) return false;
    return true;
  });

  // Activity must not reorder rows between offset-based page requests.
  const ordered = [...matches].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const page = ordered.slice(offset, offset + limit);
  const sessions = page.map((s) => buildHostSessionView(s, sessionManager.getPrStatus(s.id)));
  const consumed = offset + sessions.length;
  const result: HostSessionQueryResult = {
    sessions,
    total: matches.length,
    truncated: consumed < matches.length,
  };
  if (consumed < matches.length) result.nextOffset = consumed;
  return result;
}

function matchesPr(sessionManager: SessionManager, session: SessionInfo, prNumber: number): boolean {
  if (session.previousMergedPr?.number === prNumber) return true;
  return sessionManager.getPrStatus(session.id)?.prNumber === prNumber;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_HOST_SESSION_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_HOST_SESSION_LIMIT);
}

// Reject bad offsets: silently returning page one can make a paging loop repeat forever.
function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
    throw new ServiceError(400, `Invalid offset: must be a non-negative integer, got ${offset}.`);
  }
  return offset;
}
