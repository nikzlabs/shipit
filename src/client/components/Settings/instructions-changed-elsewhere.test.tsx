import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Settings, type SettingsProps } from "./Settings.js";
import { useUiStore } from "../../stores/ui-store.js";

/**
 * An editor with unsaved edits keeps its draft and says the underlying value
 * changed (docs/299-agent-settings-access, plan.md → Apply goes through a shared
 * layer).
 *
 * Keeping the draft is the easy half and already held: the draft lives in
 * component state, which a store refetch does not touch. Saying so is the point
 * — without it, Save silently reverts a change the user never saw.
 */

const props: SettingsProps = {
  initialContent: "",
  initialOpsContent: "",
  onSaveInstructions: vi.fn(),
  githubStatus: { authenticated: false },
  onGitHubTokenSubmit: vi.fn(),
  onGitHubLogout: vi.fn(),
  agentList: [],
  gitIdentity: { name: "", email: "" },
  onGitIdentitySave: vi.fn(),
  memoryBudgetMb: null,
  onMemoryBudgetSave: vi.fn(),
  agentSystemInstructions: "",
  hasActiveSession: false,
  onClose: vi.fn(),
};

afterEach(() => {
  cleanup();
  useUiStore.getState().setSettingsTab(undefined);
});

function openInstructions(initialContent: string) {
  useUiStore.getState().setSettingsTab("instructions");
  return render(<Settings {...props} initialContent={initialContent} />);
}

const NOTICE = "instructions-changed-elsewhere";

describe("the instructions editor, when the stored value moves underneath it", () => {
  it("adopts the new value in an untouched box, rather than writing a stale one back", () => {
    const { rerender } = openInstructions("Be brief.");
    rerender(<Settings {...props} initialContent="Be brief and cite files." />);

    expect(screen.getByTestId("settings-textarea")).toHaveValue("Be brief and cite files.");
    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
  });

  it("says nothing for an unsaved draft while the stored value has not moved", () => {
    openInstructions("Be brief.");
    fireEvent.change(screen.getByTestId("settings-textarea"), { target: { value: "Be brief. Always." } });

    expect(screen.queryByTestId(NOTICE)).not.toBeInTheDocument();
  });

  it("keeps the draft and says the value changed when both are true", () => {
    const { rerender } = openInstructions("Be brief.");
    fireEvent.change(screen.getByTestId("settings-textarea"), { target: { value: "Be brief. Always." } });

    // What a refetch does after another tab, or an applied proposal, saved a
    // different value.
    rerender(<Settings {...props} initialContent="Cite every file." />);

    expect(screen.getByTestId(NOTICE)).toBeInTheDocument();
    expect(screen.getByTestId("settings-textarea")).toHaveValue("Be brief. Always.");
  });

  it("says it for the ops instructions too", () => {
    useUiStore.getState().setSettingsTab("instructions");
    const { rerender } = render(<Settings {...props} initialOpsContent="Report a timeline." />);
    fireEvent.change(screen.getByTestId("settings-textarea-ops"), { target: { value: "Report a timeline. Always." } });

    rerender(<Settings {...props} initialOpsContent="Name the evidence." />);

    expect(screen.getByTestId(NOTICE)).toBeInTheDocument();
    expect(screen.getByTestId("settings-textarea-ops")).toHaveValue("Report a timeline. Always.");
  });
});
