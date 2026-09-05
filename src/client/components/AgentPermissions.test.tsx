import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPermissions } from "./AgentPermissions.js";
import { useRepoStore } from "../stores/repo-store.js";
import type { RepoInfo } from "../../server/shared/types.js";

/**
 * docs/287-agent-merge-per-repo — the human-held half of the grant. This switch
 * is the ONLY way the permission is given: it is deliberately absent from
 * `shipit.yaml`, which the agent can write.
 */

const URL = "https://github.com/org/repo";

function repo(allowAgentMerge: boolean): RepoInfo {
  const now = new Date().toISOString();
  return { url: URL, addedAt: now, lastUsedAt: now, status: "ready", allowAgentMerge };
}

beforeEach(() => {
  useRepoStore.getState().setRepos([repo(false)]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentPermissions", () => {
  it("renders the merge grant off for a repository that has not been granted", () => {
    render(<AgentPermissions repoUrl={URL} />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("reflects a granted repository", () => {
    useRepoStore.getState().setRepos([repo(true)]);
    render(<AgentPermissions repoUrl={URL} />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "true");
  });

  it("asks the server to GRANT when switched on, for this repository", async () => {
    const setAllow = vi.fn(async () => true);
    useRepoStore.setState({ setRepoAllowAgentMerge: setAllow });

    render(<AgentPermissions repoUrl={URL} />);
    await userEvent.click(screen.getByTestId("allow-agent-merge-toggle"));

    // Both arguments matter: the wrong url grants a different repository, and
    // an inverted flag turns the permission on when the user turned it off.
    expect(setAllow).toHaveBeenCalledWith(URL, true);
  });

  it("asks the server to REVOKE when switched off", async () => {
    const setAllow = vi.fn(async () => true);
    useRepoStore.setState({ setRepoAllowAgentMerge: setAllow });
    useRepoStore.getState().setRepos([repo(true)]);

    render(<AgentPermissions repoUrl={URL} />);
    await userEvent.click(screen.getByTestId("allow-agent-merge-toggle"));

    expect(setAllow).toHaveBeenCalledWith(URL, false);
  });

  it("shows the grant as off for a repository the store does not hold", () => {
    // `undefined` is not `true`: an unknown repository must never read as
    // granted while the switch waits for the list to arrive.
    useRepoStore.getState().setRepos([]);
    render(<AgentPermissions repoUrl={URL} />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "false");
  });
});
