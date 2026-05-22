---
status: planned
priority: medium
description: Native push-to-talk dictation in the message input, BYO STT key, transcript lands in the textarea for the user to review and edit before sending.
---

# Voice input (push-to-talk dictation)

## Goal

Let the user dictate a chat message instead of typing it, without leaving
ShipIt and without running a second app on their machine. The transcript
appears in the message input as if they had typed it, and they review and edit
it before pressing Send.

**Scope is deliberately narrow.** This is dictation, not a voice assistant:

- **In:** speech-to-text into the message input, push-to-talk, manual review
  and edit, BYO API key (or browser Web Speech API for zero-setup).
- **Out (v1):** text-to-speech responses, voice commands ("stop", "submit"),
  wake-word activation, auto-submit on release, always-on streaming.

The product principles in `CLAUDE.md` §5 govern the cut. Dictation is just an
alternate keyboard — the chat is still the input surface, and the user still
hits Send. Voice *commands* would be a shell-shaped affordance and are
explicitly out of scope.

## Why this matters

ShipIt today forces voice users to run a separate app, transcribe in that app,
and paste into the message input. That breaks the "ShipIt is the surface" rule
from §1: the user has to leave to do something the IDE could own. It also
penalises mobile (Android WebView), where on-screen typing is the worst input
modality and voice is the best.

This is the smallest, highest-leverage step toward voice as a first-class
input. We do not need to commit to "voice everywhere in the product" to ship
it — dictation is useful on its own, and the bigger questions (TTS, commands)
can be picked up later as separate features without invalidating this one.

## Key requirement: review-before-send is mandatory

The user's existing voice setup uses a local STT model that **mis-transcribes
often enough that they re-read every dictated message before submitting.**
That is the defining constraint for this feature:

- The transcript MUST land in the existing textarea, not in a separate "voice
  bubble" that auto-sends.
- There is NO "auto-submit on release" toggle in v1. The user presses Send,
  always. We can revisit later if a higher-quality STT provider makes
  auto-submit safe, but defaulting to it would regress the user's workflow.
- The transcript appends at the cursor (or end of existing text), so the user
  can stitch dictation into a partially-typed message and edit freely.
- Backspace, arrow keys, autocomplete (`@`, `/`) all keep working — voice is
  layered on top of the existing textarea, not replacing it.

## Design

### Architecture

Voice input lives **entirely in the browser**. The orchestrator is not
involved in the audio path — audio is captured by `MediaRecorder`, sent to
the chosen STT provider directly, and the resulting transcript is inserted
into the MessageInput state. No new server endpoints, no new WS messages, no
audio streaming through Fastify.

```
[Hold hotkey / press mic]
        ↓
MediaRecorder (browser) → audio/webm;opus chunks
        ↓
STT provider (Web Speech API OR Whisper OR Deepgram, by setting)
        ↓
transcript text
        ↓
MessageInput.setText(prev => spliceAtCursor(prev, transcript))
        ↓
[User reviews, edits, presses Send — existing path]
```

The only persisted state is the user's STT settings (provider, API key,
hotkey, language), stored on the **client** in localStorage via the existing
settings store. Reasons to keep the key client-side:

- ShipIt is open-source and single-user; there is no multi-user secret
  management to bolt onto.
- The audio never goes through the orchestrator, so the key has to be in the
  browser anyway to authorise the request.
- `SecretStore` is per-repo, env-var-shaped (for compose secrets) and the
  wrong primitive here.
- Round-tripping the key through the server adds complexity for no security
  win in an open-source self-hosted product.

The trade-off: the key sits in localStorage, readable by any script that runs
in the page. We accept this for v1; if it becomes an issue we can move the
key to a server-side store and proxy the STT call later without changing the
user-facing UX.

### Providers (BYO key)

Three provider options the user picks in settings. All three speak the same
client-side interface (`captureAndTranscribe(): Promise<string>`); the
provider implementations live behind a small adapter.

| Provider | Key required | Quality | Streaming partials | Browsers | Cost |
|---|---|---|---|---|---|
| **`browser`** (Web Speech API) | no | mediocre, varies by browser | yes (built-in) | Chrome, Edge | free |
| **`whisper`** (OpenAI `/v1/audio/transcriptions`) | yes (OpenAI) | high | no — whole-utterance only | all | ~$0.006/min |
| **`deepgram`** (`/v1/listen` WS) | yes (Deepgram) | high | yes | all | ~$0.0043/min |

Default is `browser` if no key is configured, because it works with zero
setup. The user opts up to Whisper or Deepgram by entering a key.

We can add more providers later (AssemblyAI, Groq Whisper, local Whisper via
WebGPU) without changing the integration surface — the adapter contract is
just "give me audio, give me back a string."

### UX

**Mic button** in MessageInput, placed next to the existing send/stop
buttons. States:

- **idle** — outlined mic icon, tooltip "Hold to record (⌘M)"
- **recording** — filled red mic + pulsing dot, elapsed timer (`00:03`),
  optional inline waveform
- **transcribing** — spinner over the mic icon, "Transcribing…"
- **error** — red exclamation, click for detail (no mic, denied permission,
  STT provider error)

**Push-to-talk gesture:**

- Hold the configured hotkey (default `Cmd/Ctrl+M`, rebindable in settings)
  → record while held → release → transcribe → insert.
- Click and *hold* the mic button → same, for users who prefer the mouse.
- Single click on the mic button → toggle record (start) → click again to
  stop. This is the mobile-friendly path; on desktop the hold gesture is
  primary, click-toggle is fallback.

**Insertion semantics:**

- Transcript is inserted at the current cursor position (or end of text if
  unfocused).
- If text is selected, the transcript replaces the selection.
- A leading space is added if the previous character is a non-space and a
  non-newline, so consecutive dictations don't run words together.
- After insertion, focus returns to the textarea with the cursor placed at
  the end of the inserted text. Send is **not** triggered.

**Permission denial** is non-fatal: show an inline hint ("Microphone access
denied — enable it in your browser settings") and leave the textarea
otherwise functional.

### Settings

New section in `Settings.tsx` titled "Voice input":

- **Enable voice input** — master toggle (default off, so users who don't
  want it never see the mic button).
- **Provider** — radio: Browser (Web Speech API) / OpenAI Whisper / Deepgram.
- **API key** — text field, shown only for whisper/deepgram. Stored in
  localStorage. Validation: a "Test" button does a 1-second mic capture +
  transcribe round-trip and reports success or the provider's error message.
- **Hotkey** — key-capture input, default `Cmd/Ctrl+M`. Rebindable. Conflict
  detection against the existing app hotkeys.
- **Language** — dropdown (default: browser locale). Passed to the provider
  as the language hint where supported.

Settings live in the existing client `settings-store.ts` (Zustand +
localStorage), alongside `notifyOnFinish`, `liveSteering`, etc. No server
persistence needed; the settings move with the browser, which is the right
mental model for a per-device input modality (microphone choice differs by
device).

### Client implementation sketch

New module `src/client/voice/`:

```
voice/
  index.ts              barrel + types
  use-voice-input.ts    React hook: state machine, hotkey listener, mic capture
  providers/
    types.ts            VoiceProvider interface
    browser.ts          Web Speech API adapter
    whisper.ts          POST audio to OpenAI /v1/audio/transcriptions
    deepgram.ts         WS streaming to wss://api.deepgram.com/v1/listen
  insert-transcript.ts  pure: splice transcript into textarea state
```

`useVoiceInput()` returns:

```ts
{
  state: "idle" | "recording" | "transcribing" | "error",
  elapsedMs: number,           // for the timer UI
  errorMessage: string | null,
  startRecording: () => void,
  stopRecording: () => void,
  onTranscript: (cb: (text: string) => void) => () => void,
}
```

The hook is plugged into `MessageInput.tsx`: on transcript, call
`insertAtCursor(textareaRef, text, setText)`. The hook also owns the hotkey
listener so MessageInput doesn't grow a third concern; it activates only
when the message input is focused (or per global setting — to be decided
during build).

The MicButton itself is a thin presentational component reading
`state`/`elapsedMs` from the hook.

### Android WebView

The Android wrapper (`android/`) needs two small changes:

1. `AndroidManifest.xml` — declare `RECORD_AUDIO` permission.
2. `WebChromeClient.onPermissionRequest(request)` — grant
   `PermissionRequest.RESOURCE_AUDIO_CAPTURE` after asking the user (standard
   Android runtime permission flow).

Without this, `getUserMedia` silently fails inside the WebView. This is the
single most-impactful piece of the feature on mobile and easy to forget.

Voice is the killer feature on mobile, so the Android pathway is part of v1
scope, not a follow-up. See `docs/116-android-webview-app/` for the wrapper
shape; the manifest/permission changes ride along with the next Android
build.

### No orchestrator changes

We are intentionally *not* adding:

- A WS message type for voice input
- An HTTP endpoint to proxy STT
- A secret-store entry for the STT key
- Any change to the agent process / system prompt

If any of those become necessary later (e.g. to hide a shared ShipIt-provided
key in a hosted variant), they can be added without rewriting the client.

## Out of scope (v1)

These are explicitly excluded — captured here so future readers know they
were considered, not forgotten:

- **Text-to-speech responses.** The agent does not speak back. May be a
  follow-up doc; the architecture in this one doesn't preclude it.
- **Voice commands** ("stop", "submit", "approve"). Violates §5 of
  `CLAUDE.md` for general commands. A tiny vocabulary (just "stop the
  current turn") might be defensible later; not now.
- **Auto-submit on release.** Explicitly rejected by the user's workflow —
  transcripts need review. Revisit only if a future provider has high enough
  fidelity that the user opts back in.
- **Wake-word activation** ("Hey ShipIt"). Always-on mic is a privacy
  surface we don't want to commit to in v1.
- **Streaming partials into the textarea while still recording.** Possible
  with Deepgram and Web Speech API; deferred because it complicates the
  edit-cursor story (where does the cursor go if the user edits while
  partials are still updating?). Whole-utterance insert on release is
  simpler and good enough for v1.
- **Local on-device STT** (e.g. WebGPU Whisper). Interesting for offline use
  and privacy; deferred until provider abstraction proves the integration
  point is clean.
- **Server-side proxying of STT.** Not needed for v1; revisit if the
  open-source product gains a hosted variant where shared keys make sense.
- **Multi-language switching mid-utterance.** Single language per session,
  set in settings. Auto-detect is a provider feature where available; we
  pass it through but don't try to do better.

## Key files

To be created:

- `src/client/voice/use-voice-input.ts` — the hook (state machine, capture,
  hotkey listener)
- `src/client/voice/providers/{types,browser,whisper,deepgram}.ts` — provider
  adapters
- `src/client/voice/insert-transcript.ts` — pure transcript-splicing helper
- `src/client/components/MicButton.tsx` — presentational mic UI
- `src/client/voice/*.test.ts` — unit tests for `insertAtCursor`, hotkey
  handling, provider error mapping

To be modified:

- `src/client/components/MessageInput.tsx` — embed MicButton, wire the hook,
  route transcript to `setText`
- `src/client/stores/settings-store.ts` — add `voiceInputEnabled`, `sttProvider`,
  `sttApiKey`, `voiceHotkey`, `voiceLanguage` fields and setters
- `src/client/utils/local-storage.ts` — persisters for the new settings
- `src/client/components/Settings.tsx` — new "Voice input" section
- `android/app/src/main/AndroidManifest.xml` — add `RECORD_AUDIO`
- `android/app/src/main/java/.../MainActivity.kt` (or equivalent) — handle
  `WebChromeClient.onPermissionRequest`

## Testing

Where Vitest can reach:

- **`insert-transcript.test.ts`** — pure logic, cursor splicing, selection
  replacement, leading-space heuristic
- **`use-voice-input.test.ts`** — state machine transitions with
  `MediaRecorder` mocked, hotkey hold/release behaviour, provider error
  surfacing
- **Provider tests** — each adapter against a fake fetch / fake WS

Manual QA covers the parts Vitest can't:

- Real mic capture in Chrome (Web Speech path)
- Whisper round-trip with a real key
- Deepgram streaming session
- Android WebView mic permission flow on a physical device
- Hotkey conflict scenarios with the existing app hotkeys

## Open questions to settle during build

1. **Hotkey scope.** Active only when the textarea is focused, or globally
   inside ShipIt? Global is more convenient ("start dictating from
   anywhere") but risks clashing with other shortcuts and surprising the
   user. Default: focused-only, with a setting for global.
2. **What happens to a partial recording on session switch?** Suggested: abort
   the recording, drop the audio, surface a toast. Easy to implement, hard to
   abuse.
3. **Error UX for "key invalid".** Inline error on the mic button vs. a toast
   vs. opening Settings. Probably inline + a "Fix in settings" link.
4. **Should the textarea visually indicate which text was dictated?** Probably
   not in v1 — once it's in the textarea it's just text the user can edit.
   Adding a styled span complicates the editing model.

## Effort estimate

Rough sizing assuming the standard ShipIt workflow (tests co-located,
typecheck/lint clean, no surprises):

| Step | Effort |
|---|---|
| `voice/` module + browser provider + MicButton + MessageInput wiring | 1–2 days |
| Settings UI + localStorage persistence | 0.5 day |
| Whisper provider | 0.5 day |
| Deepgram streaming provider | 1 day |
| Android WebView permission wiring | 0.5 day |
| Tests + manual QA + polish (waveform, timer, error states) | 1–2 days |

**Total: ~1 week for v1 as designed.** A "smaller dogfood" cut (browser
provider only, no settings UI, no Android) is ~2 days, but locks the user
out of higher-quality providers and mobile — not worth shipping as the
first cut.
