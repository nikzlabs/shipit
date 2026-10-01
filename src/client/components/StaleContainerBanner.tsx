import { useState } from "react";
import { Spinner } from "./Spinner.js";
import { ArrowsClockwiseIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useApi, ApiError } from "../hooks/useApi.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { Banner } from "./ui/banner.js";
import { Button } from "./ui/button.js";

type RestartResult =
  | { ok: true; scheduled: true }
  | { ok: true; newContainerState: "running" | "starting" | "missing" | "pending"; error: string | null };

// A slow answer must not overwrite the state that a newer request, or another session, set.
let latestRequest = 0;

export function StaleContainerBanner({ sessionId }: { sessionId: string }) {
  const freshness = useSessionStore((s) => s.containerFreshness);
  const turnRunning = useSessionStore((s) => s.isLoading);
  const restartScheduled = useSessionStore((s) => s.restartScheduled);
  const setRestartScheduled = useSessionStore((s) => s.setRestartScheduled);
  const rescueState = useSessionStore((s) => s.rescueState);
  const setRescueState = useSessionStore((s) => s.setRescueState);
  const setRecoveryActionError = useSessionStore((s) => s.setRecoveryActionError);
  const [requesting, setRequesting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const api = useApi();

  if (freshness?.state !== "stale") return null;

  const restarting = requesting || (!!rescueState && rescueState.phase !== "ready" && rescueState.phase !== "failed");
  // With no turn running, a scheduled restart waits for the agent's work; the button restarts now.
  const scheduled = turnRunning && restartScheduled;
  const waiting = restartScheduled && !turnRunning && !restarting;
  const disabled = restarting || cancelling;
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/agent/container/restart`;
  const answerIsCurrent = (request: number) =>
    request === latestRequest && useSessionStore.getState().sessionId === sessionId;

  const cancel = async () => {
    if (disabled) return;
    const request = ++latestRequest;
    setCancelling(true);
    try {
      await api.del(url);
      if (answerIsCurrent(request)) setRestartScheduled(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useUiStore.getState().setToast({ message: `Failed to cancel the scheduled restart: ${message}` });
    } finally {
      setCancelling(false);
    }
  };

  const restart = async () => {
    if (disabled) return;
    const request = ++latestRequest;
    const startedAt = Date.now();
    setRequesting(true);
    setRecoveryActionError(null);
    if (!turnRunning) setRescueState({ phase: "restarting_agent", startedAt });
    try {
      const result = await (turnRunning
        ? api.post<RestartResult>(url, { afterTurn: true })
        : api.post<RestartResult>(url));
      if ("scheduled" in result) {
        if (answerIsCurrent(request)) setRestartScheduled(true);
        return;
      }
      if (result.newContainerState === "missing" && result.error) {
        throw new Error(result.error);
      }
      window.dispatchEvent(new CustomEvent("shipit:reconnect-ws"));
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error instanceof Error ? error.message : error);
      setRecoveryActionError(`Restart agent container failed: ${message}`);
      if (!turnRunning) setRescueState({ phase: "failed", reason: "request_error", message, startedAt });
      useUiStore.getState().setToast({ message: `Failed to restart the agent container: ${message}` });
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="mx-4 last:mb-2" data-testid="stale-container-banner">
      <Banner
        variant="warning"
        className="flex flex-col items-stretch gap-2 rounded-lg border border-(--color-warning) text-left font-normal sm:flex-row sm:items-center"
        title={`Worker ${freshness.workerBuildId}; ShipIt ${freshness.orchestratorBuildId}`}
      >
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <WarningIcon size={ICON_SIZE.SM} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Update available for this session</div>
            <div className="text-(--color-text-secondary)">
              Its agent container is from an earlier ShipIt build.{" "}
              {scheduled
                ? "It restarts when this turn ends."
                : waiting
                  ? "The scheduled restart waits for the end of the agent's work. Restart it now if you do not want to wait."
                  : "Restart it to use the latest updates."}
            </div>
          </div>
        </div>
        {restartScheduled && !restarting && (
          <Button
            type="button"
            variant={scheduled ? "secondary" : "ghost"}
            size="md"
            className="w-full sm:w-auto"
            disabled={disabled}
            title="Remove the scheduled restart; the agent container stays as it is"
            onClick={() => void cancel()}
          >
            {cancelling ? <Spinner size={ICON_SIZE.XS} /> : <XIcon size={ICON_SIZE.XS} />}
            Cancel restart
          </Button>
        )}
        {!scheduled && (
          <Button
            type="button"
            variant="secondary"
            size="md"
            className="w-full sm:w-auto"
            disabled={disabled}
            title={turnRunning
              ? "Restart the agent container when this turn ends; the turn is not interrupted"
              : "Restart only the agent container; preview services keep running"}
            onClick={() => void restart()}
          >
            {restarting
              ? <Spinner size={ICON_SIZE.XS} />
              : <ArrowsClockwiseIcon size={ICON_SIZE.XS} />}
            {turnRunning ? "Restart after turn" : "Restart agent container"}
          </Button>
        )}
      </Banner>
    </div>
  );
}
