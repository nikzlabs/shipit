---
description: Make ShipIt a platform where ANY Android repo gets a zero-setup build/test/preview loop in-container — auto-detected toolchain, headless Paparazzi rendering first, streamed emulator preview later.
issue: https://linear.app/shipit-ai/issue/SHI-170
---

# 213 — Android build, test & preview as a ShipIt platform capability

## Scope (read this first)

This is **not** "help the agent build ShipIt's own `android/` wrapper." It is: **ShipIt should be a
place you build Android apps** — any repo with an Android/Gradle project gets a build → test →
**preview** loop in-session, with **zero per-repo setup**. ShipIt's own WebView wrapper (`android/`)
is just the **first dogfood consumer**, not the target audience.

That reframe changes three things versus a repo-scoped design:

1. The toolchain **cannot** live in one repo's `shipit.yaml` (`agent.install`) — that's exactly the
   "separate complicated setup" we want to avoid. It must be **auto-provisioned by the platform** when
   an Android project is detected.
2. **Preview is in scope** (phased), not deferred. The goal is a preview-pane experience for Android
   comparable to the web preview, within the limits of what the container runtime allows.
3. The unit of design is the **platform** (session image, mounts, detection, preview proxy), not a
   doc edit in this repo.

## Recommendation (lead)

**Auto-detect Android projects, mount a platform-managed toolchain read-only, give the agent a
headless build/test/render loop now, and phase the preview from rendered-screens (zero-KVM, soon) to
a streamed emulator (KVM host pool, later).**

1. **Zero-config detection.** ShipIt detects an Android project (a `build.gradle(.kts)` applying
   `com.android.application`/`com.android.library`, or `settings.gradle` + a Gradle wrapper) during
   session setup. No `shipit.yaml` keys required from the user. Detection drives both toolchain
   provisioning and preview availability.
2. **Platform-managed toolchain via a shared read-only mount.** ShipIt maintains one host-side,
   version-pinned **Android SDK + JDK 17** asset and mounts it **read-only** into Android-detected
   sessions at a fixed path (`/opt/android-sdk`, `/opt/jdk17`), exporting `ANDROID_SDK_ROOT`/`JAVA_HOME`.
   No per-session download, **no image bloat for the ~99% of sessions that never touch Android**,
   shared across all sessions. This mirrors patterns ShipIt already uses — the shared
   `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers` mount and the host-side `repo-cache`/`dep-cache`
   volumes. Gradle's per-build caches stay per-session (workspace or a dep-cache-style volume).
3. **Headless build/test/render tier — works in any session today.** With the mount attached:
   `gradle :app:assembleDebug`, `gradle lint`, JVM unit tests, **Robolectric/Roborazzi**, and crucially
   **Paparazzi** — which renders Views *and* Compose `@Preview`s to PNG via `layoutlib` **on the JVM with
   no emulator**. This is what lets the agent *see* a layout/inset change and attach a real screenshot
   to the PR. Directly unblocks the sibling API-35 edge-to-edge work, which is editing blind today.
4. **Preview, phased:**
   - **P1 — rendered-screen preview (zero-KVM, soon).** Reuse the headless renderer (layoutlib via
     Paparazzi/Roborazzi; auto-discover screens from `@Preview`/Views with **ComposablePreviewScanner**)
     to produce a **gallery of rendered screens** in the preview pane, refreshed on change. Not
     interactive, but real visual feedback with no special hardware — achievable on the existing
     container runtime.
   - **P2 — interactive streamed emulator (KVM host pool, later).** A **dedicated emulator service**
     (NOT the session container) on a **KVM-capable host pool** boots an AVD, installs the freshly
     built debug APK, and streams the live screen + input into ShipIt's preview pane over **WebRTC**
     (the proven `google/android-emulator-container-scripts` + `android-emulator-webrtc` approach). This
     is the true web-preview-equivalent — but it needs nested-virt/bare-metal infra ShipIt does not
     have today (measured: the session container has **no `/dev/kvm`**).
   - **P3 — cloud device farm fallback.** **Firebase Test Lab** (or similar) runs instrumented
     tests / interactive sessions on real/virtual cloud devices when ShipIt isn't operating its own
     emulator pool; results (video, screenshots) surface **inline** in the PR card, never as a link-out.

One-line rationale: the platform should make Android development *work everywhere with no setup* (mount
+ detection), deliver the high-value, hardware-cheap feedback now (headless build/test + rendered-screen
preview), and treat the genuinely hardware-bound piece (an interactive emulator) as a phased infra
investment with an honest dependency on KVM.

## The gap today

The Android app (`android/`) builds **only** in GitHub Actions
(`.github/workflows/android.yml`: JDK 17 + `android-actions/setup-android` + Gradle 8.7). Inside a
session container the agent has **no Java, no Android SDK, no Gradle**, and the user has **no preview**.
So for *any* Android repo opened in ShipIt today, the agent edits Kotlin/XML blind and the user sees
nothing run. The web side has a tight loop (preview pane + Playwright); the Android side has nothing.

## Container reality check (measured, this session)

| Capability | State in the session container | Consequence |
|---|---|---|
| `/dev/kvm` | **absent** (`ls /dev/kvm` → No such file; no `vmx`/`svm`) | No hardware-accelerated emulator **in the session container**. Interactive emulator preview must be a **separate KVM host**, not the session box. |
| JDK | **absent** (`java` not on PATH) | Must be provided (mount or base image) before any Gradle run. |
| Gradle | **absent**; ShipIt's own `android/` has **no committed wrapper** | Provide Gradle via the wrapper (commit it) or the mount. |
| Memory / disk | host ~15 GiB; `/workspace` 150 GB, ~34 GB free | A Gradle build (`-Xmx2g`) + SDK (~1–1.5 GB) + caches fit. |

The KVM absence is the load-bearing fact and it is specifically about the **session container**. It
does **not** block headless rendering (P1) and it does **not** forbid an interactive emulator — it
relocates the emulator to a **virt-enabled host pool** ShipIt would have to operate (P2).

## Toolchain provisioning — making it work for ANY repo, no setup

The agent runs in the **session-worker image** (fixed per deploy, not per-repo). To give *any* Android
repo a toolchain with no `shipit.yaml` edits:

| Option | How | Verdict |
|---|---|---|
| **A. Shared read-only SDK+JDK mount, auto-attached on detection** | Platform maintains one version-pinned host asset; mount read-only at `/opt/android-sdk` + `/opt/jdk17` into Android-detected sessions; export `ANDROID_SDK_ROOT`/`JAVA_HOME` | **Recommended.** Zero setup, zero per-session download, zero image bloat for non-Android sessions, shared across all. Same shape as the existing `PLAYWRIGHT_BROWSERS_PATH` mount + `repo-cache`/`dep-cache`. |
| **B. Android session-image variant** | A second worker image with SDK+JDK baked, selected when Android is detected | Workable but doubles image ops and is coarser than a mount; pick only if mount provisioning proves fragile. |
| **C. Bake into the base session image** | SDK+JDK in every worker image | **Rejected.** Taxes every session (~1.5+ GB) for a capability ~99% don't use. |
| **D. Per-repo `agent.install`** | Each Android repo installs the SDK itself | **Rejected** — this *is* the "complicated per-repo setup" the user explicitly wants to avoid; also re-downloads on cold re-clone. (It remains a fine **escape hatch** for an exotic toolchain, but not the default.) |

**Chosen: A + detection.** The platform owns one maintained, pinned toolchain (a small CI/setup job
builds the asset: cmdline-tools → `sdkmanager` platform/build-tools 35 + Temurin JDK 17; bumped
deliberately like the agent CLIs). A session that looks like an Android project gets it mounted
automatically. The user does nothing.

Detection heuristic (cheap, run at setup alongside the existing compose/shipit.yaml detection):
presence of `settings.gradle(.kts)` **and** a module `build.gradle(.kts)` applying an Android plugin,
or an `android {}` block. Gives a definite "this session needs the Android toolchain + an Android
preview surface" signal.

Prereq for ShipIt's own repo: **commit the Gradle wrapper (8.7)** under `android/` (it's missing today;
doc 116 claimed it was committed). The wrapper pins Gradle independent of the mount.

## Two test tiers

### Tier A — headless (mount only, no emulator) — viable on the current runtime

- **`assembleDebug`** — full compile + packaging; the core "did I break the build?" signal.
- **`lint`** — manifest/resource/accessibility + **edge-to-edge/inset** checks (API-35-relevant).
- **JVM unit tests** + **Robolectric** — pure logic and Android-framework-on-the-JVM behavior.
- **Paparazzi / Roborazzi** — render Views and Compose `@Preview`s to PNG via `layoutlib` **on the JVM,
  no emulator**, diff against committed goldens. Paparazzi tracks AGP closely; pin it to the repo's AGP
  (this repo: AGP 8.5.2 / Kotlin 1.9.24 / Gradle 8.7) and bump together. *(Google's official Compose
  Preview Screenshot Testing needs AGP 9 — Paparazzi/Roborazzi are the right fit until a repo is on AGP 9.)*
  - Caveat for ShipIt's wrapper specifically: its main surface is a **`WebView`**, which `layoutlib`
    does not render. Paparazzi covers the **chrome/insets/settings screen** — exactly the API-35 surface —
    not web content. For general Android apps (real native UIs) this caveat doesn't apply and Paparazzi
    is high-coverage.

### Tier B — instrumented (needs a device) — separate host / cloud only

`connectedAndroidTest` (Espresso/UIAutomator) and *live full-app* screenshots need a running Android OS.
Not in the session container (no KVM). Paths: **Gradle Managed Devices** on a KVM CI runner, or
**Firebase Test Lab**. Results surface **inline** in ShipIt (PR-card artifacts), per the link-out-is-an-
escape-hatch principle.

## Preview — designed, phased (the part you asked to push on)

The web preview pane sets the bar: see your change run, inside ShipIt. For Android we get there in stages.

### P1 — rendered-screen preview (zero-KVM, near-term)

The headless renderer that powers Paparazzi/Roborazzi can render an app's screens **without a device**.
Wire that into a **preview surface**:

- Auto-discover renderable screens (`@Preview` composables, key Views) — **ComposablePreviewScanner**
  generates the render set with no per-screen test authoring.
- On change, re-render to PNGs and show a **gallery of screens** in the preview pane (one tile per
  screen/state/config — light/dark, font scale, locale). This is *static* (no touch input) but it's
  **real, hardware-free visual feedback** that runs on today's container runtime and re-renders like a
  (slow) hot reload.
- Fits ShipIt's surface: rendered images stream into the existing preview pane; the agent can drive
  re-renders and reason over the PNGs. No KVM, no external tab.

This is the **recommended first preview** — most of the "can I see my UI?" value, none of the emulator
infra. It also doubles as the Paparazzi golden source, so preview and snapshot-testing share machinery.

### P2 — interactive streamed emulator (KVM host pool, later)

For a *real, touchable* device preview:

- A **dedicated emulator service** runs on a **KVM-capable host pool** (nested-virt cloud instances or
  bare metal) — **not** the session container. It boots an AVD, installs the session's freshly built
  `app-debug.apk`, and **streams the screen + input to the browser over WebRTC** (proven by
  `google/android-emulator-container-scripts` + `android-emulator-webrtc`: WebRTC for video, gRPC for
  input). Rendered inside ShipIt's preview pane → satisfies "inline beats link-out."
- Honest cost: this needs infra ShipIt does not run today — a separate virt-enabled pool, emulator
  lifecycle management, APK push on each build, a WebRTC bridge through the preview proxy. It is a real
  architecture (widely used for cloud Android), but a **deliberate infra investment**, phased after P1.
- Without KVM the emulator falls back to software mode — "excruciatingly slow, unsuitable for
  interactive use" — so P2 is gated on provisioning KVM hosts. No shortcut.

### P3 — cloud device farm fallback

When ShipIt doesn't operate its own emulator pool, **Firebase Test Lab** (or a device-cloud) runs
interactive/instrumented sessions on real/virtual cloud devices; video + screenshots come back as
**inline PR-card artifacts**. Good for instrumented coverage and for occasional real-device validation
without standing up a pool.

### ShipIt's own wrapper is the easy case

`android/` is a **WebView** shell — its "preview" is *literally the web preview already in ShipIt*
pointed at a dev URL. So dogfooding the toolchain (build/lint/Paparazzi-of-the-chrome) is valuable, but
the wrapper is **not** the app that motivates P2; general native Android apps are.

## Agent surfacing

1. **`src/server/shipit-docs/android.md`** (baked into the session image at `/shipit-docs/`) — the
   headless commands, the mount paths (`ANDROID_SDK_ROOT=/opt/android-sdk`), how to record/verify
   Paparazzi goldens, that **rendered-screen preview** is the in-session visual loop, and the **emulator
   ceiling** (no in-container device — don't try to launch one).
2. **`.claude/skills/android-build` skill** — discloses by description, loads when a task touches an
   Android project; carries the build → lint → render/snapshot → read-the-PNG-diff → attach-to-PR loop.
   Per `docs/209-cross-agent-skill-disclosure`, one skill covers both Claude and Codex.

## Phased plan

- **Phase 0 (prereq):** Commit the Gradle wrapper (8.7) under `android/`; add Android detection during
  session setup.
- **Phase 1 (toolchain, any repo):** Build the platform SDK+JDK asset; mount it read-only into
  Android-detected sessions; export env. Verify `assembleDebug` + `lint` + a first JVM unit test run
  green in-container for a generic Android repo. Ship `shipit-docs/android.md` + the skill.
- **Phase 2 (headless UI + P1 preview):** Add Paparazzi/Roborazzi (pinned to AGP); wire the rendered-
  screen gallery into the preview pane (ComposablePreviewScanner for discovery). This is the agent's
  *and* the user's first Android visual feedback.
- **Phase 3 (P2 preview, infra-gated):** Stand up a KVM-capable emulator host pool; emulator service +
  WebRTC bridge through the preview proxy; APK push on build. The interactive device preview.
- **Phase 4 (P3 / instrumented):** Firebase Test Lab (or GMD on KVM CI) for instrumented tests and
  real-device validation, surfaced as inline PR artifacts.

## Relationship to other work

- **Unblocks the API-35 edge-to-edge bump (sibling session, blind today).** Phase 1 lets it compile +
  lint the `targetSdk`/`compileSdk` 35 change; Phase 2 (Paparazzi of the chrome / rendered-screen
  preview) lets it *verify the insets* instead of guessing. High-leverage to land Phase 1 + a minimal
  Paparazzi golden ahead of / alongside that bump.
- **SHI-53** tracks the WebView **wrapper feature** (doc 116). This doc is the **platform build/test/
  preview capability** — distinct lifecycle, its own tracker item (**SHI-170**). The interactive
  Android **preview** (P2) may warrant its own sub-issue once Phase 1–2 land; noted, not split yet.

## Risks / open questions

- **Mount provisioning + maintenance.** The shared SDK+JDK asset needs a build/version-bump pipeline
  (pin like the agent CLIs). Mount must be genuinely read-only; Gradle's writable caches go to a
  per-session/dep-cache path. Decide JDK-in-mount vs JDK-in-base-image (mount keeps the base lean).
- **Detection false negatives/positives.** Heuristic must catch nested Android modules and not fire on
  random `.gradle` files. Allow an explicit `shipit.yaml` opt-in/out as the escape hatch.
- **P2 is real infra.** A KVM host pool is an operational commitment (cost, capacity, lifecycle,
  security isolation of the emulator service). Phase it; don't let "preview would be great" pull it
  ahead of the zero-KVM P1 that delivers most of the value.
- **Paparazzi ↔ AGP coupling** and **WebView-not-renderable** caveats (as above).
- **Memory contention** of a Gradle build alongside the agent on the session's cap — watch for OOM,
  tune Gradle heap.

## Key files (to touch when implemented — not yet changed)

- Session setup / detection (`shared/session-config.ts`, container-lifecycle) — Android-project detection
  + conditional read-only toolchain mount + env (`ANDROID_SDK_ROOT`, `JAVA_HOME`).
- A platform job/asset that builds the pinned SDK+JDK mount (analogous to the agent-CLI / playwright
  install in `docker/`).
- `android/gradlew`, `android/gradle/wrapper/*` — **new**, commit the pinned 8.7 wrapper (Phase 0).
- `android/app/build.gradle.kts` — add Paparazzi/Roborazzi (Phase 2).
- Preview proxy / preview-store — rendered-screen gallery surface (P1); WebRTC emulator route (P2).
- `src/server/shipit-docs/android.md` + `.claude/skills/android-build/SKILL.md` — **new**, agent surfacing.
- `.github/workflows/android.yml` — GMD/Firebase job is a Phase 4 addition.
</content>
