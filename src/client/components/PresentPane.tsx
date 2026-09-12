

// eslint-disable-next-line no-restricted-imports -- useEffect: unseen badge, keyboard nav, lazy content fetch, view-mode reset, draft cleanup
import { useEffect, useRef, useState } from "react";
import { useEventListener } from "../hooks/useEventListener.js";
import {
  CaretLeftIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePresentStore, type Presentation } from "../stores/present-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { slugifyHeading } from "../utils/shipit-link.js";
import { PresentGallery } from "./PresentGallery.js";
import { useSessionStore } from "../stores/session-store.js";
import { FileContentView } from "./FileContentView/FileContentView.js";
import { FileReviewFooter } from "./FileContentView/FileReviewFooter.js";
import { FileReviewSendDialog } from "./SendReviewDialog.js";
import { SourceToggle, type ViewMode } from "./FileContentView/SourceToggle.js";
import { useFileReviewControls } from "../hooks/use-file-review-controls.js";
import { kindFromMimeType, supportsSourceToggle } from "../utils/file-content-kind.js";
import { Button } from "./ui/button.js";
import type { SendCommentsPayload } from "./FilePreviewModal.js";
import { handleAgentInterfaceRequest } from "../agent-interface-sdk/handle-request.js";
import type { AgentInterfaceProvenance } from "../../server/shared/agent-interface-sdk/protocol.js";

interface PresentPaneProps {

  isActiveTab: boolean;

  onSendComments?: (payload: SendCommentsPayload) => void;

  onAskAgentReview?: (filePath: string) => void;
  onAgentInterfaceMessage?: (text: string, provenance: AgentInterfaceProvenance) => Promise<void>;
}

export function PresentPane({ isActiveTab, onSendComments, onAskAgentReview, onAgentInterfaceMessage }: PresentPaneProps) {
  const presentations = usePresentStore((s) => s.presentations);
  const activeIndex = usePresentStore((s) => s.activePresentIndex);
  const galleryOpen = usePresentStore((s) => s.galleryOpen);
  const sessionId = useSessionStore((s) => s.sessionId);
  const setActiveIndex = usePresentStore((s) => s.setActiveIndex);
  const setGalleryOpen = usePresentStore((s) => s.setGalleryOpen);
  const markSeen = usePresentStore((s) => s.markSeen);

  // and never deliver it.
  const [fetchError, setFetchError] = useState<{ presentId: string; message: string } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");

  const fetching = useRef<Set<string>>(new Set());
  const agentInterfaceFrameRef = useRef<HTMLIFrameElement | null>(null);

  const linkTarget = usePresentStore((s) => s.linkTarget);

  const contentRef = useRef<HTMLDivElement | null>(null);

  const handledClickRef = useRef<number | null>(null);

  const hasEntries = presentations.length > 0;
  const safeIndex = hasEntries ? Math.max(0, Math.min(activeIndex, presentations.length - 1)) : -1;
  const active = hasEntries ? presentations[safeIndex] : undefined;
  const activePresentId = active?.presentId;
  const activeContent = active?.content;

  const activeError = fetchError && fetchError.presentId === activePresentId ? fetchError.message : null;

  const kind = kindFromMimeType(active?.mimeType ?? "", active?.filePath ?? "");
  const agentInterfaceActive = isActiveTab && !galleryOpen && kind === "html" && viewMode === "rendered";

  useEventListener(window, "message", (event) => {
    const iframe = agentInterfaceFrameRef.current;
    if (!iframe?.contentWindow || event.source !== iframe.contentWindow || event.origin !== "null") return;
    const data = event.data as { source?: string; type?: string } | undefined;
    if (data?.source !== "shipit-preview") return;
    if (data.type === "ready") {
      iframe.contentWindow?.postMessage({
        source: "shipit-preview",
        type: "visibility",
        visible: agentInterfaceActive,
      }, "*");
      return;
    }
    if (data.type === "agent_message" && agentInterfaceActive && onAgentInterfaceMessage) {
      void handleAgentInterfaceRequest({
        event,
        iframe,
        expectedOrigin: "null",
        surface: "present",
        dispatch: onAgentInterfaceMessage,
      });
    }
  });

  // eslint-disable-next-line no-restricted-syntax -- synchronize Present visibility into the sandboxed artifact
  useEffect(() => {
    agentInterfaceFrameRef.current?.contentWindow?.postMessage({
      source: "shipit-preview",
      type: "visibility",
      visible: agentInterfaceActive,
    }, "*");
  }, [agentInterfaceActive, activePresentId]);

  const review = useFileReviewControls({
    filePath: active?.filePath ?? "",
    kind,
    content: activeContent ?? null,
    onSendComments,
    onAskAgentReview,
  });

  // eslint-disable-next-line no-restricted-syntax -- intentional unseen-clear on tab focus
  useEffect(() => {
    if (isActiveTab) markSeen();
  }, [isActiveTab, markSeen, activeIndex]);

  // eslint-disable-next-line no-restricted-syntax -- reset toggle on carousel navigation
  useEffect(() => { setViewMode("rendered"); }, [activePresentId]);

  const linkTargetIsActive = !!linkTarget && linkTarget.presentId === activePresentId;
  // eslint-disable-next-line no-restricted-syntax -- an agent-authored pointer overrides the local view mode
  useEffect(() => {
    if (linkTargetIsActive) setViewMode("rendered");
  }, [linkTargetIsActive, linkTarget?.clickId]);

  // eslint-disable-next-line no-restricted-syntax -- scrolls the pane's own DOM once the content is on screen
  useEffect(() => {
    if (!linkTarget || !linkTargetIsActive) return;
    if (handledClickRef.current === linkTarget.clickId) return;

    // this tab later cannot replay it. `handledClickRef` alone is not enough:

    const done = (keepTarget = false) => {
      handledClickRef.current = linkTarget.clickId;
      if (!keepTarget) usePresentStore.getState().clearLinkTarget(linkTarget.clickId);
    };

    if (activeError) {
      done();
      useUiStore.getState().setToast({
        message: `Could not open ${active?.filePath ?? "that artifact"} — ${activeError}`,
        variant: "error",
      });
      return;
    }
    if (activeContent === undefined) return;

    if (linkTarget.fragment === undefined) {
      done();
      return;
    }

    if (kind !== "markdown") {
      done(kind === "html");
      return;
    }
    done();

    const root = contentRef.current;
    const wanted = slugifyHeading(linkTarget.fragment);
    const headings = root ? [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")] : [];

    const match = headings.find((h) => slugifyHeading(h.textContent ?? "") === wanted);
    if (!match) {
      useUiStore.getState().setToast({
        message: `No heading "${linkTarget.fragment}" in ${active?.filePath ?? "that artifact"}.`,
        variant: "error",
      });
      return;
    }
    match.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [linkTarget, linkTargetIsActive, activeContent, activeError, kind, active?.filePath]);

  // store re-checks emptiness, so a stale closure can never drop a real draft.

  // closure can never drop a real draft.
  const discardOutgoing = review.discardEmptyDraftNow;
  // eslint-disable-next-line no-restricted-syntax -- best-effort draft cleanup on nav/blur/unmount; deps intentionally exclude discardOutgoing
  useEffect(() => {
    if (!isActiveTab) return;
    return () => { discardOutgoing(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `discardOutgoing` is captured at effect-setup on purpose so the cleanup targets the OUTGOING file (see above)
  }, [activePresentId, isActiveTab]);

  useEventListener(isActiveTab ? window : null, "keydown", (e) => {

    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
      return;
    }
    if (e.key === "Escape") {
      if (usePresentStore.getState().galleryOpen) usePresentStore.getState().setGalleryOpen(false);
      return;
    }

    if (usePresentStore.getState().galleryOpen) return;
    if (e.key === "ArrowLeft") {
      const { activePresentIndex } = usePresentStore.getState();
      usePresentStore.getState().setActiveIndex(activePresentIndex - 1);
    } else if (e.key === "ArrowRight") {
      const { activePresentIndex } = usePresentStore.getState();
      usePresentStore.getState().setActiveIndex(activePresentIndex + 1);
    }
  });

  // eslint-disable-next-line no-restricted-syntax -- lazy content fetch keyed on the active entry
  useEffect(() => {
    setFetchError(null);
    if (!activePresentId || activeContent !== undefined || !sessionId) return;
    if (fetching.current.has(activePresentId)) return;
    const id = activePresentId;
    fetching.current.add(id);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/present/${id}/content`);
        const body = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
        if (!res.ok || typeof body.content !== "string") {
          throw new Error(body.error ?? `Could not load presentation (HTTP ${res.status})`);
        }
        if (!cancelled) usePresentStore.getState().setContent(id, body.content);
      } catch (err) {
        if (!cancelled) setFetchError({ presentId: id, message: err instanceof Error ? err.message : String(err) });
      } finally {
        fetching.current.delete(id);
      }
    })();
    return () => { cancelled = true; };
  }, [activePresentId, activeContent, sessionId]);

  if (!active) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-sm text-(--color-text-tertiary) p-6 text-center">
        <p className="max-w-xs">
          Nothing to present yet. When the agent shows you a chart, diagram, or
          mockup, it will appear here.
        </p>
      </div>
    );
  }

  const onPrev = () => setActiveIndex(safeIndex - 1);
  const onNext = () => setActiveIndex(safeIndex + 1);

  const showToggle = supportsSourceToggle(kind) && active.content !== undefined;
  const showFooter =
    review.reviewable
    && active.content !== undefined
    && (review.commentCount > 0 || review.history.length > 0);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-(--color-border-primary) bg-(--color-bg-secondary) shrink-0">
        {presentations.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onPrev}
              disabled={safeIndex === 0}
              className="inline-flex items-center justify-center w-7 h-7 rounded transition-colors text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Previous presentation"
            >
              <CaretLeftIcon size={ICON_SIZE.SM} />
            </button>
            <span className="text-xs text-(--color-text-tertiary) tabular-nums">
              {safeIndex + 1}/{presentations.length}
            </span>
            <button
              onClick={onNext}
              disabled={safeIndex >= presentations.length - 1}
              className="inline-flex items-center justify-center w-7 h-7 rounded transition-colors text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Next presentation"
            >
              <CaretRightIcon size={ICON_SIZE.SM} />
            </button>
            {/* Gallery toggle sits beside the carousel — where the eye already
                is when navigating — rather than off in the right-side actions. */}
            <span className="mx-1 h-5 w-px bg-(--color-border-primary)" aria-hidden />
            <button
              onClick={() => setGalleryOpen(!galleryOpen)}
              className={`inline-flex items-center justify-center w-7 h-7 rounded transition-colors hover:bg-(--color-bg-hover) ${
                galleryOpen
                  ? "text-(--color-accent) bg-(--color-bg-hover)"
                  : "text-(--color-text-secondary) hover:text-(--color-text-primary)"
              }`}
              aria-label={galleryOpen ? "Close gallery" : "View all presentations"}
              aria-pressed={galleryOpen}
            >
              <SquaresFourIcon size={ICON_SIZE.SM} />
            </button>
          </div>
        )}
        <div className="flex flex-col min-w-0 flex-1">
          <div className="text-sm font-medium text-(--color-text-primary) truncate">
            {active.title ?? basename(active.filePath)}
          </div>
          <div
            className="text-xs text-(--color-text-tertiary) font-mono truncate"
            title={active.filePath}
          >
            {active.filePath}
          </div>
        </div>
        {showToggle && <SourceToggle value={viewMode} onChange={setViewMode} />}
        <Button
          variant="ghost"
          size="md"
          onClick={() => downloadPresentation(active)}
          disabled={active.content === undefined}
          className="shrink-0"
          aria-label="Download presentation"
        >
          <DownloadSimpleIcon size={ICON_SIZE.XS} />
          Download
        </Button>
      </div>

      <div className="flex-1 min-h-0 relative bg-(--color-bg-primary)">
        {galleryOpen && presentations.length > 1 ? (
          <PresentGallery
            presentations={presentations}
            activeIndex={safeIndex}
            sessionId={sessionId ?? ""}
            onSelect={(i) => {
              setActiveIndex(i);
              setGalleryOpen(false);
            }}
          />
        ) : (

          <div ref={contentRef} className="absolute inset-0 animate-in fade-in duration-200">
            {activeError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-sm text-(--color-text-tertiary) p-6 text-center">
                <p className="max-w-xs">{activeError}</p>
                <p className="max-w-xs text-xs">
                  The artifact may no longer be on disk. Ask the agent to present it again.
                </p>
              </div>
            ) : active.content === undefined ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-(--color-text-tertiary)">
                Loading…
              </div>
            ) : (
              <FileContentView
                key={active.presentId}
                filePath={active.filePath}
                content={active.content}
                kind={kind}
                sessionId={sessionId ?? ""}
                viewMode={viewMode}
                reviewable={review.reviewable}
                markdownComments={review.markdownComments}
                codeComments={review.codeComments}
                agentInterfaceFrameRef={kind === "html" ? agentInterfaceFrameRef : undefined}
                scrollTo={
                  linkTargetIsActive && kind === "html" ? linkTarget?.fragment : undefined
                }
              />
            )}
          </div>
        )}
      </div>

      {showFooter && (
        <FileReviewFooter
          commentCount={review.commentCount}
          history={review.history}
          canSend={review.canSend}
          composing={review.composing}
          onSend={review.handleSend}
          sendDialog={
            <FileReviewSendDialog controls={review} filePath={active?.filePath ?? ""} />
          }
        />
      )}
    </div>
  );
}

function downloadPresentation(p: Presentation): void {
  if (p.content === undefined) return;                                   
  const blob = presentationToBlob(p.content, p.mimeType);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestDownloadName(p.title, p.mimeType);
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function presentationToBlob(content: string, mimeType: string): Blob {
  if (content.startsWith("data:")) {
    return dataUriToBlob(content);
  }
  return new Blob([content], { type: mimeType || "text/plain" });
}

function dataUriToBlob(dataUri: string): Blob {
  const comma = dataUri.indexOf(",");

  if (comma < 0) return new Blob([dataUri], { type: "text/plain" });
  const meta = dataUri.slice("data:".length, comma);                           
  const data = dataUri.slice(comma + 1);
  const mime = meta.split(";")[0] || "application/octet-stream";
  if (/;base64/i.test(meta)) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(data)], { type: mime });
}

export function suggestDownloadName(title: string | undefined, mimeType: string): string {
  const ext = mimeTypeToExtension(mimeType);
  const base = title
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : "presentation";
  return `${base || "presentation"}.${ext}`;
}

function basename(filePath: string): string {
  const segment = filePath.replace(/\/+$/, "").split("/").pop();
  return segment && segment.length > 0 ? segment : filePath;
}

export function mimeTypeToExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  switch (lower) {
    case "text/html":
      return "html";
    case "image/svg+xml":
      return "svg";
    case "text/markdown":
      return "md";
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    default:
      return "txt";
  }
}
