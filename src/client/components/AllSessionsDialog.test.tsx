import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AllSessionsDialog } from "./AllSessionsDialog.js";
import type { SessionInfo } from "../../server/shared/types.js";

/**
 * `SessionItem` (rendered inside the dialog) calls `useMediaQuery("(pointer: coarse)")`
 * via its parent, but here the items are rendered directly without the sidebar
 * wrapper — they read the `isTouch` prop as undefined, which is fine.
 * Stub matchMedia anyway so any future media-query call from a nested component
 * doesn't blow up jsdom.
 */
function mockMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

beforeEach(() => {
  mockMatchMedia();
});

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
  // docs/156: session row actions moved from inline buttons into the row's
  // `[⋯] Session actions` overflow menu. The tests below exercise the menu.

  it("offers Restore in the row overflow for archived sessions", async () => {
    const user = userEvent.setup();
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Archived one", archived: true }),
    ];
    render(<AllSessionsDialog {...props} />);
    await user.click(screen.getByLabelText("Session actions"));
    expect(await screen.findByText("Restore")).toBeInTheDocument();
    // Archived rows hide Rename + Archive — only Restore is offered.
    expect(screen.queryByText("Rename")).toBeNull();
    expect(screen.queryByText("Archive")).toBeNull();
  });

  it("offers Rename + Archive in the row overflow for non-archived sessions", async () => {
    const user = userEvent.setup();
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Active one" }),
    ];
    render(<AllSessionsDialog {...props} />);
    await user.click(screen.getByLabelText("Session actions"));
    expect(await screen.findByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
    expect(screen.queryByText("Restore")).toBeNull();
  });

  it("calls onUnarchive when Restore is selected from the menu", async () => {
    const user = userEvent.setup();
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Archived one", archived: true }),
    ];
    render(<AllSessionsDialog {...props} />);
    await user.click(screen.getByLabelText("Session actions"));
    await user.click(await screen.findByText("Restore"));
    await waitFor(() => {
      expect(props.onUnarchive).toHaveBeenCalledWith("s1");
    });
  });

  it("calls onArchive when Archive is selected from the menu", async () => {
    const user = userEvent.setup();
    const props = defaultProps();
    props.sessions = [
      baseSession({ id: "s1", title: "Active one" }),
    ];
    render(<AllSessionsDialog {...props} />);
    await user.click(screen.getByLabelText("Session actions"));
    await user.click(await screen.findByText("Archive"));
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
