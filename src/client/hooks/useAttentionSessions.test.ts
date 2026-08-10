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
});
