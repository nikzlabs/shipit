// eslint-disable-next-line no-restricted-imports -- useEffect: resets the lazily-fetched body (docs/244) when a different tool result occupies the same slot after a session switch or rewind.
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { highlightCode, languageFromPath } from "../syntax-highlight.js";
import { Button } from "./ui/button.js";
import type { ToolResultBlock } from "./MessageList.js";
import { useSessionStore } from "../stores/session-store.js";
import { useDevicePixelRatio } from "../hooks/useDevicePixelRatio.js";

interface ToolResultImage {

  data?: string;
  mediaType: string;                     

  src?: string;
}

/**
 * How many lines each preview draws inline before the "Show all N lines"
 * expander. Exported because the docs/244 server-side slice is *derived* from
 * these: `TRANSCRIPT_SLICE_LINES` must be at least the largest of them, or the
 * transcript would arrive with less than it draws. `tool-result-slice.test.ts`
 * pins that relationship — raise one of these past the slice and the build
 * fails rather than silently rendering a short preview.
 */
export const BASH_MAX_LINES = 30;
export const READ_MAX_LINES = 20;
export const GREP_MAX_LINES = 20;
export const GENERIC_MAX_LINES = 15;

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false, totalLines: lines.length };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    totalLines: lines.length,
  };
}

export interface LazyResultBody {

  serverTruncated: boolean;

  fetched: boolean;

  totalLines?: number;

  full?: string;
  loading: boolean;
  error: boolean;
  fetchFull: () => void;
}

function useExpandable(content: string, maxLines: number, lazy?: LazyResultBody) {
  const [expanded, setExpanded] = useState(false);
  const source = lazy?.full ?? content;
  const { text: preview, truncated, totalLines } = useMemo(
    () => truncateLines(source, maxLines),
    [source, maxLines]
  );

  const serverTruncated = (lazy?.serverTruncated ?? false) && !(lazy?.fetched ?? false);

  return {
    expanded,
    displayText: expanded ? source : preview,

    clipped: !expanded && (truncated || serverTruncated),
    showToggle: truncated || serverTruncated,
    totalLines: lazy?.fetched ? totalLines : (lazy?.totalLines ?? totalLines),
    loading: lazy?.loading ?? false,
    error: lazy?.error ?? false,
    toggle: () => {
      if (!expanded && serverTruncated && lazy?.full === undefined) lazy?.fetchFull();
      setExpanded(!expanded);
    },
  };
}

type Expandable = ReturnType<typeof useExpandable>;

function ExpandToggle({ state }: { state: Expandable }) {
  if (!state.showToggle) return null;
  const label = state.error
    ? "Couldn't load the rest"
    : state.loading
      ? "Loading…"
      : state.expanded
        ? "Show less"
        : `Show all ${state.totalLines} lines`;
  return (
    <Button
      variant="ghost"
      size="md"
      onClick={state.toggle}
      className="w-full text-center rounded-none bg-(--color-bg-secondary) hover:bg-(--color-bg-tertiary) border-t border-(--color-border-secondary)/50"
      aria-label={state.expanded ? "Show less output" : "Show more output"}
    >
      {label}
    </Button>
  );
}

function BashResult({ content, isError, maxLines, lazy }: { content: string; isError?: boolean; maxLines?: number; lazy?: LazyResultBody }) {
  const state = useExpandable(content, maxLines ?? BASH_MAX_LINES, lazy);
  const { displayText } = state;

  return (
    <div
      className={`mt-1 rounded overflow-hidden border ${
        isError
          ? "border-(--color-error)/50 bg-(--color-error-subtle)"
          : "border-(--color-border-secondary)/50 bg-(--color-bg-primary)"
      }`}
    >
      <pre
        className={`p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed ${
          isError ? "text-(--color-error)" : "text-(--color-text-primary)"
        } ${state.clipped ? "max-h-[20rem] overflow-hidden" : ""}`}
      >
        {displayText}
      </pre>
      <ExpandToggle state={state} />
    </div>
  );
}

function ReadResult({ content, maxLines, lazy, filePath }: { content: string; maxLines?: number; lazy?: LazyResultBody; filePath?: string }) {
  const state = useExpandable(content, maxLines ?? READ_MAX_LINES, lazy);
  const { displayText } = state;

  const highlighted = useMemo(
    () => highlightCode(displayText, filePath ? languageFromPath(filePath) : null),
    [displayText, filePath],
  );

  return (
    <div className="mt-1 rounded overflow-hidden border border-(--color-border-secondary)/50 bg-(--color-bg-primary)">
      <pre className={`p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed ${state.clipped ? "max-h-[16rem] overflow-hidden" : ""}`}>
        {highlighted ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code className="text-(--color-text-primary)">{displayText}</code>
        )}
      </pre>
      <ExpandToggle state={state} />
    </div>
  );
}

function GrepResult({ content, maxLines, lazy }: { content: string; maxLines?: number; lazy?: LazyResultBody }) {
  const state = useExpandable(content, maxLines ?? GREP_MAX_LINES, lazy);
  const { displayText } = state;

  const lines = displayText.split("\n");

  return (
    <div className="mt-1 rounded overflow-hidden border border-(--color-border-secondary)/50 bg-(--color-bg-primary)">
      <pre className={`p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed ${state.clipped ? "max-h-[16rem] overflow-hidden" : ""}`}>
        {lines.map((line, i) => {

          const match = /^([^:]+):(\d+)[:-](.*)/.exec(line);
          if (match) {
            return (
              <div key={i}>
                <span className="text-(--color-text-link)">{match[1]}</span>
                <span className="text-(--color-text-tertiary)">:</span>
                <span className="text-(--color-warning)">{match[2]}</span>
                <span className="text-(--color-text-tertiary)">:</span>
                <span className="text-(--color-text-primary)">{match[3]}</span>
              </div>
            );
          }

          if (line.trim() && !line.includes(" ")) {
            return (
              <div key={i}>
                <span className="text-(--color-text-link)">{line}</span>
              </div>
            );
          }
          return (
            <div key={i} className="text-(--color-text-primary)">
              {line}
            </div>
          );
        })}
      </pre>
      <ExpandToggle state={state} />
    </div>
  );
}

function GenericResult({ content, isError, maxLines, lazy }: { content: string; isError?: boolean; maxLines?: number; lazy?: LazyResultBody }) {
  const state = useExpandable(content, maxLines ?? GENERIC_MAX_LINES, lazy);
  const { displayText } = state;

  return (
    <div
      className={`mt-1 rounded overflow-hidden border ${
        isError
          ? "border-(--color-error)/50 bg-(--color-error-subtle)"
          : "border-(--color-border-secondary)/50 bg-(--color-bg-primary)"
      }`}
    >
      <pre
        className={`p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed ${
          isError ? "text-(--color-error)" : "text-(--color-text-primary)"
        } ${state.clipped ? "max-h-[12rem] overflow-hidden" : ""}`}
      >
        {displayText}
      </pre>
      <ExpandToggle state={state} />
    </div>
  );
}

/**
 * Render images from tool result content (e.g. Playwright screenshots).
 *
 * Drawn so that **one pixel of the image is one physical pixel of the display**
 * — never resampled, in either direction. A screenshot too wide for that scrolls
 * sideways rather than shrinking to fit. Fitting is the tempting default and it
 * is the wrong one here: a resampled screenshot looks like a faithful one, so
 * the reader has no way to tell whether the blur they are squinting at is in the
 * page or in the render. A scrollbar says which.
 *
 * Hitting that on a high-DPI display takes the `srcSet` density descriptor.
 * These screenshots are 1× — headless Chromium runs at `deviceScaleFactor: 1`,
 * so a 1280 CSS-px viewport captures as 1280 image pixels whatever `scale` the
 * agent passes. Laid out with no descriptor, a browser treats an image pixel as
 * a *CSS* pixel, so on a 2× display those 1280 pixels get smeared across 2560
 * physical ones. That is the stretch: a bitmap magnified 2×, sitting next to
 * text the same display renders sharply. Declaring the density as the viewer's
 * own ratio makes the browser lay the image out at `naturalWidth / dpr`, which
 * lands each image pixel on exactly one physical pixel.
 *
 * The consequence is deliberate and worth knowing: on a 2× display the shot
 * occupies half the CSS width it used to, so it reads *smaller* than the page it
 * captured. Sharp-and-smaller beats big-and-smeared for the thing this view is
 * for — checking what the page actually looked like.
 *
 * **The descriptor decides the layout size outright — it is not a hint the
 * browser weighs against the display.** Verified in Chromium: `srcset="X 2x"`
 * lays X out at half its natural width even at `dpr === 1`, and `1.5x` / `3x` /
 * a Windows-scaling `1.7647…x` all divide exactly. `src` naming the same URL
 * does not override it and costs no second request. Two things follow. The
 * descriptor MUST carry the *live* ratio — a stale one mis-sizes the image with
 * no fallback, which is why {@link useDevicePixelRatio} re-arms on change rather
 * than reading `devicePixelRatio` once. And at `dpr === 1` this is exactly a
 * no-op, so nothing changes for an ordinary display.
 *
 * A base64 `data:` URL is safe in `srcset` despite the comma after `;base64`:
 * candidates are split on commas that follow whitespace, and base64 contains
 * none. (A `utf8,<svg …>` data URL is *not* safe — its spaces do split it. Also
 * verified, by breaking it.)
 *
 * Two earlier bounds are gone, for the reason above: a 256px height cap that
 * reduced a 1280×720 shot to an unreadable strip, and the `max-w-full` that
 * replaced it. Neither had a click-to-full-size view behind it to recover the
 * detail from. `max-w-none` is load-bearing — Tailwind's preflight sets
 * `img { max-width: 100% }`, which would silently re-fit the image inside the
 * scroller and leave a scrollbar that never scrolls. The frame sits on the
 * scroll container, not the image, so it stays put while the picture moves
 * under it.
 *
 * Stacked rather than wrapped: a result with two images gives each the full
 * width instead of squeezing both onto one row.
 */
function ToolResultImages({ images }: { images: ToolResultImage[] }) {
  const dpr = useDevicePixelRatio();
  return (
    <div className="flex flex-col gap-2 mt-2" data-testid="tool-result-images">
      {images.map((img, i) => {
        const src = img.src ?? `data:${img.mediaType};base64,${img.data}`;
        return (
          <div
            key={i}
            className="overflow-x-auto rounded-md border border-(--color-border-secondary)/50"
          >
            <img
              src={src}
              srcSet={`${src} ${dpr}x`}
              alt={`Tool output image ${i + 1}`}
              loading="lazy"
              className="block max-w-none h-auto"
            />
          </div>
        );
      })}
    </div>
  );
}

export function parseContentForImages(content: string): { text: string; images: ToolResultImage[] } | null {
  if (!content.startsWith("[")) return null;
  try {
    const blocks = JSON.parse(content) as Record<string, unknown>[];
    if (!Array.isArray(blocks)) return null;
    let text = "";
    const images: ToolResultImage[] = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        text += (text ? "\n" : "") + block.text;
      } else if (block.type === "image") {
        const source = block.source as Record<string, unknown> | undefined;
        if (source?.data && typeof source.data === "string") {
          images.push({
            data: source.data,
            mediaType: (source.media_type as string) ?? "image/png",
          });
        } else if (typeof source?.shipit_url === "string") {

          images.push({
            src: source.shipit_url,
            mediaType: (source.media_type as string) ?? "image/png",
          });
        }
      }
    }
    if (images.length === 0) return null;
    return { text, images };
  } catch {
    return null;
  }
}

/**
 * docs/244 — fetch the tail of a server-sliced result, once, on first expand.
 *
 * The endpoint reads the persisted row, which always holds the whole body: the
 * projection that produced the slice runs on the serve path only. On the live
 * path the row is committed synchronously before the WS frame is flushed, so
 * expanding a result from the turn that just produced it cannot outrun the
 * write.
 */
function useLazyResultBody(result: ToolResultBlock): LazyResultBody | undefined {
  const sessionId = useSessionStore((s) => s.sessionId);
  const [full, setFull] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const fetchFullRef = useRef<(() => void) | undefined>(undefined);

  // A new tool result in the same slot (session switch, rewind) must not show

  // eslint-disable-next-line no-restricted-syntax -- resets state owned by an external fetch when its identity key changes; there is no event to hang this on, since the component is re-pointed at a different result rather than interacted with.
  useEffect(() => {
    setFull(undefined);
    setLoading(false);
    setError(false);
  }, [result.toolUseId, sessionId]);

  // eslint-disable-next-line no-restricted-syntax -- loads data owned by an external endpoint when the view that displays it mounts; the mount is the user's click, there is no earlier event to hang it on.
  useEffect(() => {
    if (result.truncated) fetchFullRef.current?.();
  }, [result.toolUseId, result.truncated]);

  const fetchFull = useCallback(() => {
    if (!sessionId || !result.truncated) return;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(result.toolUseId)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { content?: string };
        setFull(body.content ?? "");
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId, result.toolUseId, result.truncated]);
  fetchFullRef.current = fetchFull;

  if (!result.truncated) return undefined;
  return {
    serverTruncated: true,
    fetched: full !== undefined,
    ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
    ...(full !== undefined ? { full } : {}),
    loading,
    error,
    fetchFull,
  };
}

export function ToolResult({ tool, result, filePath }: {
  tool: string;
  result: ToolResultBlock;
  /**
   * The `file_path` from the tool's own input, when it had one. Optional
   * because most tools have no file to name; a `Read` that supplies it gets
   * highlighted by lookup instead of by auto-detection.
   */
  filePath?: string;
}) {
  const lazy = useLazyResultBody(result);
  const parsed = useMemo(
    () => parseContentForImages(lazy?.full ?? result.content),
    [lazy?.full, result.content],
  );

  const displayContent = parsed?.text ?? (lazy?.full ?? result.content);

  const textLazy = lazy && parsed && lazy.full !== undefined
    ? { ...lazy, full: parsed.text }
    : lazy;
  const images = parsed?.images ?? [];
  const hasImages = images.length > 0;
  const hasContent = !!displayContent;

  // marker, because nothing renders its content until this modal opens. Show

  const awaitingBody = !!lazy && !lazy.fetched && !lazy.error;
  if (!hasContent && !hasImages && awaitingBody) {
    return (
      <div className="mt-1 text-xs text-(--color-text-tertiary) font-mono italic" role="status">
        Loading output…
      </div>
    );
  }
  if (!hasContent && !hasImages && lazy?.error) {
    return (
      <div className="mt-1 text-xs text-(--color-error)" role="status">
        Couldn&apos;t load this output.
      </div>
    );
  }

  if (!hasContent && !result.isError && !hasImages) {
    return (
      <div className="mt-1 text-xs text-(--color-text-secondary) italic" role="status">
        (no output)
      </div>
    );
  }

  const textMaxLines = hasImages ? 8 : undefined;

  let textResult = null;
  if (hasContent || result.isError) {
    if (tool === "Bash") {
      textResult = <BashResult content={displayContent} isError={result.isError} maxLines={textMaxLines} lazy={textLazy} />;
    } else if (tool === "Read") {
      textResult = <ReadResult content={displayContent} maxLines={textMaxLines} lazy={textLazy} {...(filePath ? { filePath } : {})} />;
    } else if (tool === "Grep" || tool === "Glob") {
      textResult = <GrepResult content={displayContent} maxLines={textMaxLines} lazy={textLazy} />;
    } else {
      textResult = <GenericResult content={displayContent} isError={result.isError} maxLines={textMaxLines} lazy={textLazy} />;
    }
  }

  // never loaded leaves no trace. The image is still the useful part, so this

  const imageBodyFailed = hasImages && !hasContent && !!lazy?.error;

  return (
    <div>
      {textResult}
      {hasImages && <ToolResultImages images={images} />}
      {imageBodyFailed && (
        <div className="mt-1 text-xs text-(--color-error)" role="status">
          Couldn&apos;t load this output.
        </div>
      )}
    </div>
  );
}

export { truncateLines };
