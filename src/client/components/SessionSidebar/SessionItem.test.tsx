import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionItem } from "./SessionItem.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { SessionInfo } from "../../../server/shared/types.js";

afterEach(cleanup);

const session = (keepPreviewRunning = false): SessionInfo => ({
  id: "s1", title: "Preview session", createdAt: "2024-01-01", lastUsedAt: "2024-01-01",
  remoteUrl: "", ...(keepPreviewRunning ? { keepPreviewRunning: true } : {}),
});

const MUTE = "Mute until next turn";

describe("SessionItem keep-preview action", () => {
  it("calls the toggle callback and shows a checkmark only when enabled", async () => {
    const toggle = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({ setKeepPreviewRunning: toggle });
    const user = userEvent.setup();
    const { rerender } = render(
      <SessionItem session={session()} isCurrent onResume={vi.fn()} overflowMenuPortaled={false} />,
    );
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    const action = screen.getByText("Keep preview running").closest("div");
    expect(action?.querySelector("svg")).toBeNull();
    await user.click(screen.getByText("Keep preview running"));
    expect(toggle).toHaveBeenCalledWith("s1", true);

    rerender(<SessionItem session={session(true)} isCurrent onResume={vi.fn()} overflowMenuPortaled={false} />);
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByText("Keep preview running").closest("div")?.querySelector("svg")).not.toBeNull();
  });

  it("marks the reserved row in the sidebar, so the holder is findable", () => {
    // Without this the only sign lives inside one row's overflow menu, and
    // "capacity is full" sends the user opening every menu in turn (docs/241).
    const { rerender } = render(
      <SessionItem session={session()} isCurrent={false} onResume={vi.fn()} overflowMenuPortaled={false} />,
    );
    expect(screen.queryByTitle("Always-on preview")).toBeNull();

    rerender(
      <SessionItem session={session(true)} isCurrent={false} onResume={vi.fn()} overflowMenuPortaled={false} />,
    );
    expect(screen.getByTitle("Always-on preview")).toBeInTheDocument();
  });

  it("does not mark an archived row, whose reservation the server released", () => {
    // An archived row can still carry the flag (a legacy row, or a cached All
    // Sessions entry mid-archive). Marking it claims a reservation that no
    // longer exists and that this row cannot toggle off.
    render(
      <SessionItem
        session={{ ...session(true), archived: true, userArchived: true }}
        isCurrent={false}
        onResume={vi.fn()}
        overflowMenuPortaled={false}
      />,
    );
    expect(screen.queryByTitle("Always-on preview")).toBeNull();
  });
});

describe("docs/277 mute action", () => {
  it("mutes a row that is asking for the user", async () => {
    const setMuted = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({ setMuted });
    const user = userEvent.setup();
    // A session with no PR card and no running agent reads as "Waiting for your
    // input", which is the state the control exists for.
    render(<SessionItem session={session()} isCurrent onResume={vi.fn()} overflowMenuPortaled={false} />);
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByText(MUTE));
    expect(setMuted).toHaveBeenCalledWith("s1", true);
  });

  it("offers Unmute on a muted row, which by then needs no attention (req 5)", async () => {
    const setMuted = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({ setMuted });
    const user = userEvent.setup();
    // The point of the test: muting is what removes the attention reason, so a
    // control gated only on "needs attention" would disappear the moment it was
    // used and strand the session.
    render(
      <SessionItem
        session={{ ...session(), mutedAt: "2024-01-02T00:00:00.000Z" }}
        isCurrent
        onResume={vi.fn()}
        overflowMenuPortaled={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.queryByText(MUTE)).toBeNull();
    await user.click(screen.getByText("Unmute"));
    expect(setMuted).toHaveBeenCalledWith("s1", false);
  });

  it("does not offer the mute while the agent is working (req 6)", async () => {
    useSessionStore.setState({ activeRunnerSessions: new Set(["s1"]) });
    const user = userEvent.setup();
    render(<SessionItem session={session()} isCurrent onResume={vi.fn()} overflowMenuPortaled={false} />);
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.queryByText(MUTE)).toBeNull();
    useSessionStore.setState({ activeRunnerSessions: new Set() });
  });

  it("drops the attention marker and adds no mark of its own (reqs 2, 8)", () => {
    const { container, rerender } = render(
      <SessionItem session={session()} isCurrent={false} onResume={vi.fn()} overflowMenuPortaled={false} />,
    );
    const row = () => container.querySelector<HTMLElement>('[data-testid="session-item"]')!;
    expect(row().style.boxShadow).toContain("--color-attention");
    const iconsBefore = row().querySelectorAll("svg").length;

    rerender(
      <SessionItem
        session={{ ...session(), mutedAt: "2024-01-02T00:00:00.000Z" }}
        isCurrent={false}
        onResume={vi.fn()}
        overflowMenuPortaled={false}
      />,
    );
    expect(row().style.boxShadow).toBe("");
    expect(row().title).toBe("");
    // A muted row looks like a row with nothing pending: the amber marker goes,
    // and nothing takes its place.
    expect(row().querySelectorAll("svg").length).toBe(iconsBefore);
  });
});
