import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleFilesChanged } from "./files-changed.js";
import { useIssuesStore } from "../../stores/issues-store.js";
import { usePluginReposStore } from "../../stores/plugin-repos-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { HandlerContext } from "./types.js";
import type { TrackerInfo, WsFilesChanged } from "../../../server/shared/types.js";

/**
 * planning#323 — the browser's view of a repository's `issues.trackers`
 * declarations must follow a `shipit.yaml` edit, since the server re-reads the
 * file per request while the client only refetched on session change and
 * Issues-tab activation. The file watcher already delivers `files_changed` with
 * the changed paths (`FileWatcherController` → SSE `file_changes` →
 * `ContainerSessionRunner` → WS), so this handler is where the refresh hangs.
 */

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const event = (paths: string[]): WsFilesChanged => ({ type: "files_changed", paths });

function tracker(over: Partial<TrackerInfo> = {}): TrackerInfo {
  return { id: "github", label: "GitHub", configured: true, kind: "github", ...over };
}

const originalFetch = globalThis.fetch;

/** Track calls per endpoint so a no-op refresh is distinguishable from a real one. */
let calls: string[] = [];

function stubFetch(trackers: TrackerInfo[]): void {
  globalThis.fetch = vi.fn(async (input: string) => {
    const url = input;
    calls.push(url);
    if (url.startsWith("/api/plugin-repos")) {
      return {
        ok: true,
        json: async () => ({ declared: true, pending: false, consumerRepoUrl: null, repos: [], warnings: [] }),
      } as Response;
    }
    const body = url.startsWith("/api/trackers") ? { trackers } : { tracker: trackers[0], issues: [] };
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

/** Await the handler's fire-and-forget refresh chain. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  calls = [];
  useSessionStore.setState({ sessionId: "s1" });
  useUiStore.setState({ rightTab: "issues" });
  useIssuesStore.setState({ trackers: [], issuesByTracker: {}, infoByTracker: {} });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("handleFilesChanged — plugin declarations (docs/262)", () => {
  it("refetches the plugin snapshot when shipit.yaml changes", async () => {
    // The snapshot gates the Plugins tab itself, so this refetch happens
    // whether or not the tab is open.
    stubFetch([tracker()]);
    useUiStore.setState({ rightTab: "files" });

    handleFilesChanged(ctx, event(["shipit.yaml"]));
    await flush();

    expect(calls.some((u) => u.startsWith("/api/plugin-repos"))).toBe(true);
    expect(usePluginReposStore.getState().snapshot?.declared).toBe(true);
  });

  it("leaves the plugin snapshot alone for unrelated file changes", async () => {
    stubFetch([tracker()]);
    handleFilesChanged(ctx, event(["src/index.ts"]));
    await flush();
    expect(calls.some((u) => u.startsWith("/api/plugin-repos"))).toBe(false);
  });
});

describe("handleFilesChanged — tracker declarations (planning#323)", () => {
  it("refetches the tracker list when shipit.yaml changes", async () => {
    stubFetch([tracker(), tracker({ id: "github:acme/planning", name: "planning", kind: "github" })]);

    handleFilesChanged(ctx, event(["shipit.yaml"]));
    await flush();

    expect(useIssuesStore.getState().trackers.map((t) => t.name)).toEqual([undefined, "planning"]);
    expect(calls.some((u) => u.startsWith("/api/trackers"))).toBe(true);
  });

  it("also refetches the issue list when the declared set changed and the Issues tab is showing", async () => {
    stubFetch([tracker({ id: "linear:SHI", name: "roadmap", kind: "linear" })]);

    handleFilesChanged(ctx, event(["shipit.yaml"]));
    await flush();

    expect(calls.some((u) => u.startsWith("/api/issues"))).toBe(true);
  });

  it("does not refetch the issue list when the declaration is unchanged", async () => {
    // An edit elsewhere in shipit.yaml (agent.install, compose path) still
    // re-reads the cheap local tracker list, but must not spend a tracker-API
    // round-trip on the issue list.
    useIssuesStore.setState({ trackers: [tracker()] });
    stubFetch([tracker()]);

    handleFilesChanged(ctx, event(["shipit.yaml"]));
    await flush();

    expect(calls.some((u) => u.startsWith("/api/trackers"))).toBe(true);
    expect(calls.some((u) => u.startsWith("/api/issues"))).toBe(false);
  });

  it("does not refetch the issue list when the Issues tab is not showing", async () => {
    useUiStore.setState({ rightTab: "docs" });
    stubFetch([tracker({ id: "linear:SHI", name: "roadmap", kind: "linear" })]);

    handleFilesChanged(ctx, event(["shipit.yaml"]));
    await flush();

    expect(useIssuesStore.getState().trackers).toHaveLength(1);
    expect(calls.some((u) => u.startsWith("/api/issues"))).toBe(false);
  });

  it("ignores a batch that doesn't touch shipit.yaml", async () => {
    stubFetch([tracker()]);

    handleFilesChanged(ctx, event(["src/index.ts", "docs/248-declared-issue-trackers/plan.md"]));
    await flush();

    expect(calls).toEqual([]);
  });

  it("matches a `./`-prefixed path", async () => {
    stubFetch([tracker()]);

    handleFilesChanged(ctx, event(["./shipit.yaml"]));
    await flush();

    expect(calls.some((u) => u.startsWith("/api/trackers"))).toBe(true);
  });
});
