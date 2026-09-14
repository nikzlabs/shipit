import { useState, type RefObject } from "react";
import { Button } from "../../ui/button.js";
import { SettingsTabPane } from "../SettingsTabPane.js";
import { DeclaredTextarea, DeclaredToggle } from "../declared.js";

export const MAX_LENGTH = 50_000;

export function InstructionsTab({
  content,
  onContentChange,
  opsContent,
  onOpsContentChange,
  textareaRef,
  onSave,
  onClose,
  agentSystemInstructionsEnabled,
  agentSystemInstructions,
  onToggleAgentSystemInstructions,
}: {
  content: string;
  onContentChange: (value: string) => void;
  opsContent: string;
  onOpsContentChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSave: () => void;
  onClose: () => void;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  onToggleAgentSystemInstructions: (enabled: boolean) => void;
}) {
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

  const charCount = content.length;
  const opsCharCount = opsContent.length;
  const isOverLimit = charCount > MAX_LENGTH || opsCharCount > MAX_LENGTH;

  return (
    <SettingsTabPane
      bodyClassName="gap-3"
      footer={
        <>
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
        </>
      }
    >
      {/* Agent system instructions (built-in) */}
      <div className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 space-y-2" data-testid="agent-system-instructions">
        <DeclaredToggle
          settingKey="instructions.agentInstructionsEnabled"
          heading
          enabled={agentSystemInstructionsEnabled}
          onToggle={onToggleAgentSystemInstructions}
          testId="agent-instructions-toggle"
        />
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
      <DeclaredTextarea
        settingKey="instructions.userInstructions"
        value={content}
        onChange={onContentChange}
        textareaRef={textareaRef}
        placeholder="e.g. Always use TypeScript with strict mode. Use Tailwind CSS for styling."
        className="flex-1 min-h-30 w-full bg-(--color-bg-secondary) border border-(--color-border-secondary) rounded-md px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) resize-none focus:outline-none focus:border-(--color-border-focus)"
        testId="settings-textarea"
      />

      <div className="flex items-center justify-between text-xs text-(--color-text-secondary)">
        <span>
          Note: The agent also reads CLAUDE.md from your workspace root automatically.
        </span>
        <span className={charCount > MAX_LENGTH ? "text-(--color-error)" : ""}>
          {charCount.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
        </span>
      </div>

      <div className="border-t border-(--color-border-secondary)" />

      {/* Ops sessions take their own block: ShipIt's read-only host-debugging
          instructions contradict ordinary project conventions (docs/014-system-prompt req 4). */}
      <DeclaredTextarea
        settingKey="instructions.opsInstructions"
        value={opsContent}
        onChange={onOpsContentChange}
        placeholder="e.g. Report findings as a timeline. Never propose a host change without naming the evidence."
        className="flex-1 min-h-20 w-full bg-(--color-bg-secondary) border border-(--color-border-secondary) rounded-md px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) resize-none focus:outline-none focus:border-(--color-border-focus)"
        testId="settings-textarea-ops"
      />

      <div className="flex items-center justify-end text-xs text-(--color-text-secondary)">
        <span className={opsCharCount > MAX_LENGTH ? "text-(--color-error)" : ""}>
          {opsCharCount.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
        </span>
      </div>
    </SettingsTabPane>
  );
}
