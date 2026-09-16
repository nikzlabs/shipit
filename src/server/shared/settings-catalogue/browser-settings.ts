import { sttProviders, ttsProviders } from "../voice-catalog.js";
import { defineSetting, itemAddress, withheld } from "./types.js";
import type { AnySettingDeclaration } from "./types.js";
import { bool, collection, enumOf, numeric, text } from "./value-types.js";

/**
 * The part of both dialogs that lives in `localStorage`
 * (`client/utils/local-storage.ts`), declared so that req 5 holds: a setting a
 * dialog shows and this feature cannot reach is still named, with the reason.
 *
 * **These are named and explained, nothing more.** Read and propose both refuse
 * with `browser_local`, and the read says *set in the browser; ShipIt's server
 * does not hold this value* — the honest limitation, not a gap to paper over.
 * Two shapes were tried and dropped in design: per-viewer snapshots, which give
 * "this browser" no server-side meaning with two open, and a browser-side apply,
 * which has no baseline and would need a grant protocol with a tab that can
 * close (plan.md → Browser-local settings).
 *
 * A `type` is still declared, because `get` may say what shape the value has
 * even when it may not say what the value is.
 */

const BROWSER_LOCAL = withheld("browser_local");
const NOT_PROPOSABLE = { kind: "no", reason: "browser_local" } as const;

/**
 * The languages the Voice tab offers for dictation. Declared rather than written
 * in `Settings/tabs/VoiceTab.tsx`, because a static option set is part of the
 * setting and `get` is the detail of a setting whatever the setting is (req 1).
 * Being browser-local withholds the current SELECTION; it says nothing about the
 * choices, which are ShipIt's own copy.
 */
const DICTATION_LANGUAGES = [
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
] as const;

export const BROWSER_SETTINGS = {
  "keyboard.keybindings": defineSetting({
    key: "keyboard.keybindings",
    tab: "keyboard",
    scope: "browser",
    label: "Keyboard shortcuts",
    description:
      "The chord bound to each ShipIt command. Editor keys like Enter and Esc are fixed. Saved "
      + "for this browser.",
    type: collection<string>({ operations: ["set", "reset"], patchableFields: [] }),
    store: { kind: "browser", localStorageKey: "shipit-keybindings" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "keyboard.keybindings[].chord": defineSetting({
    key: "keyboard.keybindings[].chord",
    tab: "keyboard",
    scope: "browser",
    address: itemAddress("a ShipIt command id, e.g. voice-mode-a"),
    label: "Shortcut",
    description:
      "The keys bound to one command. A chord that another command already uses is refused, and a "
      + "command that opens quick-capture or the mic needs a second modifier.",
    type: text({ maxLength: 64, noun: "Shortcut" }),
    store: { kind: "browser", localStorageKey: "shipit-keybindings" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.inputEnabled": defineSetting({
    key: "voice.inputEnabled",
    tab: "voice",
    scope: "browser",
    label: "Enable voice input",
    description: "Show the mic button and enable push-to-talk dictation.",
    type: bool({ default: false }),
    store: { kind: "browser", localStorageKey: "shipit-voice-input-enabled" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.sttProvider": defineSetting({
    key: "voice.sttProvider",
    tab: "voice",
    scope: "browser",
    label: "Speech-to-text provider",
    description:
      "Which provider transcribes dictation. It needs a key, and the key is a server-side setting "
      + "of its own.",
    type: enumOf({
      default: "openai",
      options: sttProviders().map((provider) => ({ value: provider.id, label: provider.label })),
    }),
    store: { kind: "browser", localStorageKey: "shipit-stt-provider" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.cleanupEnabled": defineSetting({
    key: "voice.cleanupEnabled",
    tab: "voice",
    scope: "browser",
    label: "Clean up transcripts with an LLM",
    description: "Fixes mis-hearings, fillers, and casing before the text lands in the box.",
    type: bool({ default: true }),
    store: { kind: "browser", localStorageKey: "shipit-voice-cleanup-enabled" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.language": defineSetting({
    key: "voice.language",
    tab: "voice",
    scope: "browser",
    label: "Language",
    description:
      "The language dictation is transcribed as, chosen from the dozen the tab offers. Empty "
      + "follows the browser's locale.",
    type: enumOf({ default: "", options: DICTATION_LANGUAGES }),
    store: { kind: "browser", localStorageKey: "shipit-voice-language" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.playbackEnabled": defineSetting({
    key: "voice.playbackEnabled",
    tab: "voice",
    scope: "browser",
    label: "Enable voice playback",
    description: "Show a Play button on each completed assistant turn.",
    type: bool({ default: false }),
    store: { kind: "browser", localStorageKey: "shipit-voice-playback-enabled" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.ttsProvider": defineSetting({
    key: "voice.ttsProvider",
    tab: "voice",
    scope: "browser",
    label: "Text-to-speech provider",
    description: "Which provider speaks a voice note. It needs a key of its own.",
    type: enumOf({
      default: "openai",
      options: ttsProviders().map((provider) => ({ value: provider.id, label: provider.label })),
    }),
    store: { kind: "browser", localStorageKey: "shipit-tts-provider" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.ttsVoice": defineSetting({
    key: "voice.ttsVoice",
    tab: "voice",
    scope: "browser",
    label: "Voice",
    description:
      "Which of the provider's voices speaks. The choices are that provider's voices, so changing "
      + "provider re-picks it.",
    type: text({ maxLength: 64, default: "alloy", noun: "Voice" }),
    store: { kind: "browser", localStorageKey: "shipit-tts-voice" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.ttsSpeed": defineSetting({
    key: "voice.ttsSpeed",
    tab: "voice",
    scope: "browser",
    label: "Playback speed",
    description: "How fast a voice note is spoken. The offered speeds come from the provider.",
    type: numeric({ default: 1, min: 0.25, max: 4 }),
    store: { kind: "browser", localStorageKey: "shipit-tts-speed" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "voice.handsFree": defineSetting({
    key: "voice.handsFree",
    tab: "voice",
    scope: "browser",
    label: "Hands-free",
    description:
      "Autoplay native voice notes, with a chime. Off by default — when off, a note shows a "
      + "tap-to-play prompt.",
    type: bool({ default: false }),
    store: { kind: "browser", localStorageKey: "shipit-voice-hands-free" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "advanced.compactConversation": defineSetting({
    key: "advanced.compactConversation",
    tab: "advanced",
    section: "Conversation",
    scope: "browser",
    label: "Compact completed turns",
    description:
      "Collapse every turn but the newest to your message and the last agent reply. Tool calls, "
      + "progress messages and cards are hidden; errors stay, and so does a card that still needs "
      + "you.",
    type: bool({ default: false }),
    store: { kind: "browser", localStorageKey: "shipit-compact-conversation" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "advanced.notifyOnFinish": defineSetting({
    key: "advanced.notifyOnFinish",
    tab: "advanced",
    section: "Notifications",
    scope: "browser",
    label: "Browser notification",
    description: "Show a desktop notification when the tab is in the background.",
    type: bool({ default: true }),
    store: { kind: "browser", localStorageKey: "shipit-notify-on-finish" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),

  "advanced.soundOnFinish": defineSetting({
    key: "advanced.soundOnFinish",
    tab: "advanced",
    section: "Notifications",
    scope: "browser",
    label: "Sound",
    description: "Play a chime when a session needs attention.",
    type: bool({ default: true }),
    store: { kind: "browser", localStorageKey: "shipit-sound-on-finish" },
    emits: BROWSER_LOCAL,
    propose: NOT_PROPOSABLE,
  }),
} as const satisfies Record<string, AnySettingDeclaration>;
