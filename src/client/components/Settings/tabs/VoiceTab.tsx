// eslint-disable-next-line no-restricted-imports -- cleanup status fetch on mount and whenever a key changes
import { useState, useEffect } from "react";
import { Button } from "../../ui/button.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { getVoiceProvider } from "../../../../server/shared/voice-catalog.js";
import { useVoiceKeyStatus } from "../../../voice/voice-key-status.js";
import { SettingsTabPane } from "../SettingsTabPane.js";
import { DeclaredSettings } from "../DeclaredSettings.js";

// Cleanup runs on the background-work model, not on a provider ShipIt picks for
// it (docs/299-direct-provider-calls req 5), so the line names that model or says nothing can clean.
const CLEANUP_UNAVAILABLE =
  "No model is set up to run background work, so cleanup can't run. Until then the raw transcript is inserted.";

interface CleanupModel {
  serviceName: string;
  modelId: string;
  modelLabel: string;
  execution: "direct" | "harness";
  harnessName?: string;
}

interface VoiceKeyOffer {
  providerId: string;
  providerLabel: string;
  serviceName: string;
}

// "Nothing can clean" and "couldn't ask" are different facts and the first one
// blames the user, so a failed status fetch must not render as the first line.
type CleanupStatus =
  | { state: "pending" }
  | { state: "unknown" }
  | { state: "ready"; model: CleanupModel | null; offer: VoiceKeyOffer | null };

/**
 * Names the user's own choice and links to it — the line it replaced named a
 * provider ShipIt picked, which described a decision the user could neither see
 * nor change. The second sentence is the wait: a direct call is quick, and a
 * harness run is the case worth warning about.
 */
function cleanupModelLine(model: CleanupModel) {
  return (
    <>
      Cleaned by {model.modelLabel}, your{" "}
      <button
        type="button"
        onClick={() => useUiStore.getState().setSettingsTab("services")}
        className="text-(--color-text-link) hover:text-(--color-accent) transition-colors"
        data-testid="voice-cleanup-background-work-link"
      >
        Background work
      </button>{" "}
      model.{" "}
      {model.execution === "direct" ? (
        "Called directly, so it is quick."
      ) : (
        <>
          <span className="text-(--color-warning)">
            Runs through {model.harnessName ?? "a harness"}, so it takes a few seconds.
          </span>{" "}
          An API key for a model provider would make it quick.
        </>
      )}
    </>
  );
}

/**
 * "Voice" settings tab (docs/144) — dictation + playback + voice notes.
 *
 * Every control on it is generated from a declaration
 * (docs/308-data-driven-settings): the rows, their order and their sections come
 * from the catalogue, four of them through components that own logic a value
 * writer has no shape for — the provider-key list, the TTS trio, hands-free and
 * the webhook pair. What is left here is chrome the declarations do not carry
 * (inventory.md P12): the link to the Keyboard tab, and the cleanup status with
 * the key-adoption offer inside it.
 *
 * Two things that status says which the model's name does not
 * (docs/299-direct-provider-calls reqs 5 and 6). **How long a dictation will
 * wait**, because a harness run takes seconds and several seconds of silence
 * after speaking is indistinguishable from a fault. And **the voice key that is
 * not a model provider**: cleanup moved onto the background-work choice, which
 * cannot see a key stored for speech, so the tab offers to adopt it rather than
 * writing a background-work choice the user never made (docs/252-custom-models
 * req 9). Declining leaves cleanup unavailable, and the line then says so.
 */
export function VoiceTab() {
  const cleanupEnabled = useSettingsStore((s) => s.cleanupEnabled);
  const sttProvider = useSettingsStore((s) => s.sttProvider);
  const configuredKeys = useVoiceKeyStatus((s) => s.configured);

  const [cleanupStatus, setCleanupStatus] = useState<CleanupStatus>({ state: "pending" });
  const [offerDismissed, setOfferDismissed] = useState(false);
  const [adoptBusy, setAdoptBusy] = useState(false);

  const refreshCleanupStatus = async () => {
    try {
      const res = await fetch("/api/voice/cleanup/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        model: CleanupModel | null;
        adoptableVoiceKey: VoiceKeyOffer | null;
      };
      setCleanupStatus({ state: "ready", model: data.model, offer: data.adoptableVoiceKey ?? null });
    } catch {
      setCleanupStatus({ state: "unknown" });
    }
  };

  /*
    Re-read whenever the stored keys change, which is what saving or clearing one
    does: a key the user just added can be the one cleanup could adopt. The key
    list owns that fetch now, so this watches its answer rather than being called
    by it.
  */
  // eslint-disable-next-line no-restricted-syntax -- status fetch on mount and on a key change
  useEffect(() => {
    void refreshCleanupStatus();
  }, [configuredKeys]);

  // The key is server-side and never sent to the browser, so the browser cannot
  // POST it to /api/credential-routes itself.
  const adoptVoiceKey = async (providerId: string) => {
    setAdoptBusy(true);
    try {
      const res = await fetch("/api/credential-routes/adopt-voice-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await refreshCleanupStatus();
    } catch (err) {
      useUiStore.getState().setToast({
        message: err instanceof Error ? err.message : "Couldn't add the key as a model provider",
      });
    } finally {
      setAdoptBusy(false);
    }
  };

  // The offer stands alone: it already explains why cleanup cannot run, so the
  // unavailable line beside it would say the same thing twice. Declining brings
  // that line back, which is what makes the consequence of declining visible.
  const cleanupOffer = cleanupStatus.state === "ready" && !offerDismissed ? cleanupStatus.offer : null;

  const cleanupNote = (
    <>
      {cleanupEnabled && cleanupStatus.state !== "pending" && !cleanupOffer && (
        <p className="text-xs text-(--color-text-tertiary)" data-testid="voice-cleanup-status">
          {cleanupStatus.state === "unknown"
            ? "Couldn't check whether cleanup is available."
            : cleanupStatus.model
              ? cleanupModelLine(cleanupStatus.model)
              : CLEANUP_UNAVAILABLE}
        </p>
      )}
      {cleanupEnabled && cleanupOffer && (
        <div
          className="space-y-2.5 rounded-lg border border-(--color-border-secondary) border-l-2 border-l-(--color-accent) bg-(--color-bg-secondary) p-3"
          data-testid="voice-key-adoption-offer"
        >
          <p className="text-xs text-(--color-text-secondary)">
            <span className="font-medium text-(--color-text-primary)">
              Use your {cleanupOffer.providerLabel} key for cleanup too?
            </span>
            <br />
            Cleanup now runs on your Background work model. Your {cleanupOffer.providerLabel} key
            is stored for speech only, so adding it as a model provider lets it clean transcripts as
            well. It stays visible and removable under Model providers like any other credential.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="md"
              disabled={adoptBusy}
              onClick={() => void adoptVoiceKey(cleanupOffer.providerId)}
              data-testid="voice-key-adopt"
            >
              {adoptBusy ? "Adding…" : "Add it as a model provider"}
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={adoptBusy}
              onClick={() => setOfferDismissed(true)}
              data-testid="voice-key-adopt-decline"
            >
              Not now
            </Button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <SettingsTabPane bodyClassName="gap-6">
      <DeclaredSettings
        tab="voice"
        notes={{
          "Voice input (dictation)": (
            <p className="text-xs text-(--color-text-tertiary)">
              Mic hotkeys (Mode A / Mode B) are configured in the{" "}
              <button
                type="button"
                onClick={() => useUiStore.getState().setSettingsTab("keyboard")}
                className="text-(--color-text-link) hover:text-(--color-accent) transition-colors"
              >
                Keyboard
              </button>{" "}
              settings.
            </p>
          ),
        }}
        rowNotes={{
          "voice.sttProvider": !configuredKeys.includes(sttProvider) && (
            <p className="text-xs text-(--color-text-tertiary)">
              Add a {getVoiceProvider(sttProvider)?.label ?? sttProvider} key above to use this
              provider.
            </p>
          ),
          "voice.cleanupEnabled": cleanupNote,
        }}
      />
    </SettingsTabPane>
  );
}
