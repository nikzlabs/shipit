/**
 * The send path's WIRING — the gap three PRs in a row had to state rather than
 * close (docs/293 req 4).
 *
 * `buildAttachmentPlan` and `resolveReviewRequest` are pure and well covered,
 * but neither can fail on `App` forgetting to spread `plan.frame` into the wire
 * frame, or on `App` computing a refusal and then dispatching anyway. Those are
 * the mistakes req 4 is actually about, and they only became testable once the
 * send body moved out of `App` into `runSend`.
 *
 * Seeds the real stores rather than mocking them: the point is to exercise the
 * same reads the browser does.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { runSend, type SendDeps } from "./send-handler.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { SendPayload } from "../components/MessageInput/MessageInput.js";

function deps(over: Partial<SendDeps> = {}): SendDeps {
  return {
    send: vi.fn().mockReturnValue(true),
    requestPermission: vi.fn(),
    disableAutoFix: vi.fn(),
    navigate: vi.fn(),
    isNewSessionRoute: false,
    ...over,
  };
}

function payload(over: Partial<SendPayload> = {}): SendPayload {
  return { text: "", uploadRefs: [], uploads: [], deferredFiles: [], ...over };
}

/** The frames a fake `send` was handed, as the objects they were. */
function framesFrom(d: SendDeps): Record<string, unknown>[] {
  return (d.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    (c) => c[0] as Record<string, unknown>,
  );
}

beforeEach(() => {
  // Reset everything a send WRITES, not just what it reads. A successful send
  // leaves an activity label, an optimistic runner mark and — on the reconnect
  // path — a stashed frame behind, and a later test inheriting those exercises a
  // different rollback than the one it names.
  useSessionStore.setState({
    sessionId: "s1",
    isLoading: false,
    messages: [],
    pendingIssueRef: undefined,
    pendingWsMessage: undefined,
    activity: undefined,
    activeRunnerSessions: new Set<string>(),
  });
  useSettingsStore.setState({ pendingFiles: [] });
  useFileStore.setState({ previewFile: null, sessionUploads: [] });
  useUiStore.setState({ toast: null });
});

describe("a refused /review dispatches nothing and says so (docs/293 req 4)", () => {
  // Each of these used to return early from `App.handleSend` while
  // `MessageInput` cleared the composer regardless, so the attachment went with
  // a message that was never sent. `resolveReviewRequest` can prove the DECISION
  // is right; only this can prove the send path acts on it.
  it("refuses with no session", () => {
    useSessionStore.setState({ sessionId: undefined });
    const d = deps();

    expect(runSend(d, payload({ text: "/review src/a.ts" }))).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
    expect(useUiStore.getState().toast?.message).toMatch(/Start a session/);
  });

  it("refuses while a turn is running", () => {
    useSessionStore.setState({ isLoading: true });
    const d = deps();

    expect(runSend(d, payload({ text: "/review src/a.ts" }))).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
    expect(useUiStore.getState().toast?.message).toMatch(/Wait for the current turn/);
  });

  it("refuses with no target file", () => {
    const d = deps();

    expect(runSend(d, payload({ text: "/review" }))).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
    expect(useUiStore.getState().toast?.message).toMatch(/needs a file/);
  });

  it("keeps the @-mentioned files a refusal did not send", () => {
    // The composer's own chips are `MessageInput`'s to keep; the `@`-mentions
    // live in the settings store and are this path's to keep.
    useSettingsStore.setState({ pendingFiles: [{ path: "src/a.ts" }] });
    const d = deps();

    expect(runSend(d, payload({ text: "/review" }))).toBe(false);
    expect(useSettingsStore.getState().pendingFiles).toEqual([{ path: "src/a.ts" }]);
  });
});

describe("an accepted /review carries its attachments and cleans up after itself", () => {
  it("puts the uploads and the @-mentioned files on the wire", () => {
    // Non-vacuous control for the refusals above, and the assertion no pure
    // helper can make: that App SPREADS the plan into the frame.
    useFileStore.setState({ previewFile: "src/a.ts" });
    useSettingsStore.setState({ pendingFiles: [{ path: "src/b.ts" }] });
    const d = deps();

    expect(
      runSend(
        d,
        payload({
          text: "/review",
          uploadRefs: [{ path: "/uploads/notes.txt", type: "upload" }],
        }),
      ),
    ).toBe(true);

    const [frame] = framesFrom(d);
    expect(frame.uploads).toEqual([{ path: "/uploads/notes.txt", type: "upload" }]);
    expect(frame.files).toEqual([{ path: "src/b.ts" }]);
    expect(frame.text).toMatch(/^Review src\/a\.ts\./);
    // Consumed by the send that carried them.
    expect(useSettingsStore.getState().pendingFiles).toEqual([]);
    expect(useFileStore.getState().previewFile).toBeNull();
  });

  it("carries the composer's per-send tick boxes (docs/218, docs/295)", () => {
    // `/review` composes its own prompt and used to build its frame from
    // scratch, so an unticked "start from the latest base" or "compact the
    // context" was silently ignored — the branch was reset and the context
    // compacted anyway, on the one send where the user had just said not to.
    useFileStore.setState({ previewFile: "src/a.ts" });
    const d = deps();

    runSend(d, payload({ text: "/review", resetMergedBranch: false, compactContext: false }));

    const [frame] = framesFrom(d);
    expect(frame.resetMergedBranch).toBe(false);
    expect(frame.compactContext).toBe(false);
  });

  it("leaves the tick boxes off the frame when the controls were not shown", () => {
    // The other half: absent means "no per-send intent", which is what makes a
    // dispatch follow the global setting. Sending `false` for a control the user
    // never saw would silently disable both actions.
    useFileStore.setState({ previewFile: "src/a.ts" });
    const d = deps();

    runSend(d, payload({ text: "/review" }));

    const [frame] = framesFrom(d);
    expect("resetMergedBranch" in frame).toBe(false);
    expect("compactContext" in frame).toBe(false);
  });

  it("graduates the URL only once the send has gone out", () => {
    // The ORDER is the point, so it is asserted from inside the dispatch: at the
    // moment the frame is handed to the socket, the route must not have moved
    // yet. Asserting only that navigation eventually happened would pass with
    // the call back above the dispatch, which is the bug this guards.
    useFileStore.setState({ previewFile: "src/a.ts" });
    let navigatedBeforeDispatch: boolean | undefined;
    const navigate = vi.fn();
    const d = deps({
      isNewSessionRoute: true,
      navigate,
      send: vi.fn(() => {
        navigatedBeforeDispatch = navigate.mock.calls.length > 0;
        return true;
      }),
    });

    expect(runSend(d, payload({ text: "/review" }))).toBe(true);
    expect(navigatedBeforeDispatch).toBe(false);
    expect(navigate).toHaveBeenCalledWith("/session/s1", { replace: true });
  });
});

describe("a /review whose frame never left the browser is a refusal too", () => {
  // `sendUserMessage` returns false when the socket will not take the frame; it
  // rolls its bubble back and toasts "try again in a moment". The user cannot do
  // that from a composer that emptied itself behind the toast — and, before the
  // review that found this, could not do it at all: the preview had been closed,
  // so the retry failed with "needs a file".
  it("reports the refusal instead of clearing", () => {
    useFileStore.setState({ previewFile: "src/a.ts" });
    const d = deps({ send: vi.fn().mockReturnValue(false) });

    expect(runSend(d, payload({ text: "/review" }))).toBe(false);
  });

  it("leaves the preview target intact, so the retry it asks for can work", () => {
    useFileStore.setState({ previewFile: "src/a.ts" });
    const d = deps({ send: vi.fn().mockReturnValue(false) });

    runSend(d, payload({ text: "/review" }));

    expect(useFileStore.getState().previewFile).toBe("src/a.ts");
  });

  it("does not graduate the URL, which would swap the composer's draft key", () => {
    useFileStore.setState({ previewFile: "src/a.ts" });
    const d = deps({ send: vi.fn().mockReturnValue(false), isNewSessionRoute: true });

    runSend(d, payload({ text: "/review" }));

    expect(d.navigate).not.toHaveBeenCalled();
  });

  it("keeps the @-mentioned files it did not send", () => {
    useFileStore.setState({ previewFile: "src/a.ts" });
    useSettingsStore.setState({ pendingFiles: [{ path: "src/b.ts" }] });
    const d = deps({ send: vi.fn().mockReturnValue(false) });

    runSend(d, payload({ text: "/review" }));

    expect(useSettingsStore.getState().pendingFiles).toEqual([{ path: "src/b.ts" }]);
  });
});

describe("an ordinary send", () => {
  it("carries the plan's attachments on the frame", () => {
    // The other half of what no pure helper can catch: `plan.frame` reaching the
    // wire on this branch too.
    useSettingsStore.setState({ pendingFiles: [{ path: "src/b.ts" }] });
    const d = deps();

    expect(
      runSend(
        d,
        payload({
          text: "look at this",
          uploadRefs: [{ path: "/uploads/notes.txt", type: "upload" }],
        }),
      ),
    ).toBe(true);

    const [frame] = framesFrom(d);
    expect(frame.text).toBe("look at this");
    expect(frame.sessionId).toBe("s1");
    expect(frame.uploads).toEqual([{ path: "/uploads/notes.txt", type: "upload" }]);
    expect(frame.files).toEqual([{ path: "src/b.ts" }]);
    expect(useSettingsStore.getState().pendingFiles).toEqual([]);
  });

  it("is accepted even when the socket refuses it, because the frame is stashed", () => {
    // The asymmetry with `/review` above, stated so it cannot drift silently:
    // this dispatch keeps the frame for reconnect and reports success, so the
    // composer is right to clear.
    const d = deps({ send: vi.fn().mockReturnValue(false) });

    expect(runSend(d, payload({ text: "hello" }))).toBe(true);
    expect(useSessionStore.getState().pendingWsMessage).toMatchObject({ text: "hello" });
  });
});

describe("/compact carries nothing and takes nothing away (docs/294 reqs 5-6)", () => {
  it("sends no attachments and leaves the @-mentioned files attached", () => {
    useSettingsStore.setState({ pendingFiles: [{ path: "src/b.ts" }] });
    const d = deps();

    // The uploads have to be PRESENT for their absence on the wire to mean
    // anything. Without them the assertion below cannot fail, including against
    // wiring that forwards the payload's uploads directly instead of the plan's.
    expect(
      runSend(
        d,
        payload({
          text: "/compact",
          uploadRefs: [{ path: "/uploads/notes.txt", type: "upload" }],
        }),
      ),
    ).toBe(true);

    const [frame] = framesFrom(d);
    expect(frame.text).toBe("/compact");
    expect(frame).not.toHaveProperty("uploads");
    expect(frame).not.toHaveProperty("files");
    // req 5 — still there for the user's next real message.
    expect(useSettingsStore.getState().pendingFiles).toEqual([{ path: "src/b.ts" }]);
  });
});

describe("an ordinary send with no session at all", () => {
  it("reports acceptance and shows the user what it carried", () => {
    // Pinning INHERITED behaviour, not endorsing it: nothing is dispatched, yet
    // this returns `true` and clears the `@`-mentions. It is not the req 4 loss
    // — the bubble names every attachment, so the user is told — but it is the
    // one acceptance in this file that is not backed by a send, and it should
    // fail loudly if someone changes it by accident.
    useSessionStore.setState({ sessionId: undefined });
    useSettingsStore.setState({ pendingFiles: [{ path: "src/b.ts" }] });
    const d = deps();

    expect(runSend(d, payload({ text: "hello" }))).toBe(true);
    expect(d.send).not.toHaveBeenCalled();
    expect(useSessionStore.getState().messages.at(-1)).toMatchObject({
      role: "user",
      text: "hello",
      files: [{ path: "src/b.ts", contentPreview: "" }],
    });
    expect(useSettingsStore.getState().pendingFiles).toEqual([]);
  });
});
