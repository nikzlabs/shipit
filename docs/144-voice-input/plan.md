---
status: in-progress
priority: medium
description: Two-way voice integration. Input — push-to-talk dictation with an LLM cleanup pass (fixes mis-hearings, fillers, capitalisation) before the transcript lands in the textarea. Mode A targets the current MessageInput, Mode B the quick-capture overlay from doc 145. Output — per-assistant-turn Play button that streams TTS of the response so the user can listen while walking around. Cleanup defaults to the user's Claude subscription, falls back to the OpenAI voice key.
---

# Voice integration (dictation + playback)

## Goal

Let the user *talk to* ShipIt and *listen to* ShipIt, without leaving the
app and without running a separate voice tool on the side.

Two directions, one feature:

- **Input — dictation.** Hold a hotkey (or tap a mic button) to dictate
  a chat message. The transcript appears in a textarea — the current
  session's input *or* a quick-capture overlay's input — and the user
  reviews and edits it before pressing Send.
- **Output — playback.** Each completed assistant turn gets a Play
  button. Press it to hear the response read aloud. Designed for the
  "I'm walking around, I want to hear the design doc I just asked for"
  case: eyes-off review of long-form prose.

**Scope is deliberately narrow** for both directions. This is dictation
+ playback, not a voice assistant:

- **In:** push-to-talk speech-to-text into a chat-input textarea with
  manual review-before-send; manual-play TTS of completed assistant
  turns; BYO API key shared between STT and TTS.
- **Out (v1):** voice commands ("stop", "submit"), wake-word activation,
  auto-submit on release, always-on streaming dictation, mid-utterance
  partials displayed in the textarea, auto-play of new assistant turns
  without the user pressing Play.

The product principles in `CLAUDE.md` §5 govern the cut. Dictation is
just an alternate keyboard — the chat is still the input surface, and
the user still hits Send. Playback is just an alternate reader — the
user still chooses what to listen to and when. Voice *commands* would
be a shell-shaped affordance and are explicitly out of scope. Auto-play
is rejected for the same reason a chat IDE shouldn't suddenly start
talking at you while you're typing.

## Dictation: two modes (relationship to doc 145)

Dictation has two natural endpoints, both of which this feature wires up:

- **Mode A — into the current session's MessageInput.** Hold the PTT
  hotkey while the main textarea is focused (or while the app is
  otherwise idle), the transcript appends at the cursor of the
  MessageInput.
- **Mode B — into the quick-capture overlay** introduced in
  `docs/145-quick-capture-overlay/plan.md`. A second hotkey opens that
  overlay *and* immediately starts mic capture. The transcript lands in
  the overlay's textarea; pressing Enter creates a new background
  session with that prompt.

Mode B depends on doc 145 (the overlay must exist). The voice feature
**ships after** the overlay; both modes land together when this feature
ships. Mode A on its own without Mode B would be incomplete — the killer
case is "I notice a bug while reviewing PR feedback in session X, I want
to dictate a prompt that spawns a different session to fix it, without
losing my place." That's Mode B.

### Why no mid-utterance partials in the textarea

The doc previously listed live partials as a deferred enhancement. They
are now a permanent non-feature, for two reasons:

1. **They complicate the edit-cursor model.** Partials updating in place
   while the user might also be editing the textarea is a race that
   neither user nor implementer can reason about cleanly. Whole-utterance
   insert is simpler and correct.
2. **The LLM cleanup pass is whole-utterance by nature** (see next
   section). Streaming partials would be throwaway work that we'd then
   post-process anyway.

So the design is: capture the whole utterance, clean it up, insert
once. Streaming partials never appear in v1 or in the planned roadmap.

### Transcript cleanup (LLM pass)

Raw Whisper output has two reliable failure modes: **filler words**
("um", "uh", "you know", "like", repeated false starts) and
**mis-hearings** (close-sounding homophones, especially proper nouns
and technical terms — "react use effect" vs "React useEffect"). The
user has to either submit a noisy prompt or hand-edit before sending,
and after a few iterations they stop trusting that what they said is
what the agent sees. That defeats the point of dictation.

So v1 routes every transcript through a small LLM cleanup call
**before** it lands in the textarea. The cleaned text is what the
user reviews — they verify intent once, in the language they meant,
not in the language Whisper heard.

**Provider selection (in order of preference):**

1. **The user's Claude Code subscription** (via the OAuth bearer
   that `AuthManager.getAccessToken()` returns). Cleanup is a
   short prompt to a small fast model (Haiku) and easily fits
   inside the subscription's headroom — no extra key, no extra
   bill. This is the default when the user has connected Claude
   Code to ShipIt, which is the overwhelmingly common case for
   ShipIt users. Selection gates on `getAccessToken()` returning
   a token (not on `checkCredentials()`, which is also true for
   API-key-only setups that have no usable OAuth bearer for
   direct Anthropic calls).
2. **OpenAI**, via the same voice API key the user already provided
   for Whisper/TTS. The cleanup call hits `gpt-4o-mini` (or
   equivalent small model) so it doesn't materially add to their
   STT/TTS spend.

Selection is automatic and silent. The Settings UI shows which
provider is being used as a status string ("Cleanup via your Claude
subscription" / "Cleanup via your OpenAI key" / "No cleanup
provider available — raw transcript will be inserted") so the user
can see what's happening, but there's no per-call dropdown — the
chosen pipeline must be predictable.

**Prompt shape (locked):**

```
You are cleaning up a voice transcription of a chat message a developer
is about to send to a coding assistant. Return the same message,
preserving meaning exactly:

- Fix obvious transcription mis-hearings (homophones, mangled proper
  nouns, mis-cased technical terms like "React useEffect").
- Remove disfluencies and filler words ("um", "uh", "you know", "like"
  used as filler, repeated false starts).
- Fix capitalisation and basic punctuation.
- Preserve the speaker's wording, tone, and intent. Do NOT rephrase,
  shorten, expand, summarise, answer, or comment on the message.
- If you are unsure whether a word is a mis-hearing or intentional,
  keep the original word.
- Output ONLY the cleaned message. No preamble, no quotes, no
  explanation.

Transcript:
{raw_transcript}
```

The "do not answer the message" line is load-bearing: cleanup must not
slip into agent-like behavior. Tests assert that a transcript shaped
like a question ("how do I add a button") comes back as the same
question, not as an answer to it.

**Failure mode — fall through, don't block.** If the cleanup provider
errors, times out (>3 s), or returns something obviously wrong (empty
string, dramatically longer than input, contains telltale "Here is
the cleaned version:" preamble), the raw transcript is inserted
instead and a small non-fatal warning appears next to the mic button
("Cleanup unavailable — inserted raw transcript"). The user is never
blocked on a flaky cleanup call.

**User can disable.** A "Clean up transcripts with an LLM" toggle in
Settings is on by default; turning it off goes straight from Whisper
→ textarea. Useful for users who explicitly want the raw transcript,
or who hit edge cases where cleanup degrades quality (heavily
non-English speech, code-name-heavy dictation).

**Latency budget.** Whisper round-trip is ~700–1500 ms for a
short utterance; the cleanup call adds ~400–800 ms on Haiku /
`gpt-4o-mini`. Total ~1.5–2 s, whole-utterance, which matches the
existing "press Send, see assistant typing" rhythm. The mic button
shows a `transcribing → cleaning` substate so the user can see
where time is going if it ever feels slow.

## Playback: per-turn Play button

Playback is a single, simple gesture: every completed assistant turn in
the chat history gets a Play button, and pressing it reads the turn
aloud. The killer scenario the user described:

> I'm walking around and I'm working on a design doc. I don't want to
> read everything; I want to press play on the response and hear it.

This is the "mobile, eyes-off, long-form prose" case — which is exactly
where reading is worst and where listening pays off the most. The
Android WebView wrapper makes the same physical mobile device the
target as Mode B of dictation, so the two halves complete each other:
talk a prompt in, listen to the response out.

**Per-turn, not per-message-group.** The chat history groups events
into bubbles around tool-call boundaries (see `CLAUDE.md` "Message
group boundaries"), but for playback we want a single Play affordance
per *complete assistant turn* — i.e. the prose the assistant produced
between the user's send and the agent's final `agent_result` event.
The button lives on the turn footer, next to the existing token /
cost / duration metadata, not on every individual bubble.

**What gets read aloud.** Only the assistant's natural-language prose:
the `agent_assistant` text events that make up the turn. Skipped:

- Code blocks (fenced triple-backtick blocks) — they don't read well
  and aren't the content the user wants to hear.
- Inline code spans — read the surrounding sentence, drop the
  `` `token` ``.
- Tool calls, tool results, file diffs, attachments — these are
  agent machinery, not prose.
- Markdown syntax — `**bold**` is read as "bold", headings are read
  as plain text without "hash hash" noise, list markers become a
  short pause.
- Front-matter, link URLs (the link text is read, the URL isn't).

The stripping happens server-side in a small `strip-for-tts.ts` helper
shared by the route and tests. If the resulting text is empty (e.g.
the turn was entirely a tool call) the Play button doesn't render.

**No auto-play in v1.** The user pressing Play is mandatory, for the
same reason auto-submit is rejected on the input side: the chat
shouldn't be doing things the user didn't initiate. Auto-play on
"hands-free mode" can be a follow-up once we know what it should
actually mean.

**No live streaming during a turn.** Play only appears once the turn
is complete (the `agent_result` event has landed). Reading partial
prose while the agent is still writing creates an awkward race —
output keeps changing under the player — and we already control
when the user is happy with the response by gating Play on turn
completion.

**Playback controls** (on the same footer affordance):

- Play / Pause toggle (the button itself).
- Scrubber? *No* in v1 — a thin horizontal progress indicator is
  enough. Mobile-first; precise scrubbing isn't the use case.
- Speed control (1×, 1.25×, 1.5×, 2×) — small dropdown, persisted
  in settings. This is the difference between "listenable" and
  "useful" for long prose, so it's v1 not deferred.
- A "stop" affordance that resets position to 0 and frees the
  underlying `HTMLAudioElement`. (Pause leaves the element live so
  resume is instant; stop is the explicit teardown.)

**Only one turn plays at a time.** Pressing Play on turn B while
turn A is playing stops A and starts B. The playback store holds a
single `playingTurnId` and a single `Audio` element.

## Why this matters

ShipIt today forces voice users to run a separate app, transcribe in that app,
and paste into the message input. That breaks the "ShipIt is the surface" rule
from §1: the user has to leave to do something the IDE could own. It also
penalises mobile (Android WebView), where on-screen typing is the worst input
modality and voice is the best.

Playback closes the loop. Without it, the user can talk *to* ShipIt but
still has to look at a screen to learn what it said back — which means
mobile-while-moving is still a degraded experience. With Play on each
turn, the user can dictate a prompt, pocket the phone, and hear the
response when it lands.

This is the smallest, highest-leverage step toward voice as a first-class
modality — both directions. We do not need to commit to "voice everywhere
in the product" to ship it; dictation + manual-play TTS are useful on
their own, and the bigger questions (voice commands, wake words,
auto-play) can be picked up later as separate features without
invalidating this one.

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

Dictation (input):

```
[Hold hotkey / tap mic]
        ↓
MediaRecorder (browser) → audio/webm;opus, ~250ms chunks
        ↓
POST /api/voice/transcribe (orchestrator)
        ↓
   orchestrator adds Authorization header from server-stored key
        ↓
STT provider (OpenAI Whisper for v1) → raw transcript
        ↓
   orchestrator picks cleanup provider:
     Claude Code OAuth → OpenAI voice key
        ↓
Cleanup LLM (Haiku / gpt-4o-mini)
        ↓
{ text: "<cleaned>", rawText: "<original>", cleanupProvider?: string }
        ↓
MessageInput.setText(prev => spliceAtCursor(prev, cleaned))
        ↓
[User reviews, edits, presses Send — existing path]
```

The raw transcript is returned to the client only for debugging /
telemetry / a future "show raw" affordance — the textarea always
gets the cleaned version when cleanup succeeds.

Playback (output):

```
[Click Play on assistant turn N]
        ↓
client collects the turn's assistant prose, hashes (text, voice, speed)
        ↓
POST /api/voice/speak (orchestrator)
        ↓
   server strips markdown/code via strip-for-tts.ts
   server checks {hash → audio} cache; if miss, calls provider with stored key
        ↓
TTS provider (OpenAI /v1/audio/speech for v1)
        ↓
audio/mpeg stream (or cached bytes) → response body
        ↓
client wraps the response in an HTMLAudioElement, plays
        ↓
[User pauses / stops / changes speed via the same control]
```

Audio capture, the textarea splice, and the `HTMLAudioElement` live in
the browser; the STT/TTS API key lives **server-side** in a small
new store and is never returned to the client. The browser does not
hold the key in memory or in localStorage.

This mirrors the existing GitHub-token pattern (`/api/github/token`):
client posts the credential once, the server holds it, the server makes
the authenticated upstream call on the client's behalf. It's a known
shape in ShipIt and the right shape here.

**Server-side audio cache (for playback only).** TTS is the
expensive direction — re-pressing Play on the same turn shouldn't
re-bill OpenAI. The server keeps a small on-disk LRU keyed by
`sha256(text + voice + speed + provider)` under the orchestrator's
cache dir. First Play synthesizes and writes; subsequent plays
stream the cached file. STT does not get a cache (every utterance
is unique audio).

### Why not localStorage for the key

ShipIt renders agent output — markdown, tool output, MCP responses — into
the page. An XSS via agent-rendered HTML would exfiltrate any
localStorage-resident credential, and the same OpenAI key now covers
both STT (Whisper) *and* TTS — exactly the sort of thing that costs the
user money if leaked, and now in two directions. The mitigation cost is
a single small server endpoint, which is trivial relative to the rest of
the feature. We pay it.

Audio goes through the orchestrator in both directions (mic upload for
STT, generated speech download for TTS); this gives us a natural place
to add per-user rate-limiting, cost caps, and the playback cache
without touching the client.

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

Three provider directions in v1:

| Direction | Provider | Endpoint | Auth | Audio path | Notes |
|---|---|---|---|---|---|
| **STT** | `whisper` | OpenAI `/v1/audio/transcriptions` | BYO OpenAI voice key, server-stored | browser → orchestrator → OpenAI | whole-utterance request/response, no streaming partials |
| **Cleanup** | `claude-oauth` (default) | Anthropic API via Claude Code OAuth | user's Claude Code subscription, OAuth bearer surfaced by `AuthManager.getAccessToken()` | server-only | `claude-haiku-4-5`, ~400 ms, prompt is the fixed cleanup template |
| **Cleanup** | `openai-cleanup` (fallback) | OpenAI `/v1/chat/completions` | same OpenAI voice key | server-only | `gpt-4o-mini`, same prompt; lets users without Claude auth still get cleanup |
| **TTS** | `openai-tts` | OpenAI `/v1/audio/speech` (`tts-1` model) | OpenAI voice key | OpenAI → orchestrator → browser | streaming `audio/mpeg` response body, cached server-side by content hash |

Provider abstraction lives in `src/server/orchestrator/voice/providers/*.ts`
with three contracts:

```ts
interface SttProvider { transcribe(audio: Buffer, opts): Promise<string> }
interface CleanupProvider { clean(rawTranscript: string, opts): Promise<string> }
interface TtsProvider { speak(text: string, opts): Promise<ReadableStream<Uint8Array>> }
```

Cleanup-provider selection lives in a single small `pickCleanupProvider()`
function inside `services/voice.ts` — it calls
`AuthManager.getAccessToken()` and falls back to the OpenAI voice key
in `CredentialStore`, returning the first available adapter. (It must
gate on a non-null token from `getAccessToken()` rather than on the
generic `checkCredentials()` boolean, which is true for API-key-only
setups that don't expose a usable OAuth bearer.) No new DI manager.

Adding a new provider in any direction means a new adapter file plus a
settings option.

Deferred for follow-ups:

- **Deepgram streaming WS (STT).** Requires a server-side WS proxy (the key cannot
  be in the URL the browser opens). Worth doing once we have a real demand
  for streaming partials.
- **ElevenLabs / PlayHT (TTS).** Higher-quality voices but require their
  own key and pricing model. The provider-adapter shape already accommodates
  them; the gating is product (one more key the user has to wrangle), not
  technical.
- **Web Speech API.** Useful for users who explicitly opt in to Google-cloud
  STT. Has a different internal shape (no MediaRecorder, native API returns
  text directly), so it lives outside the server-proxy path and needs a
  separate consent flow in the UI.
- **Local on-device STT/TTS** (WebGPU Whisper, WebGPU Piper). Interesting
  for offline use; the integration point would be the same browser-side
  hooks with a "no upload" code path.

### Multi-provider refactor (shipped — ElevenLabs TTS + Deepgram STT)

The original v1 hardcoded OpenAI in three places (service dispatch, the
credential model, and voice validation). A follow-up generalised those
so a new provider is added by data, not by editing the service layer.
**ElevenLabs (TTS) and Deepgram (STT) shipped on the back of it.** Three
pieces:

1. **Shared catalog — `src/server/shared/voice-catalog.ts`.** The single
   source of truth both layers import. Pure data + selectors: each
   `VoiceProviderInfo` lists its `capabilities` (`stt` / `tts` /
   `cleanup`), whether it `requiresKey`, and (for TTS) its `voices`,
   `speeds`, and inclusive `speedRange`. Selectors (`getVoiceProvider`,
   `sttProviders`, `ttsProviders`, `keyRequiringProviders`,
   `providerVoices`, `providerSupports`, `isValidVoice`,
   `defaultVoiceFor`, `providerSpeeds`) drive both the Settings dropdowns
   and server-side validation, so the two can never drift. Lives under
   `src/server/shared/` (not a top-level `src/shared/`); the client
   imports it via `../../server/shared/voice-catalog.js`.

2. **Multi-key credential model.** `CredentialData.voiceProviderApiKey`
   (single OpenAI key) was replaced by
   `voiceProviderKeys?: Record<string, string>` keyed by provider id, with
   `getVoiceProviderKey(id)`, `setVoiceProviderKey(id, key)`,
   `clearVoiceProviderKey(id)`, and `getConfiguredVoiceProviders()` on
   `CredentialStore`. Each provider's key is stored under its own id, so
   ElevenLabs and Deepgram keys live alongside the OpenAI one. The
   security posture is unchanged: keys are server-side only, no GET route
   returns a raw key, and `/api/voice/credentials/status` returns just
   `{ configured: string[] }` (the list of provider ids that have a key),
   never the key itself.

3. **Server provider registry — `src/server/orchestrator/voice/registry.ts`.**
   `getVoiceAdapters(providerId)` maps an id to its `createStt` /
   `createTts` factories and `ttsContentType`. The service layer
   (`services/voice.ts`) validates the requested provider against the
   catalog, then dispatches through the registry — it no longer names
   OpenAI. New adapters: `voice/providers/elevenlabs-tts.ts` (ElevenLabs
   `text-to-speech`, `eleven_multilingual_v2`) and
   `voice/providers/deepgram.ts` (Deepgram `listen`, `nova-2`).

The request shape gained a `provider` field: `POST /api/voice/speak`
takes `{ text, voice, speed, provider? }`; `POST /api/voice/transcribe`
reads an `sttProvider` multipart field; `POST`/`DELETE
/api/voice/credentials` take `{ provider, apiKey? }`. All default to
`openai` when omitted, so existing clients keep working. Adding the
next provider (e.g. AssemblyAI) is: write the adapter, register it,
add a catalog entry — no service-layer edit.

### Hotkeys: avoiding the macOS minefield

`Cmd+M` minimizes the browser window on macOS — the page never sees the
keydown. The original draft picked it as default; it is unusable. v1 uses
**two** hotkeys, one per mode:

- **Mode A (Mic into current MessageInput) — desktop default: hold
  `Ctrl+Shift+Space`.** Push-to-talk. Captured cleanly by the page on
  macOS, Linux, and Windows. Rebindable in settings.
- **Mode B (Quick-capture overlay with mic auto-on) — desktop default:
  `Ctrl+Shift+M`.** Press to open the doc-145 overlay *and* immediately
  start mic capture; release to stop the mic; press Enter on the overlay
  to submit, Esc to cancel. Rebindable. Distinct from doc 145's shipped
  text-only hotkey (`Ctrl+Alt+N` / `Cmd+Opt+N` on macOS — see doc 145's
  Trigger section) so users can opt into voice without surrendering the
  text path. Verify during build that `Ctrl+Shift+M` doesn't conflict
  with a browser or desktop-environment shortcut on the supported
  platforms (Firefox on some Linux DEs binds it to bookmarks-bar toggle;
  pick a backup if so).
- **Mobile:** no hotkey equivalents. The mic button in MessageInput is
  the Mode-A entry point; the overlay (when opened via its own mobile
  affordance from doc 145) gets a mic button for Mode B.

Both hotkeys go through the same conflict-detection logic, and both
default values must be verified against the existing app shortcut map
during implementation.

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
| Long recordings | No client-side duration cap. Recording runs until the user releases the key / taps Stop, or one of the lifecycle stops above (blur/visibility/session switch) fires. The only ceiling is the 50 MB multipart upload limit (~50 min of Opus), well beyond any realistic dictation. |
| STT call fails | Set hook state to `error`, surface inline error on the mic button, do not insert anything |

`onkeyup` is unreliable when focus moves away mid-press, which is why
`blur` + `visibilitychange` are first-class events in this state machine,
not edge cases.

### UX

**Mic button** appears in **three places** (same component, same hook
state), only rendered when voice input is enabled in settings:

- Next to the send/stop buttons in **MessageInput** — Mode A entry point.
- Inside the **QuickCaptureOverlay** (doc 145) — Mode B entry point.
  On mobile, Mode B is also reachable from the bottom tab bar's action
  cluster via the Voice Quick Session action, which uses a quick-session
  icon plus a mic badge and opens the overlay with auto-mic requested.
- Inside the **AskUserQuestion** card's "Other" free-text field — lets the
  user dictate a custom answer to an agent question without retyping. This
  surface is **button-only (no push-to-talk hotkey)**: the global Mode-A/B
  hotkeys belong to the composer/overlay, and binding one again would fire
  every mounted question card's recorder at once. The `OtherAnswerInput`
  sub-component owns its own `useVoiceInput` instance and splices the
  transcript into the textarea via `spliceTranscript`, exactly like
  MessageInput. On mobile it also mounts `MobileRecordingOverlay`.

States (shared across both mic instances):

- **idle** — outlined mic icon, tooltip shows the appropriate hotkey
- **recording** — filled red mic + pulsing dot, elapsed timer (`00:03`)
- **transcribing** — spinner over the mic icon, "Transcribing…"
- **error** — red exclamation, click reveals detail (no mic, denied
  permission, provider error, key invalid) and a "Fix in settings" shortcut

The mic UI is a single component (`MicButton`) parameterised by the
target textarea ref. The hook itself is mode-agnostic — it captures
audio and emits a transcript; the *consumer* decides where to insert it.

**Gestures (resolved):** desktop and mobile use *different* primary
gestures, picked for what each device does well, and we accept the small
cognitive cost of that split:

- **Desktop:** hold the hotkey (PTT). Click on the mic button is a
  **toggle** (start → click again to stop). Click-and-hold on the button is
  not supported — the gesture is fiddly and the toggle path is clearer.
- **Mobile:** tap the mic to start, tap again to stop. No hotkey path.

**Mobile recording UX (`MobileRecordingOverlay`).** The plain inline mic is a
~28px target — acceptable on desktop where PTT is the real gesture, but on
mobile the button *is* the entire interface, so a tiny tap target is the actual
pain (both to start and to stop). The two ends get different treatments because
they have different lifetimes:

- **Start** can't be a full-screen takeover — it has to coexist permanently
  with the composer (you might type instead of dictate). So it stays inline,
  but on mobile the composer toolbar is **reordered and resized** for the
  thumb (the desktop layout is left untouched, since it matches Claude Code
  and other desktop chat UIs). Two changes, both gated on `useIsMobile()`:
  - **Reorder (`MessageInput`).** The toolbar children are arranged via CSS
    `order` so the frequently-used **mic + send** pack together on the right
    (mic just left of send) and the rarely-tapped add-files / mode / cost
    dial / model selector pack to the left. On desktop the conventional
    `add/mic/mode | cost/model/send` split is preserved. Order values are
    spaced (10, 20, …) so items can be inserted later without renumbering.
  - **Resize.** The `large` prop now bumps the `MicButton` icon to `MD`
    (was `SM`) and floors its hit area at 44px (`p-3 min-h-11 min-w-11`),
    the Apple-HIG minimum and a match for the bottom-bar buttons. The Send /
    Stop button — previously a fixed ~32px on every viewport, the worst
    target in the row despite being the most-used — gets the same mobile
    treatment (`p-3 min-h-11 min-w-11`, `MD` icon). Desktop stays compact.
- **Stop / Cancel** only exist *while recording*, so they're free to take over
  the screen. `MobileRecordingOverlay` (gated on `useIsMobile()`) renders a
  full-screen scrim with a large centered Stop button, a live timer, a
  "Listening…" label, and a Cancel control. The overlay is **theme-independent**:
  a fixed dark scrim (`bg-black/75`) with explicit light text (`text-white`,
  `text-white/60–80`) and bright error reds (`text-red-400`), *not* the themeable
  `--color-text-*` tokens — those flip to dark in light themes and were blending
  into the scrim (reported on the "live" light theme). A recording surface is
  conventionally dark-with-light-text in every app, so we pin it. After Stop it shows a transcribing
  spinner until the transcript splices into the composer underneath, then
  auto-dismisses. Cancel calls `voice.cancelRecording()` (the newly-exposed
  `abortRecording`) to discard the audio without hitting the STT API; it's only
  offered while `recording` (once `transcribing`, the audio is already
  captured and in flight, so cancel is a no-op and the control is hidden).
  The **error** state is shown in the overlay too (a tiny inline error icon is
  illegible on a phone): a warning icon, the error message, a big primary
  recovery button, and a **Dismiss** control. Dismiss calls
  `voice.dismissError()` back to idle. Escape cancels while recording and
  dismisses while erroring (harmless on mobile, handy for desktop testing).

**Robust retry — resend the same audio (`canRetryTranscription`).** A
transcription failure is usually transient (network blip, provider hiccup), so
forcing the user to re-speak is the wrong recovery. The hook now **retains the
captured audio** (`pendingAudioRef`) for the duration of the transcribe
round-trip and keeps it on failure, exposing `canRetryTranscription` (true only
when the failure happened *after* capture) and `retryTranscription()` (re-POSTs
the same blob — no re-recording). The audio is cleared on success, on a fresh
`startRecording`, and on `dismissError`/abort so stale audio never leaks into
the wrong session. Recovery actions branch on `canRetryTranscription`:

- **Transcription failure** (audio retained) → primary **Resend** (verbatim,
  via `retryTranscription`), with **Re-record** as the fallback.
- **No usable audio** (mic permission denied, capture never started) → only
  **Try again** (record afresh, via `startRecording`).

**Desktop error UI (`VoiceErrorPanel`).** Desktop previously had only the
inline mic warning glyph + tooltip — too thin to recover from. The error state
now anchors a Radix popover (`Popover`/`PopoverAnchor`/`PopoverContent`) to the
mic button containing `VoiceErrorPanel`: the message plus the same
Resend/Re-record/Try again/Dismiss actions (and a Settings shortcut when
`onOpenSettings` is wired). The panel is shared decision logic with the mobile
overlay — both read `canRetryTranscription` — but rendered compact for the
toolbar. On mobile (`large`) the inline MicButton stays minimal and defers the
error UI to `MobileRecordingOverlay`, which sits on top of it.

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

The threat we are mitigating is **exfiltration of a paid OpenAI API key
(used for both STT and TTS) by malicious content rendered in the page**.

The agent emits markdown, tool output, and (via MCP) third-party content.
Markdown is sanitized by the existing rendering pipeline, but the surface
is large and any future regression that allows arbitrary `<script>` or
`onerror=` would let attacker-controlled content read anything from
`localStorage` / `sessionStorage`. OpenAI keys are unattended-purchase
credentials — exfiltration means real money lost, and the playback
direction doubles the cost surface because TTS bills per character of
synthesized speech.

Mitigations:

- **Key never touches the browser.** Stored in a new server-side table,
  written via `POST /api/voice/credentials`, read only by the server when
  proxying STT *or* TTS calls. The client API for "do you have a key
  configured" is a boolean status endpoint, not the key itself.
- **Audio goes through the orchestrator in both directions**, so the
  browser never opens an authenticated connection to OpenAI. Even a
  script that observes `fetch` calls sees only the orchestrator's own
  endpoints.
- **No GET for the credential.** The endpoint accepts POST (set) and DELETE
  (clear), and returns a redacted-status response on read. There is no way
  to retrieve the stored key from the client.
- **TTS request body is just text.** A compromised page can call
  `/api/voice/speak` with arbitrary text and burn the user's quota,
  but it cannot read the key, exfiltrate it, or use it against any
  other OpenAI endpoint. The cost-cap rate-limit hook is the right
  long-term mitigation; the request shape itself keeps the blast
  radius narrow.

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

New section in `Settings.tsx` titled "Voice", split into two
subsections sharing one credential:

**Shared**

- **API key** — text field, POSTed to `/api/voice/credentials` on save.
  Status shown as "Key configured ✓" or "Not set" — the key itself is
  never read back. A "Test" button does a short mic capture +
  transcribe round-trip *and* a one-sentence TTS round-trip, and
  reports success or the provider's error message for each.

**Voice input (dictation)**

- **Enable voice input** — master toggle (default off, so users who
  don't want it never see the mic button or the STT endpoint surface).
- **STT provider** — radio (v1: just "OpenAI Whisper"; structured to expand).
- **Clean up transcripts with an LLM** — toggle, default **on**.
  When on, transcripts pass through the cleanup pipeline before
  insertion; when off, the raw Whisper output is inserted directly.
  Below the toggle, a status string reports which cleanup provider
  will be used ("Cleanup via your Claude subscription" / "Cleanup
  via your OpenAI key" / "No cleanup provider available — raw
  transcript will be inserted"). This is read-only — the
  orchestrator picks the provider; the user doesn't.
- **Mode A hotkey (mic into current input)** — key-capture input,
  default `Ctrl+Shift+Space`. Rebindable. Conflict-detection against
  existing app hotkeys.
- **Mode B hotkey (open overlay with mic on)** — key-capture input,
  default `Ctrl+Shift+M`. Rebindable. Disabled until the doc-145
  overlay has shipped; settings UI shows a helpful "Available once the
  quick-capture overlay ships" string if 145 has not yet landed at
  runtime.
- **Language** — dropdown (default: browser locale). Passed to both
  the STT provider and the cleanup prompt as a language hint where
  supported.

**Voice playback**

- **Enable voice playback** — master toggle (default off; when off,
  the Play button is not rendered on assistant turns and the TTS
  endpoint surface is not exposed).
- **TTS provider** — radio (v1: just "OpenAI TTS"; structured to expand).
- **Voice** — dropdown matching the provider's offered voices
  (OpenAI: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`).
  Default: `alloy`.
- **Playback speed** — radio (1×, 1.25×, 1.5×, 2×). Default 1×.
  Persists in settings so the same speed applies to every Play press.

Non-credential settings (input enabled, STT provider name, both
hotkeys, language, playback enabled, TTS provider name, voice,
speed) live in the existing client `settings-store.ts` (Zustand +
localStorage). Only the credential itself is server-side.

### Client implementation sketch

New module `src/client/voice/`:

```
voice/
  index.ts                  barrel + types
  use-voice-input.ts        React hook: STT state machine, hotkey listener, mic capture
  capture.ts                MediaRecorder wrapper, blob assembly
  insert-transcript.ts      pure: splice transcript into textarea state
  use-voice-playback.ts     React hook: per-turn play/pause, single-audio-element ownership
  extract-turn-prose.ts     pure: walk a turn's events, return the prose to read aloud
  playback-store.ts         Zustand store: { playingTurnId, state, positionMs, durationMs }
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

`useVoicePlayback()` returns:

```ts
{
  state: "idle" | "loading" | "playing" | "paused" | "error",
  playingTurnId: string | null,
  positionMs: number,
  durationMs: number,                 // 0 until the first `loadedmetadata`
  errorMessage: string | null,
  play: (turnId: string, text: string) => Promise<void>,
  pause: () => void,
  resume: () => void,
  stop: () => void,
}
```

There is exactly one `HTMLAudioElement` in the app at a time, owned by
the playback store. `play(turnId, text)`:

1. If a different turn is already playing, stops it and frees the element.
2. Looks up the cached blob URL keyed by `(turnId, voice, speed)` in
   the store; if present, reuses it (instant replay without a fetch).
3. Otherwise opens `POST /api/voice/speak`, wraps the response in a
   `MediaSource`, attaches it to a new `Audio`, starts playback.
4. Stores `{ turnId, audioEl, blobUrl }` so step 2 works next time.

Like the input hook, the playback hook is **locked by type**: it accepts
text and a turn id, nothing else. It has no reference to the chat store,
no ability to mark turns read, no ability to trigger a follow-up — its
only job is producing audio from text.

### Server-side additions

The orchestrator already has the right primitives for everything we need:

- **Credential storage** — `CredentialStore` (`credential-store.ts`) already
  holds account-level secrets like `githubToken` in a `CredentialData` object.
  We add a single `voiceProviderApiKey?: string` field (plus optionally
  `voiceProvider?: "openai"` for forward compatibility — one key covers
  both Whisper and TTS, since both endpoints live on the same OpenAI
  account). No new store, no schema migration — this is the same shape as
  adding any other credential ShipIt has shipped to date.
- **Routes** — follow the `api-routes-github.ts` / `services/github.ts` split
  the codebase already uses. New files: `api-routes-voice.ts` (HTTP), service
  layer at `services/voice.ts` (business logic that composes the credential
  store and the provider adapter). Routes call services; services call
  providers. Pure functions, testable in isolation. This is the pattern
  documented in `CLAUDE.md` "Service layer pattern" and is non-negotiable —
  routes that bypass the service layer are a known anti-pattern.
- **Provider adapters** —
  - `voice/providers/whisper.ts` — takes a `Buffer` + key, returns text.
  - `voice/providers/openai-tts.ts` — takes text + key + opts (voice,
    speed, format), returns a `ReadableStream<Uint8Array>`.
  - `voice/providers/claude-cleanup.ts` — uses the Claude Code OAuth
    bearer returned by `AuthManager.getAccessToken()` to call Anthropic
    with the locked cleanup prompt; returns the cleaned string.
  - `voice/providers/openai-cleanup.ts` — uses the OpenAI voice key to
    call `gpt-4o-mini` with the same locked prompt; returns the cleaned
    string. Acts as the fallback when neither Claude path is available.
- **Cleanup pipeline** — `voice/cleanup.ts` exports `pickCleanupProvider()`
  and `cleanTranscript()`. `cleanTranscript` runs the chosen adapter
  with a 3 s timeout and a small sanity check (non-empty, length within
  a sensible ratio of the input, no telltale preamble). On any failure
  it returns the raw transcript plus an `errorCode` the route surfaces
  to the client.
- **Text cleanup** — `voice/strip-for-tts.ts` is a pure function that
  takes the assistant's prose and returns a cleaned string for TTS
  (drop code fences and inline code, strip markdown syntax, normalize
  whitespace, return empty string if nothing remains). The route calls
  it before hashing for the cache and before sending to the provider.
- **TTS cache** — `voice/tts-cache.ts` wraps a small on-disk LRU under
  the orchestrator's cache directory. Key: `sha256(text + voice + speed + provider)`.
  Value: the synthesized audio bytes. Modest cap (e.g. 200 MB) with
  LRU eviction. The cache survives orchestrator restarts so re-pressing
  Play across sessions is also free.

New HTTP routes (registered via the existing dispatcher in `api-routes.ts`):

- `POST /api/voice/credentials` — body: `{ provider: "openai", apiKey: string }`. Stores the key on `CredentialStore`. Returns `{ ok: true }`.
- `DELETE /api/voice/credentials` — clears the stored key.
- `GET /api/voice/credentials/status` — returns `{ configured: boolean, provider?: string }`. Never returns the key.
- `POST /api/voice/transcribe` — multipart body with `audio` file part, `language` field, and `cleanup` boolean (mirrors the Settings toggle so the server doesn't have to reach into client state). Service-layer function loads the key from `CredentialStore`, calls the STT provider adapter, then — if `cleanup` is true and a cleanup provider is available — runs `cleanTranscript()`. Returns `{ text: string, rawText: string, cleanupProvider?: "claude-oauth" | "openai-cleanup", cleanupErrorCode?: string }`. `text` is always set (cleanup falls through to raw on error). On STT error returns the upstream status code + a sanitized error message via `ServiceError`.
- `GET /api/voice/cleanup/status` — returns `{ provider: "claude-oauth" | "openai-cleanup" | null }` so the Settings UI can render the read-only status string without leaking credentials.
- `POST /api/voice/speak` — JSON body `{ text: string, voice: string, speed: number }`. Service-layer function strips markdown via `strip-for-tts.ts`, hashes the result, checks the cache, on miss calls the TTS provider adapter, writes to cache, and streams `audio/mpeg` back to the client. On provider error returns the upstream status code + a sanitized error message via `ServiceError`. If the cleaned text is empty, returns 204 No Content (the client suppresses the Play button in this case anyway).

CORS: not an issue because the audio call now goes orchestrator→OpenAI
(server-side) in both directions. OpenAI's CORS posture is irrelevant
for our path.

### Android WebView

The Android wrapper (`android/`) needs two small changes for **mic
capture**:

1. `android/app/src/main/AndroidManifest.xml`:
   - Add `<uses-permission android:name="android.permission.RECORD_AUDIO" />`
   - Add `<uses-feature android:name="android.hardware.microphone" android:required="false" />` so Play Store filtering doesn't exclude mic-less devices.
2. `android/app/src/main/java/com/shipit/wrapper/MainActivity.kt` (verify exact path during build): override `WebChromeClient.onPermissionRequest(request)` to grant `PermissionRequest.RESOURCE_AUDIO_CAPTURE` after the standard Android runtime-permission flow.

Without these, `getUserMedia` silently fails inside the WebView.

**Playback** does not need any Android permission — `<audio>` and
`HTMLAudioElement.play()` work in the WebView out of the box. We do
need to verify two mobile-specific behaviors during QA: that
playback continues when the screen locks (set `keepScreenOn` is *not*
desired — we want screen-off audio), and that the OS media controls
(lock screen / notification) show ShipIt as the active media source.
That's nice-to-have, not a v1 blocker; the minimum is "audio plays
when the user presses Play."

Voice is the killer feature on mobile, so the Android pathway is in v1
scope for both directions. See `docs/116-android-webview-app/` for the
wrapper architecture.

## Out of scope (v1)

Captured here so future readers know they were considered, not forgotten:

- **Voice commands** ("stop", "submit", "approve"). Violates §5 of
  `CLAUDE.md`.
- **Auto-submit on release.** Explicitly rejected by the user's workflow.
- **Auto-play of new assistant turns.** Play is always manual in v1. A
  follow-up "hands-free / driving mode" can opt into auto-play once we
  know what the right gating is (per-session toggle? only after a
  voice-dictated prompt?). The hook contract is already type-locked so
  this can't be added accidentally.
- **TTS during a streaming turn.** Play only appears after
  `agent_result`. Streaming TTS over a turn that's still being written
  would require partial-text segmentation, sentence-boundary
  detection, and gapless audio splicing — all interesting, none worth
  the v1 spend.
- **Wake-word activation.** Always-on mic is a privacy surface we won't
  commit to in v1.
- **Streaming partials into the textarea while still recording.** Now a
  permanent non-feature, not a deferred one — see "Two modes" above for
  reasoning (edit-cursor races and the planned LLM clean-up pass both
  make whole-utterance insert the correct shape).
- **Local on-device STT/TTS** (WebGPU Whisper, WebGPU Bark/Piper).
  Deferred until provider abstraction has proven the integration point
  is clean for both directions.
- **Web Speech API provider.** Available in the architecture but not in v1
  because it would require its own consent flow ("this sends your audio to
  Google") that we don't want to ship under time pressure.
- **Deepgram / AssemblyAI / ElevenLabs streaming.** Deferred — would
  require a server WS proxy (the key can't go in the URL the browser
  opens), and the streaming partials they're known for are already
  out of scope on the input side.
- **Per-dictation undo as a discrete action.** Standard browser undo
  (Cmd/Ctrl+Z) covers character-level undo of the inserted block — that
  is sufficient for v1.
- **Multi-language switching mid-utterance.** Single language per session,
  set in settings. Auto-detect is provider-dependent; we pass it through
  where available but don't try to improve on it.
- **OS media-session integration for playback** (lock-screen
  controls, Bluetooth headset prev/next). Nice on mobile, but adds
  `navigator.mediaSession` wiring and metadata that aren't required
  for the "press Play, hear the response" use case. Follow-up.

## Key files

### Client (new)

- `src/client/voice/use-voice-input.ts` — hook (STT state machine, capture, hotkey listener)
- `src/client/voice/capture.ts` — MediaRecorder wrapper
- `src/client/voice/insert-transcript.ts` — pure transcript-splicing helper
- `src/client/voice/use-voice-playback.ts` — hook (single-`Audio`-element owner, play/pause/stop, error state)
- `src/client/voice/extract-turn-prose.ts` — pure helper that turns a chat turn's events into a single string of prose to read aloud
- `src/client/voice/playback-store.ts` — Zustand store backing the playback hook
- `src/client/components/MicButton.tsx` — presentational mic UI (`large` prop enlarges the mobile tap target)
- `src/client/components/MobileRecordingOverlay.tsx` — full-screen mobile recording surface (big Stop button + Cancel + timer + error/Resend); mounted only on mobile
- `src/client/components/VoiceErrorPanel.tsx` — desktop error popover content (message + Resend/Re-record/Try again/Dismiss/Settings), shared decision logic with the mobile overlay
- `src/client/components/PlayTurnButton.tsx` — presentational Play/Pause UI for a single turn, with progress indicator and speed dropdown
- `src/client/voice/*.test.ts` / `src/client/voice/*.test.tsx` — unit tests
- `src/client/components/MicButton.test.tsx`, `src/client/components/MobileRecordingOverlay.test.tsx` — component tests for the mic states and the mobile overlay (stop / cancel / Escape / transcribing)

### Client (modified)

- `src/client/components/MessageInput.tsx` — embed MicButton (pass `large={isMobile}`), mount `MobileRecordingOverlay` on mobile, wire the Mode-A hook instance, route transcript to `setText`
- `src/client/components/QuickCaptureOverlay.tsx` (from doc 145) — embed MicButton, wire a Mode-B hook instance, route transcript to the overlay's own `setText`. Auto-start capture when opened via the Mode-B hotkey.
- `src/client/hooks/useQuickCaptureHotkey.ts` (from doc 145) — add a sibling Mode-B variant that opens the overlay *and* signals the overlay to auto-start mic capture
- `src/client/components/AskUserQuestion.tsx` — `OtherAnswerInput` sub-component embeds MicButton (button-only, no hotkey) in the "Other" free-text field, wires its own `useVoiceInput` instance, splices the transcript with `spliceTranscript`, and mounts `MobileRecordingOverlay` on mobile
- `src/client/components/MessageList.tsx` (or the existing turn-footer component, exact name verified during build) — render `PlayTurnButton` for each completed assistant turn; pass the turn's id and extracted prose
- `src/client/stores/settings-store.ts` — add input fields (`voiceInputEnabled`, `sttProvider`, `cleanupEnabled`, `voiceHotkeyModeA`, `voiceHotkeyModeB`, `voiceLanguage`) **and** playback fields (`voicePlaybackEnabled`, `ttsProvider`, `ttsVoice`, `ttsSpeed`) and setters (no API key — that's server-side)
- `src/client/utils/local-storage.ts` — persisters for the new non-credential settings
- `src/client/components/Settings.tsx` — new "Voice" section with input and playback subsections

### Server (new)

- `src/server/shared/voice-catalog.ts` — shared provider catalog (pure data + selectors), imported by both client and server
- `src/server/orchestrator/voice/registry.ts` — `getVoiceAdapters(id)`: maps a provider id to its STT/TTS factories + `ttsContentType`
- `src/server/orchestrator/voice/providers/elevenlabs-tts.ts` — ElevenLabs TTS adapter
- `src/server/orchestrator/voice/providers/deepgram.ts` — Deepgram STT adapter
- `src/server/orchestrator/voice/providers/types.ts` — `SttProvider`, `CleanupProvider`, and `TtsProvider` interfaces
- `src/server/orchestrator/voice/providers/whisper.ts` — OpenAI Whisper STT adapter
- `src/server/orchestrator/voice/providers/claude-cleanup.ts` — Anthropic cleanup adapter that takes the OAuth bearer returned by `AuthManager.getAccessToken()` and posts the locked prompt to the Anthropic API (or shells out to a one-shot `claude` CLI invocation if the OAuth scope rejects direct API use — see open questions)
- `src/server/orchestrator/voice/providers/openai-cleanup.ts` — OpenAI `gpt-4o-mini` cleanup adapter
- `src/server/orchestrator/voice/providers/openai-tts.ts` — OpenAI `/v1/audio/speech` TTS adapter
- `src/server/orchestrator/voice/cleanup.ts` — `pickCleanupProvider()` + `cleanTranscript()` with timeout, sanity checks, fall-through-to-raw on failure
- `src/server/orchestrator/voice/cleanup-prompt.ts` — the locked cleanup prompt template (single source of truth used by both adapters and the tests)
- `src/server/orchestrator/voice/strip-for-tts.ts` — pure markdown/code stripper, shared by route and tests
- `src/server/orchestrator/voice/tts-cache.ts` — disk-backed LRU keyed by content hash
- `src/server/orchestrator/voice/index.ts` — barrel for provider/cache exports
- `src/server/orchestrator/services/voice.ts` — service layer (loads credential, dispatches to STT / cleanup / TTS providers, manages the cache for TTS, returns transcript / audio stream). Mirrors the shape of `services/github.ts`.
- `src/server/orchestrator/api-routes-voice.ts` — HTTP routes that call into `services/voice.ts`

### Server (modified)

- `src/server/orchestrator/credential-store.ts` — multi-key voice credential model: `voiceProviderKeys?: Record<string, string>` on `CredentialData` plus `getVoiceProviderKey` / `setVoiceProviderKey` / `clearVoiceProviderKey` / `getConfiguredVoiceProviders`
- `src/server/orchestrator/api-routes.ts` — register the new routes module
- `src/server/orchestrator/services/index.ts` — re-export voice service
- `src/server/orchestrator/app-di.ts` — wire the voice provider factories and the TTS cache. `CredentialStore` is already in DI; no new manager needed.

### Android (modified)

- `android/app/src/main/AndroidManifest.xml` — `RECORD_AUDIO`, `uses-feature microphone` (for dictation; playback needs nothing)
- `android/app/src/main/java/com/shipit/wrapper/MainActivity.kt` — `WebChromeClient.onPermissionRequest` (for dictation)

## Testing

Vitest (unit / integration):

Dictation:

- **`insert-transcript.test.ts`** — pure logic, cursor splicing, selection replacement, leading-space heuristic.
- **`use-voice-input.test.ts`** — state machine transitions with `MediaRecorder` mocked, hotkey hold/release behaviour, autorepeat suppression, blur/visibilitychange handling, 250 ms minimum (no max-duration cap), session-switch abort.
- **`whisper.test.ts`** — STT provider adapter against a fake fetch, error mapping.
- **`claude-cleanup.test.ts`** / **`openai-cleanup.test.ts`** — cleanup adapters against a fake fetch / fake Anthropic client; assert the locked prompt is used, the output is returned verbatim, and the timeout fires at 3 s.
- **`cleanup.test.ts`** — `pickCleanupProvider()` selection order under each combination of (Claude OAuth present? OpenAI key present?); `cleanTranscript()` sanity checks: empty cleanup output → fall through to raw; cleanup output >2× input length → fall through; cleanup output starts with "Here is" → fall through; question-shaped input ("how do I add a button") is returned as the same question, not as an answer.
- **`MicButton.test.tsx`** — render in each state, click behaviour. Includes the `transcribing → cleaning` substate.

Playback:

- **`strip-for-tts.test.ts`** — pure markdown stripper: fenced code blocks removed, inline code removed, headings flattened, list markers turned into pauses, empty input returns empty string.
- **`extract-turn-prose.test.ts`** — walks an array of fake turn events and returns only the assistant prose; tool calls and tool results are dropped; multiple assistant messages in one turn are joined with appropriate whitespace.
- **`openai-tts.test.ts`** — TTS provider adapter against a fake fetch, error mapping, ensures the body is JSON with `text`, `voice`, `speed`, and `model`.
- **`tts-cache.test.ts`** — write / read / LRU eviction / restart-survival behavior.
- **`use-voice-playback.test.tsx`** — single-`Audio`-element invariant (starting turn B stops turn A and frees its element), pause/resume preserves position, stop resets to 0, error state on fetch failure, cache hit (second play of same turn does no fetch).
- **`PlayTurnButton.test.tsx`** — render in each state, click toggles play/pause, speed dropdown rewrites the request payload.

Shared / server:

- **`voice-routes.test.ts`** — integration test for `/api/voice/credentials` (set/clear/status round-trip), `/api/voice/transcribe` (multipart audio → fake STT provider → fake cleanup → returned cleaned + raw text, `cleanup: false` short-circuits cleanup, cleanup timeout falls through to raw, cleanup provider unavailable falls through to raw with the right `cleanupErrorCode`), `/api/voice/cleanup/status` (returns the selected provider name without leaking credentials), `/api/voice/speak` (JSON body → fake TTS provider → returned audio stream, second request returns cached bytes without hitting the provider, empty cleaned text returns 204), error paths (no key, provider failure for either direction).

Mode-B integration:

- **`quick-capture-voice.test.tsx`** — open overlay via Mode-B hotkey, verify mic auto-starts, drive a fake transcript, verify it lands in the overlay textarea (not the MessageInput textarea), verify Enter submits and creates a background session.

Manual QA covers the parts Vitest can't:

- Real mic capture in Chrome / Firefox / Safari on desktop.
- Whisper round-trip with a real OpenAI key.
- Cleanup round-trip with a real Claude Code OAuth (default) — verify a noisy transcript ("um so like add a uh react use effect for the timer") comes back clean ("Add a React useEffect for the timer"); verify a question stays a question; verify a transcript that's already clean comes back identical or near-identical.
- Cleanup fallback path: temporarily clear Claude auth, confirm Settings status flips to "Cleanup via your OpenAI key", verify the next dictation still cleans.
- Cleanup-disabled path: turn the toggle off, confirm raw Whisper output lands in the textarea unchanged.
- TTS round-trip with the same OpenAI key: Play a short turn, a long turn (multi-paragraph), a turn that's entirely a tool call (Play should not render), and a turn mixing prose and code blocks (code should not be read).
- Speed control behavior: 2× audibly faster, position scrubber moves at the right pace.
- Cache behavior: pressing Play on the same turn twice, the second press starts audibly faster and does not produce a new network request (verify in DevTools).
- Android WebView mic permission flow on a physical device (Pixel + a mid-tier device).
- Android playback: press Play, lock the screen, audio continues; unlock and pause works.
- Hotkey conflict scenarios on macOS / Windows / Linux for *both* hotkeys (Cmd+Tab during recording, alt-tab, screen lock, the Mode-A and Mode-B hotkeys pressed in quick succession).
- Mode B end-to-end: from any view, press Mode-B hotkey → overlay opens with mic recording → release hotkey → transcript lands → press Enter → background session created → original view preserved.
- Two-way loop on mobile: dictate a prompt via Mode A, wait for the response, press Play, listen with the screen off.

## Open questions to settle during build

1. **Hotkey scope.** Active only when the textarea is focused, or globally
   inside ShipIt? Default: focused-only, with a setting for global. Global
   risks clashing with browser shortcuts; revisit if users ask for it.
2. **Error UX detail level.** How verbose should the inline error be? E.g.
   "OpenAI returned 429 rate limit" vs "Couldn't transcribe — try again."
   Probably the latter, with a console log of the upstream detail.
3. **Audio format (STT).** `audio/webm;opus` works in Chrome/Firefox; Safari
   produces `audio/mp4` from MediaRecorder. Whisper accepts both. Validate
   on Safari during build.
4. **Audio format (TTS).** OpenAI offers `mp3`, `opus`, `aac`, `flac`,
   `wav`, `pcm`. Default to `mp3` for broadest `<audio>` element
   compatibility across desktop and mobile browsers; consider `opus`
   if Safari turns out to support it acceptably and the smaller bytes
   matter for the cache. Verify Safari behavior during build.
5. **Cache scope.** Is the TTS cache global to the orchestrator, or
   per-user when ShipIt eventually grows multi-user? Single-user
   self-hosted today means global is fine; flag for revisit when
   multi-user lands.
6. **Streaming vs. whole-blob fetch.** OpenAI's TTS endpoint streams
   audio bytes as they're synthesized. Start with the simpler "fetch
   whole response, then play" path and upgrade to `MediaSource`-backed
   streaming only if the time-to-first-audio is too slow on the long
   turns we actually have. Measure during QA.
7. **Long-turn segmentation.** A maxed-out turn (10k+ chars of prose)
   may hit OpenAI's per-request length limit. If we trip it during
   QA, segment the cleaned text by paragraph and stitch the resulting
   audio chunks. Don't pre-build that unless we see the limit.
8. **Claude Code OAuth scope for direct Anthropic calls.** Verify
   during build that the token `AuthManager` stores can be used to
   call the Anthropic API directly for cleanup, not only to spawn
   the `claude` CLI. If the OAuth scope rejects direct API use,
   shell out to a one-shot `claude` invocation with the cleanup
   prompt as a workaround — the `CleanupProvider` interface is
   already shaped to hide that difference from callers. If neither
   path works, demote Claude OAuth to a follow-up and ship v1 with
   OpenAI cleanup as the default; the user-visible behavior is the
   same and the Settings status string just changes.
9. **Cleanup prompt drift.** The prompt is locked in
   `cleanup-prompt.ts` and asserted by tests. Changes go through PR
   review; flagging here so the prompt isn't quietly tuned in a
   provider-specific way that creates divergent behavior between
   Claude and OpenAI.
10. **Cleanup-only failure UX.** When STT succeeds but cleanup
    fails, we currently surface a small warning next to the mic.
    Decide whether to keep the warning persistent for the session
    or auto-dismiss after the next successful dictation. Lean
    auto-dismiss after one success.

## Effort estimate

Assumes doc 145 (quick-capture overlay) has already shipped.

Dictation (input):

| Step | Effort |
|---|---|
| Server: credential field + routes + service + Whisper provider + tests | 1.5 days |
| Server: cleanup pipeline (`cleanup.ts`, `cleanup-prompt.ts`, Claude + OpenAI cleanup adapters, sanity checks, timeout, tests) | 1.5 days |
| Server: verify Claude Code OAuth path works for cleanup (and fall back to CLI shell-out if needed) | 0.5 day |
| Client: `voice/` input module, MediaRecorder capture, state machine, Mode-A hotkey, tests | 2.5 days |
| Client: cleanup substate in mic UI + cleanup-status string + warning toast on fall-through | 0.5 day |
| Client: MicButton, MessageInput wiring (Mode A) | 0.5 day |
| Client: QuickCaptureOverlay wiring + Mode-B hotkey + auto-start (Mode B) | 0.5 day |
| Android: manifest + WebChromeClient permission | 0.5 day |

Playback (output):

| Step | Effort |
|---|---|
| Server: TTS route + service + OpenAI TTS provider + `strip-for-tts.ts` + tests | 1 day |
| Server: disk-backed TTS cache + tests | 0.5 day |
| Client: `use-voice-playback` hook + `playback-store` + `extract-turn-prose` + tests | 1.5 days |
| Client: `PlayTurnButton` (idle / loading / playing / paused / error states, progress, speed dropdown) | 1 day |
| Client: MessageList integration — render Play on completed assistant turns | 0.5 day |

Shared:

| Step | Effort |
|---|---|
| Client: Settings UI + localStorage settings (input + playback fields, both hotkeys, provider, voice, speed, language) | 1 day |
| Cross-browser manual QA (Chrome / Firefox / Safari / Android) for *both* directions | 1.5 days |
| Polish: timer, error states, edge-case state-machine bugs found in QA, lock-screen playback verification | 2 days |

**Total: ~3–3.5 weeks for v1 as designed.** This is the realistic floor;
the input-side state-machine edge cases (blur during recording,
autorepeat, session switch mid-utterance, Mode-B hotkey pressed while
a Mode-A capture is in flight), the cleanup-provider verification work
(Claude Code OAuth scope, fall-through behavior, prompt regression
on real noisy transcripts), and the playback-side `Audio`-lifetime
edge cases (turn-switch mid-playback, session-switch mid-playback,
network drop mid-stream, cache eviction during playback) absorb an
extra few days in QA.
