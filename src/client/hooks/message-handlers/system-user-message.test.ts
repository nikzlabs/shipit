import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSystemUserMessage } from "./system-user-message.js";
import type { HandlerContext } from "./types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
});

/**
 * `system_user_message` carries the user message a starting turn is answering to
 * every attached viewer. Two producers share the type and the handler must keep
 * them apart:
 *
 *  - a server-initiated dispatch (Fix CI, Create PR) — no `clientRequestId`,
 *    reconciled against an optimistic `pendingDispatch` bubble by text;
 *  - a user-typed WS message — carries the sender's `clientRequestId`, which the
 *    SENDING tab matches and every other viewer does not.
 */
describe("handleSystemUserMessage (dispatch echo)", () => {
  it("appends when there is no optimistic bubble to reconcile", () => {
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      sessionId: "s1",
      text: "Fix the failing CI job",
      activity: "Auto-fixing CI...",
    });
    expect(useSessionStore.getState().messages).toEqual([
      { role: "user", text: "Fix the failing CI job" },
    ]);
    expect(useSessionStore.getState().activity).toEqual({ label: "Auto-fixing CI..." });
  });

  it("reconciles a pendingDispatch bubble in place instead of duplicating it", () => {
    useSessionStore.setState({
      messages: [{ role: "user", text: "Create a PR", pendingDispatch: true }],
    });
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      sessionId: "s1",
      text: "Create a PR",
    });
    expect(useSessionStore.getState().messages).toEqual([
      { role: "user", text: "Create a PR" },
    ]);
  });
});

describe("handleSystemUserMessage (user-typed echo)", () => {
  it("appends the message for a viewer that did not send it", () => {
    // The reported bug: the message was typed on the user's phone while the
    // desktop had the same session open. The desktop has no optimistic bubble,
    // so without this append it saw the agent's reply to a message that was
    // never on screen.
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      sessionId: "s1",
      text: "ship it",
      clientRequestId: "req-from-phone",
    });
    expect(useSessionStore.getState().messages).toEqual([
      { role: "user", text: "ship it" },
    ]);
  });

  it("does NOT double-render on the sending tab", () => {
    useSessionStore.setState({
      messages: [{ role: "user", text: "ship it", clientRequestId: "req-from-phone" }],
    });
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      sessionId: "s1",
      text: "ship it",
      clientRequestId: "req-from-phone",
    });
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });

  it("matches the sender's bubble wherever it sits, not just at the tail", () => {
    // Something can land after the optimistic bubble before the echo arrives —
    // a card, or the turn's first streamed text — which is why the id is
    // searched for rather than compared against the last message.
    useSessionStore.setState({
      messages: [
        { role: "user", text: "ship it", clientRequestId: "req-1" },
        { role: "assistant", text: "on it", streaming: true },
      ],
    });
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      sessionId: "s1",
      text: "ship it",
      clientRequestId: "req-1",
    });
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });

  it("appends a repeated identical message rather than collapsing it by text", () => {
    // Short repeats ("continue", "yes") are the common case for a second viewer,
    // and text matching would silently swallow every one after the first.
    useSessionStore.setState({
      messages: [
        { role: "user", text: "continue" },
        { role: "assistant", text: "done" },
        { role: "user", text: "continue" },
      ],
    });
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      sessionId: "s1",
      text: "continue",
      clientRequestId: "req-3",
    });
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(4);
    expect(messages[3]).toMatchObject({ role: "user", text: "continue" });
  });

  it("carries attachments so a phone-uploaded image renders on the desktop", () => {
    const images = [{ mediaType: "image/png", src: "/images/abc" }];
    const files = [{ path: "src/app.ts", contentPreview: "export const app" }];
    handleSystemUserMessage(ctx, {
      type: "system_user_message",
      sessionId: "s1",
      text: "look at this",
      clientRequestId: "req-4",
      images,
      files,
      uploadPaths: ["/uploads/shot.png"],
    });
    expect(useSessionStore.getState().messages[0]).toMatchObject({
      role: "user",
      text: "look at this",
      images,
      files,
      uploadPaths: ["/uploads/shot.png"],
    });
  });
});
