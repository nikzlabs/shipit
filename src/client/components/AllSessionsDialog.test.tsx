import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { AllSessionsDialog } from "./AllSessionsDialog.js";
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

const defaultProps = () => ({
  open: true,
  onClose: vi.fn(),
  sessions: [] as SessionInfo[],
  repos: [],
  currentRepoUrl: undefined,
  onFetch: vi.fn(),
  onResume: vi.fn(),
  onUnarchive: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
  onArchive: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
});

describe("AllSessionsDialog", () => {
  it("shows restore button for archived sessions", () => {
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Archived one", archived: true }),
    ];
    render(<AllSessionsDialog {...props} />);
    expect(screen.getByTitle("Restore session")).toBeTruthy();
  });

  it("shows archive button for non-archived sessions", () => {
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Active one" }),
    ];
    render(<AllSessionsDialog {...props} />);
    expect(screen.getByTitle("Archive session")).toBeTruthy();
  });

  it("calls onUnarchive when restore button is clicked", async () => {
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Archived one", archived: true }),
    ];
    render(<AllSessionsDialog {...props} />);
    fireEvent.click(screen.getByTitle("Restore session"));
    await waitFor(() => {
      expect(props.onUnarchive).toHaveBeenCalledWith("s1");
    });
  });

  it("calls onArchive when archive button is clicked", async () => {
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Active one" }),
    ];
    render(<AllSessionsDialog {...props} />);
    fireEvent.click(screen.getByTitle("Archive session"));
    await waitFor(() => {
      expect(props.onArchive).toHaveBeenCalledWith("s1");
    });
  });

  it("auto-unarchives when resuming an archived session", async () => {
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Archived one", archived: true }),
    ];
    render(<AllSessionsDialog {...props} />);
    // Click the session row to resume
    fireEvent.click(screen.getByText("Archived one"));
    await waitFor(() => {
      expect(props.onUnarchive).toHaveBeenCalledWith("s1");
      expect(props.onResume).toHaveBeenCalledWith("s1");
    });
  });

  it("does not render when closed", () => {
    const props = defaultProps();
    props.open = false;
    const { container } = render(<AllSessionsDialog {...props} />);
    expect(container.innerHTML).toBe("");
  });

  it("filters sessions by search query", () => {
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Build feature" }),
      baseSession({ id: "s2", title: "Fix bug" }),
    ];
    render(<AllSessionsDialog {...props} />);
    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "bug" },
    });
    expect(screen.queryByText("Build feature")).toBeNull();
    expect(screen.getByText("Fix bug")).toBeTruthy();
  });
});
