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
   `com.android.application`/`com.android.library`, or an `android {}` block) during session setup.
   No `shipit.yaml` keys required from the user. Detection also **parses the repo's declared
   requirements** — `compileSdk`/`targetSdk`, `ndkVersion`, any CMake/`externalNativeBuild` usage, and
   the AGP version — because a one-size SDK does **not** build "any repo." Detection drives toolchain
   provisioning *and* preview availability.
2. **Platform-managed toolchain: shared read-only base + per-session component overlay + Gradle + JDK matrix.**
   ShipIt maintains a host-side, version-pinned **base store** — cmdline-tools, platform-tools, **a
   matrix of common API levels + build-tools** (e.g. 33/34/35), licenses pre-accepted, **a Gradle
   distribution cache**, and **multiple JDKs** (at least 11 + 17, room for 21) — mounted **read-only** at
   `/opt/android-sdk` + `/opt/jdk*` (exporting `ANDROID_SDK_ROOT`; `JAVA_HOME` set **per detected
   project**). When detection finds a repo-declared component the base lacks (an older/newer
   `compileSdk`, an `ndkVersion`, a CMake toolchain), ShipIt provisions it into a **writable per-session
   SDK overlay** (or a host-side cache populated before start) layered over the read-only base — so
   `sdkmanager` writes never touch the shared store. **Gradle and the JDK are selected together** from
   the project's AGP: `./gradlew` when the repo commits a wrapper, else a base-store Gradle from a
   documented **AGP→Gradle matrix**, with `JAVA_HOME` pointed at the matching JDK (very old Gradle can't
   run on Java 17, so a single JDK doesn't cover "any repo" — define a supported AGP/Gradle/JDK floor).
   The base gives no per-session download for the common case and
   **no image bloat for the ~99% of sessions that never touch Android**; the overlay handles the long
   tail. This mirrors patterns ShipIt already uses — the shared
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
| **A. Shared read-only base store + writable per-session component overlay, auto-attached on detection** | Platform maintains a version-pinned host base (JDK 17, cmdline-tools, common API levels + build-tools + Gradle cache, licenses accepted); mount read-only at `/opt/android-sdk` + `/opt/jdk17`; a writable overlay provisions repo-declared components (`compileSdk`/NDK/CMake) the base lacks; Gradle from `./gradlew` or an AGP-matched base version | **Recommended.** Zero setup, zero per-session download for common SDKs, zero image bloat for non-Android sessions, base shared across all; overlay covers the long tail. Same shape as the existing `PLAYWRIGHT_BROWSERS_PATH` mount + `repo-cache`/`dep-cache`. |
| **B. Android session-image variant** | A second worker image with SDK+JDK baked, selected when Android is detected | Workable but doubles image ops and is coarser than a mount; pick only if mount provisioning proves fragile. |
| **C. Bake into the base session image** | SDK+JDK in every worker image | **Rejected.** Taxes every session (~1.5+ GB) for a capability ~99% don't use. |
| **D. Per-repo `agent.install`** | Each Android repo installs the SDK itself | **Rejected** — this *is* the "complicated per-repo setup" the user explicitly wants to avoid; also re-downloads on cold re-clone. (It remains a fine **escape hatch** for an exotic toolchain, but not the default.) |

**Chosen: A + detection.** The platform owns a maintained, pinned **base store** (a small CI/setup job
builds it: cmdline-tools → `sdkmanager` for a matrix of common API levels + build-tools, **all licenses
accepted** → a Gradle distribution cache → Temurin JDKs (11 + 17); bumped deliberately like the agent CLIs). A
session that looks like an Android project gets the base mounted read-only automatically, and any
repo-declared component the base lacks is provisioned into the **writable per-session overlay** before
the first build. The user does nothing.

Why a single fixed SDK is not enough: an Android repo declares its own `compileSdk`/`targetSdk` (and
sometimes `ndkVersion` + CMake), and the build **fails** if that exact platform/build-tools/NDK isn't
installed and licensed. So "any repo" requires the base store to carry the common levels *and* the
overlay to fill the long tail on demand — a base-only, single-version mount would break many valid
projects. Likewise **Gradle must be resolvable**: prefer the repo's `./gradlew` (the wrapper pins the
exact version offline); when a repo has no wrapper, select a base-store Gradle from a documented
AGP→Gradle compatibility matrix. License acceptance is baked into the base (and re-applied for overlay
components) so no interactive `sdkmanager --licenses` prompt ever blocks a build.

Detection heuristic (cheap, run at setup alongside the existing compose/shipit.yaml detection):
presence of `settings.gradle(.kts)` **and** a module `build.gradle(.kts)` applying an Android plugin,
or an `android {}` block — independent of whether a Gradle wrapper is committed (many repos omit it).

Requirement discovery must be a **staged resolver**, not a single static parse — many repos declare
`compileSdk`/`targetSdk`/`ndkVersion`/CMake/AGP through **version catalogs (`libs.versions.toml`),
`gradle.properties`, `buildSrc`/convention plugins, or generated Gradle logic**, which a regex over
`build.gradle` will miss and then provision the wrong SDK:

1. **Static fast path** — scan `build.gradle(.kts)`, `gradle.properties`, and `libs.versions.toml` for
   the common literal cases (covers most repos cheaply).
2. **Gradle-resolved fallback** — when a value is unresolved or comes from a convention plugin, run a
   lightweight **Gradle query/init task** (e.g. print the resolved `compileSdk`/AGP) to get the true value.
3. **Error-driven retry** — wrap the first build so that a "missing platform/NDK/CMake" `sdkmanager`/Gradle
   error triggers provisioning of that exact component into the overlay and a rerun. This makes the
   long tail self-healing instead of depending on perfect up-front parsing.

An explicit `shipit.yaml` opt-in/out remains the escape hatch for ambiguous repos.

Prereq for ShipIt's own repo: **commit the Gradle wrapper (8.7)** under `android/` (it's missing today;
doc 116 claimed it was committed) so its build pins Gradle offline. Other repos that lack a wrapper fall
back to the base-store Gradle selected from their AGP version.

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
Wire that into a **preview surface** — but be precise about what "zero-setup" means here, because the
rendering libraries are **not** zero-setup by themselves: they need their Gradle plugin + dependencies
applied and a small harness that enumerates and renders each screen. The platform must own that wiring,
or P1 silently degrades into per-repo build-file/test authoring (which contradicts the whole thesis).

**Platform-owned preview harness (the load-bearing detail).** ShipIt injects the renderer without
editing the repo's committed sources:

- Apply the Paparazzi/Roborazzi plugin + deps via a **Gradle init script / injected settings plugin**
  (or a composite build) passed at invocation, not committed to the repo.
- Generate the render harness as **uncommitted test source under a ShipIt-managed directory** (e.g.
  `build/shipit-preview/`), so nothing lands in the user's git tree.
- Discover screens by source: **ComposablePreviewScanner** covers `@Preview` composables **only**. For
  **XML/View-only** apps it does *not* apply — the fallback is to enumerate layouts/`Activity` themes
  from the manifest+`res/layout` and render those, or, where that's insufficient, state plainly that
  the screen needs a repo-authored render entry (or instrumentation in Tier B). Don't pretend Compose
  auto-discovery covers View-based UIs.
- On change, re-render to PNGs and show a **gallery of screens** in the preview pane (one tile per
  screen/state/config — light/dark, font scale, locale). *Static* (no touch input) but **real,
  hardware-free visual feedback** that runs on today's runtime and re-renders like a (slow) hot reload.
- Fits ShipIt's surface: rendered images stream into the existing preview pane; the agent drives
  re-renders and reasons over the PNGs. No KVM, no external tab, no committed test files.

Honesty bound: P1 is **zero-setup for the *user***, achieved by the *platform* owning the harness — it
is not "the libraries are zero-config." That platform harness is the actual Phase-2 build work.

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
  session setup, including the **staged requirement resolver** (static scan → Gradle query → error-driven
  retry) for `compileSdk`/`targetSdk`/`ndkVersion`/CMake/AGP.
- **Phase 1 (toolchain, any repo):** Build the platform **base store** (cmdline-tools, common
  API-level/build-tools matrix with licenses accepted, Gradle distribution cache, **JDK 11 + 17**);
  mount it read-only into Android-detected sessions; add the **writable per-session overlay** +
  provisioning of repo-declared components the base lacks; resolve Gradle + JDK together from
  `./gradlew` or the AGP→Gradle→JDK matrix. Verify `assembleDebug` + `lint` + a first JVM unit test run
  green in-container for a generic Android repo **whose `compileSdk` differs from the base default and
  whose AGP/Gradle needs a non-default JDK** (proves the overlay + JDK-matrix paths). Ship
  `shipit-docs/android.md` + the skill.
- **Phase 2 (headless UI + P1 preview):** Build the **platform-owned preview harness** — inject
  Paparazzi/Roborazzi (pinned to AGP) via a Gradle init script and generate the render harness as
  uncommitted source; ComposablePreviewScanner for Compose discovery, the manifest/`res/layout`
  fallback for View-based UIs. Wire the rendered-screen gallery into the preview pane. This is the
  agent's *and* the user's first Android visual feedback.
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

- **Mount provisioning + maintenance.** The base store (SDKs + JDK matrix + Gradle cache) needs a
  build/version-bump pipeline (pin like the agent CLIs). The base mount must be genuinely read-only;
  the writable per-session overlay and Gradle's caches go to an overlay/dep-cache path. Sizing the base
  matrix is a tradeoff — too many API levels/JDKs bloats the asset, too few pushes everything to the
  slower overlay path; tune from real repo telemetry.
- **Detection false negatives/positives.** The staged resolver must catch nested Android modules and
  requirements declared via version catalogs / `gradle.properties` / `buildSrc`, and not fire on random
  `.gradle` files; the Gradle-query fallback adds latency, so gate it behind the static-scan miss.
  Allow an explicit `shipit.yaml` opt-in/out as the escape hatch.
- **P2 is real infra.** A KVM host pool is an operational commitment (cost, capacity, lifecycle,
  security isolation of the emulator service). Phase it; don't let "preview would be great" pull it
  ahead of the zero-KVM P1 that delivers most of the value.
- **Paparazzi ↔ AGP coupling** and **WebView-not-renderable** caveats (as above).
- **Memory contention** of a Gradle build alongside the agent on the session's cap — watch for OOM,
  tune Gradle heap.

## Key files (to touch when implemented — not yet changed)

- Session setup / detection (`shared/session-config.ts`, container-lifecycle) — Android-project detection,
  the `compileSdk`/`targetSdk`/`ndkVersion`/CMake/AGP requirement parse, read-only base mount + writable
  per-session SDK overlay + env (`ANDROID_SDK_ROOT`, `JAVA_HOME`), and Gradle resolution (`./gradlew` or
  AGP→Gradle matrix).
- A platform job/asset that builds the pinned **base store** — JDKs (11 + 17, room for 21) +
  cmdline-tools + common API-level/build-tools matrix (licenses accepted) + Gradle distribution cache
  (analogous to the agent-CLI / playwright install in `docker/`) — plus the overlay-provisioning step
  (`sdkmanager` into the writable overlay for repo-declared components) and the AGP→Gradle→JDK matrix.
- `android/gradlew`, `android/gradle/wrapper/*` — **new**, commit the pinned 8.7 wrapper (Phase 0).
- The platform preview harness — injected Gradle init script applying Paparazzi/Roborazzi + generated
  uncommitted render-harness source (ShipIt-managed dir); Compose discovery via ComposablePreviewScanner
  with a manifest/`res/layout` fallback for View-based UIs (Phase 2). `android/app/build.gradle.kts` adds
  Paparazzi/Roborazzi only for ShipIt's own dogfood case.
- Preview proxy / preview-store — rendered-screen gallery surface (P1); WebRTC emulator route (P2).
- `src/server/shipit-docs/android.md` + `.claude/skills/android-build/SKILL.md` — **new**, agent surfacing.
- `.github/workflows/android.yml` — GMD/Firebase job is a Phase 4 addition.
</content>
