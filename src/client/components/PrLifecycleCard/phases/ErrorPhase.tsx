import { useUiStore } from "../../../stores/ui-store.js";
import { useSessionStore } from "../../../stores/session-store.js";
import type { PrCardState } from "../../../stores/pr-store.js";
import { Button } from "../../ui/button.js";
import { XCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../../design-tokens.js";
import { RichErrorText } from "../RichErrorText.js";

export function ErrorPhase({
  card,
  onCreatePr,
}: {
  card: PrCardState;
  sessionId: string;
  onCreatePr?: () => void;
}) {
  const setSettingsTab = useUiStore((s) => s.setSettingsTab);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const agentRunning = useSessionStore((s) => s.isLoading);
  const lines = card.errorMessage?.split("\n") ?? [];
  const isAuthError = card.errorKind === "auth";

  const handleSignIn = () => {
    setSettingsTab("integrations");
    setSettingsOpen(true);
  };

  return (
    <div className="flex items-start gap-3 min-w-0 flex-1">
      <XCircleIcon size={ICON_SIZE.SM} className="text-(--color-error) shrink-0 mt-0.5" />
      <span className="text-xs text-(--color-text-secondary) wrap-break-word min-w-0">
        Failed to create PR{lines.length > 0 && ": "}
        {lines.map((line, i) => (
          <span key={i}>
            {i > 0 && <br />}
            <RichErrorText text={line} />
          </span>
        ))}
        {isAuthError && (
          <>
            <br />
            Your GitHub token is missing or expired — reconnect to keep pushing.
          </>
        )}
      </span>
      {isAuthError && (
        <Button
          variant="ghost"
          size="md"
          onClick={handleSignIn}
          className="shrink-0"
        >
          Sign in to GitHub
        </Button>
      )}
      <Button
        variant="ghost"
        size="md"
        onClick={onCreatePr}
        disabled={agentRunning || !onCreatePr}
        className="shrink-0"
      >
        {agentRunning ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}
