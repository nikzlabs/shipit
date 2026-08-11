import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { useServerEvents } from "./useServerEvents.js";
import { useSettingsStore } from "../stores/settings-store.js";
import type { ReviewerSlotView } from "../../server/shared/types/agent-types.js";

/**
 * docs/261 phase 3 (req 8) — the `agent_list` SSE really does apply `reviewers`.
 *
 * This exists because of a hole cross-backend review found: `ReviewerTab`'s
 * "follows a pushed re-resolution" test sets the store directly, so it passes
 * whether or not anything ever pushes. The re-broadcast is the mechanism req 8's
 * visible state depends on — an auto-configured reviewer has to improve while
 * the tab is open — and this is the only test that fails if this hop drops the
 * field.
 *
 * Driven through the REAL handler, with `EventSource` stubbed at the global:
 * the hook constructs its own, so a fake global is the seam, and asserting on
 * the handler's effect is what makes this different from a source scan.
 */

type Listener = (event: MessageEvent) => void;

/** The minimum of `EventSource` the hook touches, plus a way to emit into it. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  readonly listeners = new Map<string, Listener[]>();
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  readyState = 1;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(): void {
    /* the hook only removes on teardown, and teardown drops the whole fake */
  }

  close(): void {
    this.readyState = 2;
  }

  /** Deliver one server event, exactly as the browser would. */
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

const AGENTS = [
  { id: "claude", name: "Claude Code", installed: true, hasRunnableModels: true, models: [] },
];

const reviewers: ReviewerSlotView[] = [
  {
    slot: "first",
    source: "auto",
    resolved: {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4",
      serviceName: "DeepSeek",
      label: "V4",
      harnessId: "claude",
      harnessName: "Claude Code",
      reasoningEffort: "high",
      reasoningLabel: "High",
    },
  },
  { slot: "second", source: "auto", unavailableReason: "nothing_eligible" },
];

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  useSettingsStore.getState().setReviewers([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.last = undefined;
});

describe("useServerEvents — agent_list carries the reviewer resolution", () => {
  it("applies a pushed resolution to the store", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last;
    expect(es, "the hook should have opened an EventSource").toBeTruthy();

    act(() => {
      es?.emit("agent_list", { agents: AGENTS, canRunTurns: true, reviewers });
    });

    // The whole point: a credential change fires this event, and the open
    // Reviewer tab re-renders off the store rather than off a reload.
    expect(useSettingsStore.getState().reviewers).toEqual(reviewers);
  });

  /**
   * A newer server always sends the array, so absence means an OLDER server —
   * and clearing the store on that would empty the Reviewer tab rather than say
   * anything. "No news" has to leave the last good answer alone.
   */
  it("leaves the last known resolution alone when the payload omits it", () => {
    useSettingsStore.getState().setReviewers(reviewers);
    renderHook(() => useServerEvents());

    act(() => {
      FakeEventSource.last?.emit("agent_list", { agents: AGENTS, canRunTurns: true });
    });

    expect(useSettingsStore.getState().reviewers).toEqual(reviewers);
  });
});
