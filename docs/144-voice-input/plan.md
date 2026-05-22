---
status: planned
priority: medium
description: Native push-to-talk dictation in the message input. BYO STT key stored server-side; transcript lands in the textarea for the user to review and edit before sending.
---

# Voice input (push-to-talk dictation)

## Goal

Let the user dictate a chat message instead of typing it, without leaving
ShipIt and without running a second app on their machine. The transcript
appears in the message input as if they had typed it, and they review and
edit it before pressing Send.

**Scope is deliberately narrow.** This is dictation, not a voice assistant:

- **In:** speech-to-text into the message input, push-to-talk, manual review
  and edit, BYO API key.
- **Out (v1):** text-to-speech responses, voice commands ("stop", "submit"),
  wake-word activation, auto-submit on release, always-on streaming, mid-utterance
  partials in the textarea.

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
  always.
- The transcript appends at the cursor (or end of existing text), so the user
  can stitch dictation into a partially-typed message and edit freely.
- Backspace, arrow keys, autocomplete (`@`, `/`) all keep working — voice is
  layered on top of the existing textarea, not replacing it.

This requirement is **enforced by the type system**, not by convention. The
voice hook only exposes a transcript callback typed as
`(text: string) => void`, and the only call site is
`setText(spliceAtCursor(prev, text))`. The hook is never given a reference
to the send action, so a future contributor cannot wire auto-submit without
deliberately redesigning the contract.

## Design

### Architecture

```
[Hold hotkey / tap mic]
        ↓
MediaRecorder (browser) → audio/webm;opus, ~250ms chunks
        ↓
POST /api/voice/transcribe (orchestrator)
        ↓
   orchestrator adds Authorization header from server-stored key
        ↓
STT provider (OpenAI Whisper for v1)
        ↓
{ text: "..." }
        ↓
MessageInput.setText(prev => spliceAtCursor(prev, transcript))
        ↓
[User reviews, edits, presses Send — existing path]
```

Audio capture and the textarea splice happen in the browser; the STT API key
lives **server-side** in a small new store and is never returned to the
client. The browser does not hold the key in memory or in localStorage.

This mirrors the existing GitHub-token pattern (`/api/github/token`):
client posts the credential once, the server holds it, the server makes the
authenticated upstream call on the client's behalf. It's a known shape in
ShipIt and the right shape here.

### Why not localStorage for the key

ShipIt renders agent output — markdown, tool output, MCP responses — into
the page. An XSS via agent-rendered HTML would exfiltrate any
localStorage-resident credential, and paid STT keys (Whisper, future
providers) are exactly the sort of thing that costs the user money if
leaked. The mitigation cost is a single small server endpoint, which is
trivial relative to the rest of the feature. We pay it.

The audio itself goes through the orchestrator as well; this gives us a
natural place to add per-user rate-limiting and cost caps later without
touching the client.

### Why not Web Speech API as a zero-setup default

The earlier draft of this doc proposed Chrome/Edge's `webkitSpeechRecognition`
as a "free, zero-setup, browser-local" default. That framing is **misleading**:
Chromium's implementation streams audio to Google's servers. It is not local,
the user is just not paying a key fee. Defaulting to it without consent would
silently send chat-prompt audio off-device, which is exactly the failure mode
the user is trying to avoid by running a local STT app today.

For v1 the only built-in provider is **OpenAI Whisper** (BYO key). The
adapter layer is designed so we can add more later (Deepgram, AssemblyAI,
local Whisper via WebGPU, Web Speech with explicit consent) without changing
the client integration.

### Providers

Single provider in v1:

| Provider | Auth | Quality | Audio path | Notes |
|---|---|---|---|---|
| **`whisper`** (OpenAI `/v1/audio/transcriptions`) | BYO key, server-stored | high | browser → orchestrator → OpenAI | whole-utterance request/response, no streaming partials |

Provider abstraction lives in `src/server/orchestrator/voice/providers/*.ts`,
contract: `transcribe(audio: Buffer, opts): Promise<string>`. Adding a new
provider means a new adapter file plus a settings option.

Deferred for follow-ups:

- **Deepgram streaming WS.** Requires a server-side WS proxy (the key cannot
  be in the URL the browser opens). Worth doing once we have a real demand
  for streaming partials.
- **Web Speech API.** Useful for users who explicitly opt in to Google-cloud
  STT. Has a different internal shape (no MediaRecorder, native API returns
  text directly), so it lives outside the server-proxy path and needs a
  separate consent flow in the UI.
- **Local on-device STT** (WebGPU Whisper). Interesting for offline use; the
  integration point would be the same browser-side `useVoiceInput` hook with
  a "no upload" code path.

### Hotkey: avoiding the macOS minefield

`Cmd+M` minimizes the browser window on macOS — the page never sees the
keydown. The original draft picked it as default; it is unusable. v1 uses:

- **Desktop default:** hold **`Ctrl+Shift+Space`** (push-to-talk). Captured
  cleanly by the page on macOS, Linux, and Windows. Rebindable in settings
  with conflict-detection against existing app hotkeys.
- **Mobile default:** the mic button is the only affordance — no hotkey
  equivalent.

### Push-to-talk state machine

Held-key recording is more subtle than "keydown → record, keyup → stop." The
hook must handle:

| Event | Behaviour |
|---|---|
| `keydown` with `event.repeat === true` | Ignore (autorepeat — first keydown already started recording) |
| Recording started, `keyup` arrives | Stop recording, transcribe |
| Recording started, **window `blur`** | Stop recording, transcribe (user tabbed away) |
| Recording started, **`visibilitychange` to hidden** | Stop recording, transcribe |
| Recording started, **focus moves to an iframe or other window** | Stop recording, transcribe |
| Recording started, **session switch** | Abort recording, discard captured audio, do not insert anything |
| Recording duration < 250 ms | Discard, do not call the STT API (accidental tap) |
| Recording duration > 60 s | Cap at 60 s, stop, transcribe (defensive — prevents runaway capture if keyup is lost permanently) |
| STT call fails | Set hook state to `error`, surface inline error on the mic button, do not insert anything |

`onkeyup` is unreliable when focus moves away mid-press, which is why
`blur` + `visibilitychange` are first-class events in this state machine,
not edge cases.

### UX

**Mic button** in MessageInput, placed next to the existing send/stop
buttons, only rendered when voice input is enabled in settings. States:

- **idle** — outlined mic icon, tooltip "Hold Ctrl+Shift+Space to record"
- **recording** — filled red mic + pulsing dot, elapsed timer (`00:03`)
- **transcribing** — spinner over the mic icon, "Transcribing…"
- **error** — red exclamation, click reveals detail (no mic, denied
  permission, provider error, key invalid) and a "Fix in settings" shortcut

**Gestures (resolved):** desktop and mobile use *different* primary
gestures, picked for what each device does well, and we accept the small
cognitive cost of that split:

- **Desktop:** hold the hotkey (PTT). Click on the mic button is a
  **toggle** (start → click again to stop). Click-and-hold on the button is
  not supported — the gesture is fiddly and the toggle path is clearer.
- **Mobile:** tap the mic to start, tap again to stop. No hotkey path.

**Insertion semantics:**

- Transcript inserted at the current cursor position, or end of text if the
  textarea is unfocused.
- If text is selected, the transcript replaces the selection.
- A leading space is added when the previous character is a non-space
  non-newline, so consecutive dictations don't run words together.
- After insertion, focus returns to the textarea with the cursor placed at
  the end of the inserted text. Send is **not** triggered.

**Permission denial** is non-fatal: show an inline hint ("Microphone access
denied — enable it in your browser settings") and leave the textarea
otherwise functional.

**Interaction with draft persistence.** MessageInput already saves drafts
per-session to localStorage on every keystroke. Whole-utterance insertion
(no mid-utterance partials in v1) means dictation triggers exactly one
`setText` call per recording, which the existing draft-save effect picks
up unchanged. No new draft-handling code is needed.

### Threat model

The threat we are mitigating is **exfiltration of a paid STT API key by
malicious content rendered in the page**.

The agent emits markdown, tool output, and (via MCP) third-party content.
Markdown is sanitized by the existing rendering pipeline, but the surface
is large and any future regression that allows arbitrary `<script>` or
`onerror=` would let attacker-controlled content read anything from
`localStorage` / `sessionStorage`. STT keys (OpenAI in particular) are
unattended-purchase credentials — exfiltration means real money lost.

Mitigations:

- **Key never touches the browser.** Stored in a new server-side table,
  written via `POST /api/voice/credentials`, read only by the server when
  proxying STT calls. The client API for "do you have a key configured" is
  a boolean status endpoint, not the key itself.
- **Audio goes through the orchestrator**, so the browser never opens an
  authenticated connection to OpenAI. Even a script that observes
  `fetch` calls sees only the orchestrator's own endpoint.
- **No GET for the credential.** The endpoint accepts POST (set) and DELETE
  (clear), and returns a redacted-status response on read. There is no way
  to retrieve the stored key from the client.

Residual risks accepted:

- **Audio content is sensitive.** Dictated prompts may include proprietary
  code, API keys read aloud, etc. The orchestrator sees the audio briefly
  in memory; OpenAI receives it under the user's account. This is the same
  risk profile as the user typing the same content into the chat — we are
  not changing the trust boundary, just adding an input modality.
- **Orchestrator compromise is fatal.** Whoever runs the orchestrator can
  see the key. This is fine because (a) ShipIt is single-user
  self-hosted and (b) it matches the existing GitHub-token threat model.

### Settings

New section in `Settings.tsx` titled "Voice input":

- **Enable voice input** — master toggle (default off, so users who don't
  want it never see the mic button or the orchestrator endpoint surface).
- **Provider** — radio (v1: just "OpenAI Whisper"; structured to expand).
- **API key** — text field, POSTed to `/api/voice/credentials` on save.
  Status shown as "Key configured ✓" or "Not set" — the key itself is
  never read back. A "Test" button does a short mic capture + transcribe
  round-trip and reports success or the provider's error message.
- **Hotkey** — key-capture input, default `Ctrl+Shift+Space`. Rebindable.
  Conflict-detection against existing app hotkeys.
- **Language** — dropdown (default: browser locale). Passed to the
  provider as a language hint where supported.

Non-credential settings (enabled, provider name, hotkey, language) live in
the existing client `settings-store.ts` (Zustand + localStorage). Only the
credential itself is server-side.

### Client implementation sketch

New module `src/client/voice/`:

```
voice/
  index.ts              barrel + types
  use-voice-input.ts    React hook: state machine, hotkey listener, mic capture
  capture.ts            MediaRecorder wrapper, blob assembly
  insert-transcript.ts  pure: splice transcript into textarea state
```

`useVoiceInput()` returns:

```ts
{
  state: "idle" | "recording" | "transcribing" | "error",
  elapsedMs: number,                          // for the timer UI
  errorMessage: string | null,
  startRecording: () => void,
  stopRecording: () => void,
  onTranscript: (cb: (text: string) => void) => () => void,
  //          ^ Locked to text-only. The hook has no concept of "send".
}
```

The hook owns the keydown/keyup/blur/visibilitychange listeners and the
state machine described above. It activates only when voice input is
enabled in settings. It is the single source of truth for recording
state — MicButton and any other UI just read from it.

### Server-side additions

The orchestrator already has the right primitives for everything we need:

- **Credential storage** — `CredentialStore` (`credential-store.ts`) already
  holds account-level secrets like `githubToken` in a `CredentialData` object.
  We add a single `voiceProviderApiKey?: string` field (plus optionally
  `voiceProvider?: "whisper"` for forward compatibility). No new store, no
  schema migration — this is the same shape as adding any other credential
  ShipIt has shipped to date.
- **Routes** — follow the `api-routes-github.ts` / `services/github.ts` split
  the codebase already uses. New files: `api-routes-voice.ts` (HTTP), service
  layer at `services/voice.ts` (business logic that composes the credential
  store and the provider adapter). Routes call services; services call
  providers. Pure functions, testable in isolation. This is the pattern
  documented in `CLAUDE.md` "Service layer pattern" and is non-negotiable —
  routes that bypass the service layer are a known anti-pattern.
- **Provider adapter** — new module `voice/providers/whisper.ts` that takes a
  `Buffer` and a key, returns text.

New HTTP routes (registered via the existing dispatcher in `api-routes.ts`):

- `POST /api/voice/credentials` — body: `{ provider: "whisper", apiKey: string }`. Stores the key on `CredentialStore`. Returns `{ ok: true }`.
- `DELETE /api/voice/credentials` — clears the stored key.
- `GET /api/voice/credentials/status` — returns `{ configured: boolean, provider?: string }`. Never returns the key.
- `POST /api/voice/transcribe` — multipart body with `audio` file part and `language` field. Service-layer function loads the key from `CredentialStore`, calls the provider adapter, returns `{ text: string }`. On provider error returns the upstream status code + a sanitized error message via `ServiceError`.

CORS: not an issue because the audio call now goes orchestrator→OpenAI
(server-side). OpenAI's CORS posture is irrelevant for our path.

### Android WebView

The Android wrapper (`android/`) needs two small changes:

1. `android/app/src/main/AndroidManifest.xml`:
   - Add `<uses-permission android:name="android.permission.RECORD_AUDIO" />`
   - Add `<uses-feature android:name="android.hardware.microphone" android:required="false" />` so Play Store filtering doesn't exclude mic-less devices.
2. `android/app/src/main/java/com/shipit/wrapper/MainActivity.kt` (verify exact path during build): override `WebChromeClient.onPermissionRequest(request)` to grant `PermissionRequest.RESOURCE_AUDIO_CAPTURE` after the standard Android runtime-permission flow.

Without this, `getUserMedia` silently fails inside the WebView.

Voice is the killer feature on mobile, so the Android pathway is in v1
scope. See `docs/116-android-webview-app/` for the wrapper architecture.

## Out of scope (v1)

Captured here so future readers know they were considered, not forgotten:

- **Text-to-speech responses.** The agent does not speak back. May be a
  follow-up doc; the architecture here doesn't preclude it.
- **Voice commands** ("stop", "submit", "approve"). Violates §5 of
  `CLAUDE.md`.
- **Auto-submit on release.** Explicitly rejected by the user's workflow.
- **Wake-word activation.** Always-on mic is a privacy surface we won't
  commit to in v1.
- **Streaming partials into the textarea while still recording.** Possible
  with Deepgram or Web Speech; deferred because it complicates the
  edit-cursor model (where does the cursor go if the user edits while
  partials are still arriving?). Whole-utterance insert on release is
  simpler and the v1 user can review the result before sending anyway.
- **Local on-device STT** (WebGPU Whisper). Deferred until provider
  abstraction has proven the integration point is clean.
- **Web Speech API provider.** Available in the architecture but not in v1
  because it would require its own consent flow ("this sends your audio to
  Google") that we don't want to ship under time pressure.
- **Deepgram / AssemblyAI streaming.** Deferred — requires a server WS
  proxy (the key can't go in the URL the browser opens) and the streaming
  partials they're known for are already out of scope.
- **Per-dictation undo as a discrete action.** Standard browser undo
  (Cmd/Ctrl+Z) covers character-level undo of the inserted block — that
  is sufficient for v1.
- **Multi-language switching mid-utterance.** Single language per session,
  set in settings. Auto-detect is provider-dependent; we pass it through
  where available but don't try to improve on it.

## Key files

### Client (new)

- `src/client/voice/use-voice-input.ts` — hook (state machine, capture, hotkey listener)
- `src/client/voice/capture.ts` — MediaRecorder wrapper
- `src/client/voice/insert-transcript.ts` — pure transcript-splicing helper
- `src/client/components/MicButton.tsx` — presentational mic UI
- `src/client/voice/*.test.ts` — unit tests

### Client (modified)

- `src/client/components/MessageInput.tsx` — embed MicButton, wire the hook, route transcript to `setText`
- `src/client/stores/settings-store.ts` — add `voiceInputEnabled`, `sttProvider`, `voiceHotkey`, `voiceLanguage` fields and setters (no `sttApiKey` — that's server-side)
- `src/client/utils/local-storage.ts` — persisters for the new non-credential settings
- `src/client/components/Settings.tsx` — new "Voice input" section

### Server (new)

- `src/server/orchestrator/voice/providers/types.ts` — `VoiceProvider` interface
- `src/server/orchestrator/voice/providers/whisper.ts` — OpenAI adapter
- `src/server/orchestrator/voice/index.ts` — barrel for provider exports
- `src/server/orchestrator/services/voice.ts` — service layer (loads credential, calls provider, returns transcript). Mirrors the shape of `services/github.ts`.
- `src/server/orchestrator/api-routes-voice.ts` — HTTP routes that call into `services/voice.ts`

### Server (modified)

- `src/server/orchestrator/credential-store.ts` — add `voiceProviderApiKey?: string` (and `voiceProvider?: "whisper"`) to `CredentialData`
- `src/server/orchestrator/api-routes.ts` — register the new routes module
- `src/server/orchestrator/services/index.ts` — re-export voice service
- `src/server/orchestrator/app-di.ts` — wire the voice provider factory. `CredentialStore` is already in DI; no new manager needed.

### Android (modified)

- `android/app/src/main/AndroidManifest.xml` — `RECORD_AUDIO`, `uses-feature microphone`
- `android/app/src/main/java/com/shipit/wrapper/MainActivity.kt` — `WebChromeClient.onPermissionRequest`

## Testing

Vitest (unit / integration):

- **`insert-transcript.test.ts`** — pure logic, cursor splicing, selection replacement, leading-space heuristic.
- **`use-voice-input.test.ts`** — state machine transitions with `MediaRecorder` mocked, hotkey hold/release behaviour, autorepeat suppression, blur/visibilitychange handling, 250 ms minimum and 60 s cap, session-switch abort.
- **`whisper.test.ts`** — provider adapter against a fake fetch, error mapping.
- **`voice-routes.test.ts`** — integration test for `/api/voice/credentials` (set/clear/status round-trip), `/api/voice/transcribe` (multipart audio → fake provider → returned text), error paths (no key, provider failure).
- **`MicButton.test.tsx`** — render in each state, click behaviour.

Manual QA covers the parts Vitest can't:

- Real mic capture in Chrome / Firefox / Safari on desktop.
- Whisper round-trip with a real OpenAI key.
- Android WebView mic permission flow on a physical device (Pixel + a mid-tier device).
- Hotkey conflict scenarios on macOS / Windows / Linux (Cmd+Tab during recording, alt-tab, screen lock).

## Open questions to settle during build

1. **Hotkey scope.** Active only when the textarea is focused, or globally
   inside ShipIt? Default: focused-only, with a setting for global. Global
   risks clashing with browser shortcuts; revisit if users ask for it.
2. **Error UX detail level.** How verbose should the inline error be? E.g.
   "OpenAI returned 429 rate limit" vs "Couldn't transcribe — try again."
   Probably the latter, with a console log of the upstream detail.
3. **Audio format.** `audio/webm;opus` works in Chrome/Firefox; Safari
   produces `audio/mp4` from MediaRecorder. Whisper accepts both. Validate
   on Safari during build.

## Effort estimate

| Step | Effort |
|---|---|
| Server: credentials store + routes + Whisper proxy + tests | 1.5 days |
| Client: `voice/` module, MediaRecorder capture, state machine, hotkey, tests | 2.5 days |
| Client: MicButton, MessageInput wiring | 0.5 day |
| Client: Settings UI + localStorage settings | 0.5 day |
| Android: manifest + WebChromeClient permission | 0.5 day |
| Cross-browser manual QA (Chrome / Firefox / Safari / Android) | 1 day |
| Polish: timer, error states, edge-case state-machine bugs found in QA | 1.5 days |

**Total: ~1.5 weeks for v1 as designed.** This is the realistic floor; the
state-machine edge cases (blur during recording, autorepeat, session
switch mid-utterance) are exactly the kind of thing that absorbs an extra
day or two in QA.
