import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAttentionSessions } from "./useAttentionSessions.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionInfo } from "../../server/shared/types.js";

afterEach(() => {
  useSessionStore.setState({ activeRunnerSessions: new Set<string>() });
});

const session = (overrides: Partial<SessionInfo> & { id: string }): SessionInfo => ({
  title: "Session",
  createdAt: "2024-01-01",
  lastUsedAt: "2024-01-01",
  remoteUrl: "",
  ...overrides,
});

describe("useAttentionSessions", () => {
  it("returns the sessions whose ball is in the user's court", () => {

    // which this hook must not second-guess (req 9).
    useSessionStore.setState({ activeRunnerSessions: new Set(["running"]) });
    const sessions = [session({ id: "idle" }), session({ id: "running" })];

    const { result } = renderHook(() => useAttentionSessions(sessions));

    expect([...result.current]).toEqual(["idle"]);
  });

  it("excludes archived, user-archived and warm sessions", () => {
    // An archived row carries no marker in the first view, so it must not be in

    const sessions = [
      session({ id: "live" }),
      session({ id: "archived", archived: true }),
      session({ id: "hidden", userArchived: true }),
      session({ id: "warm", warm: true }),
    ];

    const { result } = renderHook(() => useAttentionSessions(sessions));

    expect([...result.current]).toEqual(["live"]);
  });

  it("excludes a muted session, and takes it back when the mute is gone (docs/277)", () => {

    const sessions = [session({ id: "live" }), session({ id: "muted", mutedAt: "2024-01-02T00:00:00.000Z" })];

    const { result, rerender } = renderHook(
      ({ list }: { list: SessionInfo[] }) => useAttentionSessions(list),
      { initialProps: { list: sessions } },
    );
    expect([...result.current]).toEqual(["live"]);

    rerender({ list: [session({ id: "live" }), session({ id: "muted" })] });
    expect([...result.current]).toEqual(["live", "muted"]);
  });

  it("docs/298: includes a merged session whose workspace is blocked, agent or not", () => {
    useSessionStore.setState({ activeRunnerSessions: new Set(["stuck"]) });
    const sessions = [
      session({
        id: "stuck",
        mergedAt: "2024-01-02T00:00:00.000Z",
        workspaceBlock: "conflict",
      }),
      session({ id: "merged", mergedAt: "2024-01-02T00:00:00.000Z" }),
    ];

    const { result } = renderHook(() => useAttentionSessions(sessions));

    expect([...result.current]).toEqual(["stuck"]);
  });
});
