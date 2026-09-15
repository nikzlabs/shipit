import {
  configuredOnly,
  defineSetting,
  derived,
  itemAddress,
  plain,
  userText,
} from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import { collection, enumOf, numeric, text } from "./value-types.js";

/**
 * The **Model providers** tab (docs/299-agent-settings-access, plan.md → Scope
 * inventory). Its panel is bespoke, so every editable field is declared
 * separately: one entry for "the credential rows" would let a field be added,
 * bound to it, and shipped with no description, no projection rule and no
 * refusal reason.
 *
 * The background-work model pin is not here — it is a single stored value, so it
 * is declared with the other global scalars in `global-settings.ts`.
 */

const MODE_ADDRESS = itemAddress("a service and billing mode, e.g. anthropic:sub");
const CREDENTIAL_ADDRESS = itemAddress("a credential id");
const ACCOUNT_ADDRESS = itemAddress("a provider and account id");
const PROVIDER_ADDRESS = itemAddress("a provider, e.g. claude");

/** Ids only, whatever the caller holds — a routing order is about position. */
function idsOnly(raw: unknown): unknown {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry : (entry as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === "string");
}

export const SERVICES_SETTINGS = {
  "services.credentials": defineSetting({
    key: "services.credentials",
    tab: "services",
    scope: "global",
    address: MODE_ADDRESS,
    label: "Credentials",
    description:
      "The keys and tokens ShipIt bills this service's models to, in the order it tries them. The "
      + "service and the billing mode are the address, not fields: they are chosen when a "
      + "credential is added and a credential does not move between them. "
      + "Under \"Use in order\" new sessions start on the first with quota left; the order is the "
      + "fallback sequence either way.",
    type: collection<string>({ operations: ["add", "remove", "reorder"], patchableFields: ["label"] }),
    store: { kind: "bespoke", ownedBy: "credential routes (PUT /api/credential-routes/:service/:mode/order)" },
    emits: derived("the credential ids, in the order they are tried", idsOnly, {
      shipItComputed: "An id is generated when a credential is added; the label beside it is the user's own text and is emitted by `services.credentials[].label`, which is marked as such.",
    }),
    propose: { kind: "yes" },
  }),

  "services.accountSelectionMode": defineSetting({
    key: "services.accountSelectionMode",
    tab: "services",
    scope: "global",
    address: MODE_ADDRESS,
    label: "How ShipIt picks between these credentials",
    // Deliberately says nothing the two options do not, because the band has no
    // room for a description paragraph and renders them instead: novel copy here
    // would be explanation the agent reads and the user cannot (req 7).
    description: "Which credential a new session starts on. Each option explains itself.",
    // The band renders these two option descriptions as the tooltip on each
    // segment (`Settings/CredentialRouting.tsx`), so the sentence the user reads
    // there and the one the agent reads here are one sentence (req 7). They are
    // worded around "credentials", which is what the setting stores; a card
    // showing provider accounts swaps that noun and edits nothing else.
    type: enumOf({
      default: "strict",
      options: [
        {
          value: "strict",
          label: "Use in order",
          description:
            "New sessions start on the first credential with quota left. Best when they differ — "
            + "a bigger plan first, a smaller one as backup.",
        },
        {
          value: "balanced",
          label: "Spread across credentials",
          description:
            "New sessions go to whichever credential has been used least, so quota drains evenly. "
            + "Best when they are equivalent.",
        },
      ],
    }),
    store: { kind: "bespoke", ownedBy: "credential-store.accountSelectionMode, keyed by (service, billing mode)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "services.failoverCutoff.session": defineSetting({
    key: "services.failoverCutoff.session",
    tab: "services",
    scope: "global",
    address: MODE_ADDRESS,
    label: "Short window cutoff",
    description:
      "Start new work on the next credential once one passes this share of its short (5h) quota. "
      + "Credentials past their cutoff are still used when no other is below one, so nothing is "
      + "stranded. Offered only where the service reports a quota.",
    type: numeric({ default: 90, min: 1, max: 100, integer: true, unit: "%" }),
    store: { kind: "bespoke", ownedBy: "credential-store.failoverCutoffs, keyed by (service, billing mode)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "services.failoverCutoff.weekly": defineSetting({
    key: "services.failoverCutoff.weekly",
    tab: "services",
    scope: "global",
    address: MODE_ADDRESS,
    label: "Weekly cutoff",
    description:
      "Start new work on the next credential once one passes this share of its weekly (7d) quota. "
      + "Credentials past their cutoff are still used when no other is below one.",
    type: numeric({ default: 90, min: 1, max: 100, integer: true, unit: "%" }),
    store: { kind: "bespoke", ownedBy: "credential-store.failoverCutoffs, keyed by (service, billing mode)" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "services.credentials[].label": defineSetting({
    key: "services.credentials[].label",
    tab: "services",
    scope: "global",
    address: CREDENTIAL_ADDRESS,
    label: "Credential name",
    description: "What this credential is called in the list. Renaming touches nothing else.",
    type: text({ maxLength: 200, noun: "Credential name", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "credential routes (PATCH /api/credential-routes/:id)" },
    emits: userText("The name the user gave their own credential, which is how they refer to it."),
    // Renaming needs no sign-in: `Settings/ServicesPanel.tsx:805`.
    propose: { kind: "yes" },
  }),

  "services.credentials[].secret": defineSetting({
    key: "services.credentials[].secret",
    tab: "services",
    scope: "global",
    address: CREDENTIAL_ADDRESS,
    label: "API key",
    description:
      "The provider key or token this credential delivers. Never sent back to the browser, and "
      + "delivered to a session only as the environment variable the harness reads.",
    type: text({ maxLength: 4_000, noun: "API key" }),
    store: { kind: "bespoke", ownedBy: "credential routes (POST /api/credential-routes, PATCH …/:routeId `secret`)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "secret" },
  }),

  "services.providerAccounts[].connection": defineSetting({
    key: "services.providerAccounts[].connection",
    tab: "services",
    scope: "global",
    address: ACCOUNT_ADDRESS,
    label: "Provider account",
    description:
      "A subscription account signed in through the provider's own login flow. ShipIt reports "
      + "whether it is connected and whether it is usable, never its tokens.",
    type: text({ maxLength: 200, noun: "Provider account" }),
    store: { kind: "bespoke", ownedBy: "provider accounts (POST /api/provider-accounts, then the provider's own login flow)" },
    emits: configuredOnly(),
    propose: { kind: "no", reason: "external_flow" },
  }),

  "services.providerAccounts[].label": defineSetting({
    key: "services.providerAccounts[].label",
    tab: "services",
    scope: "global",
    address: ACCOUNT_ADDRESS,
    label: "Account name",
    description: "What this provider account is called in the list. Renaming needs no sign-in.",
    type: text({ maxLength: 200, noun: "Account name", required: true, trim: true }),
    store: { kind: "bespoke", ownedBy: "provider accounts (PATCH /api/provider-accounts/:provider/:accountId)" },
    emits: userText("The name the user gave their own account, which is how they refer to it."),
    // `Settings/ProviderAccountRows.tsx:761` — a rename is a label write, not a login.
    propose: { kind: "yes" },
  }),

  "services.providerAccounts": defineSetting({
    key: "services.providerAccounts",
    tab: "services",
    scope: "global",
    address: PROVIDER_ADDRESS,
    label: "Provider accounts",
    description:
      "The subscription accounts signed in for this provider, in the order ShipIt tries them. "
      + "Connecting one is the provider's own sign-in; the order and a disconnect are not.",
    type: collection<string>({ operations: ["disconnect", "reorder"], patchableFields: ["label"] }),
    store: { kind: "bespoke", ownedBy: "provider accounts (PUT /api/provider-accounts/:provider/order)" },
    emits: derived("the account ids, in the order they are tried", idsOnly, {
      shipItComputed: "An account id comes from the provider's own sign-in; the label beside it is the user's own text and is emitted by `services.providerAccounts[].label`, which is marked as such.",
    }),
    propose: { kind: "yes" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;
