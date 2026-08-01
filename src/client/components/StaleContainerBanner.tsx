import { useState } from "react";
import { ArrowsClockwiseIcon, CircleNotchIcon, WarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useApi, ApiError } from "../hooks/useApi.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { Banner } from "./ui/banner.js";
import { Button } from "./ui/button.js";

interface RestartResult {
  ok: true;
  newContainerState: "running" | "starting" | "missing" | "pending";
  error: string | null;
}

export function StaleContainerBanner({ sessionId }: { sessionId: string }) {
  const freshness = useSessionStore((s) => s.containerFreshness);
  const turnRunning = useSessionStore((s) => s.isLoading);
  const rescueState = useSessionStore((s) => s.rescueState);
  const setRescueState = useSessionStore((s) => s.setRescueState);
  const setRecoveryActionError = useSessionStore((s) => s.setRecoveryActionError);
  const [requesting, setRequesting] = useState(false);
  const api = useApi();

  if (freshness?.state !== "stale") return null;

  const restarting = requesting || (!!rescueState && rescueState.phase !== "ready" && rescueState.phase !== "failed");
  const disabled = turnRunning || restarting;
  const title = turnRunning
    ? "Wait for the current turn to finish"
    : `Worker ${freshness.workerBuildId}; ShipIt ${freshness.orchestratorBuildId}`;

  const restart = async () => {
    if (disabled) return;
    const startedAt = Date.now();
    setRequesting(true);
    setRecoveryActionError(null);
    setRescueState({ phase: "restarting_agent", startedAt });
    try {
      const result = await api.post<RestartResult>(
        `/api/sessions/${encodeURIComponent(sessionId)}/agent/container/restart`,
      );
      if (result.newContainerState === "missing" && result.error) {
        throw new Error(result.error);
      }
      window.dispatchEvent(new CustomEvent("shipit:reconnect-ws"));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error instanceof Error ? error.message : error);
      setRecoveryActionError(`Restart agent failed: ${message}`);
      setRescueState({ phase: "failed", reason: "request_error", message, startedAt });
      useUiStore.getState().setToast({ message: `Failed to restart agent: ${message}` });
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="mx-4 last:mb-2" data-testid="stale-container-banner">
      <Banner
        variant="warning"
        className="flex flex-col items-stretch gap-2 rounded-lg border border-(--color-warning) text-left font-normal sm:flex-row sm:items-center"
        title={title}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <WarningIcon size={ICON_SIZE.SM} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Update available for this session</div>
            <div className="text-(--color-text-secondary)">
              Its agent container is from an earlier ShipIt build. Restart it to use the latest updates.
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="md"
          className="w-full sm:w-auto"
          disabled={disabled}
          title={turnRunning ? "Wait for the current turn to finish" : "Restart only the agent container; preview services keep running"}
          onClick={() => void restart()}
        >
          {restarting
            ? <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
            : <ArrowsClockwiseIcon size={ICON_SIZE.XS} />}
          {turnRunning ? "Restart after turn" : "Restart agent"}
        </Button>
      </Banner>
    </div>
  );
}
