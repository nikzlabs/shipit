/**
 * One server-side API key per speech provider (docs/308-data-driven-settings
 * inventory.md P11, req 3).
 *
 * `voice.providerKey` is **addressed by a provider and belongs to no collection
 * declaration**, so this list is its owner: the renderer must not treat an
 * addressed declaration as a standalone row, and there is no panel above it to
 * repeat it. Like a panel, it keeps its own writer — the write is addressed
 * (`{ provider, apiKey }`) and has operations a value writer has no shape for,
 * Save and Clear per provider — while the words on screen stay the
 * declaration's.
 */

// eslint-disable-next-line no-restricted-imports -- external system sync: which keys the server holds, read once when the list appears
import { useEffect } from "react";
import { keyRequiringProviders } from "../../../../server/shared/voice-catalog.js";
import { useVoiceKeyStatus } from "../../../voice/voice-key-status.js";
import { ProviderKeyField } from "../ProviderKeyField.js";
import { settingCopy } from "../setting-copy.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

export function VoiceProviderKeys({ settingKey }: { settingKey: SettingKey }) {
  const configured = useVoiceKeyStatus((s) => s.configured);
  const refresh = useVoiceKeyStatus((s) => s.refresh);

  // eslint-disable-next-line no-restricted-syntax -- one-shot status fetch on mount; the store action is stable
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-(--color-text-tertiary)">
        {settingCopy(settingKey).description}
      </p>
      {keyRequiringProviders().map((provider) => (
        <ProviderKeyField
          key={provider.id}
          provider={provider}
          configured={configured.includes(provider.id)}
          onChanged={refresh}
        />
      ))}
    </div>
  );
}
