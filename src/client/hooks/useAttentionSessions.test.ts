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
    // An idle session with no PR is "Waiting for your input"; a session with a
    // running agent is not. Both verdicts come from `computeAttentionReason`,
    // which this hook must not second-guess (req 9).
    useSessionStore.setState({ activeRunnerSessions: new Set(["running"]) });
    const sessions = [session({ id: "idle" }), session({ id: "running" })];

    const { result } = renderHook(() => useAttentionSessions(sessions));

    expect([...result.current]).toEqual(["idle"]);
  });

  it("excludes archived, user-archived and warm sessions", () => {
    // An archived row carries no marker in the first view, so it must not be in
    // a view whose membership IS the marker; a warm session isn't listed at all.
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
    // The "Needs you" view and its count are the same membership as the row
    // marker, so a mute has to drop the session out of both together (req 2).
    const sessions = [session({ id: "live" }), session({ id: "muted", mutedAt: "2024-01-02T00:00:00.000Z" })];

    const { result, rerender } = renderHook(
      ({ list }: { list: SessionInfo[] }) => useAttentionSessions(list),
      { initialProps: { list: sessions } },
    );
    expect([...result.current]).toEqual(["live"]);

    // The server clears `mutedAt` at the start of the next turn and rebroadcasts
    // the list; the row comes back with no further help from this hook.
    rerender({ list: [session({ id: "live" }), session({ id: "muted" })] });
    expect([...result.current]).toEqual(["live", "muted"]);
  });
});
