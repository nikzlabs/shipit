import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionReportCard } from "./SessionReportCard.js";
import { useSessionStore } from "../stores/session-store.js";

/**
 * Tests for the read-only `SessionReportCard` (docs/233 / planning#243). The card
 * renders straight from its props (persisted on the message row — no store, no
 * lifecycle); the only store read is the reporting session's sidebar row, which
 * gates the "Open" button so a card for an archived/deleted session can't
 * navigate into nothing.
 */

const props = {
  fromSessionId: "child-1",
  fromTitle: "Elementalist catalog",
  fromBranch: "shipit/elem",
  relation: "child" as const,
  severity: "blocker" as const,
  subject: "regen wipes data/catalogs",
  body: "The shared regen command deletes every catalog, not just mine.",
};

beforeEach(() => {
  useSessionStore.setState({ sessions: [{ id: "child-1", title: "Elementalist catalog" }] as never });
});
afterEach(() => cleanup());

describe("SessionReportCard", () => {
  it("renders the reporter, severity, subject, and body", () => {
    render(<SessionReportCard {...props} />);
    expect(screen.getByTestId("session-report-card")).toHaveAttribute("data-severity", "blocker");
    expect(screen.getByText(/Report — blocker/)).toBeInTheDocument();
    expect(screen.getByText(/from a child session/)).toBeInTheDocument();
    expect(screen.getByText("Elementalist catalog")).toBeInTheDocument();
    expect(screen.getByText("shipit/elem")).toBeInTheDocument();
    expect(screen.getByText("regen wipes data/catalogs")).toBeInTheDocument();
    expect(screen.getByText(/deletes every catalog/)).toBeInTheDocument();
  });

  it("labels a cohort broadcast as coming from a sibling", () => {
    render(<SessionReportCard {...props} relation="sibling" severity="warn" />);
    expect(screen.getByText(/from a sibling session/)).toBeInTheDocument();
    expect(screen.getByTestId("session-report-card")).toHaveAttribute("data-severity", "warn");
  });

  it("opens the reporting session", () => {
    const onOpen = vi.fn();
    render(<SessionReportCard {...props} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Open reporting session/ }));
    expect(onOpen).toHaveBeenCalledWith("child-1");
  });

  it("disables Open when the reporting session is gone from the sidebar", () => {
    useSessionStore.setState({ sessions: [] as never });
    render(<SessionReportCard {...props} />);
    expect(screen.getByRole("button", { name: /Open reporting session/ })).toBeDisabled();
  });
});
