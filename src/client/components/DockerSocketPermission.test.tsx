import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DockerSocketPermission } from "./DockerSocketPermission.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { RepoInfo } from "../../server/shared/types.js";

const URL = "https://github.com/org/repo";
const OTHER = "https://github.com/org/other";

function repo(url: string, allowDockerSocket: boolean, allowAgentMerge = false): RepoInfo {
  const now = new Date().toISOString();
  return { url, addedAt: now, lastUsedAt: now, status: "ready", allowDockerSocket, allowAgentMerge };
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

describe("DockerSocketPermission", () => {
  it("renders the socket grant off for a repository that has not been granted", () => {
    render(<DockerSocketPermission />);
    expect(screen.getByTestId("allow-docker-socket-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("reflects a granted repository, and not the agent-merge grant", () => {
    useRepoStore.getState().setRepos([repo(URL, true)]);
    const { rerender } = render(<DockerSocketPermission />);
    expect(screen.getByTestId("allow-docker-socket-toggle")).toHaveAttribute("aria-checked", "true");

    useRepoStore.getState().setRepos([repo(URL, false, true)]);
    rerender(<DockerSocketPermission />);
    expect(screen.getByTestId("allow-docker-socket-toggle")).toHaveAttribute("aria-checked", "false");
  });

  it("asks the server to GRANT when switched on, for this repository", async () => {
    const setAllow = vi.fn(async () => true);
    useRepoStore.setState({ setRepoAllowDockerSocket: setAllow });

    render(<DockerSocketPermission />);
    await userEvent.click(screen.getByTestId("allow-docker-socket-toggle"));

    expect(setAllow).toHaveBeenCalledWith(URL, true);
  });

  it("asks the server to REVOKE when switched off", async () => {
    const setAllow = vi.fn(async () => true);
    useRepoStore.setState({ setRepoAllowDockerSocket: setAllow });
    useRepoStore.getState().setRepos([repo(URL, true)]);

    render(<DockerSocketPermission />);
    await userEvent.click(screen.getByTestId("allow-docker-socket-toggle"));

    expect(setAllow).toHaveBeenCalledWith(URL, false);
  });

  it("reads the repository the dialog is open for, not another granted one", async () => {
    const setAllow = vi.fn(async () => true);
    useRepoStore.setState({ setRepoAllowDockerSocket: setAllow });
    useRepoStore.getState().setRepos([repo(URL, false), repo(OTHER, true)]);

    render(<DockerSocketPermission />);
    expect(screen.getByTestId("allow-docker-socket-toggle")).toHaveAttribute("aria-checked", "false");

    await userEvent.click(screen.getByTestId("allow-docker-socket-toggle"));
    expect(setAllow).toHaveBeenCalledWith(URL, true);
  });
});
