import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../stores/session-store.js";
import { dispatchAgentMessage } from "./dispatch-agent-message.js";

beforeEach(() => {
  useSessionStore.setState({ sessionId: "s1", messages: [] });
});

describe("dispatchAgentMessage", () => {
  // planning#691 — the server names the queue row, the steer and the echo by it, so every
  // viewer matches them to this one bubble.
  it("sends the id of its optimistic bubble with the request", async () => {
    const bodies: unknown[] = [];
    await dispatchAgentMessage({
      sessionId: "s1",
      text: "Create a PR",
      activity: "Creating PR…",
      apiPost: <T,>(_path: string, body?: unknown): Promise<T> => {
        bodies.push(body);
        return Promise.resolve({ ok: true, queued: true } as T);
      },
    });

    const bubble = useSessionStore.getState().messages[0];
    expect(bubble?.clientRequestId).toEqual(expect.any(String));
    expect(bodies).toEqual([expect.objectContaining({ requestId: bubble?.clientRequestId })]);
  });
});
