import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPermissions } from "./AgentPermissions.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { RepoInfo } from "../../server/shared/types.js";

const URL = "https://github.com/org/repo";
const OTHER = "https://github.com/org/other";

function repo(url: string, allowAgentMerge: boolean): RepoInfo {
  const now = new Date().toISOString();
  return { url, addedAt: now, lastUsedAt: now, status: "ready", allowAgentMerge };
}

beforeEach(() => {
  useRepoStore.getState().setRepos([repo(URL, false)]);
  useUiStore.getState().setProjectSettingsRepoUrl(URL);
});

afterEach(() => {
  cleanup();
  useUiStore.getState().setProjectSettingsRepoUrl(null);
  vi.restoreAllMocks();
});

describe("AgentPermissions", () => {
  it("renders the merge grant off for a repository that has not been granted", () => {
    render(<AgentPermissions />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("reflects a granted repository", () => {
    useRepoStore.getState().setRepos([repo(URL, true)]);
    render(<AgentPermissions />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "true");
  });

  it("asks the server to GRANT when switched on, for this repository", async () => {
    const setAllow = vi.fn(async () => true);
    useRepoStore.setState({ setRepoAllowAgentMerge: setAllow });

    render(<AgentPermissions />);
    await userEvent.click(screen.getByTestId("allow-agent-merge-toggle"));

    expect(setAllow).toHaveBeenCalledWith(URL, true);
  });

  it("asks the server to REVOKE when switched off", async () => {
    const setAllow = vi.fn(async () => true);
    useRepoStore.setState({ setRepoAllowAgentMerge: setAllow });
    useRepoStore.getState().setRepos([repo(URL, true)]);

    render(<AgentPermissions />);
    await userEvent.click(screen.getByTestId("allow-agent-merge-toggle"));

    expect(setAllow).toHaveBeenCalledWith(URL, false);
  });

  it("shows the grant as off for a repository the store does not hold", () => {
    useRepoStore.getState().setRepos([]);
    render(<AgentPermissions />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "false");
  });

  /*
    The value is one repository's and the settings value record is keyed by
    setting alone, which is why this row is read from the repositories store
    (docs/308-data-driven-settings slice 7). The dialog's repository is the one
    it was OPENED for, not the active one, and it is what the row reports.
  */
  it("reads the repository the dialog is open for, not another granted one", async () => {
    const setAllow = vi.fn(async () => true);
    useRepoStore.setState({ setRepoAllowAgentMerge: setAllow });
    useRepoStore.getState().setRepos([repo(URL, false), repo(OTHER, true)]);
    useUiStore.getState().setProjectSettingsRepoUrl(URL);

    render(<AgentPermissions />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "false");

    await userEvent.click(screen.getByTestId("allow-agent-merge-toggle"));
    expect(setAllow).toHaveBeenCalledWith(URL, true);
  });

  it("follows the dialog when it is opened for another repository", () => {
    useRepoStore.getState().setRepos([repo(URL, false), repo(OTHER, true)]);
    const { rerender } = render(<AgentPermissions />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "false");

    useUiStore.getState().setProjectSettingsRepoUrl(OTHER);
    rerender(<AgentPermissions />);
    expect(screen.getByTestId("allow-agent-merge-toggle")).toHaveAttribute("aria-checked", "true");
  });
});
