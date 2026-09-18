import { configuredOnly, defineSetting, itemAddress } from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import { text } from "./value-types.js";

/**
 * What the **Voice** tab stores on the server (docs/299-agent-settings-access,
 * plan.md → Scope inventory). The delivery mode is a single stored value and is
 * declared with the global scalars; everything else on that tab is either a
 * credential, declared here, or browser-local, declared in `browser-settings.ts`.
 */

/**
 * The two webhook halves share ONE address: they are one credential written in
 * one request, so both name the same path and differ only in the body field
 * they occupy (docs/308-data-driven-settings plan.md → Slices → 4). A GET of
 * the same path answers the url; nothing answers the token, which is what
 * `configuredOnly` already says about it.
 */
const WEBHOOK_PATH = "/api/voice/webhook";

/**
 * The rank that puts **Voice notes** last on the tab, so **Provider API keys**
 * leads it — the key is what every other section on the tab needs first.
 *
 * It is carried by all four of that section's declarations, across three files,
 * because a section is placed by the first of its rows and `voice.handsFree` is
 * declared in `browser-settings.ts`. One of the four could not do it alone:
 * `voice.deliveryMode` is a payload scalar and cannot leave `GLOBAL_SETTINGS`,
 * which is the registry's first source (`types.ts` → `order`).
 */
export const VOICE_NOTES_ORDER = 1;

export const VOICE_SETTINGS = {
  "voice.providerKey": defineSetting({
    key: "voice.providerKey",
    tab: "voice",
    section: "Provider API keys",
    // Addressed by a provider and belonging to no collection declaration, so the
    // list that repeats it over the key-requiring providers is its owner
    // (docs/308-data-driven-settings inventory.md P11). Its write is per
    // provider and has a second body field, which is why the list keeps it.
    component: "voice-provider-keys",
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
    section: "Voice notes",
    order: VOICE_NOTES_ORDER,
    component: "voice-webhook",
    scope: "global",
    label: "Voice note webhook URL",
    description:
      "Where a voice note is POSTed when delivery includes the external mode. The body is "
      + "{ v: 1, summary, needsAttention, context }. It is half of one credential — the bearer "
      + "token is the other half — so ShipIt reports only whether the webhook is configured.",
    type: text({ maxLength: 2_000, noun: "Voice webhook URL" }),
    store: { kind: "own-route", method: "POST", path: WEBHOOK_PATH, bodyField: "url" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  "voice.webhook.token": defineSetting({
    key: "voice.webhook.token",
    tab: "voice",
    section: "Voice notes",
    order: VOICE_NOTES_ORDER,
    component: "voice-webhook",
    scope: "global",
    label: "Voice note webhook bearer token",
    description:
      "Sent as the bearer token on every voice-note POST. Saving with it left blank keeps the "
      + "stored one; ShipIt never shows it again.",
    type: text({ maxLength: 4_000, noun: "Voice webhook token" }),
    store: { kind: "own-route", method: "POST", path: WEBHOOK_PATH, bodyField: "token" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;
