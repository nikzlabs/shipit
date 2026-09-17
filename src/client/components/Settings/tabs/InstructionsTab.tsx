import { useState } from "react";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { SettingsTabPane } from "../SettingsTabPane.js";
import { DeclaredSettings } from "../DeclaredSettings.js";

/**
 * The two instruction boxes and the built-in-instructions toggle are declared
 * rows; what is left here is the chrome around them (inventory.md P12).
 *
 * The built-in text is not a setting — it ships with ShipIt and its one control
 * shows and hides it — so it is the toggle's own row note, which is what puts it
 * directly under the control that enables it. The CLAUDE.md sentence is likewise
 * not part of any declaration's description, because the agent has no use for it.
 */
function AgentInstructions() {
  const text = useSettingsStore((s) => s.agentSystemInstructions);
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div data-testid="agent-system-instructions">
      <button
        onClick={() => { setExpanded(!expanded); }}
        className="text-xs text-(--color-text-link) hover:text-(--color-accent) transition-colors"
        data-testid="agent-instructions-expand"
      >
        {expanded ? "Hide instructions" : "View instructions"}
      </button>
      {expanded && (
        <pre
          className="mt-2 text-xs text-(--color-text-secondary) whitespace-pre-wrap bg-(--color-bg-primary) rounded-md p-2 border border-(--color-border-secondary) max-h-48 overflow-y-auto"
          data-testid="agent-instructions-content"
        >
          {text}
        </pre>
      )}
    </div>
  );
}

export function InstructionsTab() {
  return (
    <SettingsTabPane bodyClassName="gap-3">
      <p className="text-xs text-(--color-text-secondary)">
        Note: The agent also reads CLAUDE.md from your workspace root automatically.
      </p>

      <DeclaredSettings
        tab="instructions"
        rowNotes={{ "instructions.agentInstructionsEnabled": <AgentInstructions /> }}
      />
    </SettingsTabPane>
  );
}
