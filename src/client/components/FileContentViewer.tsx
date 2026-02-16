import { useMemo } from "react";
import hljs from "highlight.js";

export interface FileContentViewerProps {
  filePath: string;
  content: string | null;
  isBinary?: boolean;
  onClose: () => void;
}

/** Map file extensions to highlight.js language names. */
function languageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    bash: "bash",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    sql: "sql",
    xml: "xml",
    toml: "ini",
    dockerfile: "dockerfile",
  };
  if (ext && map[ext]) return map[ext];
  // Handle files like "Dockerfile" with no extension
  const name = filePath.split("/").pop()?.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  return undefined;
}

export function FileContentViewer({ filePath, content, isBinary, onClose }: FileContentViewerProps) {
  const highlighted = useMemo(() => {
    if (content === null) return "";
    const lang = languageFromPath(filePath);
    try {
      if (lang) {
        return hljs.highlight(content, { language: lang }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch {
      // Fall back to plain escaped text if highlighting fails
      return content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
  }, [content, filePath]);

  return (
    <div className="flex flex-col h-full">
      {/* Header with file path and close button */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium text-gray-700 dark:text-gray-300 truncate" title={filePath}>
          {filePath}
        </span>
        <button
          onClick={onClose}
          className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0 ml-2"
          title="Close file viewer"
        >
          Close
        </button>
      </div>

      {/* File content */}
      <div className="flex-1 overflow-auto bg-white dark:bg-gray-950">
        {content === null ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Loading...
          </div>
        ) : isBinary ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            <p>{content}</p>
          </div>
        ) : (
          <pre className="p-4 text-sm leading-relaxed">
            <code
              className="hljs"
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          </pre>
        )}
      </div>
    </div>
  );
}
