// eslint-disable-next-line no-restricted-imports -- useEffect: Monaco editor lifecycle, useRef: editor ref
import { useMemo, useEffect, useRef } from "react";
import { useFileReviewStore } from "../../stores/file-review-store.js";
import { createCommentWidgetManager } from "../MonacoCommentWidgets.js";
import type { CommentWidgetManager, LineCommentLike } from "../MonacoCommentWidgets.js";
import type * as MonacoEditor from "monaco-editor";

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json",
    html: "html", htm: "html",
    css: "css", scss: "scss", less: "less",
    md: "markdown", mdx: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c", h: "c",
    cpp: "cpp", hpp: "cpp", cc: "cpp",
    yaml: "yaml", yml: "yaml",
    toml: "ini",
    xml: "xml", svg: "xml",
    sh: "shell", bash: "shell", zsh: "shell",
    sql: "sql",
    graphql: "graphql", gql: "graphql",
    dockerfile: "dockerfile",
  };
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return map[ext] ?? "plaintext";
}

export function CodeEditor({
  filePath,
  content,
  sessionId,
  comments,
  readOnly = false,
  revealLine,
  language,
}: {
  filePath: string;
  content: string;
  sessionId: string;
  comments: { id: string; kind: "line" | "selection"; line?: number; text: string }[];
  readOnly?: boolean;
  revealLine?: number;
  language?: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<CommentWidgetManager | null>(null);
  const editorInstanceRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);

  const addLineComment = useFileReviewStore((s) => s.addLineComment);
  const editComment = useFileReviewStore((s) => s.editComment);
  const deleteComment = useFileReviewStore((s) => s.deleteComment);
  const setComposing = useFileReviewStore((s) => s.setComposing);

  const lineComments = useMemo<LineCommentLike[]>(() => {
    return comments
      .filter((c): c is { id: string; kind: "line"; line: number; text: string } =>
        c.kind === "line" && typeof c.line === "number",
      )
      .map((c) => ({ id: c.id, kind: "line", line: c.line, text: c.text }));
  }, [comments]);

  // Cover comment updates while Monaco's dynamic import is pending.
  const lineCommentsRef = useRef(lineComments);
  lineCommentsRef.current = lineComments;

  // eslint-disable-next-line no-restricted-syntax -- Monaco lifecycle (createEditor + cleanup)
  useEffect(() => {
    if (!editorRef.current) return;
    let disposed = false;

    // eslint-disable-next-line no-restricted-syntax -- dynamic import for code splitting
    void import("monaco-editor").then((monaco) => {
      if (disposed || !editorRef.current) return;

      const editor = monaco.editor.create(editorRef.current, {
        value: content,
        language: language ?? getLanguageFromPath(filePath),
        theme: "vs-dark",
        readOnly: true,
        minimap: { enabled: false },
        lineNumbers: "on",
        glyphMargin: true,
        folding: false,
        scrollBeyondLastLine: false,
        fontSize: 12,
        automaticLayout: true,
      });

      editorInstanceRef.current = editor;

      managerRef.current = createCommentWidgetManager(editor, {
        filePath,
        onAddComment: (line, text) => {
          if (readOnly) return;
          void addLineComment(sessionId, filePath, line, text);
        },
        onEditComment: (id, text) => {
          if (readOnly) return;
          void editComment(sessionId, filePath, id, text);
        },
        onDeleteComment: (id) => {
          if (readOnly) return;
          void deleteComment(sessionId, filePath, id);
        },
        onInputOpenChange: (open) => { setComposing(sessionId, filePath, open); },
        readOnly,
      });

      managerRef.current.setComments(lineCommentsRef.current);

      if (revealLine && revealLine > 0) {
        const lineCount = editor.getModel()?.getLineCount() ?? revealLine;
        const target = Math.min(revealLine, lineCount);
        editor.revealLineInCenter(target);
        editor.setPosition({ lineNumber: target, column: 1 });
        const decorations = editor.createDecorationsCollection([
          {
            range: new monaco.Range(target, 1, target, 1),
            options: {
              isWholeLine: true,
              className: "shipit-preview-line-highlight",
            },
          },
        ]);
        setTimeout(() => {
          if (!disposed) decorations.clear();
        }, 2400);
      }
    });

    return () => {
      disposed = true;
      managerRef.current?.dispose();
      managerRef.current = null;
      editorInstanceRef.current?.dispose();
      editorInstanceRef.current = null;
    };
    // Adding lineComments would recreate Monaco for every comment update.
  }, [filePath, content, sessionId, addLineComment, editComment, deleteComment, setComposing, readOnly, revealLine, language]);

  // eslint-disable-next-line no-restricted-syntax -- syncing widget state with store updates
  useEffect(() => {
    managerRef.current?.setComments(lineComments);
  }, [lineComments]);

  return <div ref={editorRef} className="h-full w-full" />;
}
