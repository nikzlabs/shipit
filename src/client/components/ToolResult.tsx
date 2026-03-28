import { useState, useMemo } from "react";
import hljs from "highlight.js";
import { Button } from "./ui/button.js";
import type { ToolResultBlock, ToolResultImage } from "./MessageList.js";

const BASH_MAX_LINES = 30;
const READ_MAX_LINES = 20;
const GREP_MAX_LINES = 20;
const GENERIC_MAX_LINES = 15;

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

function BashResult({ content, isError, maxLines }: { content: string; isError?: boolean; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveMax = maxLines ?? BASH_MAX_LINES;
  const { text: preview, truncated, totalLines } = useMemo(
    () => truncateLines(content, effectiveMax),
    [content, effectiveMax]
  );

  const displayText = expanded ? content : preview;

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
        } ${!expanded && truncated ? "max-h-[20rem]" : ""}`}
      >
        {displayText}
      </pre>
      {truncated && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          className="w-full text-center py-1 rounded-none bg-(--color-bg-secondary)/50 hover:bg-(--color-bg-tertiary)/50 border-t border-(--color-border-secondary)/50"
          aria-label={expanded ? "Show less output" : "Show more output"}
        >
          {expanded ? "Show less" : `Show all ${totalLines} lines`}
        </Button>
      )}
    </div>
  );
}

function ReadResult({ content, maxLines }: { content: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveMax = maxLines ?? READ_MAX_LINES;
  const { text: preview, truncated, totalLines } = useMemo(
    () => truncateLines(content, effectiveMax),
    [content, effectiveMax]
  );

  extractFilePathFromReadContent(content);

  const displayText = expanded ? content : preview;

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
      <pre className={`p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed ${!expanded && truncated ? "max-h-[16rem]" : ""}`}>
        {highlighted ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code className="text-(--color-text-primary)">{displayText}</code>
        )}
      </pre>
      {truncated && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          className="w-full text-center py-1 rounded-none bg-(--color-bg-secondary)/50 hover:bg-(--color-bg-tertiary)/50 border-t border-(--color-border-secondary)/50"
          aria-label={expanded ? "Show less output" : "Show more output"}
        >
          {expanded ? "Show less" : `Show all ${totalLines} lines`}
        </Button>
      )}
    </div>
  );
}

function GrepResult({ content, maxLines }: { content: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveMax = maxLines ?? GREP_MAX_LINES;
  const { text: preview, truncated, totalLines } = useMemo(
    () => truncateLines(content, effectiveMax),
    [content, effectiveMax]
  );

  const displayText = expanded ? content : preview;

  // Grep output has file:line:content format — highlight file paths
  const lines = displayText.split("\n");

  return (
    <div className="mt-1 rounded overflow-hidden border border-(--color-border-secondary)/50 bg-(--color-bg-primary)">
      <pre className={`p-2 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed ${!expanded && truncated ? "max-h-[16rem]" : ""}`}>
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
      {truncated && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          className="w-full text-center py-1 rounded-none bg-(--color-bg-secondary)/50 hover:bg-(--color-bg-tertiary)/50 border-t border-(--color-border-secondary)/50"
          aria-label={expanded ? "Show less output" : "Show more output"}
        >
          {expanded ? "Show less" : `Show all ${totalLines} lines`}
        </Button>
      )}
    </div>
  );
}

function GenericResult({ content, isError, maxLines }: { content: string; isError?: boolean; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveMax = maxLines ?? GENERIC_MAX_LINES;
  const { text: preview, truncated, totalLines } = useMemo(
    () => truncateLines(content, effectiveMax),
    [content, effectiveMax]
  );

  const displayText = expanded ? content : preview;

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
        } ${!expanded && truncated ? "max-h-[12rem]" : ""}`}
      >
        {displayText}
      </pre>
      {truncated && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          className="w-full text-center py-1 rounded-none bg-(--color-bg-secondary)/50 hover:bg-(--color-bg-tertiary)/50 border-t border-(--color-border-secondary)/50"
          aria-label={expanded ? "Show less output" : "Show more output"}
        >
          {expanded ? "Show less" : `Show all ${totalLines} lines`}
        </Button>
      )}
    </div>
  );
}

/** Render images from tool result content (e.g. Playwright screenshots). */
function ToolResultImages({ images }: { images: ToolResultImage[] }) {
  return (
    <div className="flex gap-2 flex-wrap mt-2" data-testid="tool-result-images">
      {images.map((img, i) => {
        const src = `data:${img.mediaType};base64,${img.data}`;
        return (
          <img
            key={i}
            src={src}
            alt={`Tool output image ${i + 1}`}
            className="max-w-full max-h-64 rounded-md border border-(--color-border-secondary)/50 object-contain"
          />
        );
      })}
    </div>
  );
}

/**
 * Try to extract images and text from a JSON-stringified MCP content array.
 * Used when loading from persisted history where the server stored the raw
 * JSON.stringify of the content array.
 */
function parseContentForImages(content: string): { text: string; images: ToolResultImage[] } | null {
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
        }
      }
    }
    if (images.length === 0) return null;
    return { text, images };
  } catch {
    return null;
  }
}

export function ToolResult({ tool, result }: { tool: string; result: ToolResultBlock }) {
  // Use structured images if present, otherwise try parsing from JSON content (history reload)
  const parsed = useMemo(() => {
    if (result.images && result.images.length > 0) {
      return { text: result.content, images: result.images };
    }
    return parseContentForImages(result.content);
  }, [result.content, result.images]);

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
      textResult = <BashResult content={displayContent} isError={result.isError} maxLines={textMaxLines} />;
    } else if (tool === "Read") {
      textResult = <ReadResult content={displayContent} maxLines={textMaxLines} />;
    } else if (tool === "Grep" || tool === "Glob") {
      textResult = <GrepResult content={displayContent} maxLines={textMaxLines} />;
    } else {
      textResult = <GenericResult content={displayContent} isError={result.isError} maxLines={textMaxLines} />;
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
