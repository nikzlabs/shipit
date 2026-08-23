/**
 * PresentInlineCard — a `present({ inline: true })` artifact rendered as a card
 * in the chat transcript (docs/280).
 *
 * The Present tab answers "show me the thing, I want to study it". This answers
 * "look at this while you read the reply": a thumbnail, a small chart, a two-line
 * SVG, a short rendered table. Same tool, same file-path identity, same MIME
 * inference — the only difference is which surface it lands on, and it lands on
 * BOTH (req 6), so the carousel still holds every artifact of the session.
 *
 * **Metadata in, bytes on demand.** The card message carries no artifact bytes;
 * the presentation's entry in `present-store` does, fetched lazily by the shared
 * `loadPresentContent`. Three things follow, and all three are the point:
 *   - a card persisted weeks ago renders the file's CURRENT contents;
 *   - re-presenting the same path refreshes this card in place, because
 *     `addOrReplace` drops the cached bytes and the card refetches (which is why
 *     the server emits the card exactly once per artifact);
 *   - if the source file is gone, the card degrades to a placeholder rather than
 *     to a broken frame.
 *
 * **Height is measured, not assumed** (req 5). The artifact is sandboxed onto an
 * opaque origin, so the frame volunteers its own height via `reportHeight` and
 * the card clamps it to [MIN_FRAME_H, MAX_FRAME_H]. The clamp is what keeps a
 * large artifact from taking over the conversation without rejecting it — past
 * the cap it simply scrolls inside its box, and "Open" gives it the whole pane.
 *
 * **The SDK is live here** (req 7): inline HTML runs its own scripts and can
 * send a composed message back to the agent, exactly as an active Present
 * artifact can. It is gated on the card being on screen — an artifact scrolled
 * far up the transcript is not a surface the user is looking at, so its
 * `sendMessage` is refused and its `visibility` subscribers are told false.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: IntersectionObserver gate, lazy byte fetch, frame visibility sync (browser API subscriptions)
import { useEffect, useRef, useState } from "react";
import { ArrowsOutSimpleIcon, PresentationChartIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { PresentInlineCard as PresentInlineCardData } from "../../server/shared/types.js";
import type { AgentInterfaceProvenance } from "../../server/shared/agent-interface-sdk/protocol.js";
import { usePresentStore } from "../stores/present-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { loadPresentContent } from "../utils/present-content-fetch.js";
import { kindFromMimeType } from "../utils/file-content-kind.js";
import { RenderedFrame } from "./FileContentView/RenderedFrame.js";
import { MarkdownContent } from "./message-markdown.js";
import { handleAgentInterfaceRequest } from "../agent-interface-sdk/handle-request.js";
import { useEventListener } from "../hooks/useEventListener.js";
import { revealWorkspaceTab } from "../utils/reveal-workspace-tab.js";

/** Frame height bounds. Small artifacts shrink to fit; large ones scroll inside the cap. */
const MIN_FRAME_H = 64;
const MAX_FRAME_H = 420;
/** Height used until the document reports its own (and for a frame that never does). */
const DEFAULT_FRAME_H = 220;

export interface PresentInlineCardProps {
  card: PresentInlineCardData;
  /** Dispatch a message the artifact composed through the Agent Interface SDK. */
  onAgentInterfaceMessage?: (text: string, provenance: AgentInterfaceProvenance) => Promise<void>;
}

export function PresentInlineCard({ card, onAgentInterfaceMessage }: PresentInlineCardProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  // Subscribe to THIS artifact's entry only, so an unrelated present elsewhere in
  // the carousel doesn't re-render every inline card in the transcript.
  const entry = usePresentStore((s) => s.presentations.find((p) => p.presentId === card.presentId));
  const content = entry?.content;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_H);

  const kind = kindFromMimeType(card.mimeType, card.filePath);
  // An artifact that has left the store (session cleared) can no longer be
  // fetched — the card says so rather than showing an empty frame.
  const missing = !entry;
  const sdkActive = onScreen && kind === "html" && !!onAgentInterfaceMessage;

  // Pull the bytes once the card is on screen. Deferring to visibility keeps a
  // long transcript full of inline artifacts from firing every fetch on load.
  // eslint-disable-next-line no-restricted-syntax -- lazy content fetch keyed on visibility
  useEffect(() => {
    if (onScreen && sessionId && entry && content === undefined) {
      void loadPresentContent(sessionId, card.presentId);
    }
  }, [onScreen, sessionId, entry, content, card.presentId]);

  // On-screen gate. Without IntersectionObserver (jsdom, older browsers) treat
  // the card as visible: the fetch and the SDK are both things the user asked
  // for, so failing open matches the artifact simply being rendered.
  // eslint-disable-next-line no-restricted-syntax -- IntersectionObserver subscription with cleanup
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((e) => e.isIntersecting)),
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Messages from this card's own frame: the height it measured, the SDK
  // handshake, and any message the artifact composed for the agent.
  useEventListener(window, "message", (event) => {
    const iframe = frameRef.current;
    if (!iframe?.contentWindow || event.source !== iframe.contentWindow || event.origin !== "null") return;
    const data = event.data as { source?: string; type?: string; height?: number } | undefined;
    if (data?.source !== "shipit-preview") return;
    if (data.type === "content_height" && typeof data.height === "number") {
      setFrameHeight(Math.min(MAX_FRAME_H, Math.max(MIN_FRAME_H, Math.ceil(data.height))));
      return;
    }
    if (data.type === "ready") {
      iframe.contentWindow?.postMessage(
        { source: "shipit-preview", type: "visibility", visible: sdkActive },
        "*",
      );
      return;
    }
    if (data.type === "agent_message" && sdkActive && onAgentInterfaceMessage) {
      void handleAgentInterfaceRequest({
        event,
        iframe,
        expectedOrigin: "null",
        surface: "present",
        dispatch: onAgentInterfaceMessage,
      });
    }
  });

  // Keep the artifact's `visibility` subscribers in step as the card scrolls.
  // eslint-disable-next-line no-restricted-syntax -- synchronize visibility into the sandboxed artifact
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { source: "shipit-preview", type: "visibility", visible: sdkActive },
      "*",
    );
  }, [sdkActive]);

  const openInTab = () => {
    usePresentStore.getState().focusById(card.presentId);
    revealWorkspaceTab("present");
  };

  const heading = card.title ?? card.filePath.split("/").pop() ?? card.filePath;

  return (
    <div
      ref={rootRef}
      data-testid="present-inline-card"
      className="overflow-hidden rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)"
    >
      <div className="flex items-center gap-2 border-b border-(--color-border-secondary) px-3 py-2">
        <PresentationChartIcon size={ICON_SIZE.SM} className="shrink-0 text-(--color-accent)" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-(--color-text-primary)">{heading}</div>
          <div className="truncate text-[11px] text-(--color-text-tertiary)">{card.filePath}</div>
        </div>
        <button
          type="button"
          onClick={openInTab}
          title="Open in the Present tab"
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-(--color-text-link) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
        >
          <ArrowsOutSimpleIcon size={ICON_SIZE.XS} />
          Open
        </button>
      </div>

      <div className="bg-(--color-bg-primary)">
        <PresentInlineBody
          kind={kind}
          card={card}
          content={content}
          missing={missing}
          frameHeight={frameHeight}
          frameRef={frameRef}
          sdkActive={sdkActive}
        />
      </div>
    </div>
  );
}

function PresentInlineBody({
  kind,
  card,
  content,
  missing,
  frameHeight,
  frameRef,
  sdkActive,
}: {
  kind: ReturnType<typeof kindFromMimeType>;
  card: PresentInlineCardData;
  content: string | undefined;
  missing: boolean;
  frameHeight: number;
  frameRef: React.Ref<HTMLIFrameElement>;
  sdkActive: boolean;
}) {
  if (missing) {
    return (
      <div className="px-3 py-4 text-xs text-(--color-text-tertiary)">
        This artifact is no longer available.
      </div>
    );
  }
  if (content === undefined) {
    return <div className="px-3 py-4 text-xs text-(--color-text-tertiary)">Loading artifact…</div>;
  }

  if (kind === "html" || kind === "svg") {
    return (
      <div style={{ height: frameHeight }}>
        <RenderedFrame
          kind={kind}
          content={content}
          // req 7 — inline HTML gets the SDK, so an artifact can collect input
          // and message the agent. Only ever enabled while the card is on screen,
          // and `handleAgentInterfaceRequest` is gated on the same flag.
          enableAgentInterface={kind === "html" && sdkActive}
          reportHeight
          frameRef={frameRef}
        />
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className="flex justify-center px-3 py-3">
        <img
          src={content}
          alt={card.title ?? card.filePath}
          style={{ maxHeight: MAX_FRAME_H }}
          className="max-w-full rounded object-contain"
        />
      </div>
    );
  }

  if (kind === "markdown") {
    return (
      <div
        style={{ maxHeight: MAX_FRAME_H }}
        className="overflow-auto px-3 py-2 text-sm text-(--color-text-primary)"
      >
        <MarkdownContent text={content} />
      </div>
    );
  }

  return (
    <pre
      style={{ maxHeight: MAX_FRAME_H }}
      className="overflow-auto px-3 py-2 text-xs whitespace-pre-wrap text-(--color-text-secondary)"
    >
      {content}
    </pre>
  );
}
