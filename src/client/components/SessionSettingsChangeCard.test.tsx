import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionSettingsChangeCard } from "./SessionSettingsChangeCard.js";
import type { SessionSettingsChangeCard as CardData } from "../../server/shared/types.js";

const card = (over: Partial<CardData> = {}): CardData => ({
  cardId: "ssc-1",
  scope: "sandbox-capabilities",
  changes: [{ label: "Docker access", from: "off", to: "on", granted: true }],
  pendingRestart: false,
  createdAt: "2026-08-21T11:34:00.000Z",
  ...over,
});

afterEach(cleanup);

describe("SessionSettingsChangeCard (docs/279)", () => {
  it("names each grant that moved, with where it moved from and to", () => {
    render(<SessionSettingsChangeCard card={card({
      changes: [
        { label: "GitHub access", from: "off", to: "on", granted: true },
        { label: "Network access", from: "on", to: "off", granted: false },
      ],
    })} />);
    expect(screen.getByText("Sandbox capabilities changed")).toBeInTheDocument();
    expect(screen.getByText("GitHub access")).toBeInTheDocument();
    expect(screen.getByText("Network access")).toBeInTheDocument();
    expect(screen.getAllByText("on")).not.toHaveLength(0);
    expect(screen.getAllByText("off")).not.toHaveLength(0);
  });

  it("titles a regular session's network-mode change differently", () => {
    render(<SessionSettingsChangeCard card={card({
      scope: "network-mode",
      changes: [{ label: "Network containment", from: "Inherit global", to: "Open" }],
    })} />);
    expect(screen.getByText("Network access changed")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("says so when the change was pending a container restart", () => {
    render(<SessionSettingsChangeCard card={card({ pendingRestart: true })} />);
    expect(screen.getByTestId("session-settings-change-card-pending")).toBeInTheDocument();
  });

  it("omits the pending line when the change applied immediately", () => {
    render(<SessionSettingsChangeCard card={card()} />);
    expect(screen.queryByTestId("session-settings-change-card-pending")).not.toBeInTheDocument();
  });
});
