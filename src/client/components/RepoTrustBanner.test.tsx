import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RepoTrustBanner } from "./RepoTrustBanner.js";
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

describe("RepoTrustBanner (docs/178)", () => {
  it("shows for an untrusted active repo", () => {
    useRepoStore.setState({ repos: [repo("https://github.com/owner/repo.git", false)] });
    render(<RepoTrustBanner repoUrl="https://github.com/owner/repo.git" />);
    expect(screen.getByTestId("repo-trust-banner")).toBeInTheDocument();
  });

  it("hides for a trusted repo", () => {
    useRepoStore.setState({ repos: [repo("https://github.com/owner/repo.git", true)] });
    render(<RepoTrustBanner repoUrl="https://github.com/owner/repo.git" />);
    expect(screen.queryByTestId("repo-trust-banner")).not.toBeInTheDocument();
  });

  it("hides while trust state is unknown (undefined)", () => {
    useRepoStore.setState({ repos: [repo("https://github.com/owner/repo.git", undefined)] });
    render(<RepoTrustBanner repoUrl="https://github.com/owner/repo.git" />);
    expect(screen.queryByTestId("repo-trust-banner")).not.toBeInTheDocument();
  });

  it("hides when there is no active repo", () => {
    useRepoStore.setState({ repos: [repo("https://github.com/owner/repo.git", false)] });
    render(<RepoTrustBanner repoUrl={undefined} />);
    expect(screen.queryByTestId("repo-trust-banner")).not.toBeInTheDocument();
  });

  it("matches the repo by canonical URL form (.git suffix differs)", () => {
    useRepoStore.setState({ repos: [repo("https://github.com/owner/repo.git", false)] });
    render(<RepoTrustBanner repoUrl="https://github.com/owner/repo" />);
    expect(screen.getByTestId("repo-trust-banner")).toBeInTheDocument();
  });

  it("clicking Trust POSTs to the trust endpoint and clears the banner", async () => {
    const url = "https://github.com/owner/repo.git";
    useRepoStore.setState({ repos: [repo(url, false)] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(<RepoTrustBanner repoUrl={url} />);
    await userEvent.click(screen.getByTestId("repo-trust-accept"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repos/trust",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ url }) }),
    );
    // Optimistic flip clears the banner.
    await waitFor(() => expect(screen.queryByTestId("repo-trust-banner")).not.toBeInTheDocument());
    expect(useRepoStore.getState().repos[0].trusted).toBe(true);
  });

  it("'Keep restricted' dismisses the banner without trusting", async () => {
    const url = "https://github.com/owner/repo.git";
    useRepoStore.setState({ repos: [repo(url, false)] });
    render(<RepoTrustBanner repoUrl={url} />);

    await userEvent.click(screen.getByText("Keep restricted"));
    expect(screen.queryByTestId("repo-trust-banner")).not.toBeInTheDocument();
    // Trust state is unchanged — it is a local dismissal only.
    expect(useRepoStore.getState().repos[0].trusted).toBe(false);
  });
});
