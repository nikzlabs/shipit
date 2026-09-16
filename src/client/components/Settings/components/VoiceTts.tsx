/**
 * The text-to-speech provider, the voice it speaks in and the speed it speaks
 * at — one control over three declarations (docs/308-data-driven-settings
 * inventory.md P3 and P7, req 3).
 *
 * **Changing the provider repairs the other two**, which is why they are one
 * component: a voice belongs to the provider that offers it, and the speeds an
 * install offers come from the provider too, so a provider switch that left the
 * old voice behind would ask for a voice that provider does not have. A
 * generated row's writer awaits its response and does nothing else, so a write
 * with a follow-up of its own cannot be one (P3).
 *
 * Each write still goes where its own declaration says, through the same writer
 * every row uses: what is custom here is the repair and the option lists, never
 * the destination (req 3). The voice is declared `text` because its choices are
 * the install's rather than the catalogue's (P7), and this is where they come
 * from.
 */

import { useState } from "react";
import { Button } from "../../ui/button.js";
import {
  defaultVoiceFor,
  getVoiceProvider,
  isValidVoice,
  providerSpeeds,
  providerVoices,
} from "../../../../server/shared/voice-catalog.js";
import { useVoiceKeyStatus } from "../../../voice/voice-key-status.js";
import { saveSetting, useSetting } from "../declared-setting.js";
import { DeclaredSelect, SettingCopy } from "../declared.js";
import { bindSettingOption, settingCopy } from "../setting-binding.js";

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const PROVIDER = "voice.ttsProvider";
const VOICE = "voice.ttsVoice";
const SPEED = "voice.ttsSpeed";

export function VoiceTts() {
  const provider = asText(useSetting(PROVIDER).value);
  const { value: voiceValue, set: setVoice } = useSetting(VOICE);
  const voice = asText(voiceValue);
  const { value: speedValue } = useSetting(SPEED);
  const speed = typeof speedValue === "number" ? speedValue : 1;

  const configured = useVoiceKeyStatus((s) => s.configured.includes(provider));
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const voices = providerVoices(provider);
  const speeds = providerSpeeds(provider);
  const providerLabel = getVoiceProvider(provider)?.label ?? provider;

  /*
    The repair, and the reason this is a component. Each of the three is written
    by `saveSetting` under its own declaration, so the store, the storage key and
    the record all still come from the catalogue — only the decision to write
    them together is here.
  */
  const changeProvider = (next: string) => {
    void saveSetting(PROVIDER, next);
    if (!isValidVoice(next, voice)) void saveSetting(VOICE, defaultVoiceFor(next));
    const nextSpeeds = providerSpeeds(next);
    if (!nextSpeeds.includes(speed)) {
      void saveSetting(SPEED, nextSpeeds.includes(1) ? 1 : nextSpeeds[0]);
    }
  };

  const runTest = async () => {
    setTestState("testing");
    setTestMessage(null);
    try {
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Voice is configured correctly.", voice, speed, provider }),
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
    <div className="space-y-4">
      <div className="space-y-1.5">
        <DeclaredSelect
          settingKey={PROVIDER}
          id="tts-provider"
          value={provider}
          onChange={changeProvider}
          testId="tts-provider"
        />
        {!configured && (
          <p className="text-xs text-(--color-text-tertiary)">
            Add a {providerLabel} key above to use this provider.
          </p>
        )}
      </div>

      {/* The voices are the provider's, so they are values rather than copy —
          the declaration supplies the words and this supplies the list. */}
      <DeclaredSelect
        settingKey={VOICE}
        id="tts-voice"
        value={voice}
        onChange={setVoice}
        options={voices.map((v) => ({ value: v.id, label: v.label }))}
        testId="tts-voice"
      />

      <div className="space-y-1.5">
        <SettingCopy settingKey={SPEED} />
        {/* A named group, because the speeds are one choice over one field —
            which is what `settings-coverage.test.tsx` counts them as. */}
        <div
          className="flex items-center gap-2"
          role="group"
          aria-label={settingCopy(SPEED).label}
          data-testid="tts-speed"
        >
          {speeds.map((s) => (
            <button
              key={s}
              onClick={() => { void saveSetting(SPEED, s); }}
              aria-label={`Playback speed ${s}×`}
              aria-pressed={speed === s}
              {...bindSettingOption(SPEED, String(s))}
              className={`rounded-md border px-3 py-1 text-sm transition-colors ${
                speed === s
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
          disabled={!configured || testState === "testing"}
          onClick={() => void runTest()}
          data-testid="voice-key-test"
        >
          {testState === "testing" ? "Testing…" : "Test playback"}
        </Button>
        {testMessage && (
          <p className={`text-xs ${testState === "error" ? "text-(--color-error)" : "text-(--color-success)"}`}>
            {testMessage}
          </p>
        )}
      </div>
    </div>
  );
}
