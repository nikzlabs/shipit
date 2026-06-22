/**
 * PresentPane — Present tab in the right panel (docs/093).
 *
 * Renders agent-emitted artifacts (HTML, SVG, markdown, images) from the
 * `present` MCP tool. Single visible entry at a time, with a `◀ N/M ▶`
 * carousel header when there's more than one. The store holds only metadata;
 * the bytes are fetched lazily from the authenticated session API
 * (`GET /api/sessions/:id/present/:presentId/content`, a one-time disk read
 * proxied to the worker) and cached back onto the entry, so nothing large is
 * retained server-side and a reload re-fetches. "Download" is the escape hatch
 * — a purely client-side `Blob` + `<a download>` that pulls the artifact onto
 * the user's local machine (a destination ShipIt can't reach since the
 * workspace lives inside a container). To keep an artifact in the repo, ask the
 * agent to write it there.
 *
 * Content rendering + review are shared with the file-viewer dialog via
 * `FileContentView` + `useFileReviewControls` (docs/219): HTML/SVG render in a
 * sandboxed iframe (toggle to source), markdown gets frontmatter stripping +
 * selection comments, and review works on workspace-relative artifacts.
 * Non-workspace artifacts (e.g. `/persist` throwaways) render read-only — the
 * file-review API resolves against `/workspace` and can't address them.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: unseen badge, keyboard nav, lazy content fetch, view-mode reset, draft cleanup
import { useEffect, useRef, useState } from "react";
import {
  CaretLeftIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePresentStore, type Presentation } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { FileContentView } from "./FileContentView/FileContentView.js";
import { FileReviewFooter } from "./FileContentView/FileReviewFooter.js";
import { SourceToggle, type ViewMode } from "./FileContentView/SourceToggle.js";
import { useFileReviewControls } from "../hooks/use-file-review-controls.js";
import { kindFromMimeType, supportsSourceToggle } from "../utils/file-content-kind.js";
import { Button } from "./ui/button.js";
import type { SendCommentsPayload } from "./FilePreviewModal.js";

interface PresentPaneProps {
  /** When true the pane is currently visible to the user — clears the unseen badge. */
  isActiveTab: boolean;
  /** Submit review comments on a workspace-relative artifact (App dispatches the prompt). */
  onSendComments?: (payload: SendCommentsPayload) => void;
  /** docs/203 — "Ask agent to review" on a workspace-relative artifact. */
  onAskAgentReview?: (filePath: string) => void;
}

export function PresentPane({ isActiveTab, onSendComments, onAskAgentReview }: PresentPaneProps) {
  const presentations = usePresentStore((s) => s.presentations);
  const activeIndex = usePresentStore((s) => s.activePresentIndex);
  const sessionId = useSessionStore((s) => s.sessionId);
  const setActiveIndex = usePresentStore((s) => s.setActiveIndex);
  const markSeen = usePresentStore((s) => s.markSeen);

  const [fetchError, setFetchError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");
  // Ids with an in-flight content fetch, so a re-render doesn't double-fetch.
  const fetching = useRef<Set<string>>(new Set());

  // Active entry (computed before any early return so the hooks below see it).
  const hasEntries = presentations.length > 0;
  const safeIndex = hasEntries ? Math.max(0, Math.min(activeIndex, presentations.length - 1)) : -1;
  const active = hasEntries ? presentations[safeIndex] : undefined;
  const activePresentId = active?.presentId;
  const activeContent = active?.content;

  const kind = kindFromMimeType(active?.mimeType ?? "", active?.filePath ?? "");

  // Review controls — called UNCONDITIONALLY before the empty-state early return
  // (hook-order stability), passing the active artifact's path or "" when none.
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

  // Reset the source/rendered toggle when the visible artifact changes.
  // eslint-disable-next-line no-restricted-syntax -- reset toggle on carousel navigation
  useEffect(() => { setViewMode("rendered"); }, [activePresentId]);

  // Discard the outgoing artifact's empty draft on carousel nav / tab blur /
  // unmount — the Present analogue of the modal's close. `discardEmptyDraftNow`
  // is captured at effect-setup so the cleanup targets the OUTGOING file; the
  // store re-checks emptiness, so a stale closure can never drop a real draft.
  // `discardEmptyDraftNow` is captured at effect-setup (not in the dep array) so
  // the cleanup targets the OUTGOING file; re-keying only on id/tab change avoids
  // re-running on every draft mutation. The store re-checks emptiness, so a stale
  // closure can never drop a real draft.
  const discardOutgoing = review.discardEmptyDraftNow;
  // eslint-disable-next-line no-restricted-syntax -- best-effort draft cleanup on nav/blur/unmount; deps intentionally exclude discardOutgoing
  useEffect(() => {
    if (!isActiveTab) return;
    return () => { discardOutgoing(); };
  }, [activePresentId, isActiveTab]);

  // Keyboard nav scoped to this pane — read latest index via the store rather
  // than depending on `safeIndex` so the listener doesn't re-install on every
  // navigation. Declared before the empty-state early return so the hook order
  // stays stable when `presentations` empties on session switch (React #300).
  // eslint-disable-next-line no-restricted-syntax -- keyboard nav scoped to this pane
  useEffect(() => {
    if (!isActiveTab) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        const { activePresentIndex } = usePresentStore.getState();
        usePresentStore.getState().setActiveIndex(activePresentIndex - 1);
      } else if (e.key === "ArrowRight") {
        const { activePresentIndex } = usePresentStore.getState();
        usePresentStore.getState().setActiveIndex(activePresentIndex + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActiveTab]);

  // Lazily fetch the active artifact's bytes from disk the first time it's
  // shown (and again after a reload, when the store holds metadata only). The
  // server retains nothing; this one-time fetch is how the browser gets a copy.
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
        if (!cancelled) setFetchError(err instanceof Error ? err.message : String(err));
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
        {fetchError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-sm text-(--color-text-tertiary) p-6 text-center">
            <p className="max-w-xs">{fetchError}</p>
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
          />
        )}
      </div>

      {showFooter && (
        <FileReviewFooter
          commentCount={review.commentCount}
          history={review.history}
          canSend={review.canSend}
          onSend={review.handleSend}
        />
      )}
    </div>
  );
}

/**
 * Trigger a client-side download of the active presentation. By the time the
 * Download button is enabled the bytes have been fetched and cached on the
 * entry, so this is a pure `Blob` + temporary `<a download>` — no further
 * round-trip. The destination is the user's local machine, not the workspace;
 * to keep an artifact in the repo, ask the agent to write it there.
 */
function downloadPresentation(p: Presentation): void {
  if (p.content === undefined) return; // button is disabled until loaded
  const blob = presentationToBlob(p.content, p.mimeType);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestDownloadName(p.title, p.mimeType);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revocation so the browser has committed the download; revoking
  // synchronously can cancel it in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Build a Blob for download from raw presentation content. Image artifacts
 * arrive as `data:` URIs (base64 or URL-encoded) and are decoded back to their
 * binary bytes; text artifacts (HTML/SVG/markdown) become a typed text Blob.
 */
export function presentationToBlob(content: string, mimeType: string): Blob {
  if (content.startsWith("data:")) {
    return dataUriToBlob(content);
  }
  return new Blob([content], { type: mimeType || "text/plain" });
}

/** Decode a `data:` URI into a Blob, handling both base64 and URL-encoded payloads. */
function dataUriToBlob(dataUri: string): Blob {
  const comma = dataUri.indexOf(",");
  // Malformed (no comma) — fall back to an opaque text blob rather than throw.
  if (comma < 0) return new Blob([dataUri], { type: "text/plain" });
  const meta = dataUri.slice("data:".length, comma); // e.g. "image/png;base64"
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

/**
 * Bare `<basename>.<ext>` for a local download — no directory prefix, since
 * the browser's download UI decides where the file lands.
 */
export function suggestDownloadName(title: string | undefined, mimeType: string): string {
  const ext = mimeTypeToExtension(mimeType);
  const base = title
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : "presentation";
  return `${base || "presentation"}.${ext}`;
}

/**
 * Last path segment of a presented file path, used as the header's primary
 * label when the agent didn't pass a title. The path is always present (the
 * worker validates `present`'s `file` arg is non-empty), so this returns the
 * segment — or the whole path for a degenerate slashes-only input.
 */
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
