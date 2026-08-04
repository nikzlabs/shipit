import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
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
import type { RepoInfo, TrackerIssue } from "../../server/shared/types.js";

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
  // Regression for React error #185 (Maximum update depth exceeded): selecting
  // `issuesByTracker[active] ?? []` with a fresh `[]` literal made
  // useSyncExternalStore see a new snapshot every render and loop forever — the
  // exact state on tab open, before the first fetch populates the store.
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
      trackers: [{ id: "linear", label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", label: "Linear", configured: true } },
    });
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onStartSession={() => {}} onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });

  // Stable-reference regression with filters active: derived arrays
  // (filteredIssues, distinct statuses/assignees) must be memoized, not freshly
  // computed each render, or the panel loops into React #185.
  it("renders without a loop when filters are active", () => {
    useIssuesStore.setState({
      trackers: [{ id: "linear", label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", label: "Linear", configured: true } },
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

// docs/236: Linear issues are workspace-wide, so the issue you want to work on
// often belongs to a repo other than the one your current session is checked
// out on. The panel offers every registered repo as a start target.
describe("IssuesPanel repo picker (docs/236)", () => {
  afterEach(() => {
    useRepoStore.setState({ repos: [], activeRepoUrl: undefined });
  });

  function renderWithRepos(repos: RepoInfo[], activeRepoUrl?: string) {
    useRepoStore.setState({ repos, ...(activeRepoUrl ? { activeRepoUrl } : {}) });
    useIssuesStore.setState({
      trackers: [{ id: "linear", label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", label: "Linear", configured: true } },
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
    expect(onStartSession.mock.calls[0]![1]).toBe(website.url);
  });

  it("omits hidden repos, but keeps the current target even when hidden", async () => {
    const hiddenActive = makeRepo("https://github.com/acme/legacy.git", { hidden: true });
    const visible = makeRepo("https://github.com/acme/website.git");
    const hiddenOther = makeRepo("https://github.com/acme/archive.git", { hidden: true });
    renderWithRepos([hiddenActive, visible, hiddenOther], hiddenActive.url);

    await userEvent.click(
      screen.getByRole("button", { name: /start session in another repository/i }),
    );
    // The active repo survives the hidden filter so the checkmark has a home…
    expect(await screen.findByRole("menuitem", { name: /legacy/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /website/i })).toBeInTheDocument();
    // …but a repo the user hid and isn't working in stays out of the way.
    expect(screen.queryByRole("menuitem", { name: /archive/i })).toBeNull();
  });

  it("leaves the plain click on the implicit target untouched", async () => {
    const shipit = makeRepo("https://github.com/acme/shipit.git");
    const onStartSession = renderWithRepos([shipit, makeRepo("https://github.com/acme/website.git")], shipit.url);

    await userEvent.click(screen.getByRole("button", { name: /^start session$/i }));

    expect(onStartSession).toHaveBeenCalledTimes(1);
    // No explicit repo — App resolves the session's own repo, as it always has.
    expect(onStartSession.mock.calls[0]![1]).toBeUndefined();
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
    store.toggleStatus("In Review"); // exists on linear, not github
    store.toggleAssignee("Ana"); // exists on linear, not github
    store.toggleAssignee(UNASSIGNED); // synthetic — must always survive

    useIssuesStore.getState().setActiveTracker("github");

    const { filters } = useIssuesStore.getState();
    expect(filters.query).toBe("auth"); // universal — persists
    expect([...filters.priorities]).toEqual(["high"]); // universal — persists
    expect([...filters.statuses]).toEqual([]); // "In Review" not in github list — pruned
    expect(filters.assignees.has("Ana")).toBe(false); // pruned
    expect(filters.assignees.has(UNASSIGNED)).toBe(true); // synthetic — survives
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
