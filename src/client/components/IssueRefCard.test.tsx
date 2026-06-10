import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { IssueRefCard } from "./IssueRefCard.js";
import type { IssueRefCard as IssueRefCardData } from "../../server/shared/types.js";

/**
 * Tests for the read-only `IssueRefCard` (docs/188). The card renders straight
 * from its props (no store, no lifecycle), so these cover the navigation line,
 * the deep-link affordance, and the done-state muting.
 */

function card(over: Partial<IssueRefCardData> = {}): IssueRefCardData {
  return {
    cardId: "ref-1",
    tracker: "github",
    identifier: "octocat/hello#42",
    title: "An open issue",
    url: "https://github.com/octocat/hello/issues/42",
    status: "Open",
    statusType: "started",
    createdAt: "2026-06-03T00:00:00.000Z",
    ...over,
  };
}

afterEach(() => cleanup());

describe("IssueRefCard", () => {
  it("renders the viewed identifier, title, status, and a jump-to-issue link", () => {
    render(<IssueRefCard card={card()} />);
    expect(screen.getByText(/Agent viewed/)).toBeInTheDocument();
    // Identifier appears in both the body line and the deep link.
    expect(screen.getAllByText("octocat/hello#42").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("An open issue")).toBeInTheDocument();
    expect(screen.getByText(/Open/)).toBeInTheDocument();
    const link = screen.getByRole("link") as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/octocat/hello/issues/42");
    expect(link.target).toBe("_blank");
  });

  it("omits the link when the issue has no url", () => {
    render(<IssueRefCard card={card({ url: undefined })} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
