import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepoTrustNotice } from "./RepoTrustNotice.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { RepoInfo } from "../../server/shared/types.js";

const now = new Date().toISOString();
function repo(url: string, trusted: boolean | undefined): RepoInfo {
  return { url, status: "ready", addedAt: now, lastUsedAt: now, trusted };
}

beforeEach(() => {
  useRepoStore.setState({ repos: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RepoTrustNotice (docs/178 consent reachable without the Preview tab)", () => {
  it("offers the grant for an untrusted repo", () => {
    const url = "https://github.com/owner/repo.git";
    useRepoStore.setState({ repos: [repo(url, false)] });
    render(<RepoTrustNotice repoUrl={url} />);
    expect(screen.getByTestId("repo-trust-notice-accept")).toBeInTheDocument();
  });

  it("grants trust without any Preview tab in the tree", async () => {
    // The regression this component exists for: local mode (dogfood) renders no
    // Preview tab, so RepoTrustBanner — which lives inside the preview frame —
    // never mounts. Nothing here depends on it.
    const url = "https://github.com/owner/repo.git";
    useRepoStore.setState({ repos: [repo(url, false)] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ repo: repo(url, true) }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<RepoTrustNotice repoUrl={url} />);
    await userEvent.click(screen.getByTestId("repo-trust-notice-accept"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repos/trust",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ url }) }),
    );
    await waitFor(() => expect(useRepoStore.getState().repos[0].trusted).toBe(true));
    // The grant flips the store, so the button retires on the next render.
    await waitFor(() =>
      expect(screen.queryByTestId("repo-trust-notice-accept")).not.toBeInTheDocument(),
    );
  });

  it("matches the repo by canonical URL form (.git suffix differs)", () => {
    useRepoStore.setState({ repos: [repo("https://github.com/owner/repo.git", false)] });
    render(<RepoTrustNotice repoUrl="https://github.com/owner/repo" />);
    expect(screen.getByTestId("repo-trust-notice-accept")).toBeInTheDocument();
  });

  it("still explains the block when the remote isn't a tracked repo", () => {
    // The caller (App's `agentMessagingBlocked`) has already decided the
    // composer is blocked. With no resolvable repo there's nothing the trust
    // endpoint would accept, but silently rendering nothing would leave a
    // disabled composer with no explanation at all.
    render(<RepoTrustNotice repoUrl="https://github.com/owner/unknown.git" />);
    expect(screen.getByTestId("repo-trust-notice")).toHaveTextContent(/isn.t trusted yet/);
    expect(screen.queryByTestId("repo-trust-notice-accept")).not.toBeInTheDocument();
  });

  it("does not point the user at the Preview tab", () => {
    // The old copy read "Trust this repository in Preview before sending
    // messages to the agent" — an instruction that is impossible to follow in
    // any mode without a Preview tab.
    const url = "https://github.com/owner/repo.git";
    useRepoStore.setState({ repos: [repo(url, false)] });
    render(<RepoTrustNotice repoUrl={url} />);
    expect(screen.getByTestId("repo-trust-notice")).not.toHaveTextContent(/Preview/i);
  });
});
