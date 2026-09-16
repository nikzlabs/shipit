import type { VoiceDeliveryMode } from "../types/voice-note-types.js";
import { DEFAULT_VOICE_DELIVERY_MODE } from "../types/voice-note-types.js";
import { bool, enumOf, gitIdentity, modelSelection, numeric, text } from "./value-types.js";
import { defineSetting, isPayloadDeclaration, plain, userText } from "./types.js";
import type {
  AnyPayloadDeclaration,
  AnySettingDeclaration,
  NonPayloadStore,
  SettingValue,
} from "./types.js";

/**
 * Every global setting stored as a single value. Labels and descriptions are the
 * words the dialog shows, so the agent and the user read the same thing (req 7).
 *
 * Only the settings stored ONCE are here, because only those derive the payload.
 * A setting a panel of its own owns — a collection, a per-service routing map,
 * a project or a browser value — is declared beside its panel
 * (`services-settings.ts` and its siblings) and reaches the agent through
 * `registry.ts`.
 */
export const GLOBAL_SETTINGS = {
  "advanced.enableSubAgents": defineSetting({
    key: "advanced.enableSubAgents",
    tab: "advanced",
    section: "Agent",
    scope: "global",
    label: "Allow spawning another agent for a sub-task",
    description:
      "Lets the agent in a session spawn another agent for a one-shot sub-task (e.g. a "
      + "second-opinion review from a different model). The spawned agent runs with full tool "
      + "access and its work is committed under your session's agent. Enabling this means a "
      + "session container can briefly hold credentials for both agents.",
    type: bool({ default: true }),
    store: { kind: "credential-store", field: "enableSubAgents" },
    wire: "enableSubAgents",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "advanced.liveSteering": defineSetting({
    key: "advanced.liveSteering",
    tab: "advanced",
    section: "Agent",
    scope: "global",
    label: "Inject messages mid-turn",
    description:
      "Send a message while the agent is running to steer it without waiting for the turn to "
      + "finish. On by default — it also keeps the agent process alive across interrupts so "
      + "answering an AskUserQuestion or continuing after a stop works cleanly. Toggle off to "
      + "return to the queue-based mode (one process per turn).",
    type: bool({ default: true }),
    store: { kind: "credential-store", field: "liveSteering" },
    wire: "liveSteering",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "advanced.autoFixCi": defineSetting({
    key: "advanced.autoFixCi",
    tab: "advanced",
    section: "Automation",
    scope: "global",
    label: "Auto-fix CI when checks fail",
    description:
      "When a PR's checks fail and the agent isn't busy, fetches the failing logs and asks the "
      + "agent to fix them. Retries up to three times per commit.",
    type: bool({ default: false }),
    store: { kind: "credential-store", field: "autoFixCi" },
    wire: "autoFixCi",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "advanced.sessionStatusCard": defineSetting({
    key: "advanced.sessionStatusCard",
    tab: "advanced",
    section: "Agent",
    scope: "global",
    label: "Session status card",
    description:
      "Shows an agent-written card just above the composer with what the session is about, "
      + "what needs you, and the follow-up actions the agent offers. While it is on, the agent "
      + "offers actions through that card instead of the follow-up-actions card.",
    type: bool({ default: false }),
    store: { kind: "credential-store", field: "sessionStatusCard" },
    wire: "sessionStatusCard",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "advanced.autoResolveConflicts": defineSetting({
    key: "advanced.autoResolveConflicts",
    tab: "advanced",
    section: "Automation",
    scope: "global",
    label: "Auto-resolve conflicts when the base branch moves",
    description:
      "Detects when the PR can no longer merge cleanly. When the agent isn't busy, runs a rebase "
      + "and asks the agent to fix any conflicts. Force-pushes the result.",
    type: bool({ default: false }),
    store: { kind: "credential-store", field: "autoResolveConflicts" },
    wire: "autoResolveConflicts",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "advanced.autoResetMergedBranch": defineSetting({
    key: "advanced.autoResetMergedBranch",
    tab: "advanced",
    section: "Automation",
    scope: "global",
    label: "Start from the latest base after a merge",
    description:
      "When you continue a session whose PR already merged and the branch hasn't moved since, "
      + "this does two things before the next turn: resets the branch to the latest base, so the "
      + "agent builds on current code, and compacts the agent's context, so the shipped work stops "
      + "filling it. A per-message checkbox lets you skip either one for any one send.",
    type: bool({ default: true }),
    store: { kind: "credential-store", field: "autoResetMergedBranch" },
    wire: "autoResetMergedBranch",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "advanced.memoryBudgetMb": defineSetting({
    key: "advanced.memoryBudgetMb",
    tab: "advanced",
    scope: "global",
    label: "Memory budget",
    description:
      "Memory ShipIt may use in total, in MB — sessions, previews and all. Inside the budget "
      + "nothing is stopped for being idle, so an idle session keeps its preview running. Over it, "
      + "the longest-idle session gives up its agent container first, its preview only if that was "
      + "not enough. Null follows this install's default — half the machine on a local install, "
      + "the whole machine on a server. The dialog shows the same value in GB.",
    // No minimum: a value under 1 MB has always meant "unset", not a refusal.
    type: numeric({ default: null, nullable: true, unsetBelow: 1, integer: true, unit: "MB" }),
    store: { kind: "credential-store", field: "memoryBudgetMb" },
    wire: "memoryBudgetMb",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "advanced.releaseChannel": defineSetting({
    key: "advanced.releaseChannel",
    tab: "advanced",
    scope: "global",
    label: "Release channel",
    description: "Which ShipIt releases this install follows.",
    type: enumOf({
      default: "stable",
      options: [
        // "Recommended" rides in the option's own words: the dialog renders
        // these, so a badge beside them would be copy with no declaration.
        { value: "stable", label: "Stable", description: "Vetted releases, fewer updates. Recommended." },
        { value: "edge", label: "Edge", description: "Latest changes from main, updated continuously." },
      ],
    }),
    store: { kind: "own-route", route: "POST /api/updates/channel" },
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "integrations.autoCreatePr": defineSetting({
    key: "integrations.autoCreatePr",
    tab: "integrations",
    scope: "global",
    label: "Auto-create PR after every meaningful turn",
    description:
      "When the agent finishes a turn that changes files, ShipIt opens a pull request "
      + "automatically.",
    type: bool({ default: false }),
    store: { kind: "credential-store", field: "autoCreatePr" },
    wire: "autoCreatePr",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "git.identity": defineSetting({
    key: "git.identity",
    tab: "git",
    scope: "global",
    label: "Git identity",
    description: "Git identity used for automatic commits in all sessions.",
    type: gitIdentity(),
    store: { kind: "git-config" },
    wire: "gitIdentity",
    emits: userText("The name and email the user chose for their own commits."),
    propose: { kind: "yes" },
  }),

  "instructions.userInstructions": defineSetting({
    key: "instructions.userInstructions",
    tab: "instructions",
    scope: "global",
    label: "Your Instructions",
    description:
      "Custom instructions sent to the agent with every message. Use them to define project "
      + "conventions, preferred libraries, or style guidelines.",
    type: text({ maxLength: 50_000, noun: "System prompt", trim: true }),
    store: { kind: "system-prompt-file", promptScope: "standard" },
    wire: "systemPrompt",
    emits: userText("The user's own instructions, shown because they are theirs."),
    propose: { kind: "yes" },
  }),

  "instructions.opsInstructions": defineSetting({
    key: "instructions.opsInstructions",
    tab: "instructions",
    scope: "global",
    label: "Ops Session Instructions",
    description:
      "Sent in an ops session instead of Your Instructions, which can contradict the read-only "
      + "host-debugging contract an ops session already carries. Leave it empty to send no "
      + "instructions of your own in an ops session.",
    type: text({ maxLength: 50_000, noun: "Ops session prompt", trim: true }),
    store: { kind: "system-prompt-file", promptScope: "ops" },
    wire: "systemPromptOps",
    emits: userText("The user's own instructions, shown because they are theirs."),
    propose: { kind: "yes" },
  }),

  "instructions.agentInstructionsEnabled": defineSetting({
    key: "instructions.agentInstructionsEnabled",
    tab: "instructions",
    scope: "global",
    label: "ShipIt Agent Instructions",
    description:
      "Built-in context sent with every message to help the agent understand the ShipIt "
      + "environment.",
    type: bool({ default: true }),
    store: { kind: "credential-store", field: "agentSystemInstructionsEnabled" },
    wire: "agentSystemInstructionsEnabled",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "voice.deliveryMode": defineSetting({
    key: "voice.deliveryMode",
    tab: "voice",
    scope: "global",
    label: "Delivery",
    description: "Where a voice note goes when the agent records one.",
    type: enumOf({
      default: DEFAULT_VOICE_DELIVERY_MODE,
      options: [
        { value: "native", label: "Native — inline note in ShipIt" },
        { value: "external", label: "External — webhook only" },
        { value: "both", label: "Both" },
      ],
    }),
    store: { kind: "credential-store", field: "voiceDeliveryMode" },
    wire: "voiceDeliveryMode",
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "services.nonTurnModel": defineSetting({
    key: "services.nonTurnModel",
    tab: "services",
    scope: "global",
    label: "Background work",
    description:
      "What ShipIt runs for its own work, such as naming a session or writing a pull-request "
      + "description. Null follows the install instead of pinning a model.",
    type: modelSelection(),
    store: { kind: "credential-store", field: "nonTurnModel" },
    wire: "nonTurnModel",
    // The payload has always omitted an unset pin; clients read null as "clear this".
    omitWhenNull: true,
    emits: plain(),
    propose: { kind: "yes" },
  }),

  "network.egressContained": defineSetting({
    key: "network.egressContained",
    tab: "network",
    scope: "global",
    label: "Contain outbound network access",
    description:
      "On (recommended): default-deny egress with an allowlist and inline prompts. Off: "
      + "unrestricted egress, no prompts. Applies the next time each session's container starts.",
    type: bool({ default: true }),
    store: { kind: "own-route", route: "PUT /api/egress/settings" },
    emits: plain(),
    propose: { kind: "yes" },
  }),
} as const satisfies Record<string, AnySettingDeclaration>;

export type GlobalSettingsCatalogue = typeof GLOBAL_SETTINGS;
export type GlobalSettingKey = keyof GlobalSettingsCatalogue;

type Catalogue = Record<string, AnySettingDeclaration>;

// Keyed on the store, the same discriminant `isPayloadDeclaration` uses at
// runtime: a type that promised a field the server omits would be worse than none.
type PayloadKeyOf<C extends Catalogue> = {
  [K in keyof C]: C[K]["store"] extends NonPayloadStore ? never : K;
}[keyof C];

type RequiredPayloadKeyOf<C extends Catalogue> = {
  [K in PayloadKeyOf<C>]: C[K] extends { readonly omitWhenNull: true } ? never : K;
}[PayloadKeyOf<C>];

type WireOf<D> = D extends { readonly wire: infer W extends string } ? W : never;

type Prettify<T> = { [K in keyof T]: T[K] };

/**
 * The half of `GlobalSettings` that is stored rather than computed. Generic over
 * the catalogue so the derivation can be exercised against one a test builds:
 * adding a declaration adds the field, with no second edit (req 7).
 */
export type StoredSettingsOf<C extends Catalogue> = Prettify<
  {
    [K in RequiredPayloadKeyOf<C> as WireOf<C[K]>]: SettingValue<C[K]>;
  } & {
    [K in Exclude<PayloadKeyOf<C>, RequiredPayloadKeyOf<C>> as WireOf<C[K]>]?:
      Exclude<SettingValue<C[K]>, null>;
  }
>;

export type StoredGlobalSettings = StoredSettingsOf<GlobalSettingsCatalogue>;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// Dropping a delivery-mode option would still satisfy the store's accessor and
// silently narrow what ShipIt can deliver, so pin the two to the same set.
type _DeliveryModesMatchTheStoredType =
  Exact<SettingValue<GlobalSettingsCatalogue["voice.deliveryMode"]>, VoiceDeliveryMode>;

/**
 * The `PUT /api/settings` body. Every field is optional — a save carries only
 * what changed — and null stays in range, because clearing a pin is a value.
 */
export type GlobalSettingsPatch = {
  [K in PayloadKeyOf<GlobalSettingsCatalogue> as WireOf<GlobalSettingsCatalogue[K]>]?:
    SettingValue<GlobalSettingsCatalogue[K]>;
};

export const GLOBAL_SETTING_KEYS = Object.keys(GLOBAL_SETTINGS) as GlobalSettingKey[];

/**
 * The persisted field names, derived from the declarations rather than listed
 * beside them: adding a setting must not need a second registration (req 7).
 */
export type CredentialStoreSettingField = {
  [K in GlobalSettingKey]: GlobalSettingsCatalogue[K]["store"] extends
    { readonly kind: "credential-store"; readonly field: infer F } ? F : never;
}[GlobalSettingKey];

/** The declarations `CredentialStore` persists. */
export type CredentialStoreSettingKey = {
  [K in GlobalSettingKey]: GlobalSettingsCatalogue[K]["store"] extends { readonly kind: "credential-store" }
    ? K
    : never;
}[GlobalSettingKey];

export function credentialStoreField(key: CredentialStoreSettingKey): CredentialStoreSettingField {
  const { store } = GLOBAL_SETTINGS[key];
  // Narrowed by CredentialStoreSettingKey; the cast is what the index loses.
  return (store as { kind: "credential-store"; field: CredentialStoreSettingField }).field;
}

/**
 * Every declaration the global settings payload reads and writes. Enumerated at
 * call time: the registry is the source of truth, not a list snapshotted beside it.
 */
export function payloadDeclarations(): AnyPayloadDeclaration[] {
  return (Object.values(GLOBAL_SETTINGS) as AnySettingDeclaration[]).filter(isPayloadDeclaration);
}
