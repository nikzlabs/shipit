/**
 * docs/257 — the GitHub gate's dismissal latch.
 *
 * The requirement this protects is a negative one ("the GitHub step keeps
 * today's behaviour in full"), so the case that matters is the one where the
 * latch makes the gate do *less* than a naive `githubNeeded` gate would. Pinned
 * because the latch reads like an accident, which is how a later simplification
 * deletes it. Raised by cross-backend review as untested.
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGitHubGateLatch } from "./useGitHubGateLatch.js";

describe("useGitHubGateLatch", () => {
  it("stays down while GitHub is connected", () => {
    const { result } = renderHook(() => useGitHubGateLatch(false));
    expect(result.current.showGitHubGate).toBe(false);
  });

  it("blocks as soon as GitHub is needed", () => {
    const { result } = renderHook(() => useGitHubGateLatch(true));
    expect(result.current.showGitHubGate).toBe(true);
  });

  it("pops mid-load for a user who has NOT been through it this load", () => {
    const { result, rerender } = renderHook(({ needed }) => useGitHubGateLatch(needed), {
      initialProps: { needed: false },
    });
    expect(result.current.showGitHubGate).toBe(false);

    rerender({ needed: true });
    expect(result.current.showGitHubGate).toBe(true);
  });

  it("closes when GitHub connects, and stays closed while it is still needed", () => {
    // The gate does not close reactively on `githubNeeded` — it closes because
    // the form reported success. Holding it shut afterwards is what stops it
    // flickering while the new status propagates.
    const { result, rerender } = renderHook(({ needed }) => useGitHubGateLatch(needed), {
      initialProps: { needed: true },
    });

    act(() => { result.current.dismiss(); });
    expect(result.current.showGitHubGate).toBe(false);

    rerender({ needed: true });
    expect(result.current.showGitHubGate).toBe(false);
  });

  it("does NOT re-gate a user whose token dies later in the same page load", () => {
    // The one row where the latch differs from a direct `githubNeeded` gate,
    // and the reason it is kept: a gate popping over the work of someone who
    // has already been through it would be a change to a step that is out of
    // scope. A fresh page load re-gates them — that is a new hook instance.
    const { result, rerender } = renderHook(({ needed }) => useGitHubGateLatch(needed), {
      initialProps: { needed: true },
    });

    act(() => { result.current.dismiss(); });
    rerender({ needed: false });
    expect(result.current.showGitHubGate).toBe(false);

    // Token revoked mid-session.
    rerender({ needed: true });
    expect(result.current.showGitHubGate).toBe(false);

    // Next page load: a fresh instance, and the gate is back.
    const reloaded = renderHook(() => useGitHubGateLatch(true));
    expect(reloaded.result.current.showGitHubGate).toBe(true);
  });
});
