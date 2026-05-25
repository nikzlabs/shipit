import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTopBar } from "./SessionTopBar.js";
import { usePrStore } from "../stores/pr-store.js";

const defaultProps = {
  sessionId: "s1",
  title: "Test session",
  onRename: vi.fn(),
  onDownloadChat: vi.fn(),
  onArchive: vi.fn(),
  onSearch: vi.fn(),
};

describe("SessionTopBar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    usePrStore.getState().reset();
  });

  it("shows auto-merge in session actions for repo-backed sessions", async () => {
    const user = userEvent.setup();
    render(<SessionTopBar {...defaultProps} canAutoMerge />);

    await user.click(screen.getByLabelText("Session actions"));

    expect(await screen.findByText("Auto-merge")).toBeInTheDocument();
  });

  it("hides auto-merge in session actions for sessions without a repo", async () => {
    const user = userEvent.setup();
    render(<SessionTopBar {...defaultProps} canAutoMerge={false} />);

    await user.click(screen.getByLabelText("Session actions"));

    expect(screen.queryByText("Auto-merge")).toBeNull();
  });
});
