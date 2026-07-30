/**
 * RebaseBanner — the banner used to hard-code `main` as the base branch, so on a
 * `master` repo it told the user their branch was behind a branch that doesn't
 * exist, and "Update branch" rebased onto an unresolvable ref. These cover the
 * branch name it renders and the one it hands to `startRebase`.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RebaseBanner } from "./RebaseBanner.js";
import { useGitStore } from "../stores/git-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { RepoInfo, SessionInfo } from "../../server/shared/types.js";

const REPO_URL = "https://github.com/o/legacy.git";

function repo(defaultBranch?: string): RepoInfo {
  return {
    url: REPO_URL,
    addedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

function session(): SessionInfo {
  return {
    id: "s1",
    title: "s1",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    remoteUrl: REPO_URL,
  } as SessionInfo;
}

const realStartRebase = useGitStore.getState().startRebase;

beforeEach(() => {
  useGitStore.getState().reset();
  useGitStore.setState({ startRebase: realStartRebase });
  useSessionStore.setState({ sessions: [session()] });
  useRepoStore.setState({ repos: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("RebaseBanner", () => {
  it("renders nothing when idle and the push wasn't rejected", () => {
    const { container } = render(<RebaseBanner sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the repo's real default branch in the push-rejected nudge", () => {
    useRepoStore.setState({ repos: [repo("master")] });
    useGitStore.setState({ pushRejected: true });
    render(<RebaseBanner sessionId="s1" />);

    expect(screen.getByText("master")).toBeInTheDocument();
    expect(screen.queryByText("main")).toBeNull();
  });

  it("rebases onto the real default branch when 'Update branch' is clicked", async () => {
    const user = userEvent.setup();
    const startRebase = vi.fn();
    useRepoStore.setState({ repos: [repo("master")] });
    useGitStore.setState({ pushRejected: true, startRebase });
    render(<RebaseBanner sessionId="s1" />);

    await user.click(screen.getByRole("button", { name: /Update branch/ }));
    expect(startRebase).toHaveBeenCalledWith("s1", "master");
  });

  it("names the real default branch while the rebase runs", () => {
    useRepoStore.setState({ repos: [repo("trunk")] });
    useGitStore.setState({ rebaseStatus: "in_progress" });
    render(<RebaseBanner sessionId="s1" />);

    expect(screen.getByText("trunk")).toBeInTheDocument();
  });

  it("falls back to main before the repo list hydrates", () => {
    useGitStore.setState({ pushRejected: true });
    render(<RebaseBanner sessionId="s1" />);

    expect(screen.getByText("main")).toBeInTheDocument();
  });
});
