import { useState, type RefObject } from "react";
import { Button } from "../../ui/button.js";

const MAX_LENGTH = 50_000;

/**
 * Instructions tab. `content` and the textarea ref are owned by the parent
 * `Settings` dialog so the dialog-level Cmd/Ctrl+Enter shortcut and the
 * focus-on-tab-switch behavior keep working; everything else is local.
 */
export function InstructionsTab({
  content,
  onContentChange,
  textareaRef,
  onSave,
  onClose,
  agentSystemInstructionsEnabled,
  agentSystemInstructions,
  onToggleAgentSystemInstructions,
}: {
  content: string;
  onContentChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSave: () => void;
  onClose: () => void;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  onToggleAgentSystemInstructions: (enabled: boolean) => void;
}) {
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

  const charCount = content.length;
  const isOverLimit = charCount > MAX_LENGTH;

  return (
    <div className="px-5 py-4 flex flex-col gap-3 overflow-y-auto h-full">
      {/* Agent system instructions (built-in) */}
      <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 space-y-2" data-testid="agent-system-instructions">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-(--color-text-primary)">ShipIt Agent Instructions</h3>
            <p className="text-xs text-(--color-text-tertiary) mt-0.5">
              Built-in context sent with every message to help the agent understand the ShipIt environment.
            </p>
          </div>
          <button
            onClick={() => onToggleAgentSystemInstructions(!agentSystemInstructionsEnabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
              agentSystemInstructionsEnabled ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
            }`}
            role="switch"
            aria-checked={agentSystemInstructionsEnabled}
            data-testid="agent-instructions-toggle"
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                agentSystemInstructionsEnabled ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
        {agentSystemInstructions && (
          <div>
            <button
              onClick={() => setInstructionsExpanded(!instructionsExpanded)}
              className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors"
              data-testid="agent-instructions-expand"
            >
              {instructionsExpanded ? "Hide instructions" : "View instructions"}
            </button>
            {instructionsExpanded && (
              <pre className="mt-2 text-xs text-(--color-text-secondary) whitespace-pre-wrap bg-(--color-bg-primary) rounded-md p-2 border border-(--color-border-secondary) max-h-48 overflow-y-auto" data-testid="agent-instructions-content">
                {agentSystemInstructions}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-(--color-border-secondary)" />

      {/* User custom instructions */}
      <div>
        <h3 className="text-sm font-medium text-(--color-text-primary) mb-1">Your Instructions</h3>
        <p className="text-xs text-(--color-text-secondary) mb-2">
          Custom instructions sent to the agent with every message. Use them to define project
          conventions, preferred libraries, or style guidelines.
        </p>
      </div>

      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        placeholder="e.g. Always use TypeScript with strict mode. Use Tailwind CSS for styling."
        className="flex-1 min-h-30 w-full bg-(--color-bg-secondary) border border-(--color-border-secondary) rounded-md px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) resize-none focus:outline-none focus:border-(--color-border-focus)"
        data-testid="settings-textarea"
      />

      <div className="flex items-center justify-between text-xs text-(--color-text-secondary)">
        <span>
          Note: The agent also reads CLAUDE.md from your workspace root automatically.
        </span>
        <span className={isOverLimit ? "text-(--color-error)" : ""}>
          {charCount.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
        </span>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="md"
          onClick={onClose}
          className="rounded-md"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={onSave}
          disabled={isOverLimit}
          className="rounded-md"
          data-testid="settings-save"
        >
          Save
        </Button>
      </div>
    </div>
  );
}
