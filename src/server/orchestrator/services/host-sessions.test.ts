import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ServiceError } from "./types.js";
import {
  buildHostSessionView,
  composeProjectForSession,
  containerNameForSession,
  queryHostSessions,
  sanitizeRemoteUrlForInventory,
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

function seed(
  id: string,
  opts: { title?: string; branch?: string; pr?: PrStatusSummary; remoteUrl?: string } = {},
) {
  sessions.track(id, opts.title ?? `Session ${id}`);
  if (opts.branch) sessions.setBranch(id, opts.branch);
  if (opts.remoteUrl) sessions.setRemoteUrl(id, opts.remoteUrl);
  if (opts.pr) sessions.setPrStatus(id, opts.pr);
}

describe("sessionIdPrefixFromContainerName", () => {
  it("reads the id slice out of every host-visible name shape", () => {
    expect(sessionIdPrefixFromContainerName("agent-83292266-744")).toBe("83292266-744");
    expect(sessionIdPrefixFromContainerName("/agent-83292266-744")).toBe("83292266-744");
    expect(sessionIdPrefixFromContainerName("shipit-83292266-744-web-1")).toBe("83292266-744");
    expect(sessionIdPrefixFromContainerName("shipit-83292266-744_node_modules")).toBe("83292266-744");
  });

  it("returns null when nothing is left to match on", () => {
    expect(sessionIdPrefixFromContainerName("agent-")).toBeNull();
    expect(sessionIdPrefixFromContainerName("   ")).toBeNull();
  });

  it("refuses any name ShipIt did not generate, instead of guessing", () => {
    expect(sessionIdPrefixFromContainerName("payments-db")).toBeNull();
    expect(sessionIdPrefixFromContainerName("postgres")).toBeNull();
    expect(sessionIdPrefixFromContainerName("my_app_web_1")).toBeNull();
    expect(sessionIdPrefixFromContainerName("docker-socket-proxy")).toBeNull();
  });

  it("refuses a bare hex name, which would otherwise mis-attribute a container", () => {
    expect(sessionIdPrefixFromContainerName("deadbeef")).toBeNull();
    expect(sessionIdPrefixFromContainerName("83292266-7445-4a1b-9c2d-000000000000")).toBeNull();
  });

  it("round-trips the names ShipIt itself generates", () => {
    const id = "83292266-7445-4a1b-9c2d-000000000000";
    expect(sessionIdPrefixFromContainerName(containerNameForSession(id))).toBe(id.slice(0, 12));
    expect(sessionIdPrefixFromContainerName(composeProjectForSession(id))).toBe(id.slice(0, 12));
  });
});

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
    expect(sessions.findByIdPrefix("8329226_")).toEqual([]);
    expect(sessions.findByIdPrefix("%")).toEqual([]);
    expect(sessions.findByIdPrefix("")).toEqual([]);
  });
});

describe("queryHostSessions", () => {
  it("the motivating incident: branch → the session, PR → the same session", () => {
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

  it("hides warm pool sessions by default but keeps every route to them open", () => {
    seed("aaaa-0001-aaaa-bbbb", { branch: "shipit/live" });
    seed("warm-0001-aaaa-bbbb", { branch: "shipit/warm" });
    sessions.setWarm("warm-0001-aaaa-bbbb", true);
    expect(queryHostSessions(sessions, {}).sessions.map((s) => s.id)).toEqual(["aaaa-0001-aaaa-bbbb"]);
    expect(queryHostSessions(sessions, { branch: "shipit/warm" }).sessions).toEqual([]);
    expect(
      queryHostSessions(sessions, { container: "agent-warm-0001-a" }).sessions.map((s) => s.id),
    ).toEqual(["warm-0001-aaaa-bbbb"]);
    expect(queryHostSessions(sessions, { includeWarm: true }).sessions.map((s) => s.id).sort()).toEqual([
      "aaaa-0001-aaaa-bbbb",
      "warm-0001-aaaa-bbbb",
    ]);
    expect(
      queryHostSessions(sessions, { branch: "shipit/warm", includeWarm: true }).sessions.map((s) => s.id),
    ).toEqual(["warm-0001-aaaa-bbbb"]);
  });

  it("keeps an automatically evicted session in the default answer", () => {
    seed("evicted-1", { branch: "shipit/old" });
    sessions.setDiskTier("evicted-1", "evicted");
    const listed = queryHostSessions(sessions, {}).sessions;
    expect(listed.map((s) => s.id)).toEqual(["evicted-1"]);
    expect(listed[0].diskTier).toBe("evicted");
    expect(listed[0].archived).toBeUndefined();
  });

  it("pages past the result cap so a big host is still fully enumerable", () => {
    for (let i = 0; i < 5; i++) seed(`s${i}`, { branch: "shipit/many" });
    const first = queryHostSessions(sessions, { branch: "shipit/many", limit: 2 });
    expect(first.sessions).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.nextOffset).toBe(2);

    const second = queryHostSessions(sessions, { branch: "shipit/many", limit: 2, offset: 2 });
    expect(second.sessions).toHaveLength(2);
    expect(second.nextOffset).toBe(4);

    const last = queryHostSessions(sessions, { branch: "shipit/many", limit: 2, offset: 4 });
    expect(last.sessions).toHaveLength(1);
    expect(last.truncated).toBe(false);
    expect(last.nextOffset).toBeUndefined();

    const walked = [...first.sessions, ...second.sessions, ...last.sessions].map((s) => s.id);
    expect(new Set(walked).size).toBe(5);
  });

  it("pages consistently even when a session takes a turn mid-enumeration", () => {
    for (let i = 0; i < 6; i++) seed(`s${i}`, { branch: "shipit/many" });

    const page1 = queryHostSessions(sessions, { branch: "shipit/many", limit: 2 });
    sessions.track("s0");

    const page2 = queryHostSessions(sessions, {
      branch: "shipit/many", limit: 2, offset: page1.nextOffset,
    });
    const page3 = queryHostSessions(sessions, {
      branch: "shipit/many", limit: 2, offset: page2.nextOffset,
    });

    const walked = [...page1.sessions, ...page2.sessions, ...page3.sessions].map((s) => s.id);
    expect(walked).toHaveLength(6);
    expect(new Set(walked).size).toBe(6);
    expect([...walked].sort()).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("rejects a bad offset rather than silently returning page 1", () => {
    seed("a");
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => queryHostSessions(sessions, { offset: bad })).toThrow(ServiceError);
    }
    const past = queryHostSessions(sessions, { offset: 999 });
    expect(past.sessions).toEqual([]);
    expect(past.nextOffset).toBeUndefined();
  });

  it("treats --id the same whether or not another filter is also supplied", () => {
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
    expect(queryHostSessions(sessions, { limit: Number.NaN }).sessions).toHaveLength(1);
  });

  it("rejects a container name with no id in it, and names the label fallback", () => {
    expect(() => queryHostSessions(sessions, { container: "agent-" })).toThrow(ServiceError);
    expect(() => queryHostSessions(sessions, { container: "payments-db" })).toThrow(
      /shipit-parent-session/,
    );
  });
});

describe("metadata-only projection", () => {
  it("emits ONLY the allowlisted inventory keys", () => {
    seed("a", { branch: "shipit/x", pr: prStatus("a", 7), remoteUrl: "https://example.com/r" });
    sessions.setAgentId("a", "claude");
    sessions.setModel("a", "opus");
    sessions.setPinned("a", new Date().toISOString());
    const view = queryHostSessions(sessions, { id: "a" }).sessions[0];

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
    expect(view.latestAssistantMessage).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("the user said something private");
  });

  it("fails closed on every remote-URL shape that can carry a credential", () => {
    for (const [raw, expected] of [
      ["https://u:pw@github.com/o/r.git", "https://github.com/o/r.git"],
      ["ssh://git:pw@example.com/o/r.git", "ssh://example.com/o/r.git"],
      ["https://example.com/o/r.git?access_token=pw", "https://example.com/o/r.git"],
      ["https://example.com/o/r.git#tok=pw", "https://example.com/o/r.git"],
      ["tok@example.com:o/r.git", "example.com:o/r.git"],
      ["git@github.com:o/r.git", "github.com:o/r.git"],
    ] as const) {
      expect(sanitizeRemoteUrlForInventory(raw)).toBe(expected);
    }
    expect(sanitizeRemoteUrlForInventory("https://u:pw@")).toBeUndefined();
    expect(sanitizeRemoteUrlForInventory("   ")).toBeUndefined();
    expect(sanitizeRemoteUrlForInventory("https://github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
  });

  it("withholds a non-http credentialed URL end to end, not just via the helper", () => {
    seed("a", { branch: "shipit/x" });
    sessions.setRemoteUrl("a", "ssh://git:pw@example.com/o/r.git");
    const view = queryHostSessions(sessions, { id: "a" }).sessions[0];
    expect(JSON.stringify(view)).not.toContain("pw@");
    expect(view.remoteUrl).toBe("ssh://example.com/o/r.git");
  });

  it("strips credentials out of a repo URL before showing it to another session", () => {
    // Generic userinfo exercises stripping without triggering the secret scanner.
    seed("a", { branch: "shipit/x" });
    sessions.setRemoteUrl("a", "https://u:pw@github.com/o/r.git");
    const view = queryHostSessions(sessions, { id: "a" }).sessions[0];
    expect(view.remoteUrl).toBe("https://github.com/o/r.git");
    expect(JSON.stringify(view)).not.toContain("u:pw@");
  });

  it("leaves an ordinary repo URL untouched", () => {
    seed("a", { remoteUrl: "https://github.com/nikzlabs/shipit" });
    expect(queryHostSessions(sessions, { id: "a" }).sessions[0].remoteUrl).toBe(
      "https://github.com/nikzlabs/shipit",
    );
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
