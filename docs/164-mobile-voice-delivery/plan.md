---
status: planned
priority: low
description: Options for delivering voice notes to a backgrounded or closed mobile device, where in-browser delivery and autoplay are impossible — server-push to a channel that survives a dead tab.
---

# Mobile / background voice delivery — options

## Problem

`docs/163-voice-notes` defines a voice-note primitive and a delivery router with
sinks (Native inline / External webhook / Both). Its **Native sink is
foreground-only**: it works when ShipIt is the active, visible tab. This doc
covers the part 163 explicitly defers — **reaching a mobile device whose ShipIt
tab is backgrounded, the screen is locked, or the app is closed.** That's the
"phone in my pocket while the agent works" case, which is exactly where voice
output is most valuable.

This is an options doc. It does not commit to one path yet; it lays out the
feasible mechanisms, what each can and can't do, and how each slots into the
existing 163 router.

## Why the browser cannot do this (the hard constraint)

Two independent browser limits stack, and a WebView wrapper does **not** escape
either:

1. **Delivery fails.** 163's Native sink emits a `voice_note` over the
   per-session WebSocket (`runner.emitMessage`). A backgrounded/frozen tab has
   its JS throttled and its WS dropped, so the message **never arrives** until
   the page is foregrounded and reconnects.
2. **Autoplay is blocked.** Even if a note arrived, starting fresh audio from a
   non-visible page is blocked by autoplay policy. (Audio *already* playing
   continues in the background — how web music players work — but *initiating*
   playback on an incoming event does not.)

**`docs/116`'s WebView wrapper shares the page lifecycle of Chrome** — it hides
the address bar, nothing more. It has no foreground service, no native TTS, and
explicitly scopes push out (116 "Out of scope": push notifications). So "use the
wrapper" buys nothing here unless the wrapper is *upgraded* with native
capabilities (Option C).

**Conclusion:** anything that reaches a dead tab must be **server-initiated push**
to a channel that survives the tab being gone. It cannot ride the client WS.
Architecturally this is clean: each option below is just **another sink in the
163 router**, driven server-side from the same `{ summary, needsAttention,
context }` payload. The agent-facing primitive does not change.

## What "delivered" can mean

Two distinct outcomes, and not every option achieves both:

- **Alert** — get the user's attention with the screen off (a system
  notification + sound/vibration, and a readable headline). They learn *that*
  the agent needs them and *what about*, then tap to act.
- **Spoken** — the ear-shaped headline is actually *read aloud* hands-free,
  without the user touching the device.

The "spoken, hands-free, screen-off" outcome is the high bar; only a *native*
audio path achieves it. Browser-based options top out at "alert."

## Options

### Option A — External webhook → external app (baseline; already in 163)

ShipIt POSTs the payload to a user-configured webhook; the receiver delivers via
an app that's allowed to make noise with the screen off — Telegram, a push
service, or a voice call (the existing `docs/159` receiver pattern).

- **Alert:** ✅ (native app notification). **Spoken:** ✅ if the receiver routes
  to a voice channel / TTS-capable app (e.g. a voice call, or Telegram's own
  audio).
- **Needs:** the user to stand up / run a receiver (an evening of work per
  159). No ShipIt mobile-client work at all — delivery is entirely server→
  external.
- **Pro:** already designed and decided in 163; sidesteps the browser entirely;
  works on any phone with the target app installed; the user already has this
  via hermes.
- **Con:** depends on a third-party app and a user-hosted receiver; not
  first-party; ShipIt doesn't own the experience.
- **Status:** this is the **recommended day-one answer** for background mobile —
  it requires nothing new beyond 163.

### Option B — Web Push + service worker (lightest first-party)

ShipIt registers a service worker and a Web Push subscription; the orchestrator
encrypts and POSTs the payload to the browser vendor's push service (FCM /
Mozilla / Apple), which wakes the SW even with the tab closed; the SW shows a
system notification with the headline + a chime.

- **Alert:** ✅. **Spoken:** ❌ in background — **a service worker cannot autoplay
  arbitrary audio.** It can show a notification with a short system sound only.
  Tapping the notification foregrounds ShipIt, which can *then* play the TTS
  (now visible + a user gesture exists).
- **Needs:** VAPID keypair, a `service-worker.js`, a subscribe/permission flow, a
  store of push subscriptions per user/device, and a `push` event handler. All
  first-party; no third-party app, no user-hosted receiver.
- **Pro:** lightest path to first-party "reach me, screen off" — ShipIt itself
  owns it. No Telegram, no native build.
- **Con:** alert-only in background (the spoken note happens on tap); browser
  vendor push infra is in the path; **iOS only supports Web Push for a PWA the
  user "Add to Home Screen"-installed, iOS 16.4+** (plain Safari tabs get
  nothing); requires HTTPS and a granted permission.

### Option C — Native Android wrapper upgrade (only true hands-free-spoken)

Upgrade `docs/116`'s WebView shell into a real app: a **foreground service** to
keep a connection (or an FCM channel) alive, a **native TextToSpeech / MediaPlayer**
bridge so audio plays regardless of browser autoplay policy, and **FCM push** to
wake the app. The WebView JS posts the note to the native layer, which speaks it.

- **Alert:** ✅. **Spoken:** ✅ truly hands-free, screen off — native apps aren't
  subject to autoplay policy and a foreground service keeps the app live.
- **Needs:** substantial native Kotlin work (foreground service + notification
  channel, FCM integration with VAPID/sender setup, a JS↔native bridge, native
  TTS), plus the battery/permission UX that comes with a foreground service.
- **Pro:** the only path to "phone in pocket, ShipIt itself speaks the note
  aloud" without a third-party app.
- **Con:** large effort; **directly contradicts 116's current minimal scope**
  ("~300–500 lines, hide the address bar, push out of scope") — 116 would need
  re-scoping or a successor doc; Android-only; foreground services have their own
  battery-drain and OEM-killer headaches (116 already flags aggressive
  battery-saver connection drops).

### Option D — Installed PWA + Web Push (cross-platform variant of B)

Ship/refine the existing `manifest.webmanifest` so users install ShipIt as a PWA
("Add to Home Screen"), then use Web Push (Option B) from within it. This is the
only way to get Web Push on **iOS** (16.4+), and on Android an installed PWA gets
a real app icon and slightly better lifecycle than a tab.

- Same alert-only-in-background limit as B. Still no hands-free spoken in
  background (no native TTS).
- **Pro:** cross-platform (incl. iOS), no native build, reuses the manifest we
  already ship.
- **Con:** install friction; iOS Web Push reliability is newer/less proven;
  same "alert not spoken" ceiling.

## Comparison

| Option | Alert (screen off) | Spoken hands-free (screen off) | First-party | Mobile-client work | Cross-platform |
|---|---|---|---|---|---|
| A — External webhook | ✅ | ✅ (via voice channel) | ❌ (external receiver) | none | ✅ (any app) |
| B — Web Push + SW | ✅ | ❌ (spoken on tap) | ✅ | medium | Android; iOS only if installed |
| C — Native wrapper upgrade | ✅ | ✅ | ✅ | large (native) | Android only |
| D — Installed PWA + Web Push | ✅ | ❌ (spoken on tap) | ✅ | medium | ✅ (incl. iOS 16.4+) |

## Suggested sequencing (not a commitment)

1. **Now:** Option A is the documented background answer — it falls out of 163's
   webhook sink for free. No new work.
2. **Next, if first-party "reach me screen-off" is wanted without Telegram:**
   Option B/D (Web Push), accepting alert-only-in-background. Medium lift, owns
   the experience, cross-platform via D.
3. **Later, only if truly hands-free spoken background is a hard requirement:**
   Option C, as a re-scope of (or successor to) 116. Large native effort; weigh
   against just using A's voice channel.

The recurring tradeoff: **A and C give spoken background but cost either a
third-party dependency (A) or a big native build (C); B/D are first-party and
cross-platform but can only alert in the background.** There is no option that is
simultaneously first-party, no-native-build, and hands-free-spoken-in-background —
that combination is not achievable on today's mobile web.

## Relationship to other docs

- **`docs/163-voice-notes`** — owns the primitive, the router, the foreground
  Native sink, and the External webhook sink. Every option here is a new sink in
  *its* router; this doc does not redefine the payload or the agent tool.
- **`docs/116-android-webview-app`** (`planned`, `low`) — its current scope is a
  thin WebView shell with push explicitly out of scope. Option C would re-scope
  or supersede it. Until then, the wrapper does **not** help background voice.
- **`docs/159-turn-end-notification-mcp`** (`done`) — the receiver pattern Option
  A builds on; the webhook is 163's re-scoping of it.
- **`docs/060-global-notifications`** — check for any existing notification
  infrastructure (SSE/global events) before building Web Push from scratch;
  there may be shared plumbing.

## Open questions

1. **Is hands-free-spoken-in-background actually required**, or is "alert me
   screen-off, I'll tap to hear" (Option B/D) sufficient for the real use case?
   This single answer decides whether C is ever worth its cost.
2. **Web Push subscription storage & multi-device** — where do per-device
   subscriptions live, how are they pruned (expired endpoints 410), and how does
   this interact with sessions vs. account-level?
3. **De-dup across background sinks + the foreground Native sink** — if the tab
   later foregrounds, does the user get both a push *and* the inline note for the
   same event? (163's single-router de-dup logic needs to extend to "already
   delivered via push.")
4. **Does any of this need the orchestrator to know device state** (foreground
   vs. background) to choose a sink, or is it purely the user's per-channel
   setting? Leaning: user setting; the server can't reliably know tab state.
5. **iOS reach** — is the PWA-install requirement (Option D) acceptable, or is
   iOS background delivery only ever via Option A (external app)?
