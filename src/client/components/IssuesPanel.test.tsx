import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IssuesPanel } from "./IssuesPanel.js";
import { useIssuesStore } from "../stores/issues-store.js";

afterEach(() => {
  cleanup();
  useIssuesStore.getState().reset();
  useIssuesStore.setState({ trackers: [], activeTracker: "linear", infoByTracker: {} });
});

describe("IssuesPanel", () => {
  // Regression for React error #185 (Maximum update depth exceeded): selecting
  // `issuesByTracker[active] ?? []` with a fresh `[]` literal made
  // useSyncExternalStore see a new snapshot every render and loop forever — the
  // exact state on tab open, before the first fetch populates the store.
  it("renders with an empty store without an infinite render loop", () => {
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });

  it("renders when the active tracker has no issues entry yet", () => {
    useIssuesStore.setState({
      trackers: [{ id: "linear", label: "Linear", configured: true }],
      activeTracker: "linear",
      infoByTracker: { linear: { id: "linear", label: "Linear", configured: true } },
    });
    expect(() =>
      render(
        <MemoryRouter>
          <IssuesPanel onConnect={() => {}} />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });
});
