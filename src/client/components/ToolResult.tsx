import { useState, useMemo, useEffect, useCallback } from "react";
import hljs from "highlight.js";
import { Button } from "./ui/button.js";
import type { ToolResultBlock } from "./MessageList.js";
import { useSessionStore } from "../stores/session-store.js";

interface ToolResultImage {
  /** Base64 payload — only present on results the client parsed locally. */
  data?: string;
  mediaType: string; // "image/png", etc.
  /**
   * docs/244 — content-addressed URL substituted for the base64 payload on the
   * serve path. An MCP screenshot is ~500 KB of base64 inside the result JSON;
   * keeping it there made every transcript load carry every screenshot ever
   * taken. Rendered at the stored resolution, not downscaled: these images have
   * no click-to-full-size view to recover detail from.
   */
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

/** Truncate text to a maximum number of lines, returning whether it was truncated. */
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

/** Detect language from file path extension for syntax highlighting. */
function languageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", html: "xml", css: "css", scss: "scss",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", c: "c", cpp: "cpp", h: "c",
    sh: "bash", bash: "bash", zsh: "bash",
    md: "markdown", yaml: "yaml", yml: "yaml",
    sql: "sql", xml: "xml", toml: "ini",
  };
  return map[ext] ?? "";
}

/** Try to extract file path from Read result content (first line often has path info). */
function extractFilePathFromReadContent(content: string): string | null {
  // Read results from Claude CLI often start with the file path or line numbers
  // Try to detect if the content looks like it has line numbers (e.g., "     1\tconst x = 1;")
  const firstLine = content.split("\n")[0] ?? "";
  if (/^\s*\d+\t/.test(firstLine)) {
    return null; // Has line numbers — it's file content, not a path header
  }
  return null;
}

/**
 * docs/244 — the lazy tail of a server-sliced result.
 *
 * The transcript carries only the head slice of a heavy tool output, plus the
 * true line count so the "Show all N lines" label stays honest. This bundles
 * the fetch for the rest; the four preview components below share it through
 * `useExpandable` so the fetch lives in one place rather than four.
 */
export interface LazyResultBody {
  /** `content` is a server slice with more available behind a fetch. */
  serverTruncated: boolean;
  /** True line count of the whole body. */
  totalLines?: number;
  /** The full body, once fetched. */
  full?: string;
  loading: boolean;
  error: boolean;
  fetchFull: () => void;
}

/**
 * Expand/collapse state for a result preview, with the docs/244 lazy fetch
 * folded in. Falls back to purely client-side truncation when `lazy` is absent
 * (nothing was sliced server-side), so behavior is unchanged for small results.
 */
function useExpandable(content: string, maxLines: number, lazy?: LazyResultBody) {
  const [expanded, setExpanded] = useState(false);
  const source = lazy?.full ?? content;
  const { text: preview, truncated, totalLines } = useMemo(
    () => truncateLines(source, maxLines),
    [source, maxLines]
  );
  const serverTruncated = lazy?.serverTruncated ?? false;

  return {
    expanded,
    displayText: expanded ? source : preview,
    // Collapse the box while a slice is still only a slice, so an expanded
    // fetch-in-flight doesn't render a short body as if it were complete.
    clipped: !expanded && (truncated || serverTruncated),
    showToggle: truncated || serverTruncated,
    totalLines: lazy?.totalLines ?? totalLines,
    loading: lazy?.loading ?? false,
    error: lazy?.error ?? false,
    toggle: () => {
      if (!expanded && serverTruncated && lazy?.full === undefined) lazy?.fetchFull();
      setExpanded(!expanded);
    },
  };
}

type Expandable = ReturnType<typeof useExpandable>;

/** The "Show all N lines" / "Show less" footer shared by every preview. */
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

function ReadResult({ content, maxLines, lazy }: { content: string; maxLines?: number; lazy?: LazyResultBody }) {
  const state = useExpandable(content, maxLines ?? READ_MAX_LINES, lazy);
  const { displayText } = state;

  extractFilePathFromReadContent(content);

  // Attempt syntax highlighting based on content heuristics
  const highlighted = useMemo(() => {
    try {
      const result = hljs.highlightAuto(displayText);
      return result.value;
    } catch {
      return null;
    }
  }, [displayText]);

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

  // Grep output has file:line:content format — highlight file paths
  const lines = displayText.split("\n");

  return (
    <div className="mt-1 rounded overflow-hidden border border-(--color-border-secondary)/50 bg-(--color-bg-primary)">
      <pre className={`p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed ${state.clipped ? "max-h-[16rem] overflow-hidden" : ""}`}>
        {lines.map((line, i) => {
          // Match ripgrep-style output: file:line:content or file:line-content
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
          // File-only matches (files_with_matches mode)
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

/** Render images from tool result content (e.g. Playwright screenshots). */
function ToolResultImages({ images }: { images: ToolResultImage[] }) {
  return (
    <div className="flex gap-2 flex-wrap mt-2" data-testid="tool-result-images">
      {images.map((img, i) => {
        const src = img.src ?? `data:${img.mediaType};base64,${img.data}`;
        return (
          <img
            key={i}
            src={src}
            alt={`Tool output image ${i + 1}`}
            loading="lazy"
            className="max-w-full max-h-64 rounded-md border border-(--color-border-secondary)/50 object-contain"
          />
        );
      })}
    </div>
  );
}

/**
 * Try to extract images and text from a JSON-stringified MCP content array.
 *
 * MCP tools (e.g. mcp__playwright__browser_take_screenshot) return content as
 * an array of {type:"text"} and {type:"image"} blocks. The server stores this
 * as JSON.stringify(content), so we parse it back here.
 *
 * The `startsWith("[")` guard is a fast-path to skip plain string content.
 * If content happens to be a JSON array without image blocks, we return null
 * and fall through to normal text rendering.
 *
 * If a screenshot renders as raw JSON text instead of an image, the block is
 * missing *upstream*, not lost here: `@playwright/mcp` only attaches the image
 * when `browser_take_screenshot` is called without a `filename`. See
 * `session/agents/playwright-mcp.ts`.
 */
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
          // docs/244 — the projection replaced the base64 with a URL. The array
          // is still valid JSON with the same block structure, which is why
          // image-bearing results need no exemption from the line slice.
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

  // A new tool result in the same slot (session switch, rewind) must not show
  // the previous one's body.
  useEffect(() => {
    setFull(undefined);
    setLoading(false);
    setError(false);
  }, [result.toolUseId, sessionId]);

  const fetchFull = useCallback(() => {
    if (!sessionId || !result.truncated) return;
    setLoading(true);
    setError(false);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(result.toolUseId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { content?: string }) => setFull(body.content ?? ""))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [sessionId, result.toolUseId, result.truncated]);

  if (!result.truncated) return undefined;
  return {
    serverTruncated: true,
    ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
    ...(full !== undefined ? { full } : {}),
    loading,
    error,
    fetchFull,
  };
}

export function ToolResult({ tool, result }: { tool: string; result: ToolResultBlock }) {
  const lazy = useLazyResultBody(result);
  const parsed = useMemo(
    () => parseContentForImages(lazy?.full ?? result.content),
    [lazy?.full, result.content],
  );

  const displayContent = parsed?.text ?? result.content;
  const images = parsed?.images ?? [];
  const hasImages = images.length > 0;
  const hasContent = !!displayContent;

  if (!hasContent && !result.isError && !hasImages) {
    return (
      <div className="mt-1 text-xs text-(--color-text-secondary) italic" role="status">
        (no output)
      </div>
    );
  }

  // When images are present, shrink the text output panel
  const textMaxLines = hasImages ? 8 : undefined;

  let textResult = null;
  if (hasContent || result.isError) {
    if (tool === "Bash") {
      textResult = <BashResult content={displayContent} isError={result.isError} maxLines={textMaxLines} lazy={lazy} />;
    } else if (tool === "Read") {
      textResult = <ReadResult content={displayContent} maxLines={textMaxLines} lazy={lazy} />;
    } else if (tool === "Grep" || tool === "Glob") {
      textResult = <GrepResult content={displayContent} maxLines={textMaxLines} lazy={lazy} />;
    } else {
      textResult = <GenericResult content={displayContent} isError={result.isError} maxLines={textMaxLines} lazy={lazy} />;
    }
  }

  return (
    <div>
      {textResult}
      {hasImages && <ToolResultImages images={images} />}
    </div>
  );
}

export { truncateLines, languageFromPath };
