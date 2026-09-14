// eslint-disable-next-line no-restricted-imports -- credential/cleanup status fetch on mount
import { useState, useEffect } from "react";
import { Button } from "../../ui/button.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import {
  keyRequiringProviders,
  providerVoices,
  providerSpeeds,
  getVoiceProvider,
} from "../../../../server/shared/voice-catalog.js";
import { armAutoplay } from "../../../voice/voice-notes.js";
import { ProviderKeyField } from "../ProviderKeyField.js";
import { inputClass } from "../shared.js";
import {
  DeclaredSelect,
  DeclaredToggle,
  SettingCopy,
  bindSetting,
  settingCopy,
  type DeclaredOption,
} from "../declared.js";

const VOICE_LANGUAGES: DeclaredOption[] = [
  { value: "", label: "Auto (browser locale)" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ru", label: "Russian" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
];

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
 * "Voice" settings tab (docs/144) — dictation + playback. Each provider that
 * needs a credential has its own server-side key (POSTed to
 * /api/voice/credentials, never read back; status is the `configured` id
 * list). STT/TTS providers are chosen from the shared catalog. Every other
 * field lives in the client settings-store (localStorage). The cleanup line is
 * read-only: it reports the background-work model, which is chosen elsewhere.
 *
 * Two things it says that the model's name does not
 * (docs/299-direct-provider-calls reqs 5 and 6). **How long a dictation will
 * wait**, because a harness run takes seconds and several seconds of silence
 * after speaking is indistinguishable from a fault. And **the voice key that is
 * not a model provider**: cleanup moved onto the background-work choice, which
 * cannot see a key stored for speech, so the tab offers to adopt it rather than
 * writing a background-work choice the user never made (docs/252-custom-models
 * req 9). Declining leaves cleanup unavailable, and the line then says so.
 */
export function VoiceTab() {
  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const setVoiceInputEnabled = useSettingsStore((s) => s.setVoiceInputEnabled);
  const sttProvider = useSettingsStore((s) => s.sttProvider);
  const setSttProvider = useSettingsStore((s) => s.setSttProvider);
  const cleanupEnabled = useSettingsStore((s) => s.cleanupEnabled);
  const setCleanupEnabled = useSettingsStore((s) => s.setCleanupEnabled);
  const voiceLanguage = useSettingsStore((s) => s.voiceLanguage);
  const setVoiceLanguage = useSettingsStore((s) => s.setVoiceLanguage);
  const voicePlaybackEnabled = useSettingsStore((s) => s.voicePlaybackEnabled);
  const setVoicePlaybackEnabled = useSettingsStore((s) => s.setVoicePlaybackEnabled);
  const ttsProvider = useSettingsStore((s) => s.ttsProvider);
  const setTtsProvider = useSettingsStore((s) => s.setTtsProvider);
  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const setTtsVoice = useSettingsStore((s) => s.setTtsVoice);
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const setTtsSpeed = useSettingsStore((s) => s.setTtsSpeed);
  const voiceDeliveryMode = useSettingsStore((s) => s.voiceDeliveryMode);
  const setVoiceDeliveryMode = useSettingsStore((s) => s.setVoiceDeliveryMode);
  const voiceWebhookConfigured = useSettingsStore((s) => s.voiceWebhookConfigured);
  const setVoiceWebhookConfigured = useSettingsStore((s) => s.setVoiceWebhookConfigured);
  const voiceHandsFree = useSettingsStore((s) => s.voiceHandsFree);
  const setVoiceHandsFree = useSettingsStore((s) => s.setVoiceHandsFree);

  const [configured, setConfigured] = useState<string[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [webhookSavedUrl, setWebhookSavedUrl] = useState<string | null>(null);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [cleanupStatus, setCleanupStatus] = useState<CleanupStatus>({ state: "pending" });
  const [offerDismissed, setOfferDismissed] = useState(false);
  const [adoptBusy, setAdoptBusy] = useState(false);

  const refreshKeyStatus = async () => {
    try {
      const res = await fetch("/api/voice/credentials/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { configured: string[] };
      setConfigured(Array.isArray(data.configured) ? data.configured : []);
    } catch {
      setConfigured([]);
    }
  };

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

  const refreshWebhookStatus = async () => {
    try {
      const res = await fetch("/api/voice/webhook/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { configured: boolean; url: string | null };
      setVoiceWebhookConfigured(data.configured);
      setWebhookSavedUrl(data.url);
      if (data.url) setWebhookUrl(data.url);
    } catch {
      /* leave as-is */
    }
  };

  // eslint-disable-next-line no-restricted-syntax -- one-shot status fetch on mount; the refresh fns are re-created each render and must not re-trigger it
  useEffect(() => {
    void refreshKeyStatus();
    void refreshCleanupStatus();
    void refreshWebhookStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot status fetch on mount; the refresh fns are re-created each render and must not re-trigger it
  }, []);

  const onDeliveryModeChange = async (mode: "native" | "external" | "both") => {
    setVoiceDeliveryMode(mode);
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceDeliveryMode: mode }),
      });
    } catch (err) {
      console.error("[settings] Failed to save voice delivery mode:", err);
    }
  };

  const saveWebhook = async () => {
    setWebhookBusy(true);
    try {
      const res = await fetch("/api/voice/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl.trim(), token: webhookToken.trim() }),
      });
      if (res.ok) {
        setWebhookToken("");
        await refreshWebhookStatus();
      }
    } catch (err) {
      console.error("[settings] Failed to save voice webhook:", err);
    } finally {
      setWebhookBusy(false);
    }
  };

  const clearWebhook = async () => {
    setWebhookBusy(true);
    try {
      await fetch("/api/voice/webhook", { method: "DELETE" });
      setWebhookUrl("");
      setWebhookToken("");
      setWebhookSavedUrl(null);
      setVoiceWebhookConfigured(false);
    } catch (err) {
      console.error("[settings] Failed to clear voice webhook:", err);
    } finally {
      setWebhookBusy(false);
    }
  };

  const onKeyChanged = async () => {
    setTestState("idle");
    setTestMessage(null);
    await refreshKeyStatus();
    await refreshCleanupStatus();
  };

  // The offer stands alone: it already explains why cleanup cannot run, so the
  // unavailable line beside it would say the same thing twice. Declining brings
  // that line back, which is what makes the consequence of declining visible.
  const cleanupOffer = cleanupStatus.state === "ready" && !offerDismissed ? cleanupStatus.offer : null;

  const voices = providerVoices(ttsProvider);
  const speeds = providerSpeeds(ttsProvider);
  const ttsProviderLabel = getVoiceProvider(ttsProvider)?.label ?? ttsProvider;
  const ttsConfigured = configured.includes(ttsProvider);

  const runTest = async () => {
    setTestState("testing");
    setTestMessage(null);
    try {
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Voice is configured correctly.", voice: ttsVoice, speed: ttsSpeed, provider: ttsProvider }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      void audio.play().catch(() => undefined);
      setTestState("ok");
      setTestMessage("Key works — you should hear a test sentence.");
    } catch (err) {
      setTestState("error");
      setTestMessage(err instanceof Error ? err.message : "Test failed");
    }
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-6 overflow-y-auto h-full">
      {/* Provider API keys */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-(--color-text-primary)">Provider API keys</h3>
          <p className="text-xs text-(--color-text-tertiary) mt-0.5">
            Add a key for each provider you use. Keys are stored server-side and never sent back to the browser.
          </p>
        </div>
        {keyRequiringProviders().map((p) => (
          <ProviderKeyField
            key={p.id}
            provider={p}
            configured={configured.includes(p.id)}
            onChanged={onKeyChanged}
          />
        ))}
      </div>

      <div className="border-t border-(--color-border-secondary)" />

      {/* Voice input (dictation) */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Voice input (dictation)</h3>

        <DeclaredToggle
          settingKey="voice.inputEnabled"
          enabled={voiceInputEnabled}
          onToggle={setVoiceInputEnabled}
          testId="voice-input-enabled"
        />

        <div className="space-y-1.5">
          <DeclaredSelect
            settingKey="voice.sttProvider"
            id="stt-provider"
            value={sttProvider}
            onChange={setSttProvider}
            testId="stt-provider"
          />
          {!configured.includes(sttProvider) && (
            <p className="text-xs text-(--color-text-tertiary)">
              Add a {getVoiceProvider(sttProvider)?.label ?? sttProvider} key above to use this provider.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <DeclaredToggle
            settingKey="voice.cleanupEnabled"
            enabled={cleanupEnabled}
            onToggle={setCleanupEnabled}
            testId="voice-cleanup-enabled"
          />
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
        </div>

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

        <DeclaredSelect
          settingKey="voice.language"
          id="voice-language"
          value={voiceLanguage}
          onChange={setVoiceLanguage}
          options={VOICE_LANGUAGES}
          testId="voice-language"
        />
      </div>

      <div className="border-t border-(--color-border-secondary)" />

      {/* Voice playback */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Voice playback</h3>

        <DeclaredToggle
          settingKey="voice.playbackEnabled"
          enabled={voicePlaybackEnabled}
          onToggle={setVoicePlaybackEnabled}
          testId="voice-playback-enabled"
        />

        <div className="space-y-1.5">
          <DeclaredSelect
            settingKey="voice.ttsProvider"
            id="tts-provider"
            value={ttsProvider}
            onChange={setTtsProvider}
            testId="tts-provider"
          />
          {!ttsConfigured && (
            <p className="text-xs text-(--color-text-tertiary)">
              Add a {ttsProviderLabel} key above to use this provider.
            </p>
          )}
        </div>

        {/* The voices are the provider's, so they are values rather than copy —
            the declaration supplies the words and this supplies the list. */}
        <DeclaredSelect
          settingKey="voice.ttsVoice"
          id="tts-voice"
          value={ttsVoice}
          onChange={setTtsVoice}
          options={voices.map((v) => ({ value: v.id, label: v.label }))}
          testId="tts-voice"
        />

        <div className="space-y-1.5">
          <SettingCopy settingKey="voice.ttsSpeed" />
          <div className="flex items-center gap-2" data-testid="tts-speed">
            {speeds.map((s) => (
              <button
                key={s}
                onClick={() => setTtsSpeed(s)}
                aria-label={`Playback speed ${s}×`}
                aria-pressed={ttsSpeed === s}
                {...bindSetting("voice.ttsSpeed")}
                className={`rounded-md border px-3 py-1 text-sm transition-colors ${
                  ttsSpeed === s
                    ? "border-(--color-accent) bg-(--color-accent)/15 text-(--color-text-primary)"
                    : "border-(--color-border-secondary) text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            disabled={!ttsConfigured || testState === "testing"}
            onClick={() => void runTest()}
            data-testid="voice-key-test"
          >
            {testState === "testing" ? "Testing…" : "Test playback"}
          </Button>
          {testMessage && (
            <p className={`text-xs ${testState === "error" ? "text-(--color-error)" : "text-(--color-success)"}`}>{testMessage}</p>
          )}
        </div>
      </div>

      <div className="border-t border-(--color-border-secondary)" />

      {/* Voice notes (docs/163) */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-(--color-text-primary)">Voice notes</h3>
          <p className="text-xs text-(--color-text-tertiary) mt-0.5">
            Short spoken summaries the agent emits when it needs you. Choose how they're delivered.
          </p>
        </div>

        <DeclaredSelect
          settingKey="voice.deliveryMode"
          id="voice-delivery-mode"
          value={voiceDeliveryMode}
          onChange={(mode) => void onDeliveryModeChange(mode as "native" | "external" | "both")}
          testId="voice-delivery-mode"
        />

        <DeclaredToggle
          settingKey="voice.handsFree"
          enabled={voiceHandsFree}
          onToggle={(v) => { setVoiceHandsFree(v); if (v) armAutoplay(); }}
          testId="voice-hands-free"
        />

        {(voiceDeliveryMode === "external" || voiceDeliveryMode === "both") && (
          <div className="space-y-3 rounded-lg border border-(--color-border-secondary) p-3">
            <div>
              <span className="text-sm text-(--color-text-primary)">Webhook</span>
              <p className="text-xs text-(--color-text-tertiary) mt-0.5">
                ShipIt POSTs {"{ v: 1, summary, needsAttention, context }"} with a bearer token. The token is stored server-side and never shown again.
                {voiceWebhookConfigured && webhookSavedUrl ? ` Configured → ${webhookSavedUrl}` : ""}
              </p>
            </div>
            {/* The two boxes are one credential in two halves, so each names
                its own declaration rather than a word the panel invented. */}
            <div className="space-y-1.5">
              <label
                className="block text-xs text-(--color-text-secondary)"
                htmlFor="voice-webhook-url"
                data-setting-label="voice.webhook.url"
              >
                {settingCopy("voice.webhook.url").label}
              </label>
              <input
                id="voice-webhook-url"
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://example.com/voice-notes"
                className={inputClass}
                data-testid="voice-webhook-url"
                {...bindSetting("voice.webhook.url")}
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="block text-xs text-(--color-text-secondary)"
                htmlFor="voice-webhook-token"
                data-setting-label="voice.webhook.token"
              >
                {settingCopy("voice.webhook.token").label}
              </label>
              <input
                id="voice-webhook-token"
                type="password"
                value={webhookToken}
                onChange={(e) => setWebhookToken(e.target.value)}
                placeholder={voiceWebhookConfigured ? "•••••• (leave blank to keep)" : "token"}
                className={inputClass}
                data-testid="voice-webhook-token"
                {...bindSetting("voice.webhook.token")}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="md"
                disabled={webhookBusy || !webhookUrl.trim()}
                onClick={() => void saveWebhook()}
                data-testid="voice-webhook-save"
                {...bindSetting("voice.webhook.url")}
              >
                {webhookBusy ? "Saving…" : "Save webhook"}
              </Button>
              {voiceWebhookConfigured && (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={webhookBusy}
                  onClick={() => void clearWebhook()}
                  data-testid="voice-webhook-clear"
                  aria-label="Remove the voice note webhook"
                  {...bindSetting("voice.webhook.url")}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
