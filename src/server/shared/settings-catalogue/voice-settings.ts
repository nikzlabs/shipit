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

  "voice.webhook": defineSetting({
    key: "voice.webhook",
    tab: "voice",
    scope: "global",
    label: "Voice note webhook",
    description:
      "Where a voice note is POSTed when delivery includes the external mode, with a bearer token "
      + "ShipIt stores and never shows again.",
    type: text({ maxLength: 2_000, noun: "Voice webhook" }),
    store: { kind: "bespoke", ownedBy: "the voice webhook credential (POST /api/voice/webhook)" },
    // The URL and the token are saved together and the token is the reason the
    // pair is unreadable: a card could not show what it replaces.
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;
