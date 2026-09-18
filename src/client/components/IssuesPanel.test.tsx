import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { IssuesPanel } from "./IssuesPanel.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { UNASSIGNED } from "./issues-filter.js";
import {
  getSavedIssueFilters,
  saveIssueFilters,
  ISSUE_FILTERS_KEY,
} from "../utils/local-storage.js";
import type { RepoInfo, TrackerInfo, TrackerIssue } from "../../server/shared/types.js";

function makeRepo(url: string, over: Partial<RepoInfo> = {}): RepoInfo {
  return { url, addedAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-01-01T00:00:00.000Z", status: "ready", ...over };
}

function makeIssue(over: Partial<TrackerIssue> & { id: string }): TrackerIssue {
  return {
    identifier: over.id,
    title: over.title ?? "title",
    url: "https://linear.app/x",
    priority: over.priority ?? { level: "urgent", sortOrder: 0, label: "Urgent" },
    status: "status" in over ? over.status : { name: "Todo" },
    assignee: "assignee" in over ? over.assignee : { name: "Nik" },
    ...over,
  };
}

afterEach(() => {
  cleanup();
  useIssuesStore.getState().reset();
  useIssuesStore.setState({ trackers: [], activeTracker: "linear", infoByTracker: {} });
});

describe("IssuesPanel", () => {
  it("renders with an empty store without an infinite render loop", () => {
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onStartSession={() => {}} onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });

  it("renders when the active tracker has no issues entry yet", () => {
    useIssuesStore.setState({
      trackers: [{ id: "linear", kind: "linear" as const, label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", kind: "linear" as const, label: "Linear", configured: true } },
    });
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onStartSession={() => {}} onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });

  it("renders without a loop when filters are active", () => {
    useIssuesStore.setState({
      trackers: [{ id: "linear", kind: "linear" as const, label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", kind: "linear" as const, label: "Linear", configured: true } },
      issuesByTracker: {
        linear: [makeIssue({ id: "SHI-1", title: "Auth bug", status: { name: "Todo" } })],
      },
    });
    useIssuesStore.getState().togglePriority("urgent");
    useIssuesStore.getState().setQuery("bug");
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onStartSession={() => {}} onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });
});

describe("IssuesPanel repo picker (docs/236)", () => {
  afterEach(() => {
    useRepoStore.setState({ repos: [], activeRepoUrl: undefined });
  });

  function renderWithRepos(repos: RepoInfo[], activeRepoUrl?: string) {
    useRepoStore.setState({ repos, ...(activeRepoUrl ? { activeRepoUrl } : {}) });
    useIssuesStore.setState({
      trackers: [{ id: "linear", kind: "linear" as const, label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", kind: "linear" as const, label: "Linear", configured: true } },
      issuesByTracker: { linear: [makeIssue({ id: "SHI-1", title: "Auth bug" })] },
    });
    const onStartSession = vi.fn();
    render(
      <MemoryRouter>
        <IssuesPanel onStartSession={onStartSession} onConnect={() => {}} />
      </MemoryRouter>,
    );
    return onStartSession;
  }

  it("forwards the picked repo alongside the issue", async () => {
    const shipit = makeRepo("https://github.com/acme/shipit.git");
    const website = makeRepo("https://github.com/acme/website.git");
    const onStartSession = renderWithRepos([shipit, website], shipit.url);

    await userEvent.click(
      screen.getByRole("button", { name: /start session in another repository/i }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: /website/i }));

    expect(onStartSession).toHaveBeenCalledTimes(1);
    expect(onStartSession.mock.calls[0]![0]).toMatchObject({ identifier: "SHI-1" });
    expect(onStartSession.mock.calls[0]![1]).toBe("linear");
    expect(onStartSession.mock.calls[0]![2]).toBe(website.url);
  });

  it("omits hidden repos, but keeps the current target even when hidden", async () => {
    const hiddenActive = makeRepo("https://github.com/acme/legacy.git", { hidden: true });
    const visible = makeRepo("https://github.com/acme/website.git");
    const hiddenOther = makeRepo("https://github.com/acme/archive.git", { hidden: true });
    renderWithRepos([hiddenActive, visible, hiddenOther], hiddenActive.url);

    await userEvent.click(
      screen.getByRole("button", { name: /start session in another repository/i }),
    );
    expect(await screen.findByRole("menuitem", { name: /legacy/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /website/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /archive/i })).toBeNull();
  });

  it("leaves the plain click on the implicit target untouched", async () => {
    const shipit = makeRepo("https://github.com/acme/shipit.git");
    const onStartSession = renderWithRepos([shipit, makeRepo("https://github.com/acme/website.git")], shipit.url);

    await userEvent.click(screen.getByRole("button", { name: /^start session$/i }));

    expect(onStartSession).toHaveBeenCalledTimes(1);
    expect(onStartSession.mock.calls[0]![1]).toBe("linear");
    expect(onStartSession.mock.calls[0]![2]).toBeUndefined();
  });
});

describe("IssuesPanel repo switch (planning#327)", () => {
  const roadmap: TrackerInfo = {
    id: "linear:SHI",
    kind: "linear",
    label: "roadmap",
    configured: true,
    name: "roadmap",
    binding: { key: "SHI", name: "ShipIt" },
  };

  afterEach(() => {
    useIssuesStore.setState({ repoScope: null, activeTracker: "linear" });
  });

  function renderWithOpenIssue() {
    useIssuesStore.setState({
      repoScope: "https://github.com/acme/app.git",
      trackers: [roadmap],
      activeTracker: "linear:SHI",
      infoByTracker: { "linear:SHI": roadmap },
      issuesByTracker: { "linear:SHI": [makeIssue({ id: "SHI-1", title: "Auth bug" })] },
      selected: { tracker: "linear:SHI", id: "SHI-1", identifier: "SHI-1", title: "Auth bug" },
      detail: makeIssue({ id: "SHI-1", title: "Auth bug" }),
    });
    render(
      <MemoryRouter>
        <IssuesPanel onStartSession={() => {}} onConnect={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByTitle("Back to issues")).toBeInTheDocument();
  }

  it("falls back to the list when the incoming repository is a different one", () => {
    renderWithOpenIssue();

    act(() => useIssuesStore.getState().setRepoScope("https://github.com/acme/website.git"));

    expect(screen.queryByTitle("Back to issues")).toBeNull();
    expect(screen.getByText(/loading issues/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /roadmap/i })).toBeNull();
  });

  it("keeps the open issue when the switch stays inside the same repository", () => {
    renderWithOpenIssue();

    act(() => useIssuesStore.getState().setRepoScope("https://github.com/acme/app.git"));

    expect(screen.getByTitle("Back to issues")).toBeInTheDocument();
  });

  it("falls back to the list once the new declarations drop the open tracker", async () => {
    renderWithOpenIssue();
    const gh: TrackerInfo = { id: "github", kind: "github", label: "GitHub", configured: true };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ trackers: [gh] }), { status: 200 }),
    ) as typeof fetch;

    await act(async () => {
      await useIssuesStore.getState().fetchTrackers();
    });

    expect(screen.queryByTitle("Back to issues")).toBeNull();
    expect(screen.getByRole("button", { name: /github/i })).toBeInTheDocument();
  });
});

describe("issues-store filter pruning", () => {
  afterEach(() => {
    useIssuesStore.getState().reset();
    useIssuesStore.setState({ trackers: [], activeTracker: "linear", infoByTracker: {} });
  });

  it("prunes stale statuses/assignees on tracker switch but keeps query, priorities and Unassigned", () => {
    useIssuesStore.setState({
      activeTracker: "linear",
      issuesByTracker: {
        linear: [makeIssue({ id: "SHI-1", status: { name: "In Review" }, assignee: { name: "Ana" } })],
        github: [makeIssue({ id: "gh-1", status: { name: "Open" }, assignee: undefined })],
      },
    });
    const store = useIssuesStore.getState();
    store.setQuery("auth");
    store.togglePriority("high");
    store.toggleStatus("In Review");
    store.toggleAssignee("Ana");
    store.toggleAssignee(UNASSIGNED);

    useIssuesStore.getState().setActiveTracker("github");

    const { filters } = useIssuesStore.getState();
    expect(filters.query).toBe("auth");
    expect([...filters.priorities]).toEqual(["high"]);
    expect([...filters.statuses]).toEqual([]);
    expect(filters.assignees.has("Ana")).toBe(false);
    expect(filters.assignees.has(UNASSIGNED)).toBe(true);
  });
});

describe("issues filter persistence (docs/173)", () => {
  afterEach(() => {
    localStorage.removeItem(ISSUE_FILTERS_KEY);
    useIssuesStore.getState().reset();
    useIssuesStore.setState({ trackers: [], activeTracker: "linear", infoByTracker: {} });
  });

  it("round-trips filters through localStorage, restoring Sets", () => {
    saveIssueFilters({
      query: "auth",
      priorities: new Set(["high", "urgent"]),
      statuses: new Set(["In Review"]),
      assignees: new Set(["Ana", UNASSIGNED]),
      labels: new Set(["bug", "design"]),
    });
    const restored = getSavedIssueFilters();
    expect(restored.query).toBe("auth");
    expect([...restored.priorities].sort()).toEqual(["high", "urgent"]);
    expect([...restored.statuses]).toEqual(["In Review"]);
    expect(restored.assignees.has("Ana")).toBe(true);
    expect(restored.assignees.has(UNASSIGNED)).toBe(true);
    expect([...restored.labels].sort()).toEqual(["bug", "design"]);
  });

  it("drops invalid priority levels on read", () => {
    localStorage.setItem(
      ISSUE_FILTERS_KEY,
      JSON.stringify({ query: "", priorities: ["high", "bogus"], statuses: [], assignees: [] }),
    );
    expect([...getSavedIssueFilters().priorities]).toEqual(["high"]);
  });

  it("returns empty filters when nothing is stored or the payload is corrupt", () => {
    localStorage.removeItem(ISSUE_FILTERS_KEY);
    const empty = getSavedIssueFilters();
    expect(empty.query).toBe("");
    expect(empty.priorities.size).toBe(0);

    localStorage.setItem(ISSUE_FILTERS_KEY, "not json");
    const fallback = getSavedIssueFilters();
    expect(fallback.statuses.size).toBe(0);
    expect(fallback.assignees.size).toBe(0);
  });

  it("persists store filter changes to localStorage automatically", () => {
    useIssuesStore.getState().setQuery("bug");
    useIssuesStore.getState().togglePriority("urgent");
    const saved = getSavedIssueFilters();
    expect(saved.query).toBe("bug");
    expect([...saved.priorities]).toEqual(["urgent"]);
  });
});
