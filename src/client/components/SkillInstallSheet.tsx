/**
 * Install sheet for a single plugin (docs/149).
 *
 * Renders inline Monaco preview of the plugin's `SKILL.md` by default — the
 * headline GUI lift over the upstream `/plugin` TUI (which can only show the
 * description). Showing the body means the user has actually had the chance
 * to read what they're installing before clicking Install.
 *
 * When a plugin contains multiple skills, a left-side picker lets the user
 * page between them; the Monaco panel stays mounted between switches so we
 * don't pay the editor-init cost more than once per open.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: dynamic Monaco editor lifecycle + per-skill SKILL.md fetch
import { useEffect, useRef, useState } from "react";
import type * as MonacoEditor from "monaco-editor";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import type { PluginInfo, SkillRef } from "../../server/shared/types.js";

interface SkillInstallSheetProps {
  plugin: PluginInfo;
  /** Where the install will write to (e.g. `.claude/skills`). */
  installPathLabel: string;
  /** True while the agent is mid-turn — disables Install with a tooltip. */
  agentRunning: boolean;
  /** True while the install request is in flight. */
  installing: boolean;
  /** True if there's no active session — empty state instead of the install button. */
  hasActiveSession: boolean;
  onCancel: () => void;
  onInstall: () => void;
  /** Async loader for a single SKILL.md body. */
  fetchSkillBody: (plugin: string, skill: string) => Promise<string>;
}

export function SkillInstallSheet({
  plugin,
  installPathLabel,
  agentRunning,
  installing,
  hasActiveSession,
  onCancel,
  onInstall,
  fetchSkillBody,
}: SkillInstallSheetProps) {
  const [selectedSkill, setSelectedSkill] = useState<SkillRef | null>(plugin.skills[0] ?? null);
  const [bodyByName, setBodyByName] = useState<Record<string, string | null>>({});
  const [bodyError, setBodyError] = useState<string | null>(null);

  // Fetch the SKILL.md body for the selected skill, caching by name so
  // switching back doesn't re-hit the network.
  // eslint-disable-next-line no-restricted-syntax -- per-selection async fetch into local cache; effects are the canonical place for "when the input changes, kick off an async load"
  useEffect(() => {
    if (!selectedSkill) return;
    if (bodyByName[selectedSkill.name] !== undefined) return;
    setBodyError(null);
    void (async () => {
      try {
        const body = await fetchSkillBody(plugin.name, selectedSkill.name);
        setBodyByName((m) => ({ ...m, [selectedSkill.name]: body }));
      } catch (err: unknown) {
        setBodyError((err as Error).message);
      }
    })();
  }, [plugin.name, selectedSkill, bodyByName, fetchSkillBody]);

  const totalBytes = plugin.estimatedContextBytes;
  const contextCostLabel = formatBytes(totalBytes);

  const installDisabled =
    !hasActiveSession || agentRunning || installing || plugin.skills.length === 0;

  const installTooltip = !hasActiveSession
    ? "Open a session to install skills"
    : agentRunning
    ? "Agent is working — install will become available when it's done"
    : "";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent
        className="rounded-lg border-(--color-border-secondary) max-w-3xl w-full md:mx-4 flex flex-col md:h-[78vh] max-md:h-full"
        data-testid="skill-install-sheet"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-(--color-border-secondary)">
          <div className="min-w-0">
            <DialogTitle className="text-lg font-semibold text-(--color-text-primary)">
              Install {plugin.name}
            </DialogTitle>
            <p className="text-xs text-(--color-text-tertiary) mt-0.5 truncate">
              {plugin.author ? `by ${plugin.author} · ` : ""}from {plugin.marketplaceId}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {plugin.description && (
            <p className="text-sm text-(--color-text-secondary)">{plugin.description}</p>
          )}

          <div className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-xs space-y-1">
            <div className="text-(--color-text-secondary)">
              Installs to{" "}
              <code className="text-(--color-text-primary)">{installPathLabel}</code>{" "}
              in this repo
            </div>
            <div className="text-(--color-text-tertiary)">
              {plugin.skills.length} skill{plugin.skills.length === 1 ? "" : "s"} · context cost ≈ {contextCostLabel}
            </div>
          </div>

          {/* Preview pane: skill picker + Monaco. */}
          <div className="flex-1 min-h-60 flex border border-(--color-border-secondary) rounded-md overflow-hidden">
            <SkillPicker
              skills={plugin.skills}
              selected={selectedSkill}
              onSelect={setSelectedSkill}
            />
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="px-3 py-1.5 text-xs text-(--color-text-tertiary) border-b border-(--color-border-secondary) bg-(--color-bg-secondary)">
                {selectedSkill ? `Preview: ${plugin.name}__${selectedSkill.name}/SKILL.md` : "No skill selected"}
              </div>
              <MonacoPreview
                body={selectedSkill ? bodyByName[selectedSkill.name] : null}
                error={bodyError}
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-(--color-border-secondary)">
          <Button variant="ghost" size="md" onClick={onCancel} className="rounded-md">
            Cancel
          </Button>
          <span title={installTooltip}>
            <Button
              variant="primary"
              size="md"
              onClick={onInstall}
              disabled={installDisabled}
              className="rounded-md"
              data-testid="skill-install-confirm"
            >
              {installing ? "Installing..." : "Install"}
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillPicker({
  skills,
  selected,
  onSelect,
}: {
  skills: SkillRef[];
  selected: SkillRef | null;
  onSelect: (s: SkillRef) => void;
}) {
  if (skills.length <= 1) return null;
  return (
    <div className="w-44 shrink-0 border-r border-(--color-border-secondary) overflow-y-auto bg-(--color-bg-secondary)">
      {skills.map((s) => {
        const isSelected = selected?.name === s.name;
        return (
          <button
            key={s.name}
            onClick={() => onSelect(s)}
            className={`block w-full text-left px-3 py-2 text-xs transition-colors ${
              isSelected
                ? "bg-(--color-bg-hover) text-(--color-text-primary) border-l-2 border-(--color-accent)"
                : "text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
            }`}
          >
            <div className="truncate font-medium">{s.name}</div>
            {s.description && (
              <div className="truncate text-(--color-text-tertiary) mt-0.5">{s.description}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function MonacoPreview({
  body,
  error,
}: {
  body: string | null | undefined;
  error: string | null;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- Monaco editor lifecycle (mount + dispose)
  useEffect(() => {
    if (!editorRef.current || body === null || body === undefined) return;
    let disposed = false;
    // eslint-disable-next-line no-restricted-syntax -- dynamic import for code splitting
    void import("monaco-editor").then((monaco) => {
      if (disposed || !editorRef.current) return;
      if (instanceRef.current) {
        instanceRef.current.setValue(body);
        return;
      }
      instanceRef.current = monaco.editor.create(editorRef.current, {
        value: body,
        language: "markdown",
        theme: "vs-dark",
        readOnly: true,
        minimap: { enabled: false },
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        fontSize: 12,
        automaticLayout: true,
        wordWrap: "on",
      });
    });
    return () => {
      disposed = true;
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, [body]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-(--color-error) px-4 text-center">
        Failed to load preview: {error}
      </div>
    );
  }
  if (body === null || body === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-(--color-text-tertiary)">
        Loading preview…
      </div>
    );
  }
  return <div ref={editorRef} className="flex-1 min-h-0" data-testid="skill-monaco-preview" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Tests import this for snapshot stability on the byte formatter.
export const _internals = { formatBytes };
