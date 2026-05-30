/**
 * PresentPane — Present tab in the right panel (docs/093).
 *
 * Renders agent-emitted artifacts (HTML, SVG, markdown, images) from the
 * `present` MCP tool. Single visible entry at a time, with a `◀ N/M ▶`
 * carousel header when there's more than one. "Save to project" copies the
 * byte-exact content from the worker's buffer to a user-picked workspace
 * path; the file watcher and auto-commit pipeline take it from there.
 *
 * Sandboxing: HTML/SVG content renders in an iframe with `sandbox="allow-scripts"`.
 * That lets charts and interactive markup run JS but prevents same-origin
 * access to cookies, storage, parent frame, or top-level navigation.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: clear unseen badge on tab focus + global keydown subscription
import { useEffect, useState } from "react";
import {
  CaretLeftIcon,
  CaretRightIcon,
  FloppyDiskIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { usePresentStore } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { MarkdownContent } from "./message-markdown.js";
import { Button } from "./ui/button.js";

interface PresentPaneProps {
  /** When true the pane is currently visible to the user — clears the unseen badge. */
  isActiveTab: boolean;
}

export function PresentPane({ isActiveTab }: PresentPaneProps) {
  const presentations = usePresentStore((s) => s.presentations);
  const activeIndex = usePresentStore((s) => s.activePresentIndex);
  const sessionId = useSessionStore((s) => s.sessionId);
  const setActiveIndex = usePresentStore((s) => s.setActiveIndex);
  const markSeen = usePresentStore((s) => s.markSeen);
  const dropOne = usePresentStore((s) => s.clear);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- intentional unseen-clear on tab focus
  useEffect(() => {
    if (isActiveTab) markSeen();
  }, [isActiveTab, markSeen, activeIndex]);

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

  if (presentations.length === 0) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-sm text-(--color-text-tertiary) p-6 text-center">
        <p className="max-w-xs">
          Nothing to present yet. When the agent shows you a chart, diagram, or
          mockup, it will appear here.
        </p>
      </div>
    );
  }

  const safeIndex = Math.max(0, Math.min(activeIndex, presentations.length - 1));
  const active = presentations[safeIndex];

  const onPrev = () => setActiveIndex(safeIndex - 1);
  const onNext = () => setActiveIndex(safeIndex + 1);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-(--color-border-primary) bg-(--color-bg-secondary) shrink-0">
        {presentations.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onPrev}
              disabled={safeIndex === 0}
              className="inline-flex items-center justify-center w-6 h-6 rounded transition-colors text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:cursor-not-allowed"
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
              className="inline-flex items-center justify-center w-6 h-6 rounded transition-colors text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Next presentation"
            >
              <CaretRightIcon size={ICON_SIZE.SM} />
            </button>
          </div>
        )}
        <div className="text-sm font-medium text-(--color-text-primary) truncate flex-1">
          {active.title ?? `Presentation ${safeIndex + 1}`}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setSaveError(null); setSaveOpen(true); }}
          className="shrink-0"
          aria-label="Save presentation to project"
        >
          <FloppyDiskIcon size={ICON_SIZE.XS} />
          Save
        </Button>
        <button
          onClick={() => dropOne(active.presentId)}
          className="inline-flex items-center justify-center w-6 h-6 rounded transition-colors text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover)"
          aria-label="Dismiss presentation"
        >
          <XIcon size={ICON_SIZE.SM} />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative bg-(--color-bg-primary)">
        <PresentationContent
          key={active.presentId}
          content={active.content}
          mimeType={active.mimeType}
        />
      </div>

      {saveOpen && (
        <SaveDialog
          sessionId={sessionId}
          presentId={active.presentId}
          defaultName={suggestFilename(active.title, active.mimeType)}
          error={saveError}
          onError={setSaveError}
          onClose={() => setSaveOpen(false)}
        />
      )}
    </div>
  );
}

function PresentationContent({
  content,
  mimeType,
}: {
  content: string;
  mimeType: string;
}) {
  const lower = mimeType.toLowerCase();

  if (lower === "text/html") {
    return (
      <iframe
        title="Presentation"
        sandbox="allow-scripts"
        srcDoc={content}
        className="w-full h-full border-0"
      />
    );
  }

  if (lower === "image/svg+xml") {
    // Wrap raw SVG markup in a minimal HTML host so iframe sandboxing applies
    // even if the SVG contains <script>. Centered with subtle padding so
    // viewBox-relative dimensions don't paint flush to the bezel.
    const wrapped =
      `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:white">${content}</body></html>`;
    return (
      <iframe
        title="Presentation"
        sandbox="allow-scripts"
        srcDoc={wrapped}
        className="w-full h-full border-0"
      />
    );
  }

  if (lower === "text/markdown") {
    return (
      <div className="w-full h-full overflow-auto p-6">
        <MarkdownContent text={content} />
      </div>
    );
  }

  if (lower.startsWith("image/")) {
    // PNG/JPEG/etc arrive as data URIs — pass straight to <img>. Plain text
    // payloads of an image type fall through to the unknown-content branch.
    if (content.startsWith("data:")) {
      return (
        <div className="w-full h-full flex items-center justify-center p-6 bg-(--color-bg-primary)">
          <img
            src={content}
            alt="Agent presentation"
            className="max-w-full max-h-full object-contain"
          />
        </div>
      );
    }
  }

  return (
    <div className="w-full h-full overflow-auto p-6 text-xs font-mono text-(--color-text-secondary) whitespace-pre-wrap">
      {content}
    </div>
  );
}

function SaveDialog({
  sessionId,
  presentId,
  defaultName,
  error,
  onError,
  onClose,
}: {
  sessionId: string | undefined;
  presentId: string;
  defaultName: string;
  error: string | null;
  onError: (msg: string | null) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(defaultName);
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    if (!sessionId) {
      onError("No active session to save into.");
      return;
    }
    const trimmed = path.trim();
    if (!trimmed) {
      onError("Pick a destination path inside the workspace.");
      return;
    }
    onError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/present/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presentId, destPath: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        onError(body.error ?? `Save failed (HTTP ${res.status})`);
        setSaving(false);
        return;
      }
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-(--color-bg-overlay) p-4"
      role="dialog"
      aria-label="Save presentation to project"
    >
      <div className="w-full max-w-md rounded-lg bg-(--color-bg-primary) border border-(--color-border-primary) p-4 shadow-xl flex flex-col gap-3">
        <div className="text-sm font-semibold text-(--color-text-primary)">
          Save presentation to project
        </div>
        <div className="text-xs text-(--color-text-tertiary)">
          Choose where to save this presentation inside the workspace. The path
          is relative to the repository root.
        </div>
        <label className="flex flex-col gap-1 text-xs text-(--color-text-secondary)">
          Workspace path
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="rounded border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 text-sm text-(--color-text-primary) outline-none focus:border-(--color-border-focus)"
            placeholder="docs/preview.html"
            autoFocus
          />
        </label>
        {error && (
          <div className="text-xs text-(--color-error) bg-(--color-error)/10 rounded px-2 py-1">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => { void onSave(); }}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Pick a sensible default filename for the save dialog. Title-based when
 * available; otherwise mime-type-driven. Slugifies the title so the user
 * doesn't have to.
 */
function suggestFilename(title: string | undefined, mimeType: string): string {
  const ext = mimeTypeToExtension(mimeType);
  const base = title
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : "presentation";
  return `presentations/${base || "presentation"}.${ext}`;
}

function mimeTypeToExtension(mimeType: string): string {
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

