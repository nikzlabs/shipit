## Phase 8 — Mobile recording UX

- [x] Expose `cancelRecording` (the existing `abortRecording`) on `VoiceInputApi` so a Cancel gesture can discard audio without transcribing.
- [x] `MicButton`: add a `large` prop that enlarges the mobile tap target (`p-3` vs `p-1.5`); icon size unchanged.
- [x] New `MobileRecordingOverlay` — full-screen scrim with a big centered Stop button, live timer, "Listening…" label, Cancel control, and a transcribing spinner; Escape cancels while recording.
- [x] Wire into `MessageInput`: `large={isMobile}` on the mic, mount the overlay only when `voiceInputEnabled && isMobile`.
- [x] Tests: `MobileRecordingOverlay.test.tsx` (stop / cancel / Escape / transcribing / idle+error render nothing) and a `large`-padding case in `MicButton.test.tsx`.
- [ ] Manual QA on a real phone: tap the enlarged mic, confirm the overlay covers the screen, Stop transcribes into the composer, Cancel discards, and the desktop inline path is unchanged.

## Phase 1 — Shared foundation

- [x] Add `voiceProviderApiKey` and `voiceProvider` to `CredentialData` in `credential-store.ts`.
- [x] Add `POST` / `DELETE` / `GET status` routes for `/api/voice/credentials` in a new `api-routes-voice.ts`, registered via `api-routes.ts`.
- [x] Scaffold `services/voice.ts` and re-export from `services/index.ts`.
- [x] Extend `settings-store.ts` with input fields (`voiceInputEnabled`, `sttProvider`, `voiceHotkeyModeA`, `voiceHotkeyModeB`, `voiceLanguage`) and playback fields (`voicePlaybackEnabled`, `ttsProvider`, `ttsVoice`, `ttsSpeed`); persist via `local-storage.ts`.
- [x] Add the "Voice" section shell to `Settings.tsx` with shared API key field, `Configured ✓ / Not set` status, and Test button stub.

## Phase 2 — Dictation: Mode A (MessageInput)

- [x] Implement `voice/capture.ts` MediaRecorder wrapper.
- [x] Implement `voice/insert-transcript.ts` with cursor splice, selection replacement, leading-space heuristic; unit tests.
- [x] Implement `voice/use-voice-input.ts` state machine: keydown/keyup, autorepeat suppression, blur/visibilitychange handling, 250 ms minimum, 60 s cap, session-switch abort, `transcribing → cleaning` substates; unit tests.
- [x] Implement `voice/providers/whisper.ts` STT adapter against a fake fetch; unit tests.
- [x] Wire `POST /api/voice/transcribe` (multipart audio + language + `cleanup` flag) through `services/voice.ts` to the Whisper adapter; integration tests for success and error paths.
- [x] Build `MicButton` component with idle / recording / transcribing / cleaning / error states + cleanup-fall-through warning; render tests.
- [x] Wire MicButton into `MessageInput.tsx`; route transcript to `setText` only (never to send).
- [x] Wire the Mode A hotkey (`Ctrl+Shift+Space` default) with conflict detection against the existing app hotkey map.

## Phase 2b — Transcript cleanup (LLM pass)

- [x] Add `voice/cleanup-prompt.ts` with the locked cleanup prompt; reference it from both adapters.
- [x] Implement `voice/providers/claude-cleanup.ts` using the OAuth bearer surfaced by `AuthManager.getAccessToken()`; unit tests against a fake Anthropic client.
- [x] Verify during build that the Claude Code OAuth bearer can be used for direct Anthropic API calls; if not, shell out to a one-shot `claude` CLI invocation behind the same `CleanupProvider` interface.
- [x] Implement `voice/providers/openai-cleanup.ts` using `gpt-4o-mini` and the OpenAI voice key; unit tests.
- [x] Implement `voice/cleanup.ts` with `pickCleanupProvider()` (selection order: Claude OAuth bearer present → OpenAI voice key present) and `cleanTranscript()` (3 s timeout, empty-output / >2× length / preamble sanity checks, fall-through-to-raw with `cleanupErrorCode`); unit tests covering each fall-through case, the selection gating on `getAccessToken()` rather than `checkCredentials()`, and the "question stays a question" assertion.
- [x] Extend `POST /api/voice/transcribe` to run cleanup when the `cleanup` flag is true and a provider is available; return `{ text, rawText, cleanupProvider?, cleanupErrorCode? }`.
- [x] Add `GET /api/voice/cleanup/status` returning the selected provider (or `null`) without leaking credentials.
- [x] Add `cleanupEnabled` to the settings store; surface it as the "Clean up transcripts with an LLM" toggle in Settings.
- [x] Render the read-only cleanup-provider status string under the toggle; refetch on Claude/OpenAI credential changes.
- [x] Wire the mic-button warning toast for the cleanup-fall-through case; auto-dismiss on the next successful cleanup.
- [x] Manual QA: noisy transcript → cleaned correctly; question stays a question; toggle off → raw inserted; Claude path → fallback path (clear Claude auth, confirm OpenAI cleanup takes over).

## Phase 3 — Dictation: Mode B (QuickCaptureOverlay)

- [x] Embed `MicButton` in `QuickCaptureOverlay`; wire a Mode B hook instance routing transcript to the overlay's own `setText`.
- [x] Add a Mode B variant in `useQuickCaptureHotkey` that opens the overlay *and* auto-starts mic capture.
- [x] Confirm the Mode B default hotkey (`Ctrl+Shift+M`) has no conflict on macOS / Windows / Linux; if Firefox-on-Linux bookmarks-bar collides, pick the backup.
- [x] Add `quick-capture-voice.test.tsx` end-to-end test: Mode B hotkey opens overlay, mic auto-starts, fake transcript lands in the overlay textarea, Enter creates a background session.
- [x] Implement the Test button round-trip in Settings: short mic capture → Whisper → reports success or error.

## Phase 4 — Playback (TTS)

- [x] Implement `voice/strip-for-tts.ts` pure stripper (fenced code, inline code, headings, list markers, link URLs, empty-input case); unit tests.
- [x] Implement `voice/extract-turn-prose.ts` walking a turn's events to a single string (drop tool calls, tool results, attachments; join assistant messages); unit tests.
- [x] Implement `voice/providers/openai-tts.ts` against a fake fetch (text, voice, speed, model); unit tests.
- [x] Implement `voice/tts-cache.ts` disk-backed LRU keyed by `sha256(text+voice+speed+provider)`; unit tests for write, hit, eviction, restart survival.
- [x] Wire `POST /api/voice/speak` through `services/voice.ts`: strip → hash → cache check → on miss call adapter → write cache → stream `audio/mpeg`; 204 on empty cleaned text; integration tests covering cache hit, miss, and provider error.
- [x] Implement `voice/playback-store.ts` Zustand store: `playingTurnId`, `state`, `positionMs`, `durationMs`, single `HTMLAudioElement` invariant.
- [x] Implement `voice/use-voice-playback.ts` hook: play / pause / resume / stop / error, single-element invariant (switching turns frees the previous element), per-turn blob URL reuse; unit tests.
- [x] Build `PlayTurnButton` with idle / loading / playing / paused / error states, progress indicator, speed dropdown (1×, 1.25×, 1.5×, 2×); render and interaction tests.
- [x] Render `PlayTurnButton` on completed assistant turns in `MessageList` (or the existing turn-footer component); suppress when extracted prose is empty.
- [x] Extend the Settings Test button to also run a one-sentence TTS round-trip and report success / error separately from STT.

## Phase 5 — Android

- [x] Add `<uses-permission android:name="android.permission.RECORD_AUDIO" />` and the `android.hardware.microphone` `uses-feature` entry to `AndroidManifest.xml`.
- [x] Override `WebChromeClient.onPermissionRequest` in `MainActivity.kt` to grant `PermissionRequest.RESOURCE_AUDIO_CAPTURE` after the Android runtime-permission flow.
- [ ] Build via the "Android build" GitHub Actions workflow; install on a physical Pixel and a mid-tier device.
- [ ] Verify mic permission flow end-to-end (first-time grant, deny + re-grant, app backgrounding mid-capture).
- [ ] Verify playback continues with the screen locked and that pause works after unlock.

## Phase 7 — Multi-provider refactor (ElevenLabs TTS + Deepgram STT)

- [x] Add the shared provider catalog `src/server/shared/voice-catalog.ts` (pure data + selectors: `getVoiceProvider`, `sttProviders`, `ttsProviders`, `keyRequiringProviders`, `providerVoices`, `providerSupports`, `isValidVoice`, `defaultVoiceFor`, `providerSpeeds`); unit tests.
- [x] Replace the single-key credential model with a multi-key one: `voiceProviderKeys?: Record<string, string>` on `CredentialData` plus `getVoiceProviderKey` / `setVoiceProviderKey` / `clearVoiceProviderKey` / `getConfiguredVoiceProviders` on `CredentialStore`.
- [x] Add the server provider registry `voice/registry.ts` (`getVoiceAdapters(id)` → STT/TTS factories + `ttsContentType`); unit tests.
- [x] Implement `voice/providers/elevenlabs-tts.ts` (ElevenLabs `text-to-speech`, `eleven_multilingual_v2`); unit tests against a fake fetch.
- [x] Implement `voice/providers/deepgram.ts` (Deepgram `listen`, `nova-2`, smart_format); unit tests against a fake fetch.
- [x] Make `services/voice.ts` data-driven: validate the requested provider against the catalog and dispatch through the registry instead of hardcoding OpenAI; speak validates `isValidVoice` + catalog `speedRange`.
- [x] Add a `provider` field to the voice routes (`speak` body, `transcribe` `sttProvider` multipart field, `credentials` POST/DELETE body), defaulting to `openai`; update `api-routes-voice.test.ts` to the multi-key API.
- [x] Settings UI: per-provider key fields from `keyRequiringProviders()`, STT/TTS provider dropdowns, voices/speeds from the catalog; `setTtsProvider` snaps stale voice/speed to valid defaults.
- [x] Client wiring: `sttProvider` threaded through `use-voice-input` + `MessageInput`; `playback-store` sends `provider` and namespaces its cache key by provider.
- [ ] Manual QA: configure an ElevenLabs key, play a turn with an ElevenLabs voice; configure a Deepgram key, dictate with Deepgram STT; confirm OpenAI still works with no provider field.

## Phase 6 — Cross-browser QA + polish

- [ ] Chrome desktop: dictation (both modes), playback (short turn, long turn, code-only turn suppresses Play), cache hit on second Play.
- [ ] Firefox desktop: same matrix.
- [ ] Safari desktop: verify the Whisper round-trip with `audio/mp4`; confirm `mp3` TTS playback works; pick `opus` only if Safari handles it cleanly.
- [ ] Hotkey conflict matrix: `Cmd+Tab` mid-recording, alt-tab, screen lock during capture, Mode A and Mode B pressed in quick succession; verify the state machine recovers cleanly each time.
- [ ] End-to-end mobile loop: Mode A dictate → wait for response → press Play → listen with the screen off.
- [ ] Polish: inline error UX on the mic button and Play button (terse user-facing text, console-logged detail), recording-elapsed timer, playback progress indicator alignment.
- [ ] Verify the TTS cache cap (~200 MB) evicts correctly under load and that eviction during playback does not stall the current `HTMLAudioElement`.
- [ ] Decide on `audio/webm;opus` vs `audio/mp4` for STT and `mp3` vs `opus` for TTS based on Safari results; update the doc's open questions section with the chosen formats.
- [ ] Only if OpenAI's per-request character limit is tripped during QA: segment cleaned text by paragraph and stitch the resulting audio chunks; add a regression test.
