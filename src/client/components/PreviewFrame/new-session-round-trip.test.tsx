import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRef } from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { BrowserRouter, Routes, Route, useLocation, useNavigate, useParams } from "react-router-dom";
import { PreviewFrame } from "./PreviewFrame.js";
import { ContentPanels, homeScreenShown } from "../ContentPanels.js";
import { useSessionActivation } from "../../hooks/useSessionActivation.js";
import { handleSessionResume } from "../../stores/actions/session-actions.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useRepoStore } from "../../stores/repo-store.js";
import { deriveEffectivePreviewStatus } from "../../utils/preview-status.js";
import { parseNewSessionSlug } from "../../utils/repo-label.js";
import { handleServiceList } from "../../hooks/message-handlers/service-list.js";
import { handlePreviewStatus } from "../../hooks/message-handlers/preview-status.js";

// A desktop App reduced to what decides whether the preview pane stays mounted:
// the real router, route→store sync, home-screen rule, layout and iframe pool.

const REPO = "https://github.com/acme/app";
const noop = () => {};

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function Shell() {
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const newSessionRepoSlug = parseNewSessionSlug(pathname);
  const isNewSessionRoute = newSessionRepoSlug !== undefined;
  const sessionId = useSessionStore((s) => s.sessionId);
  const status = usePreviewStore((s) => s.status);
  const services = usePreviewStore((s) => s.services);
  const selectedPort = usePreviewStore((s) => s.selectedPort);
  const { handleNewSessionForRepo } = useSessionActivation({
    urlSessionId,
    sessionId,
    isNewSessionRoute,
    newSessionRepoSlug,
    newSessionRepoUrl: isNewSessionRoute ? REPO : undefined,
    bootstrapLoaded: true,
    reposLength: 1,
    disableAutoFix: noop,
    navigate,
  });
  const showNewSessionView = isNewSessionRoute && !urlSessionId;
  const showHomeScreen = homeScreenShown({
    showNewSessionView,
    urlSessionId,
    sessionId,
    templatesForEmptySession: false,
  });
  const preview = deriveEffectivePreviewStatus(status, services, sessionId);

  return (
    <ContentPanels
      isMobile={false}
      showHomeScreen={showHomeScreen}
      showNewSessionView={showNewSessionView}
      activePanel="chat"
      chatPanel={
        <>
          <button onClick={() => void handleNewSessionForRepo(REPO)}>New session</button>
          <button onClick={() => handleSessionResume("A", navigate)}>Session A</button>
        </>
      }
      rightPanel={
        <PreviewFrame
          preview={preview}
          sessionId={sessionId}
          detectedPorts={preview?.detectedPorts ?? []}
          selectedPort={selectedPort}
          onSelectPort={noop}
          errors={[]}
          onSendErrors={noop}
          onClearErrors={noop}
        />
      }
      fraction={0.5}
      isDragging={false}
      onMouseDown={noop}
      onTouchStart={noop}
      containerRef={createRef()}
    />
  );
}

const ctx = {} as Parameters<typeof handleServiceList>[0];

async function serverAttach(sessionId: string) {
  await act(async () => {
    handleServiceList(ctx, {
      type: "service_list",
      sessionId,
      services: [{ name: "web", status: "running", port: 3000, preview: "auto" }],
    });
    handlePreviewStatus(ctx, {
      type: "preview_status",
      sessionId,
      running: true,
      port: 3000,
      url: `/preview/${sessionId}/3000/`,
      source: "detected",
      detectedPorts: [3000],
    });
  });
}

async function click(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
}

async function openSessionA() {
  window.history.replaceState(null, "", "/");
  render(
    <BrowserRouter>
      <Routes>
        <Route path="/session/:sessionId" element={<Shell />} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </BrowserRouter>,
  );
  await click("Session A");
  await serverAttach("A");
  const iframe = await screen.findByTitle("Live Preview");
  const deepUrl = "http://A--3000.localhost:3000/deep";
  iframe.setAttribute("src", deepUrl);
  return { iframe, deepUrl };
}

describe("a new-session page between two visits to a session", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    useSessionStore.getState().setSessionId(undefined);
    usePreviewStore.getState().reset();
    usePreviewStore.getState().clearPreviewPaths();
    usePreviewStore.getState().clearPreviewTargetMemory();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the session's preview iframe through the sidebar round trip", async () => {
    useRepoStore.setState({ claimSession: () => Promise.resolve({ sessionId: "W", sessionDir: "/w" }) });
    const { iframe, deepUrl } = await openSessionA();

    await click("New session");
    expect(useSessionStore.getState().sessionId).toBe("W");
    await serverAttach("W");
    await click("Session A");
    await serverAttach("A");

    expect(screen.getByTitle("Live Preview")).toBe(iframe);
    expect(iframe.getAttribute("src")).toBe(deepUrl);
  });

  it("keeps it when Back leaves the new-session page before its claim lands", async () => {
    useRepoStore.setState({ claimSession: () => new Promise(() => {}) });
    const { iframe, deepUrl } = await openSessionA();

    await click("New session");
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(window.location.pathname).toBe("/session/A");
    await serverAttach("A");

    expect(screen.getByTitle("Live Preview")).toBe(iframe);
    expect(iframe.getAttribute("src")).toBe(deepUrl);
  });
});
