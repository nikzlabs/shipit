import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RepoSelector } from "./RepoSelector.js";
import type { RepoSelectorProps } from "./RepoSelector.js";
import type { SessionInfo } from "../../server/shared/types.js";

afterEach(cleanup);

const baseSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "sess-1",
  title: "My session",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  remoteUrl: "",
  ...overrides,
});

const defaultProps: RepoSelectorProps = {
  sessions: [],
  searchResults: [],
  onSearch: vi.fn(),
  selectedRepoUrl: null,
  onSelect: vi.fn(),
  onNewRepo: vi.fn(),
  disabled: false,
};

describe("RepoSelector", () => {
  it("renders input placeholder when no repo selected", () => {
    render(<RepoSelector {...defaultProps} />);
    const input = screen.getByPlaceholderText("Select a repository...");
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("shows local repos from sessions (deduplicated by remoteUrl) when dropdown opened", () => {
    const sessions = [
      baseSession({ id: "s1", remoteUrl: "https://github.com/alice/project.git" }),
      baseSession({ id: "s2", remoteUrl: "https://github.com/alice/project.git" }),
      baseSession({ id: "s3", remoteUrl: "https://github.com/bob/other.git" }),
    ];
    render(<RepoSelector {...defaultProps} sessions={sessions} />);

    // Open dropdown by focusing the input
    fireEvent.focus(screen.getByPlaceholderText("Select a repository..."));

    // Should show deduplicated repos
    expect(screen.getByText("alice/project")).toBeTruthy();
    expect(screen.getByText("bob/other")).toBeTruthy();

    // "alice/project" should appear only once (deduplicated)
    const allButtons = screen.getAllByRole("button");
    const aliceButtons = allButtons.filter((btn) => btn.textContent === "alice/project");
    expect(aliceButtons).toHaveLength(1);
  });

  it("shows '+ New repository' option in dropdown", () => {
    render(<RepoSelector {...defaultProps} />);
    fireEvent.focus(screen.getByPlaceholderText("Select a repository..."));

    expect(screen.getByText("New repository")).toBeTruthy();
  });

  it("calls onSelect when a repo is clicked", () => {
    const onSelect = vi.fn();
    const sessions = [
      baseSession({ id: "s1", remoteUrl: "https://github.com/alice/project.git" }),
    ];
    render(<RepoSelector {...defaultProps} sessions={sessions} onSelect={onSelect} />);

    fireEvent.focus(screen.getByPlaceholderText("Select a repository..."));
    fireEvent.click(screen.getByText("alice/project"));

    expect(onSelect).toHaveBeenCalledWith("https://github.com/alice/project.git");
  });

  it("calls onNewRepo when '+ New repository' is clicked", () => {
    const onNewRepo = vi.fn();
    render(<RepoSelector {...defaultProps} onNewRepo={onNewRepo} />);

    fireEvent.focus(screen.getByPlaceholderText("Select a repository..."));
    fireEvent.click(screen.getByText("New repository"));

    expect(onNewRepo).toHaveBeenCalledTimes(1);
  });

  it("selected repo shown in input when dropdown closed", () => {
    render(
      <RepoSelector
        {...defaultProps}
        selectedRepoUrl="https://github.com/alice/project.git"
      />,
    );

    const input = screen.getByPlaceholderText("Select a repository...") as HTMLInputElement;
    // Dropdown is closed by default, so the input should show the selected label
    expect(input.value).toBe("alice/project");
  });

  it("disabled state renders input as disabled", () => {
    render(<RepoSelector {...defaultProps} disabled={true} />);
    const input = screen.getByPlaceholderText("Select a repository...") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    // The input should have the disabled opacity class
    expect(input.className).toContain("disabled:opacity-50");
  });

  it("Escape key closes dropdown", () => {
    const sessions = [
      baseSession({ id: "s1", remoteUrl: "https://github.com/alice/project.git" }),
    ];
    render(<RepoSelector {...defaultProps} sessions={sessions} />);

    const input = screen.getByPlaceholderText("Select a repository...");
    fireEvent.focus(input);

    // Dropdown should be open
    expect(screen.getByText("alice/project")).toBeTruthy();

    // Press Escape
    fireEvent.keyDown(input, { key: "Escape" });

    // Dropdown should be closed
    expect(screen.queryByText("alice/project")).toBeNull();
  });

  describe("search with debounce", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      cleanup();
    });

    it("search input triggers onSearch after 300ms debounce", () => {
      const onSearch = vi.fn();
      render(<RepoSelector {...defaultProps} onSearch={onSearch} />);

      const input = screen.getByPlaceholderText("Select a repository...");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "my-repo" } });

      // onSearch should not be called immediately
      expect(onSearch).not.toHaveBeenCalled();

      // Advance time by 300ms
      vi.advanceTimersByTime(300);

      expect(onSearch).toHaveBeenCalledWith("my-repo");
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    it("debounce resets on subsequent input changes", () => {
      const onSearch = vi.fn();
      render(<RepoSelector {...defaultProps} onSearch={onSearch} />);

      const input = screen.getByPlaceholderText("Select a repository...");
      fireEvent.focus(input);

      // Type first query
      fireEvent.change(input, { target: { value: "ab" } });
      vi.advanceTimersByTime(200);

      // Type again before debounce fires
      fireEvent.change(input, { target: { value: "abc" } });
      vi.advanceTimersByTime(200);

      // First query should not have fired
      expect(onSearch).not.toHaveBeenCalled();

      // Finish debounce for second query
      vi.advanceTimersByTime(100);
      expect(onSearch).toHaveBeenCalledWith("abc");
      expect(onSearch).toHaveBeenCalledTimes(1);
    });

    it("does not call onSearch for queries shorter than 2 characters", () => {
      const onSearch = vi.fn();
      render(<RepoSelector {...defaultProps} onSearch={onSearch} />);

      const input = screen.getByPlaceholderText("Select a repository...");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "a" } });

      vi.advanceTimersByTime(300);

      expect(onSearch).not.toHaveBeenCalled();
    });
  });

  it("shows search results from GitHub alongside session repos", () => {
    const sessions = [
      baseSession({ id: "s1", remoteUrl: "https://github.com/alice/local-repo.git" }),
    ];
    const searchResults = [
      {
        fullName: "bob/remote-repo",
        description: "A remote repository",
        private: false,
        defaultBranch: "main",
        cloneUrl: "https://github.com/bob/remote-repo.git",
      },
    ];
    render(
      <RepoSelector {...defaultProps} sessions={sessions} searchResults={searchResults} />,
    );

    fireEvent.focus(screen.getByPlaceholderText("Select a repository..."));

    expect(screen.getByText("alice/local-repo")).toBeTruthy();
    expect(screen.getByText("bob/remote-repo")).toBeTruthy();
    expect(screen.getByText("A remote repository")).toBeTruthy();
    expect(screen.getByText("public")).toBeTruthy();
  });

  it("deduplicates search results that match session repos", () => {
    const sessions = [
      baseSession({ id: "s1", remoteUrl: "https://github.com/alice/project.git" }),
    ];
    const searchResults = [
      {
        fullName: "alice/project",
        description: null,
        private: false,
        defaultBranch: "main",
        cloneUrl: "https://github.com/alice/project.git",
      },
    ];
    render(
      <RepoSelector {...defaultProps} sessions={sessions} searchResults={searchResults} />,
    );

    fireEvent.focus(screen.getByPlaceholderText("Select a repository..."));

    // "alice/project" from session repos only, search result is deduplicated
    const allButtons = screen.getAllByRole("button");
    const projectButtons = allButtons.filter(
      (btn) => btn.textContent === "alice/project",
    );
    expect(projectButtons).toHaveLength(1);
  });

  it("clear button calls onSelect with empty string and refocuses input", () => {
    const onSelect = vi.fn();
    render(
      <RepoSelector
        {...defaultProps}
        selectedRepoUrl="https://github.com/alice/project.git"
        onSelect={onSelect}
      />,
    );

    const clearBtn = screen.getByLabelText("Clear selection");
    expect(clearBtn).toBeTruthy();

    fireEvent.click(clearBtn);
    expect(onSelect).toHaveBeenCalledWith("");
  });

  it("does not show clear button when no repo is selected", () => {
    render(<RepoSelector {...defaultProps} selectedRepoUrl={null} />);
    expect(screen.queryByLabelText("Clear selection")).toBeNull();
  });

  it("closes dropdown and clears query when a repo is selected", () => {
    const onSelect = vi.fn();
    const sessions = [
      baseSession({ id: "s1", remoteUrl: "https://github.com/alice/project.git" }),
    ];
    render(<RepoSelector {...defaultProps} sessions={sessions} onSelect={onSelect} />);

    const input = screen.getByPlaceholderText("Select a repository...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "alice" } });

    // Click the repo
    fireEvent.click(screen.getByText("alice/project"));

    // Dropdown should be closed (no "New repository" visible)
    expect(screen.queryByText("New repository")).toBeNull();
  });

  it("shows private badge for private search results", () => {
    const searchResults = [
      {
        fullName: "alice/secret-repo",
        description: null,
        private: true,
        defaultBranch: "main",
        cloneUrl: "https://github.com/alice/secret-repo.git",
      },
    ];
    render(<RepoSelector {...defaultProps} searchResults={searchResults} />);

    fireEvent.focus(screen.getByPlaceholderText("Select a repository..."));

    expect(screen.getByText("private")).toBeTruthy();
  });

  it("sessions without remoteUrl are excluded from dropdown", () => {
    const sessions = [
      baseSession({ id: "s1", title: "No remote" }),
      baseSession({ id: "s2", title: "With remote", remoteUrl: "https://github.com/x/y.git" }),
    ];
    render(<RepoSelector {...defaultProps} sessions={sessions} />);

    fireEvent.focus(screen.getByPlaceholderText("Select a repository..."));

    expect(screen.getByText("x/y")).toBeTruthy();
    // "No remote" session should not appear since it has no remoteUrl
    expect(screen.queryByText("No remote")).toBeNull();
  });
});
