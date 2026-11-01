import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionReportCard } from "./SessionReportCard.js";
import { useSessionStore } from "../stores/session-store.js";

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

  it("renders a legacy persisted sibling report", () => {
    render(<SessionReportCard {...props} relation="sibling" severity="warn" />);
    expect(screen.getByText(/from a sibling session/)).toBeInTheDocument();
    expect(screen.getByTestId("session-report-card")).toHaveAttribute("data-severity", "warn");
  });

  // docs/328-session-message-inbox — the agent reads the inbox; this card is the user's record.
  it.each([
    ["parent", /Message · from the parent session/],
    ["proposed", /Message · from another session, approved by you/],
  ] as const)("renders a message from a %s session, which has no severity", (relation, label) => {
    const { severity: _severity, subject: _subject, ...message } = props;
    render(<SessionReportCard {...message} relation={relation} />);

    expect(screen.getByTestId("session-report-card")).toHaveAttribute("data-severity", "message");
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(/deletes every catalog/)).toBeInTheDocument();
    expect(screen.queryByText(/Report/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open sending session/ })).toBeInTheDocument();
  });

  it("says that the agent reads it from the inbox", () => {
    render(<SessionReportCard {...props} />);
    expect(screen.getByText(/In this session's inbox/)).toBeInTheDocument();
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
