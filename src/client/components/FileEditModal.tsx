// eslint-disable-next-line no-restricted-imports -- useEffect/useRef manage the Monaco editor lifecycle.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleNotchIcon, XIcon } from "@phosphor-icons/react";
import type * as MonacoEditor from "monaco-editor";
import { ICON_SIZE } from "../design-tokens.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Button } from "./ui/button.js";

function getLanguageFromPath(filePath: string): string {
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

function EditableCodeEditor({
  filePath,
  content,
  onChange,
}: {
  filePath: string;
  content: string;
  onChange: (content: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);

  onChangeRef.current = onChange;

  // eslint-disable-next-line no-restricted-syntax -- Monaco is loaded lazily for editor-only surface.
  useEffect(() => {
    if (!editorRef.current) return;
    let disposed = false;

    // eslint-disable-next-line no-restricted-syntax -- dynamic import keeps Monaco out of the initial client bundle.
    void import("monaco-editor").then((monaco) => {
      if (disposed || !editorRef.current) return;
      const editor = monaco.editor.create(editorRef.current, {
        value: content,
        language: getLanguageFromPath(filePath),
        theme: "vs-dark",
        readOnly: false,
        minimap: { enabled: false },
        lineNumbers: "on",
        glyphMargin: false,
        folding: true,
        scrollBeyondLastLine: false,
        fontSize: 12,
        automaticLayout: true,
      });
      editorInstanceRef.current = editor;
      editor.onDidChangeModelContent(() => {
        onChangeRef.current(editor.getValue());
      });
      editor.focus();
    });

    return () => {
      disposed = true;
      editorInstanceRef.current?.dispose();
      editorInstanceRef.current = null;
    };
  }, [filePath, content]);

  return <div ref={editorRef} className="h-full w-full" data-testid="file-edit-monaco" />;
}

export interface FileEditModalProps {
  filePath: string;
  content: string;
  originalContent: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onChange: (content: string) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
}

export function FileEditModal({
  filePath,
  content,
  originalContent,
  loading,
  saving,
  error,
  onChange,
  onSave,
  onClose,
}: FileEditModalProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = content !== originalContent;
  const canSave = dirty && !loading && !saving;

  const requestClose = useCallback(() => {
    if (dirty && !saving) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [dirty, saving, onClose]);

  const save = useCallback(async () => {
    if (!canSave) return;
    try {
      await onSave();
    } catch {
      // The store owns the visible error state.
    }
  }, [canSave, onSave]);

  const status = useMemo(() => {
    if (loading) return "Loading";
    if (saving) return "Saving";
    if (dirty) return "Unsaved";
    return "Saved";
  }, [loading, saving, dirty]);

  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) requestClose(); }}>
      <DialogContent className="w-[92vw] max-w-5xl h-[86vh] flex flex-col overflow-hidden">
        <div className="border-b border-(--color-border-secondary) shrink-0">
          <div className="flex items-center justify-between px-6 py-4 gap-4">
            <div className="min-w-0">
              <DialogTitle className="text-sm font-medium text-(--color-text-primary) truncate" title={filePath}>
                {filePath}
              </DialogTitle>
              <div className="mt-0.5 text-[11px] text-(--color-text-tertiary)" aria-live="polite">
                {status}
              </div>
            </div>
            <button
              onClick={requestClose}
              className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors shrink-0"
              aria-label="Close editor"
            >
              <XIcon size={ICON_SIZE.MD} />
            </button>
          </div>
        </div>

        {error && (
          <div className="border-b border-(--color-error) bg-(--color-error-subtle) px-6 py-2 text-sm text-(--color-error)" role="alert">
            {error}
          </div>
        )}

        {confirmDiscard && (
          <div className="border-b border-(--color-warning) bg-(--color-warning-subtle) px-6 py-2 flex items-center justify-between gap-3">
            <span className="text-sm text-(--color-text-primary)">Discard unsaved changes?</span>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="destructive" size="sm" onClick={onClose}>
                Discard
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-(--color-text-secondary)">
              Loading...
            </div>
          ) : error && !content ? (
            <div className="h-full flex items-center justify-center text-sm text-(--color-text-secondary)">
              Unable to edit this file.
            </div>
          ) : (
            <EditableCodeEditor filePath={filePath} content={content} onChange={onChange} />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-(--color-border-secondary) bg-(--color-bg-elevated) shrink-0">
          <Button variant="ghost" size="sm" onClick={requestClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!canSave}>
            {saving && <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
