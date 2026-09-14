import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { TopPanelBanner } from "./TopPanelBanner.js";
import { useUiStore } from "../stores/ui-store.js";
import type { UpdateNotice } from "../../server/shared/types.js";

const AVAILABLE: UpdateNotice = {
  available: true,
  latestVersion: "v1.5.0",
  currentVersion: "v1.4.0",
  dismissed: false,
};

beforeEach(() => {
  useUiStore.getState().setUpdateNotice(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The connection pill only appears once the socket has been open at least once. */
function renderAfterConnect(props: Parameters<typeof TopPanelBanner>[0]) {
  const result = render(<TopPanelBanner {...props} status="open" />);
  result.rerender(<TopPanelBanner {...props} />);
  act(() => { vi.advanceTimersByTime(1500); });
  return result;
}

describe("TopPanelBanner", () => {
  it("shows no pill when neither occupant has anything to say", () => {
    const { container } = render(
      <TopPanelBanner variant="desktop" showConnection status="open" />,
    );
    expect(container.querySelector("[role]")).toBeNull();
  });

  it("keeps the mobile row's space while a connection could be reported", () => {
    const { container } = render(
      <TopPanelBanner variant="mobile" showConnection status="open" />,
    );
    expect(container.firstElementChild).not.toBeNull();
  });

  it("adds no mobile row on a screen that never reserved one", () => {
    const { container } = render(
      <TopPanelBanner variant="mobile" showConnection={false} status="open" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows the update banner while the connection is healthy", () => {
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    render(<TopPanelBanner variant="desktop" showConnection status="open" />);
    expect(screen.getByTestId("update-available-banner")).toBeInTheDocument();
  });

  it("shows the update banner where the connection banner is not wanted — the home screen", () => {
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    render(<TopPanelBanner variant="desktop" showConnection={false} status="closed" />);
    expect(screen.getByTestId("update-available-banner")).toBeInTheDocument();
  });

  it("gives the slot to the connection banner when both want it", () => {
    vi.useFakeTimers();
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    renderAfterConnect({ variant: "desktop", showConnection: true, status: "closed" });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("update-available-banner")).not.toBeInTheDocument();
  });

  it("hands the slot back to the update banner once the connection recovers", () => {
    vi.useFakeTimers();
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    const props = { variant: "desktop", showConnection: true } as const;
    const { rerender } = renderAfterConnect({ ...props, status: "closed" });

    rerender(<TopPanelBanner {...props} status="open" />);
    act(() => { vi.advanceTimersByTime(3000); });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("update-available-banner")).toBeInTheDocument();
  });

  it("still announces a disconnect after the update banner held the slot", () => {
    vi.useFakeTimers();
    useUiStore.getState().setUpdateNotice(AVAILABLE);
    const props = { variant: "mobile", showConnection: true } as const;
    // Open first, so the update banner owns the slot, then drop the socket.
    const { rerender } = render(<TopPanelBanner {...props} status="open" />);
    expect(screen.getByTestId("update-available-banner")).toBeInTheDocument();

    rerender(<TopPanelBanner {...props} status="connecting" />);
    act(() => { vi.advanceTimersByTime(1500); });

    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });
});
