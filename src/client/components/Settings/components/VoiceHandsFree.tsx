/**
 * Hands-free autoplay (docs/308-data-driven-settings inventory.md P3, req 3).
 *
 * It is a component for one reason: **a browser unlocks audio only inside the
 * click gesture**, so `armAutoplay()` has to run in the handler itself. A
 * generated toggle awaits its write and does nothing else — which is exactly
 * right for every other row and would leave this one switched on with playback
 * silent until the next click.
 *
 * Nothing else about it is custom: the switch, the words and the write are the
 * ones every declared boolean gets.
 */

import { armAutoplay } from "../../../voice/voice-notes.js";
import { useSetting } from "../declared-setting.js";
import { DeclaredToggle } from "../declared.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

export function VoiceHandsFree({ settingKey }: { settingKey: SettingKey }) {
  const { value, set } = useSetting(settingKey);
  return (
    <DeclaredToggle
      settingKey={settingKey}
      enabled={value === true}
      onToggle={(enabled) => {
        // Before the write, and synchronously: the gesture is what the browser
        // is granting on, and an await would end it.
        if (enabled) armAutoplay();
        void set(enabled);
      }}
      testId="voice-hands-free"
    />
  );
}
