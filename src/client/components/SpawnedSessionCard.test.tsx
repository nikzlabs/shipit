import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { SpawnedSessionCard } from "./SpawnedSessionCard.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionInfo } from "../../server/shared/types.js";

/**
 * Tests for the in-chat `SpawnedSessionCard` (docs/117 Phase 2).
 *
 * The card renders inline in the parent's chat at the point where the
 * running agent spawned a sibling session. It reads the child's status
 * (running / idle / archived / missing) live from the session store, so the
 * tests seed `useSessionStore` and exercise the matrix of states.
 */

function seedSessions(sessions: SessionInfo[]): void {
  useSessionStore.setState({
    sessions,
    activeRunnerSessions: new Set<string>(),
  });
}

function setRunning(sessionIds: string[]): void {
  useSessionStore.setState({ activeRunnerSessions: new Set(sessionIds) });
}

function mkSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: overrides.id ?? "child-1",
    title: overrides.title ?? "Spawned",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    lastUsedAt: overrides.lastUsedAt ?? "2026-01-01T00:00:00Z",
    ...overrides,
  } as SessionInfo;
}

const BASE_PROPS = {
  childSessionId: "child-1",
  title: "Port API to TypeScript",
  branch: "port-api-ts",
  spawnedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  seedSessions([]);
});

afterEach(() => {
  cleanup();
  // Reset between tests so a leftover sessions list doesn't bleed into the
  // next test's missing-child fallback assertions.
  seedSessions([]);
});

describe("SpawnedSessionCard", () => {
  it("renders the title and branch baked in by the spawn event", () => {
    seedSessions([mkSession({ id: "child-1" })]);
    render(<SpawnedSessionCard {...BASE_PROPS} />);
    expect(screen.getByText("Port API to TypeScript")).toBeInTheDocument();
    expect(screen.getByText("port-api-ts")).toBeInTheDocument();
    expect(screen.getByText("Spawned session")).toBeInTheDocument();
  });

  it("renders an 'Idle' status when the child exists but no agent is running", () => {
    seedSessions([mkSession({ id: "child-1" })]);
    render(<SpawnedSessionCard {...BASE_PROPS} />);
    expect(screen.getByTestId("spawned-session-status")).toHaveTextContent(/idle/i);
  });

  it("renders a 'Running' status when the child appears in activeRunnerSessions", () => {
    seedSessions([mkSession({ id: "child-1" })]);
    setRunning(["child-1"]);
    render(<SpawnedSessionCard {...BASE_PROPS} />);
    expect(screen.getByTestId("spawned-session-status")).toHaveTextContent(/running/i);
  });

  it("transitions between idle and running reactively when activeRunnerSessions changes", () => {
    seedSessions([mkSession({ id: "child-1" })]);
    render(<SpawnedSessionCard {...BASE_PROPS} />);
    expect(screen.getByTestId("spawned-session-status")).toHaveTextContent(/idle/i);
    act(() => { setRunning(["child-1"]); });
    expect(screen.getByTestId("spawned-session-status")).toHaveTextContent(/running/i);
    act(() => { setRunning([]); });
    expect(screen.getByTestId("spawned-session-status")).toHaveTextContent(/idle/i);
  });

  it("falls back to 'Session not found' when the child session is missing from the store", () => {
    seedSessions([]);
    render(<SpawnedSessionCard {...BASE_PROPS} />);
    expect(screen.getByTestId("spawned-session-status")).toHaveTextContent(/not found/i);
    // The card itself still renders so the user sees what was spawned.
    expect(screen.getByText("Port API to TypeScript")).toBeInTheDocument();
  });

  it("renders an 'Archived' pill when the child session exists but is archived", () => {
    seedSessions([mkSession({ id: "child-1", archived: true })]);
    render(<SpawnedSessionCard {...BASE_PROPS} />);
    expect(screen.getByTestId("spawned-session-status")).toHaveTextContent(/archived/i);
  });

  it("disables the Open button when the child session is missing", () => {
    seedSessions([]);
    render(<SpawnedSessionCard {...BASE_PROPS} />);
    const openButton = screen.getByRole("button", { name: /open/i });
    expect(openButton).toBeDisabled();
  });

  it("invokes onOpen with the child id when the Open button is clicked", () => {
    seedSessions([mkSession({ id: "child-1" })]);
    const onOpen = vi.fn();
    render(<SpawnedSessionCard {...BASE_PROPS} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("child-1");
  });

  it("falls back to setting the session-store's sessionId when onOpen is omitted", () => {
    seedSessions([mkSession({ id: "child-1" })]);
    render(<SpawnedSessionCard {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(useSessionStore.getState().sessionId).toBe("child-1");
  });

  it("does NOT call onOpen when the child is missing (defensive)", () => {
    seedSessions([]);
    const onOpen = vi.fn();
    render(<SpawnedSessionCard {...BASE_PROPS} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    // The button is disabled, so React's synthetic event shouldn't reach the handler.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("omits the branch line when no branch is supplied", () => {
    seedSessions([mkSession({ id: "child-1" })]);
    const { childSessionId, title, spawnedAt } = BASE_PROPS;
    render(
      <SpawnedSessionCard
        childSessionId={childSessionId}
        title={title}
        spawnedAt={spawnedAt}
      />,
    );
    expect(screen.queryByText("port-api-ts")).not.toBeInTheDocument();
  });

  // docs/162 — Ops "ShipIt fix session" variant.
  describe("shipitFix variant", () => {
    it("renders the ShipIt-fix header, source ref, target repo, and diagnosis", () => {
      seedSessions([mkSession({ id: "child-1" })]);
      render(
        <SpawnedSessionCard
          {...BASE_PROPS}
          shipitFix={{
            sourceRef: "abc123def456789",
            sourceExact: true,
            refSource: "build-id",
            targetRepo: "shipit-hq/shipit",
            diagnosis: "Container stuck in a SIGTERM recreate loop.",
          }}
        />,
      );
      expect(screen.getByText("ShipIt fix session")).toBeInTheDocument();
      const fix = screen.getByTestId("spawned-session-shipit-fix");
      // Source ref is rendered short (12 chars).
      expect(fix).toHaveTextContent("abc123def456");
      expect(fix).toHaveTextContent("shipit-hq/shipit");
      expect(fix).toHaveTextContent("Container stuck in a SIGTERM recreate loop.");
      expect(screen.getByTestId("spawned-session-source-exactness")).toHaveTextContent(/exact/i);
    });

    it("flags an approximate source ref", () => {
      seedSessions([mkSession({ id: "child-1" })]);
      render(
        <SpawnedSessionCard
          {...BASE_PROPS}
          shipitFix={{ sourceRef: "deadbeefcafe", sourceExact: false }}
        />,
      );
      expect(screen.getByTestId("spawned-session-source-exactness")).toHaveTextContent(/approximate/i);
    });

    it("renders the plain 'Spawned session' header when shipitFix is absent", () => {
      seedSessions([mkSession({ id: "child-1" })]);
      render(<SpawnedSessionCard {...BASE_PROPS} />);
      expect(screen.getByText("Spawned session")).toBeInTheDocument();
      expect(screen.queryByTestId("spawned-session-shipit-fix")).not.toBeInTheDocument();
    });
  });
});
