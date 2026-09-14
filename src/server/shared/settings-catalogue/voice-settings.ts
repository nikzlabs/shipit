import { configuredOnly, defineSetting, itemAddress } from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import { text } from "./value-types.js";

/**
 * What the **Voice** tab stores on the server (docs/299-agent-settings-access,
 * plan.md → Scope inventory). The delivery mode is a single stored value and is
 * declared with the global scalars; everything else on that tab is either a
 * credential, declared here, or browser-local, declared in `browser-settings.ts`.
 */

export const VOICE_SETTINGS = {
  "voice.providerKey": defineSetting({
    key: "voice.providerKey",
    tab: "voice",
    scope: "global",
    address: itemAddress("a speech provider id, e.g. openai"),
    label: "Provider API key",
    description:
      "A key for a speech provider, used to transcribe dictation and to speak voice notes. Stored "
      + "server-side and never sent back to the browser.",
    type: text({ maxLength: 4_000, noun: "Speech provider key" }),
    store: { kind: "bespoke", ownedBy: "the voice credentials (POST /api/voice/credentials)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  "voice.webhook.url": defineSetting({
    key: "voice.webhook.url",
    tab: "voice",
    scope: "global",
    label: "Voice note webhook URL",
    description:
      "Where a voice note is POSTed when delivery includes the external mode. It is half of one "
      + "credential — the bearer token is the other half — so ShipIt reports only whether the "
      + "webhook is configured.",
    type: text({ maxLength: 2_000, noun: "Voice webhook URL" }),
    store: { kind: "bespoke", ownedBy: "the voice webhook credential (POST /api/voice/webhook)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  "voice.webhook.token": defineSetting({
    key: "voice.webhook.token",
    tab: "voice",
    scope: "global",
    label: "Voice note webhook bearer token",
    description:
      "Sent as the bearer token on every voice-note POST. Saving with it left blank keeps the "
      + "stored one; ShipIt never shows it again.",
    type: text({ maxLength: 4_000, noun: "Voice webhook token" }),
    store: { kind: "bespoke", ownedBy: "the voice webhook credential (POST /api/voice/webhook)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;
