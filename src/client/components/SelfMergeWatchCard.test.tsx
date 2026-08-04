import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelfMergeWatchCard } from "./SelfMergeWatchCard.js";

/**
 * The arm card (docs/239). Static payload, one action.
 *
 * The test that matters is the last one: Cancel must send the card's OWN
 * `watchId`, because a chained session leaves older arm cards in the scrollback
 * and clicking one of those must not cancel the watch armed for the CURRENT PR.
 * The server answers `{ cancelled: false }` for a stale id, which the card
 * renders as "no longer armed" rather than an error.
 */

const CARD = {
  cardId: "self-merge-watch-1",
  watchId: "watch-abc",
  prNumber: 43,
  prUrl: "https://github.com/o/r/pull/43",
  prTitle: "Step two",
  branch: "shipit/s1",
  createdAt: "2026-07-31T00:00:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ cancelled: true }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SelfMergeWatchCard", () => {
  it("says what will happen when the PR merges", () => {
    render(<SelfMergeWatchCard card={CARD} sessionId="s1" />);
    expect(screen.getByText("Will continue when this PR merges")).toBeTruthy();
    expect(screen.getByText("Waiting on PR #43")).toBeTruthy();
    expect(screen.getByText(/resets this branch to the latest base/)).toBeTruthy();
  });

  it("Cancel posts the card's own watchId and reports the cancellation", async () => {
    render(<SelfMergeWatchCard card={CARD} sessionId="s1" />);
    await userEvent.click(screen.getByRole("button", { name: /cancel the merge watch/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/sessions/s1/notify-on-merge-self/cancel");
    expect(JSON.parse(init.body)).toEqual({ watchId: "watch-abc" });

    await screen.findByText(/Cancelled/);
    // The copy is honest about the one thing cancelling does NOT stop.
    expect(screen.getByText(/already running will still finish/)).toBeTruthy();
  });

  it("a stale card's Cancel reports 'no longer armed', not success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ cancelled: false, reason: "superseded" }),
    });
    render(<SelfMergeWatchCard card={CARD} sessionId="s1" />);
    await userEvent.click(screen.getByRole("button", { name: /cancel the merge watch/i }));

    await screen.findByText(/No longer armed/);
    expect(screen.getByTestId("self-merge-watch-card").getAttribute("data-phase")).toBe("stale");
  });
});
