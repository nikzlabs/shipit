---
description: Make ShipIt build, test & preview Android apps for any repo — including web/Android monorepos — using the same shipit.yaml setup model as web, a platform-provided toolchain, headless Paparazzi rendering first, and a streamed emulator later.
issue: https://linear.app/shipit-ai/issue/SHI-170
---

# 213 — Android build, test & preview as a ShipIt platform capability

## Summary

ShipIt should be a place you build Android apps. Any repo with an Android/Gradle project — including a
**monorepo** that holds a web app and one or more Android modules, like ShipIt itself — should get a
build → test → **preview** loop in-session, using the **same `shipit.yaml` setup model as the web
preview**. The split is: the platform provides the Android **toolchain** (no per-repo SDK install,
the same way it provides the Playwright browser via a mount, not your `agent.install`), and the repo
**declares** its Android project + preview the way it already declares web services — one unified
mechanism, not a bespoke one. ShipIt's own WebView wrapper (`android/`) is the first dogfood consumer.

Today the wrapper builds only in GitHub Actions, and a session container has no Java, SDK, Gradle, or
preview — so the agent edits Kotlin/XML blind and the user sees nothing run. The web side has a tight
loop (preview pane + Playwright); the Android side has none.

## Recommendation

**Declare Android projects in `shipit.yaml` the same way web is declared, mount a platform-managed
toolchain, give the agent a headless build/test/render loop now, and phase the preview from rendered
screens (zero-KVM, soon) to a streamed emulator (KVM host pool, later).**

1. **Declaration unified with web (+ auto-detect for the simple case).** A repo names its Android
   project(s) in `shipit.yaml` — an `android:` list of module paths + preview mode — exactly as it names
   web services via `compose:`/`x-shipit-preview`. A single-project repo can be auto-detected (a
   `build.gradle(.kts)` applying an Android plugin, mirroring compose auto-detection) so it needs no
   declaration; monorepos and preview selection use the explicit list. Either way the lookup is
   **path-scoped to the module(s)**, so a web/Android monorepo keeps its web preview and gains Android
   surfaces alongside. From the resolved project ShipIt reads `compileSdk`/`targetSdk`, `ndkVersion`,
   CMake usage, and AGP version to drive toolchain provisioning.
2. **Platform-managed toolchain.** A version-pinned **read-only base store** (cmdline-tools,
   platform-tools, a matrix of common API levels + build-tools, a Gradle distribution cache, JDK 11 +
   17, licenses pre-accepted) mounts into Android-detected sessions at `/opt/android-sdk` + `/opt/jdk*`.
   A **writable per-session overlay** provisions any repo-declared component the base lacks. Gradle and
   the JDK are selected from the project's AGP (the repo's `./gradlew` when committed, else a base-store
   version via an AGP→Gradle→JDK matrix). Common case: no per-session download, no image bloat for the
   ~99% of sessions that never touch Android. Mirrors the existing `PLAYWRIGHT_BROWSERS_PATH` mount and
   `repo-cache`/`dep-cache` volumes.
3. **Headless build/test/render — works in any session today.** With the mount attached:
   `gradle :app:assembleDebug`, `gradle lint`, JVM unit tests, **Robolectric/Roborazzi**, and
   **Paparazzi** — which renders Views and Compose `@Preview`s to PNG via `layoutlib` on the JVM, no
   emulator. This lets the agent see a layout/inset change and attach a real screenshot to the PR, and
   unblocks the sibling API-35 edge-to-edge work.
4. **Preview, phased.**
   - **P1 — rendered-screen preview (zero-KVM, soon).** Reuse the headless renderer to produce a gallery
     of rendered screens in the preview pane, refreshed on change. Static (no touch), but real visual
     feedback on the existing runtime.
   - **P2 — interactive streamed emulator (KVM host pool, later).** A dedicated emulator service on a
     KVM-capable host pool boots an AVD, installs the freshly built APK, and streams screen + input into
     the preview pane over WebRTC. The true web-preview-equivalent — gated on KVM infra ShipIt would
     stand up.
   - **P3 — cloud device farm.** Firebase Test Lab for instrumented/real-device runs when ShipIt isn't
     operating its own pool; results surface inline in the PR card.

## Container reality check (measured)

| Capability | Session container | Consequence |
|---|---|---|
| `/dev/kvm` | absent (no `vmx`/`svm`) | Interactive emulator runs on a separate KVM host (P2), not the session box. Headless rendering (P1) is unaffected. |
| JDK | absent | Provided by the toolchain mount. |
| Gradle | absent; `android/` has no committed wrapper | Provided by `./gradlew` (commit it) or the base store. |
| Memory / disk | host ~15 GiB; `/workspace` ~34 GB free | A Gradle build + SDK + caches fit. |

The KVM absence is the load-bearing fact: it relocates the emulator to a virt-enabled host pool, while
everything in the headless tier and P1 runs on today's runtime.

## Toolchain provisioning

The agent runs in the fixed session-worker image, so the toolchain reaches Android-detected sessions via
a mount rather than a per-repo install:

| Option | Verdict |
|---|---|
| **A. Read-only base store + writable per-session overlay (attached when an Android project is present)** | **Recommended.** No per-repo toolchain install, no per-session download for common SDKs, no image bloat for non-Android sessions; overlay covers the long tail. Same shape as `PLAYWRIGHT_BROWSERS_PATH` + `repo-cache`/`dep-cache`. |
| **B. Android session-image variant** | Workable fallback if mount provisioning proves fragile; doubles image ops and is coarser than a mount. |
| **C. Bake SDK+JDK into the base session image** | Taxes every session (~1.5+ GB) for a capability ~99% don't use. |
| **D. Per-repo `agent.install`** | Re-downloads the SDK on every cold re-clone and copies a platform-shared binary into each repo's setup. The SDK is a fixed, shareable asset — like the Playwright browser ShipIt mounts rather than has you install — so it belongs in the platform mount. (A repo's *own* Gradle deps still download per-build, like web deps.) Remains an escape hatch for an exotic toolchain. |

**Chosen: A.** A CI/setup job builds the pinned base store (cmdline-tools → `sdkmanager` for a matrix of
common API levels + build-tools with licenses accepted → Gradle cache → Temurin JDK 11 + 17). A detected
Android project gets it mounted read-only; the overlay fills in any repo-declared `compileSdk`/NDK/CMake
the base lacks before the first build. Baked-in license acceptance keeps `sdkmanager --licenses` from
ever blocking. A single fixed SDK/JDK would break repos whose `compileSdk`, NDK, or AGP/Gradle/JDK
combination differs from the default — hence the base matrix plus the overlay and the version matrices.

### Requirement discovery — staged resolver

Repos declare versions in many ways (literals, version catalogs, `gradle.properties`, `buildSrc`/
convention plugins), so discovery is staged rather than a single regex:

1. **Static scan** — `build.gradle(.kts)`, `gradle.properties`, `libs.versions.toml` for the common cases.
2. **Gradle query** — when a value is unresolved or comes from a convention plugin, a lightweight
   init/query task prints the resolved `compileSdk`/AGP.
3. **Error-driven retry** — a "missing platform/NDK/CMake" build error provisions that exact component
   into the overlay and reruns, so the long tail self-heals.

An explicit `shipit.yaml` opt-in/out covers ambiguous repos.

### Monorepos & web/Android coexistence

ShipIt itself is the case to design for: a Node/React web app plus the `android/` Gradle project in one
repo. The model:

- **`shipit.yaml` declares each Android module by path**, alongside the existing web `agent.install` /
  `compose:` config — they coexist, neither replaces the other:

  ```yaml
  agent:
    install: npm install        # web toolchain, unchanged
  compose: docker-compose.yml   # web preview, unchanged
  android:
    - project: android          # path to the Gradle project/module
      preview: rendered         # rendered | emulator | none
      # toolchain: derived from the Gradle project by default (see below).
      # Optional overrides, only for blind spots / heavy pre-provisioning:
      # sdk: ["ndk;26.1.10909125", "cmake;3.22.1"]
      # jdk: 17
  ```

  A repo with exactly one Android project and no `android:` key is auto-detected; the list is for
  monorepos and for choosing the preview mode per app.
- **Builds are path-scoped** to the declared module — `android/gradlew :app:assembleDebug`, not a
  repo-root Gradle invocation — so the web build and the Android build stay independent. The toolchain
  mount attaches because *some* Android module exists; the web Node toolchain is untouched.
- **Previews coexist in the existing multi-preview pane.** Android surfaces (P1 gallery / P2 emulator)
  slot in next to the web service's `x-shipit-preview`, the same way multiple web services already do;
  the user switches between them. Multiple Android apps each get their own build target and preview tile.

**Prereq for `android/`:** commit the pinned Gradle wrapper (8.7) — missing today though doc 116 assumed
it was present. Repos without a wrapper fall back to the base-store Gradle matched to their AGP.

### Toolchain: derived, not declared

The toolchain itself is **not** a `shipit.yaml` field by default — unlike web, where the toolchain
isn't fully captured in-repo and `agent.install` fills the gap, an Android project already pins its
requirements in build-tool-native places: `compileSdk`/`targetSdk`/`ndkVersion`/CMake in
`build.gradle(.kts)` + version catalogs, the Gradle version in the wrapper, and the JDK implied by the
AGP version + `jvmTarget`. The platform reads those (the staged resolver) and provisions them. Asking
the user to re-declare versions in `shipit.yaml` would just add a second source of truth that drifts
from the build files.

In practice the variance is real but bounded along a few axes: **JDK** ~2–3 values (11/17, soon 21);
**Gradle** a documented AGP→Gradle matrix; **SDK platform/build-tools** a range `sdkmanager` fills
cheaply (~60 MB each); **NDK/CMake** a minority of (native) apps but exact and heavy (~1 GB per NDK).
So an **optional per-project override** (`sdk:`/`jdk:` above) earns its place for exactly two cases —
**heavy/exact pre-provisioning** (fetch the right NDK up front instead of via error-retry) and
**resolver blind spots** (convention plugins / generated Gradle logic). It supplements the derived set,
never replaces the Gradle build as the source of truth — the same role `install-inputs` plays for web.

## Test tiers

### Tier A — headless (mount only, no emulator) — viable today

- **`assembleDebug`** — full compile + packaging; the core build signal.
- **`lint`** — manifest/resource/accessibility + edge-to-edge/inset checks (API-35-relevant).
- **JVM unit tests + Robolectric** — pure logic and Android-framework-on-the-JVM behavior.
- **Paparazzi / Roborazzi** — render Views and Compose `@Preview`s to PNG via `layoutlib` on the JVM,
  diffed against committed goldens. Pin Paparazzi to the repo's AGP (this repo: AGP 8.5.2 / Kotlin 1.9.24
  / Gradle 8.7) and bump together. (Google's official Compose Preview Screenshot Testing needs AGP 9;
  Paparazzi/Roborazzi fit until then.)

For ShipIt's wrapper specifically, the main surface is a `WebView`, which `layoutlib` doesn't render —
Paparazzi covers the chrome/insets/settings screen (the API-35 surface). For general native UIs this
caveat falls away and coverage is high.

### Tier B — instrumented (needs a device) — separate host / cloud

`connectedAndroidTest` (Espresso/UIAutomator) and live full-app screenshots need a running Android OS,
so they run via **Gradle Managed Devices** on a KVM CI runner or **Firebase Test Lab**, with results
surfaced inline in ShipIt (PR-card artifacts).

## Preview — phased

The web preview pane sets the bar: see your change run, inside ShipIt. Android gets there in stages.

### P1 — rendered-screen preview (zero-KVM, near-term)

The same `layoutlib` renderer behind Paparazzi/Roborazzi can render screens without a device. The
platform owns the wiring, so beyond the `shipit.yaml` declaration the user authors no test code:

- Apply the Paparazzi/Roborazzi plugin + deps via an injected **Gradle init script / settings plugin**
  at invocation, and generate the render harness as **uncommitted source** under a ShipIt-managed
  directory (e.g. `build/shipit-preview/`) — nothing lands in the repo's git tree.
- Discover screens via **ComposablePreviewScanner** for `@Preview` composables; for XML/View UIs,
  enumerate layouts/`Activity` themes from the manifest + `res/layout`. Screens neither path can reach
  fall to a repo-authored render entry or Tier B instrumentation.
- On change, re-render to PNGs and show a **gallery** in the preview pane (one tile per screen/state —
  light/dark, font scale, locale). Hardware-free visual feedback that re-renders like a slow hot reload.

This is the recommended first preview — most of the "can I see my UI?" value with none of the emulator
infra — and it doubles as the Paparazzi golden source, so preview and snapshot testing share machinery.
The user declares the project once (as for web); building the platform harness is the Phase-2 work.

### P2 — interactive streamed emulator (KVM host pool, later)

For a real, touchable preview, a dedicated emulator service on a KVM-capable host pool (nested-virt or
bare metal) boots an AVD, installs the session's `app-debug.apk`, and streams screen + input to the
preview pane over WebRTC (the `google/android-emulator-container-scripts` + `android-emulator-webrtc`
approach: WebRTC for video, gRPC for input). This is a deliberate infra investment — a virt-enabled
pool, emulator lifecycle, APK push per build, and a WebRTC bridge through the preview proxy — phased
after P1, since software-mode emulation without KVM is too slow for interactive use.

### P3 — cloud device farm

When ShipIt isn't operating its own pool, **Firebase Test Lab** (or a device cloud) runs interactive/
instrumented sessions on cloud devices; video + screenshots come back as inline PR-card artifacts. Good
for instrumented coverage and occasional real-device validation.

ShipIt's own wrapper is the easy preview case: `android/` is a WebView shell, so its preview is the web
preview already in ShipIt pointed at a dev URL. General native apps are what motivate P2.

## Agent surfacing

1. **`src/server/shipit-docs/android.md`** (baked into the session image at `/shipit-docs/`) — the
   headless commands, the mount paths (`ANDROID_SDK_ROOT=/opt/android-sdk`), recording/verifying
   Paparazzi goldens, rendered-screen preview as the in-session visual loop, and the emulator ceiling
   (the device lives on a separate host, not the session container).
2. **`.claude/skills/android-build` skill** — discloses by description, loads when a task touches an
   Android project; carries the build → lint → render/snapshot → read-the-PNG-diff → attach-to-PR loop.
   Per `docs/209-cross-agent-skill-disclosure`, one skill covers both Claude and Codex.

## Phased plan

- **Phase 0 (prereq):** Commit the Gradle wrapper (8.7) under `android/`; add the `shipit.yaml`
  `android:` schema + path-scoped detection (auto-detect single-project repos) and the staged
  requirement resolver (static scan → Gradle query → error-driven retry).
- **Phase 1 (toolchain, any repo):** Build the base store (cmdline-tools, API-level/build-tools matrix,
  Gradle cache, JDK 11 + 17); mount it read-only; add the writable overlay + component provisioning;
  resolve Gradle + JDK from `./gradlew` or the AGP matrix. Verify `assembleDebug` + `lint` + a JVM unit
  test green for (a) a generic Android repo whose `compileSdk`/JDK differ from the base default and
  (b) a **web/Android monorepo** where the Android build is path-scoped and the web preview is
  unaffected. Ship `shipit-docs/android.md` + the skill.
- **Phase 2 (headless UI + P1 preview):** Build the platform-owned preview harness — inject
  Paparazzi/Roborazzi via a Gradle init script and generate the render harness as uncommitted source;
  ComposablePreviewScanner for Compose, manifest/`res/layout` for Views. Wire the gallery into the
  preview pane. First Android visual feedback for agent and user.
- **Phase 3 (P2 preview, infra-gated):** Stand up a KVM-capable emulator host pool; emulator service +
  WebRTC bridge through the preview proxy; APK push on build.
- **Phase 4 (P3 / instrumented):** Firebase Test Lab (or GMD on KVM CI) for instrumented tests and
  real-device validation, surfaced as inline PR artifacts.

## Relationship to other work

- **Unblocks the API-35 edge-to-edge bump (sibling session).** Phase 1 lets it compile + lint the
  `targetSdk`/`compileSdk` 35 change; Phase 2 lets it verify the insets visually. High-leverage to land
  Phase 1 + a minimal Paparazzi golden alongside that bump.
- **SHI-53** tracks the WebView wrapper feature (doc 116). This doc is the platform build/test/preview
  capability — distinct lifecycle, its own tracker item (**SHI-170**). The interactive preview (P2) may
  get its own sub-issue once Phase 1–2 land.

## Risks / open questions

- **Base-store sizing.** Too many API levels/JDKs bloats the asset; too few pushes work to the slower
  overlay path. Tune the matrix from real repo telemetry. The base mount stays read-only; overlay and
  Gradle caches go to an overlay/dep-cache path.
- **Detection accuracy + monorepo scoping.** The resolver must locate Android module(s) by path
  (catching nested modules and version-catalog/`buildSrc`-declared requirements) without firing on stray
  `.gradle` files or disturbing the web toolchain in the same repo; gate the Gradle-query stage behind a
  static-scan miss to keep it cheap. The `shipit.yaml` `android:` list is the explicit override for
  monorepos and ambiguous repos.
- **P2 infra cost.** A KVM host pool is an operational commitment (capacity, lifecycle, emulator-service
  isolation). Phase it behind the zero-KVM P1.
- **Paparazzi ↔ AGP coupling** and the **WebView-not-renderable** caveat (above).
- **Memory contention** of a Gradle build alongside the agent — watch for OOM, tune the Gradle heap.

## Key files (when implemented — not yet changed)

- Session setup / detection (`shared/session-config.ts`, container-lifecycle) — the `shipit.yaml`
  `android:` schema, path-scoped detection + staged resolver, read-only base mount + writable overlay +
  env (`ANDROID_SDK_ROOT`, `JAVA_HOME`), Gradle/JDK resolution. Compose with the existing web `compose:`/
  preview config rather than replacing it.
- Platform base-store job (analogous to the agent-CLI / playwright install in `docker/`) — JDKs (11 +
  17), cmdline-tools, API-level/build-tools matrix (licenses accepted), Gradle cache — plus the
  overlay-provisioning step and the AGP→Gradle→JDK matrix.
- `android/gradlew`, `android/gradle/wrapper/*` — new, the pinned 8.7 wrapper (Phase 0).
- Platform preview harness — injected Gradle init script + generated uncommitted render harness; Compose
  discovery via ComposablePreviewScanner with a manifest/`res/layout` fallback (Phase 2).
  `android/app/build.gradle.kts` adds Paparazzi/Roborazzi for the dogfood case.
- Preview proxy / preview-store — rendered-screen gallery (P1); WebRTC emulator route (P2).
- `src/server/shipit-docs/android.md` + `.claude/skills/android-build/SKILL.md` — new, agent surfacing.
- `.github/workflows/android.yml` — GMD/Firebase job is a Phase 4 addition.
</content>
