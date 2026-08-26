import { describe, it, expect, beforeEach } from "vitest";
import { openShipitLink } from "./open-shipit-link.js";
import { parseShipitLink, type ShipitLink } from "./shipit-link.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { usePresentStore } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { ManagedServiceState } from "../stores/preview-store.js";

/** Parse an href the way the renderer does, failing loudly if it isn't a pointer. */
function link(href: string): ShipitLink {
  const parsed = parseShipitLink(href);
  if (!parsed) throw new Error(`not a ShipIt link: ${href}`);
  return parsed;
}

const WEB_RUNNING: ManagedServiceState = { name: "web", status: "running", port: 5173, preview: "auto" };
const WEB_STOPPED: ManagedServiceState = { ...WEB_RUNNING, status: "stopped" };

function toast(): string | undefined {
  return useUiStore.getState().toast?.message;
}

beforeEach(() => {
  useSessionStore.setState({ sessionId: "sess-1" });
  usePreviewStore.setState({ services: [], previewLinkIntent: null, selectedPort: null });
  usePresentStore.getState().reset();
  useUiStore.setState({ toast: null, rightTab: "files", mobilePanel: "chat" });
});

describe("openShipitLink — preview (req 2, req 8)", () => {
  it("records the destination and selects the port of a running service", () => {
    usePreviewStore.setState({ services: [WEB_RUNNING] });
    openShipitLink(link("shipit-preview://web/runs/1?highlight=4#step-4"));

    const intent = usePreviewStore.getState().previewLinkIntent;
    expect(intent).toMatchObject({
      sessionId: "sess-1",
      service: "web",
      port: 5173,
      slotKey: "sess-1:5173",
      targetPath: "/runs/1?highlight=4#step-4",
    });
    expect(usePreviewStore.getState().selectedPort).toBe(5173);
    expect(toast()).toBeUndefined();
  });

  it("reveals the Preview tab, on desktop and on mobile", () => {
    usePreviewStore.setState({ services: [WEB_RUNNING] });
    openShipitLink(link("shipit-preview://web/x"));
    expect(useUiStore.getState().rightTab).toBe("preview");
    // On a phone the workspace is a separate column from the chat.
    expect(useUiStore.getState().mobilePanel).toBe("preview");
  });

  it("leaves a stopped service's port unselected until it is running (req 12)", () => {
    // `selectedPort` is derived from the session's remembered target and holds
    // a port only while its service is running (planning#478), so selecting up
    // front would be undone. The intent reselects when the service reports
    // `running`.
    usePreviewStore.setState({ services: [WEB_STOPPED] });
    openShipitLink(link("shipit-preview://web/x"));

    expect(usePreviewStore.getState().previewLinkIntent?.service).toBe("web");
    expect(usePreviewStore.getState().selectedPort).toBeNull();
    // Still revealed — that is how the user watches it boot.
    expect(useUiStore.getState().rightTab).toBe("preview");
  });

  it("names the service when the project declares none by that name", () => {
    usePreviewStore.setState({ services: [WEB_RUNNING] });
    openShipitLink(link("shipit-preview://api/x"));
    expect(toast()).toContain('"api"');
    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
  });

  it("matches the service name exactly, never by prefix", () => {
    usePreviewStore.setState({ services: [{ ...WEB_RUNNING, name: "web-admin" }] });
    openShipitLink(link("shipit-preview://web/x"));
    expect(usePreviewStore.getState().previewLinkIntent).toBeNull();
    expect(toast()).toContain('"web"');
  });

  it("names the service when it declares no port to preview", () => {
    usePreviewStore.setState({ services: [{ name: "db", status: "running", preview: "manual" }] });
    openShipitLink(link("shipit-preview://db/x"));
    expect(toast()).toContain('"db"');
  });

  it("does not touch the panel when the destination cannot be resolved", () => {
    usePreviewStore.setState({ services: [] });
    openShipitLink(link("shipit-preview://web/x"));
    // Resolve first, then reveal: a failure must not replace what the user was
    // looking at and *then* apologise.
    expect(useUiStore.getState().rightTab).toBe("files");
  });

  it("last click wins — an unfinished earlier intent is dropped, not queued", () => {
    usePreviewStore.setState({
      services: [WEB_RUNNING, { name: "api", status: "running", port: 4000, preview: "auto" }],
    });
    openShipitLink(link("shipit-preview://web/first"));
    const first = usePreviewStore.getState().previewLinkIntent;
    openShipitLink(link("shipit-preview://api/second"));
    const second = usePreviewStore.getState().previewLinkIntent;

    expect(second?.targetPath).toBe("/second");
    expect(second?.clickId).toBeGreaterThan(first?.clickId ?? 0);
  });
});

describe("openShipitLink — present (req 3, req 9)", () => {
  const artifact = {
    presentId: "p1",
    mimeType: "text/html",
    filePath: "/persist/reqs.html",
    createdAt: "2026-08-09T00:00:00Z",
  };

  it("focuses the artifact and records the addressed place", () => {
    usePresentStore.getState().addOrReplace(artifact);
    usePresentStore.getState().addOrReplace({ ...artifact, presentId: "p2", filePath: "/persist/other.md" });

    openShipitLink(link("shipit-present:/persist/reqs.html#req-7"));

    expect(useUiStore.getState().rightTab).toBe("present");
    expect(usePresentStore.getState().activePresentIndex).toBe(0);
    expect(usePresentStore.getState().linkTarget).toMatchObject({
      presentId: "p1",
      fragment: "req-7",
    });
  });

  it("closes the gallery, where no artifact is rendered at all", () => {
    usePresentStore.getState().addOrReplace(artifact);
    usePresentStore.getState().setGalleryOpen(true);
    openShipitLink(link("shipit-present:/persist/reqs.html#req-7"));
    expect(usePresentStore.getState().galleryOpen).toBe(false);
  });

  it("addresses the artifact as a whole when there is no fragment (req 5)", () => {
    usePresentStore.getState().addOrReplace(artifact);
    openShipitLink(link("shipit-present:/persist/reqs.html"));
    expect(usePresentStore.getState().linkTarget?.fragment).toBeUndefined();
  });

  it("re-clicking the same pointer is a new click, not a coalesced one", () => {
    usePresentStore.getState().addOrReplace(artifact);
    openShipitLink(link("shipit-present:/persist/reqs.html#req-7"));
    const first = usePresentStore.getState().linkTarget?.clickId;
    openShipitLink(link("shipit-present:/persist/reqs.html#req-7"));
    expect(usePresentStore.getState().linkTarget?.clickId).toBeGreaterThan(first ?? 0);
  });

  it("names the path when nothing has been presented from it", () => {
    openShipitLink(link("shipit-present:/persist/missing.html#x"));
    expect(toast()).toContain("/persist/missing.html");
    expect(useUiStore.getState().rightTab).toBe("files");
  });

  it("matches ./-prefixed and bare paths as the same artifact", () => {
    usePresentStore.getState().addOrReplace({ ...artifact, filePath: "./docs/plan.md" });
    openShipitLink(link("shipit-present:docs/plan.md"));
    expect(usePresentStore.getState().linkTarget?.presentId).toBe("p1");
  });
});

describe("openShipitLink — malformed", () => {
  it("explains itself rather than doing nothing (req 10)", () => {
    openShipitLink(link("shipit-preview://web/x?shipit-render=card"));
    expect(useUiStore.getState().toast?.variant).toBe("error");
    expect(toast()).toContain("shipit-render");
  });
});
