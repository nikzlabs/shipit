// eslint-disable-next-line no-restricted-imports -- credential/cleanup status fetch on mount
import { useState, useEffect } from "react";
import { Button } from "../../ui/button.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import {
  sttProviders,
  ttsProviders,
  keyRequiringProviders,
  providerVoices,
  providerSpeeds,
  getVoiceProvider,
} from "../../../../server/shared/voice-catalog.js";
import { armAutoplay } from "../../../voice/voice-notes.js";
import { ToggleSwitch } from "../ToggleSwitch.js";
import { ProviderKeyField } from "../ProviderKeyField.js";
import { inputClass } from "../shared.js";

const VOICE_LANGUAGES: { code: string; label: string }[] = [
  { code: "", label: "Auto (browser locale)" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "ru", label: "Russian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];

const CLEANUP_STATUS_LABELS: Record<string, string> = {
  "claude-oauth": "Cleanup via your Claude subscription",
  "openai-cleanup": "Cleanup via your OpenAI key",
};

/**
 * "Voice" settings tab (docs/144) — dictation + playback. Each provider that
 * needs a credential has its own server-side key (POSTed to
 * /api/voice/credentials, never read back; status is the `configured` id
 * list). STT/TTS providers are chosen from the shared catalog. Every other
 * field lives in the client settings-store (localStorage). The cleanup-provider
 * line is read-only — the orchestrator picks it; the user only sees which runs.
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
  const [cleanupProvider, setCleanupProvider] = useState<string | null>(null);

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
      const data = (await res.json()) as { provider: string | null };
      setCleanupProvider(data.provider);
    } catch {
      setCleanupProvider(null);
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

  // eslint-disable-next-line no-restricted-syntax -- one-shot status fetch on mount
  useEffect(() => {
    void refreshKeyStatus();
    void refreshCleanupStatus();
    void refreshWebhookStatus();
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

  const sttList = sttProviders();
  const ttsList = ttsProviders();
  const voices = providerVoices(ttsProvider);
  const speeds = providerSpeeds(ttsProvider);
  const ttsProviderLabel = getVoiceProvider(ttsProvider)?.label ?? ttsProvider;
  const ttsConfigured = configured.includes(ttsProvider);

  // Verifies the selected playback provider's key by synthesizing one short
  // sentence. A successful TTS round-trip confirms the credential without
  // needing mic permission here.
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

        <div className="flex items-center justify-between gap-4 py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Enable voice input</span>
            <p className="text-xs text-(--color-text-tertiary)">Show the mic button and enable push-to-talk dictation.</p>
          </div>
          <ToggleSwitch enabled={voiceInputEnabled} onToggle={setVoiceInputEnabled} testId="voice-input-enabled" />
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm text-(--color-text-primary)" htmlFor="stt-provider">
            Speech-to-text provider
          </label>
          <select
            id="stt-provider"
            value={sttProvider}
            onChange={(e) => setSttProvider(e.target.value)}
            className={`w-56 ${inputClass}`}
            data-testid="stt-provider"
          >
            {sttList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {!configured.includes(sttProvider) && (
            <p className="text-xs text-(--color-text-tertiary)">
              Add a {getVoiceProvider(sttProvider)?.label ?? sttProvider} key above to use this provider.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-4 py-1">
            <div>
              <span className="text-sm text-(--color-text-primary)">Clean up transcripts with an LLM</span>
              <p className="text-xs text-(--color-text-tertiary)">Fixes mis-hearings, fillers, and casing before the text lands in the box.</p>
            </div>
            <ToggleSwitch enabled={cleanupEnabled} onToggle={setCleanupEnabled} testId="voice-cleanup-enabled" />
          </div>
          {cleanupEnabled && (
            <p className="text-xs text-(--color-text-tertiary)" data-testid="voice-cleanup-status">
              {cleanupProvider
                ? CLEANUP_STATUS_LABELS[cleanupProvider] ?? `Cleanup via ${cleanupProvider}`
                : "No cleanup provider available — raw transcript will be inserted"}
            </p>
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

        <div className="space-y-1.5">
          <label className="block text-sm text-(--color-text-primary)" htmlFor="voice-language">
            Language
          </label>
          <select
            id="voice-language"
            value={voiceLanguage}
            onChange={(e) => setVoiceLanguage(e.target.value)}
            className={`w-56 ${inputClass}`}
            data-testid="voice-language"
          >
            {VOICE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="border-t border-(--color-border-secondary)" />

      {/* Voice playback */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Voice playback</h3>

        <div className="flex items-center justify-between gap-4 py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Enable voice playback</span>
            <p className="text-xs text-(--color-text-tertiary)">Show a Play button on each completed assistant turn.</p>
          </div>
          <ToggleSwitch enabled={voicePlaybackEnabled} onToggle={setVoicePlaybackEnabled} testId="voice-playback-enabled" />
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm text-(--color-text-primary)" htmlFor="tts-provider">
            Text-to-speech provider
          </label>
          <select
            id="tts-provider"
            value={ttsProvider}
            onChange={(e) => setTtsProvider(e.target.value)}
            className={`w-56 ${inputClass}`}
            data-testid="tts-provider"
          >
            {ttsList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {!ttsConfigured && (
            <p className="text-xs text-(--color-text-tertiary)">
              Add a {ttsProviderLabel} key above to use this provider.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm text-(--color-text-primary)" htmlFor="tts-voice">
            Voice
          </label>
          <select
            id="tts-voice"
            value={ttsVoice}
            onChange={(e) => setTtsVoice(e.target.value)}
            className={`w-56 ${inputClass}`}
            data-testid="tts-voice"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <span className="block text-sm text-(--color-text-primary)">Playback speed</span>
          <div className="flex items-center gap-2" data-testid="tts-speed">
            {speeds.map((s) => (
              <button
                key={s}
                onClick={() => setTtsSpeed(s)}
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

        <div className="space-y-1.5">
          <label className="block text-sm text-(--color-text-primary)" htmlFor="voice-delivery-mode">
            Delivery
          </label>
          <select
            id="voice-delivery-mode"
            value={voiceDeliveryMode}
            onChange={(e) => void onDeliveryModeChange(e.target.value as "native" | "external" | "both")}
            className={`w-56 ${inputClass}`}
            data-testid="voice-delivery-mode"
          >
            <option value="native">Native — inline note in ShipIt</option>
            <option value="external">External — webhook only</option>
            <option value="both">Both</option>
          </select>
        </div>

        <div className="flex items-center justify-between gap-4 py-1">
          <div>
            <span className="text-sm text-(--color-text-primary)">Hands-free</span>
            <p className="text-xs text-(--color-text-tertiary)">Autoplay native voice notes (with a chime). Off by default — when off, notes show a tap-to-play prompt.</p>
          </div>
          <ToggleSwitch
            enabled={voiceHandsFree}
            onToggle={(v) => { setVoiceHandsFree(v); if (v) armAutoplay(); }}
            testId="voice-hands-free"
          />
        </div>

        {(voiceDeliveryMode === "external" || voiceDeliveryMode === "both") && (
          <div className="space-y-3 rounded-lg border border-(--color-border-secondary) p-3">
            <div>
              <span className="text-sm text-(--color-text-primary)">Webhook</span>
              <p className="text-xs text-(--color-text-tertiary) mt-0.5">
                ShipIt POSTs {"{ v: 1, summary, needsAttention, context }"} with a bearer token. The token is stored server-side and never shown again.
                {voiceWebhookConfigured && webhookSavedUrl ? ` Configured → ${webhookSavedUrl}` : ""}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs text-(--color-text-secondary)" htmlFor="voice-webhook-url">URL</label>
              <input
                id="voice-webhook-url"
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://example.com/voice-notes"
                className={inputClass}
                data-testid="voice-webhook-url"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs text-(--color-text-secondary)" htmlFor="voice-webhook-token">Bearer token</label>
              <input
                id="voice-webhook-token"
                type="password"
                value={webhookToken}
                onChange={(e) => setWebhookToken(e.target.value)}
                placeholder={voiceWebhookConfigured ? "•••••• (leave blank to keep)" : "token"}
                className={inputClass}
                data-testid="voice-webhook-token"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="md"
                disabled={webhookBusy || !webhookUrl.trim()}
                onClick={() => void saveWebhook()}
                data-testid="voice-webhook-save"
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
