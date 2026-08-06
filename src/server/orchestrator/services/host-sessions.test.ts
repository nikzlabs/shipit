/**
 * docs/255 — Ops host-session inventory lookups.
 *
 * Two things are under test and they carry different weight:
 *
 *  1. The LOOKUPS — that an operator's real inputs (a branch name, a PR number,
 *     a container name straight out of `docker ps`) resolve to the right
 *     session. The 2026-08-06 dead end this feature exists to fix is
 *     reconstructed verbatim in "the motivating incident".
 *  2. The metadata-only BOUNDARY — that the projection never emits another
 *     session's conversation, workspace path, or provider route. That assertion
 *     is written as a key-set comparison rather than a set of per-field
 *     `toBeUndefined()` checks, so a NEW field added to `SessionInfo` and
 *     spread through by accident fails the build instead of slipping past.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ServiceError } from "./types.js";
import {
  buildHostSessionView,
  composeProjectForSession,
  containerNameForSession,
  queryHostSessions,
  sessionIdPrefixFromContainerName,
  MAX_HOST_SESSION_LIMIT,
} from "./host-sessions.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

let dbManager: DatabaseManager;
let sessions: SessionManager;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
});

afterEach(() => {
  dbManager.close();
});

/** Minimal PR snapshot — only the fields the inventory projection reads. */
function prStatus(sessionId: string, prNumber: number, over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId,
    prNumber,
    prUrl: `https://github.com/nikzlabs/shipit/pull/${prNumber}`,
    prTitle: "Some PR",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/kmwodw",
    insertions: 0,
    deletions: 0,
    checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: "mergeable",
    reviewState: "none",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...over,
  } as PrStatusSummary;
}

/** Create a tracked session with a branch, and optionally a PR snapshot. */
function seed(
  id: string,
  opts: { title?: string; branch?: string; pr?: PrStatusSummary; remoteUrl?: string } = {},
) {
  sessions.track(id, opts.title ?? `Session ${id}`);
  if (opts.branch) sessions.setBranch(id, opts.branch);
  if (opts.remoteUrl) sessions.setRemoteUrl(id, opts.remoteUrl);
  if (opts.pr) sessions.setPrStatus(id, opts.pr);
}

// ---------------------------------------------------------------------------
// Container-name → session-id prefix
// ---------------------------------------------------------------------------

describe("sessionIdPrefixFromContainerName", () => {
  it("reads the id slice out of every host-visible name shape", () => {
    // All four derive from `sessionId.slice(0, 12)` — one rule covers them.
    expect(sessionIdPrefixFromContainerName("agent-83292266-744")).toBe("83292266-744");
    expect(sessionIdPrefixFromContainerName("/agent-83292266-744")).toBe("83292266-744");
    expect(sessionIdPrefixFromContainerName("shipit-83292266-744-web-1")).toBe("83292266-744");
    expect(sessionIdPrefixFromContainerName("shipit-83292266-744_node_modules")).toBe("83292266-744");
  });

  it("passes a bare (possibly truncated) session id through", () => {
    expect(sessionIdPrefixFromContainerName("83292266-7445-4a1b-9c2d-000000000000")).toBe("83292266-744");
    expect(sessionIdPrefixFromContainerName("8329")).toBe("8329");
  });

  it("returns null when nothing is left to match on", () => {
    expect(sessionIdPrefixFromContainerName("agent-")).toBeNull();
    expect(sessionIdPrefixFromContainerName("   ")).toBeNull();
  });

  it("round-trips the names ShipIt itself generates", () => {
    const id = "83292266-7445-4a1b-9c2d-000000000000";
    expect(sessionIdPrefixFromContainerName(containerNameForSession(id))).toBe(id.slice(0, 12));
    expect(sessionIdPrefixFromContainerName(composeProjectForSession(id))).toBe(id.slice(0, 12));
  });
});

// ---------------------------------------------------------------------------
// SessionManager lookups
// ---------------------------------------------------------------------------

describe("SessionManager inventory lookups", () => {
  it("finds by exact branch", () => {
    seed("a", { branch: "shipit/kmwodw" });
    seed("b", { branch: "shipit/other" });
    expect(sessions.findByBranch("shipit/kmwodw").map((s) => s.id)).toEqual(["a"]);
    expect(sessions.findByBranch("nope")).toEqual([]);
  });

  it("finds by current PR number", () => {
    seed("a", { branch: "shipit/kmwodw", pr: prStatus("a", 1744) });
    seed("b", { branch: "shipit/other", pr: prStatus("b", 1700) });
    expect(sessions.findByPrNumber(1744).map((s) => s.id)).toEqual(["a"]);
    expect(sessions.findByPrNumber(9999)).toEqual([]);
  });

  it("finds by a PREVIOUSLY-merged PR number from the same branch", () => {
    // The 2026-08-06 case: `shipit/kmwodw` carried #1741 and then #1744. Only
    // the current snapshot is in `pr_status`; #1741 survives as the docs/202
    // breadcrumb, and both numbers must resolve to the same session.
    seed("a", { branch: "shipit/kmwodw", pr: prStatus("a", 1744) });
    sessions.markMerged("a");
    sessions.clearMerged("a", {
      number: 1741,
      url: "https://github.com/nikzlabs/shipit/pull/1741",
      title: "Earlier PR",
      baseBranch: "main",
    });
    expect(sessions.findByPrNumber(1741).map((s) => s.id)).toEqual(["a"]);
    expect(sessions.findByPrNumber(1744).map((s) => s.id)).toEqual(["a"]);
  });

  it("survives a corrupt pr_status value instead of failing the whole query", () => {
    // `json_extract` raises "malformed JSON"; the query guards with json_valid.
    seed("good", { pr: prStatus("good", 1744) });
    seed("corrupt");
    dbManager.db.prepare("UPDATE sessions SET pr_status = ? WHERE id = ?").run("{not json", "corrupt");
    expect(sessions.findByPrNumber(1744).map((s) => s.id)).toEqual(["good"]);
  });

  it("finds by id prefix and treats LIKE metacharacters literally", () => {
    seed("83292266-7445-4a1b");
    seed("83292266-9999-0000");
    expect(sessions.findByIdPrefix("83292266-744").map((s) => s.id)).toEqual(["83292266-7445-4a1b"]);
    expect(sessions.findByIdPrefix("83292266-").map((s) => s.id).sort()).toEqual([
      "83292266-7445-4a1b",
      "83292266-9999-0000",
    ]);
    // `_` must not act as a single-char wildcard: `8329226_` would otherwise
    // match `83292266-…`. A compose VOLUME name contains `_`, so this is reachable.
    expect(sessions.findByIdPrefix("8329226_")).toEqual([]);
    expect(sessions.findByIdPrefix("%")).toEqual([]);
    expect(sessions.findByIdPrefix("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// queryHostSessions
// ---------------------------------------------------------------------------

describe("queryHostSessions", () => {
  it("the motivating incident: branch → the session, PR → the same session", () => {
    // Reconstructs 2026-08-06 end to end. Ops session 84ac5cf7 spawned the fix
    // session; the fix session owns `shipit/kmwodw` and shipped #1741 then #1744.
    sessions.track("84ac5cf7-701f-4ae7-b02f-50c6d5bca1a6", "Ops — host");
    sessions.setKind("84ac5cf7-701f-4ae7-b02f-50c6d5bca1a6", "ops");
    seed("83292266-7445-4a1b-9c2d-000000000000", {
      title: "Fix integration-suite self-kill",
      branch: "shipit/kmwodw",
      pr: prStatus("83292266-7445-4a1b-9c2d-000000000000", 1744),
      remoteUrl: "https://github.com/nikzlabs/shipit",
    });
    sessions.setParentSession(
      "83292266-7445-4a1b-9c2d-000000000000",
      "84ac5cf7-701f-4ae7-b02f-50c6d5bca1a6",
    );
    sessions.markMerged("83292266-7445-4a1b-9c2d-000000000000");
    sessions.clearMerged("83292266-7445-4a1b-9c2d-000000000000", {
      number: 1741,
      url: "https://github.com/nikzlabs/shipit/pull/1741",
      title: "First attempt",
      baseBranch: "main",
    });

    const byBranch = queryHostSessions(sessions, { branch: "shipit/kmwodw" });
    expect(byBranch.sessions).toHaveLength(1);
    const found = byBranch.sessions[0];
    expect(found.id).toBe("83292266-7445-4a1b-9c2d-000000000000");
    expect(found.title).toBe("Fix integration-suite self-kill");
    expect(found.parentSessionId).toBe("84ac5cf7-701f-4ae7-b02f-50c6d5bca1a6");
    expect(found.pr).toEqual({
      number: 1744,
      url: "https://github.com/nikzlabs/shipit/pull/1744",
      state: "merged",
      baseBranch: "main",
      headBranch: "shipit/kmwodw",
    });
    expect(found.previousPr).toEqual({
      number: 1741,
      url: "https://github.com/nikzlabs/shipit/pull/1741",
    });
    // …and the answer hands the operator back a Docker handle.
    expect(found.containerName).toBe("agent-83292266-744");

    expect(queryHostSessions(sessions, { pr: 1744 }).sessions.map((s) => s.id)).toEqual([found.id]);
    expect(queryHostSessions(sessions, { pr: 1741 }).sessions.map((s) => s.id)).toEqual([found.id]);
    expect(queryHostSessions(sessions, { container: "agent-83292266-744" }).sessions.map((s) => s.id))
      .toEqual([found.id]);
    expect(queryHostSessions(sessions, { container: "shipit-83292266-744-web-1" }).sessions.map((s) => s.id))
      .toEqual([found.id]);
  });

  it("returns nothing (not an error) when nothing matches", () => {
    seed("a", { branch: "shipit/aaa" });
    const res = queryHostSessions(sessions, { branch: "shipit/zzz" });
    expect(res.sessions).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.truncated).toBe(false);
  });

  it("hides archived sessions by default and includes them on request", () => {
    seed("live", { branch: "shipit/live" });
    seed("gone", { branch: "shipit/gone" });
    sessions.archive("gone");
    expect(queryHostSessions(sessions, {}).sessions.map((s) => s.id)).toEqual(["live"]);
    expect(queryHostSessions(sessions, { branch: "shipit/gone" }).sessions).toEqual([]);
    const withArchived = queryHostSessions(sessions, { branch: "shipit/gone", includeArchived: true });
    expect(withArchived.sessions.map((s) => s.id)).toEqual(["gone"]);
    expect(withArchived.sessions[0].archived).toBe(true);
  });

  it("hides warm pool sessions from the inventory but resolves them by container name", () => {
    seed("warm-0001-aaaa-bbbb", { branch: "shipit/warm" });
    sessions.setWarm("warm-0001-aaaa-bbbb", true);
    expect(queryHostSessions(sessions, {}).sessions).toEqual([]);
    expect(queryHostSessions(sessions, { branch: "shipit/warm" }).sessions).toEqual([]);
    // An operator holding the container name is asking about that exact box.
    expect(
      queryHostSessions(sessions, { container: "agent-warm-0001-a" }).sessions.map((s) => s.id),
    ).toEqual(["warm-0001-aaaa-bbbb"]);
  });

  it("treats --id the same whether or not another filter is also supplied", () => {
    // The warm-session exemption keys on the filter being SUPPLIED, not on which
    // lookup ran first. Without that, adding `--branch` to an `--id` query would
    // silently change what `--id` means.
    seed("warm-0001-aaaa-bbbb", { branch: "shipit/warm" });
    sessions.setWarm("warm-0001-aaaa-bbbb", true);
    expect(queryHostSessions(sessions, { id: "warm-0001" }).sessions.map((s) => s.id)).toEqual([
      "warm-0001-aaaa-bbbb",
    ]);
    expect(
      queryHostSessions(sessions, { id: "warm-0001", branch: "shipit/warm" }).sessions.map((s) => s.id),
    ).toEqual(["warm-0001-aaaa-bbbb"]);
  });

  it("rejects an unparseable container name regardless of which filter is primary", () => {
    seed("a", { branch: "shipit/x" });
    expect(() => queryHostSessions(sessions, { container: "agent-" })).toThrow(ServiceError);
    // …including when `branch` supplies the candidate set and `container` is the
    // secondary predicate — a 400 must not depend on filter ordering.
    expect(() => queryHostSessions(sessions, { branch: "shipit/x", container: "agent-" })).toThrow(
      ServiceError,
    );
  });

  it("composes filters (AND) rather than widening", () => {
    seed("a", { branch: "shipit/shared", pr: prStatus("a", 10) });
    seed("b", { branch: "shipit/shared", pr: prStatus("b", 20) });
    expect(queryHostSessions(sessions, { branch: "shipit/shared" }).sessions).toHaveLength(2);
    expect(
      queryHostSessions(sessions, { branch: "shipit/shared", pr: 20 }).sessions.map((s) => s.id),
    ).toEqual(["b"]);
    expect(queryHostSessions(sessions, { branch: "shipit/shared", pr: 30 }).sessions).toEqual([]);
  });

  it("caps the result set and reports the true total", () => {
    for (let i = 0; i < 5; i++) seed(`s${i}`, { branch: "shipit/many" });
    const res = queryHostSessions(sessions, { branch: "shipit/many", limit: 2 });
    expect(res.sessions).toHaveLength(2);
    expect(res.total).toBe(5);
    expect(res.truncated).toBe(true);
  });

  it("clamps an absurd limit rather than honouring it", () => {
    seed("a");
    expect(queryHostSessions(sessions, { limit: 10_000 }).sessions.length).toBeLessThanOrEqual(
      MAX_HOST_SESSION_LIMIT,
    );
    // A garbage limit falls back to the default instead of returning nothing.
    expect(queryHostSessions(sessions, { limit: Number.NaN }).sessions).toHaveLength(1);
  });

  it("rejects a container name with no id in it", () => {
    expect(() => queryHostSessions(sessions, { container: "agent-" })).toThrow(ServiceError);
  });
});

// ---------------------------------------------------------------------------
// The metadata-only boundary (req 8)
// ---------------------------------------------------------------------------

describe("metadata-only projection", () => {
  it("emits ONLY the allowlisted inventory keys", () => {
    seed("a", { branch: "shipit/x", pr: prStatus("a", 7), remoteUrl: "https://example.com/r" });
    sessions.setAgentId("a", "claude");
    sessions.setModel("a", "opus");
    sessions.setPinned("a", new Date().toISOString());
    const view = queryHostSessions(sessions, { id: "a" }).sessions[0];

    // A key-set assertion, not per-field absence checks: a field accidentally
    // spread in from `SessionInfo` fails here rather than shipping quietly.
    expect(Object.keys(view).sort()).toEqual(
      [
        "agentId",
        "branch",
        "composeProject",
        "containerName",
        "createdAt",
        "diskTier",
        "id",
        "lastUsedAt",
        "model",
        "pinned",
        "pr",
        "remoteUrl",
        "title",
      ].sort(),
    );
  });

  it("withholds conversation, workspace and provider fields even when set", () => {
    seed("a", { branch: "shipit/x" });
    sessions.setConversationReplay("a", "the user said something private");
    sessions.setAgentSessionId("a", "agent-session-secret");
    const view = queryHostSessions(sessions, { id: "a" }).sessions[0] as unknown as Record<string, unknown>;
    expect(view.conversationReplay).toBeUndefined();
    expect(view.agentSessionId).toBeUndefined();
    expect(view.workspaceDir).toBeUndefined();
    expect(view.providerRouteId).toBeUndefined();
    expect(view.capabilities).toBeUndefined();
    // `latestAssistantMessage` is on the sibling child-session projection by
    // design; it must never appear on this one.
    expect(view.latestAssistantMessage).toBeUndefined();
    // Serializing the whole view must not carry the replay text through either.
    expect(JSON.stringify(view)).not.toContain("the user said something private");
  });

  it("never emits PR prose, only the PR's identity and state", () => {
    seed("a", { pr: prStatus("a", 7, { prTitle: "Secret-sounding PR title", prState: "open" }) });
    const view = queryHostSessions(sessions, { id: "a" }).sessions[0];
    expect(Object.keys(view.pr ?? {}).sort()).toEqual(
      ["baseBranch", "headBranch", "number", "state", "url"].sort(),
    );
    expect(JSON.stringify(view)).not.toContain("Secret-sounding PR title");
  });

  it("builds a view with no PR snapshot at all", () => {
    sessions.track("a", "Bare session");
    const view = buildHostSessionView(sessions.get("a")!, null);
    expect(view.pr).toBeUndefined();
    expect(view.previousPr).toBeUndefined();
    expect(view.diskTier).toBe("hot");
    expect(view.containerName).toBe("agent-a");
  });
});
