import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePreviewLinkIntent } from "./usePreviewLinkIntent.js";
import {
  usePreviewStore,
  PREVIEW_LINK_INTENT_TTL_MS,
  type ManagedServiceState,
  type PreviewLinkIntent,
} from "../stores/preview-store.js";
import { useUiStore } from "../stores/ui-store.js";

const WEB: ManagedServiceState = { name: "web", status: "stopped", port: 5173, preview: "auto" };
const API_RUNNING: ManagedServiceState = { name: "api", status: "running", port: 4000, preview: "auto" };

function intent(over: Partial<PreviewLinkIntent> = {}): PreviewLinkIntent {
  return {
    sessionId: "sess-1",
    service: "web",
    port: 5173,
    slotKey: "sess-1:5173",
    targetPath: "/runs/1",
    clickId: 1,
    startedAt: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  usePreviewStore.setState({ services: [], previewLinkIntent: null, selectedPort: null });
  useUiStore.setState({ toast: null });
});

/** Mount the hook with a `send` that reports success unless told otherwise. */
function mount(send: (data: unknown) => boolean = () => true, sessionId = "sess-1") {
  return renderHook(() => usePreviewLinkIntent(sessionId, send));
}

describe("usePreviewLinkIntent — starting a stopped service (req 12)", () => {
  it("sends start_service for a stopped target and marks the start in flight", () => {
    const send = vi.fn(() => true);
    usePreviewStore.setState({ services: [WEB], previewLinkIntent: intent() });
    mount(send);

    expect(send).toHaveBeenCalledWith({ type: "start_service", name: "web" });
  });

  it("waits during a boot instead of queueing a second start", () => {
    const send = vi.fn(() => true);
    usePreviewStore.setState({
      services: [{ ...WEB, status: "starting" }],
      previewLinkIntent: intent(),
    });
    mount(send);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends one start for two rapid clicks on the same stopped service", () => {
    // The second click replaces the intent while the boot is still in flight,
    // so the service is still `stopped` and nothing in the intent itself would
    // suppress a duplicate.
    const send = vi.fn(() => true);
    usePreviewStore.setState({ services: [WEB], previewLinkIntent: intent({ clickId: 1 }) });
    const { rerender } = mount(send);
    usePreviewStore.setState({ previewLinkIntent: intent({ clickId: 2 }) });
    rerender();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("starts a service already sitting in error, rather than refusing it (req 12)", () => {
    // `error` from some earlier attempt means "not running", which req 12 says
    // to start. Refusing would leave a link that can never work again.
    const send = vi.fn(() => true);
    usePreviewStore.setState({
      services: [{ ...WEB, status: "error" }],
      previewLinkIntent: intent(),
    });
    mount(send);
    expect(send).toHaveBeenCalledWith({ type: "start_service", name: "web" });
    expect(useUiStore.getState().toast).toBeNull();
    expect(usePreviewStore.getState().previewLinkIntent).not.toBeNull();
  });

  it("does not report a failure against its own start request", () => {
    // The status is still `stopped` in the moment after the send — the server
    // has not answered. Treating that as "did not start" would toast every time.
    const send = vi.fn(() => true);
    usePreviewStore.setState({ services: [WEB], previewLinkIntent: intent() });
    const { rerender } = mount(send);
    rerender();
    expect(useUiStore.getState().toast).toBeNull();
    expect(usePreviewStore.getState().previewLinkIntent).not.toBeNull();
  });

  it("reports a refused send — the socket was closed", () => {
    usePreviewStore.setState({ services: [WEB], previewLinkIntent: intent() });
    mount(() => false);

    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
    expect(useUiStore.getState().toast?.message).toContain("isn't connected");
  });

  it("reports a service that reaches error after our own start", () => {
    usePreviewStore.setState({ services: [WEB], previewLinkIntent: intent() });
    const { rerender } = mount();

    usePreviewStore.setState({ services: [{ ...WEB, status: "starting" }] });
    rerender();
    usePreviewStore.setState({ services: [{ ...WEB, status: "error" }] });
    rerender();

    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
    expect(useUiStore.getState().toast?.message).toContain('"web"');
  });
});

describe("usePreviewLinkIntent — selecting the intent's own port", () => {
  it("selects the target's port when it reaches running, not whatever else is up", () => {
    // The multi-service case: A is already running and the pointer targets
    // stopped B. `preview_status` carries only running ports and clears
    // `selectedPort`, so without an explicit reselect the panel stays on A
    // unless Compose ordering happens to put B first.
    usePreviewStore.setState({
      services: [API_RUNNING, WEB],
      previewLinkIntent: intent(),
      selectedPort: 4000,
    });
    const { rerender } = mount();
    expect(usePreviewStore.getState().selectedPort).toBe(4000);

    usePreviewStore.setState({ services: [API_RUNNING, { ...WEB, status: "running" }] });
    rerender();

    expect(usePreviewStore.getState().selectedPort).toBe(5173);
  });

  it("leaves the intent in place for PreviewFrame to navigate", () => {
    usePreviewStore.setState({
      services: [{ ...WEB, status: "running" }],
      previewLinkIntent: intent(),
    });
    mount();
    expect(usePreviewStore.getState().previewLinkIntent?.targetPath).toBe("/runs/1");
  });
});

describe("usePreviewLinkIntent — cancellation", () => {
  it("drops an intent belonging to another session", () => {
    // `service_list` / `service_status` handlers ignore their own `sessionId`,
    // so the intent has to check the session itself.
    usePreviewStore.setState({ services: [WEB], previewLinkIntent: intent() });
    mount(() => true, "sess-2");
    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("drops a stale intent silently, so it cannot fire much later", () => {
    const send = vi.fn(() => true);
    usePreviewStore.setState({
      services: [WEB],
      previewLinkIntent: intent({ startedAt: Date.now() - PREVIEW_LINK_INTENT_TTL_MS - 1 }),
    });
    mount(send);

    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
    expect(send).not.toHaveBeenCalled();
    // Not a failure — expiry is cleanup, and req 10 is best effort.
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("reports a service that disappeared from the compose file after the click", () => {
    usePreviewStore.setState({ services: [API_RUNNING], previewLinkIntent: intent() });
    mount();
    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
    expect(useUiStore.getState().toast?.message).toContain('"web"');
  });
});
