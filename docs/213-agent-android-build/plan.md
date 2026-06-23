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
screens (zero-KVM, soon) to a streamed emulator service container (KVM-gated, later).**

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
   - **P2 — interactive emulator.** Not bespoke infra: the user declares an **emulator Compose service**
     (agent helps from a recipe ShipIt ships); the image's own web UI renders via `x-shipit-preview`, and
     the agent drives it over `adb`. ShipIt only builds the gated **`/dev/kvm` `devices:` allowance** the
     recipe needs (plus host KVM). The true web-preview-equivalent, mostly from existing primitives.
   - **P3 — cloud device farm.** Firebase Test Lab for instrumented/real-device runs when the host can't
     offer KVM at all; results surface inline in the PR card.

## Where the emulator runs (the KVM question, corrected)

An earlier draft read "the session container has no `/dev/kvm`, therefore no emulator" — that conflates
two things. **Web previews don't run in the session container either**; ShipIt starts them as a separate
per-session **Docker Compose stack** (`ServiceManager` → `docker compose`). The emulator is the same kind
of thing: a long-running daemon, i.e. a **service**, so it belongs in a **service container** in that
Compose stack — reached from the session container over `adb` (TCP `adb connect`), not run inside it.

So the real question isn't the session container; it's the **host** and the **Compose security model**:

| Fact | State | Consequence |
|---|---|---|
| `/dev/kvm` in the **session container** | absent (measured) | Irrelevant — the emulator runs in a service container, like every web preview. |
| `/dev/kvm` on the **deployment host** | **unknown — depends on the instance** (verify with `kvm-ok` / `ls /dev/kvm` on the host) | A bare-metal or nested-virt instance has it → a fast emulator runs locally; a basic cloud VM doesn't → needs a KVM-capable instance, a separate pool, or Firebase. |
| Compose device passthrough | not supported today; `privileged`/`network_mode: host`/abs-path mounts are rejected, but `devices:` isn't handled | `/dev/kvm` passthrough uses `devices: ["/dev/kvm:/dev/kvm"]` — a device-cgroup allow that does **not** need `privileged`, so it fits the security model. Add it as a **narrowly-scoped allowance** (only `/dev/kvm`, behind a flag — mirrors the existing `docker-socket: true` gate). |
| JDK / Gradle in the session container | absent; `android/` has no committed wrapper | Build toolchain reaches the session container via the mount (so the agent runs `gradle` directly); `./gradlew` (commit it) or the base store supplies Gradle. |

Headless build/test/render (Tier A, P1) is unaffected and runs on today's runtime. The emulator tier
becomes: **run an emulator service container, give it `/dev/kvm` where the host provides it.** Whether
that host is the local deployment box or a dedicated pool is a deployment choice, not an architectural
fork — the emulator-as-service + `adb`-over-TCP shape is identical either way.

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
      preview: rendered         # rendered (platform render gallery) | none.
                                # The interactive emulator is a normal Compose service
                                # (x-shipit-preview), not a ShipIt-implemented preview mode — see P2.
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

### P2 — interactive emulator: a user-defined Compose service, not bespoke infra

The interactive emulator is **just a Compose service the user declares** (with the agent's help) — the
same primitive ShipIt already uses for every long-running preview (dev server, Prisma Studio, log tailer
— CLAUDE.md §5). ShipIt does **not** build an emulator service, a WebRTC bridge, or an APK-push pipeline.
It provides a **recipe** and **one platform enabler**:

```yaml
# docker-compose.yml — the recipe ShipIt ships (agent drops it in on request)
services:
  emulator:
    image: budtmo/docker-android:emulator_14   # or an AOSP emulator-webrtc image
    devices: ["/dev/kvm"]          # hardware accel — needs the ShipIt allowance below + host KVM
    ports: ["5555"]                # adb, reached from the session container
    x-shipit-preview: auto         # the image's web UI renders in the existing preview pane
```

With that service up, everything falls out of existing primitives:

- **Interactive preview** — the emulator image's own web UI (noVNC/WebRTC) is shown by the **existing
  preview pane** via `x-shipit-preview`. No streaming bridge to build; the image provides it.
- **Agent control/debug** — the agent runs `adb connect emulator:5555` from the session container (the
  Compose network) and then `adb install app-debug.apk`, `adb logcat`, `uiautomator dump`, `adb shell
  input tap …`, `adb exec-out screencap` — plain commands, no platform code.

**What ShipIt must actually build is small:**

1. A **narrowly-scoped `/dev/kvm` `devices:` allowance** in the compose generator — gated like the
   existing `docker-socket: true` flag, no `privileged`. The recipe fails validation until this lands;
   it is the one hard dependency.
2. A **canonical, tested recipe** shipped in `compose.md` + the Android skill, so the agent drops in a
   known-good service instead of guessing an image.

Prerequisite the recipe can't supply: **KVM on the host that runs the service** — present on a
bare-metal/nested-virt instance, absent on a basic cloud VM (where the emulator falls back to slow
software mode, or the user points the service at a remote/Firebase device). ShipIt should detect a
missing `/dev/kvm` and say so rather than booting an unusably slow emulator.

### P3 — cloud device farm

When ShipIt isn't operating its own pool, **Firebase Test Lab** (or a device cloud) runs interactive/
instrumented sessions on cloud devices; video + screenshots come back as inline PR-card artifacts. Good
for instrumented coverage and occasional real-device validation.

ShipIt's own wrapper is the easy preview case: `android/` is a WebView shell, so its preview is the web
preview already in ShipIt pointed at a dev URL. General native apps are what motivate P2.

## Debugging & inspection

Web debugging has two pillars: build/test output, and live browser introspection (Playwright console
messages, accessibility snapshot, network). Android needs both too — and the second one is the agent's,
not just the user's.

### Static / headless (works today, mount only)

Most debugging is reading output the headless tier already produces:

- **Build/compile errors** from `assembleDebug`, **lint findings**, and **unit + Robolectric test
  failures with stack traces** — the agent reads them directly.
- **Visual diffs** from Paparazzi/Roborazzi golden mismatches.
- **Static APK/manifest inspection** via `apkanalyzer` and `aapt2` — already in the SDK mount, so the
  agent can dump the merged manifest, resource table, DEX/method counts, and dependency tree without a
  device. Surface these as supported commands; they cost nothing extra.

The limit: `layoutlib` renders a static view tree — it does **not run the app** — so the headless tier
sees no logcat and no runtime crash. Anything that only appears while code executes (lifecycle bugs,
threading, prod-path exceptions) needs a running instance.

### Runtime (against a running instance)

The Android equivalent of Playwright's browser introspection, over `adb`:

- **`adb logcat`** — the primary runtime stream: crashes, exceptions, `Log.*` output. The first thing
  to read when something fails at runtime.
- **`uiautomator dump`** — the live view hierarchy as XML (the semantic analog of the Playwright
  accessibility snapshot), so the agent can reason about the on-screen tree, not just a screenshot.
- **`adb shell`** — install/launch, set permissions, pull app data (`run-as`), drive intents.

**Key point: this is debug instrumentation, not preview, and it doesn't need the emulator's web UI.** The
agent reaches the emulator Compose service over `adb` (TCP `adb connect`) from the session container —
the same Compose-stack wiring as a web preview. So the agent's runtime-debug loop just needs the emulator
**running and adb-reachable**; the image's screen-streaming UI is for the *user's* preview (P2), not the
agent. A **Firebase Test Lab** run that returns logcat + crash logs serves the same agent loop where the
host has no KVM. KVM helps the emulator boot fast; the user-facing interactive view rides on the image's
own web UI via `x-shipit-preview`.

Out of scope: an **interactive debugger / breakpoints** (JDWP attach) and **profiling** (CPU/memory/jank,
perfetto) — heavy, device-bound, and not part of the agent loop.

### Interactive control — drive the running app (press buttons, screenshot, snapshot)

This is the Android analog of the Playwright tools the agent already uses for web — `browser_snapshot`
(a11y tree), `browser_click`, `browser_take_screenshot` — and the same triad maps cleanly onto Android,
all over `adb` against a running instance (no WebRTC). How people do it, lowest-effort first:

- **Raw `adb` primitives (recommended baseline).** `uiautomator dump` → the view-hierarchy XML with each
  element's `resource-id`/`text`/`bounds` (the **snapshot**); `adb shell input tap <x> <y>` / `input
  text` / `input keyevent` (the **press**, with coordinates read from the dump); `adb exec-out screencap
  -p` (the **screenshot**). No framework, no extra install — the SDK platform-tools in the mount already
  ship `adb`. This satisfies "press a button, screenshot, snapshot" with the smallest surface and runs on
  the same headless emulator as logcat. ShipIt can wrap the triad as agent tools mirroring `browser_*`.
- **Maestro (recommended higher-level option).** A CLI-first mobile UI framework: short YAML flows
  (`tapOn`, `inputText`, `takeScreenshot`), tolerant text/id selectors, and auto-wait — ergonomic for an
  agent that wants resilient "tap Login, screenshot" steps without computing coordinates. Drives the same
  adb-reachable instance; `maestro studio` is its interactive recorder. Trade-off: limited logic (no loops
  in YAML).
- **Appium (heavier alternative).** The cross-platform WebDriver standard (UiAutomator2 engine): full
  programmatic control, element find, `getPageSource` (XML snapshot), screenshots — symmetric with
  Playwright/Selenium if ShipIt wants a single WebDriver protocol across web and mobile. Cost: an Appium
  server + driver per session.
- **Espresso / UI Automator (in-test).** Espresso for the app's own white-box UI tests; UI Automator for
  robust cross-app selectors inside an instrumented test (Tier B). Best as committed test code, not for
  ad-hoc agent driving.

**Recommendation:** lead with the **`adb` primitive triad** (the minimum — only needs the emulator
service reachable over `adb` + platform-tools, and mirrors `browser_*`), and add **Maestro** as the
optional ergonomic layer. Both run against the emulator Compose service the moment it's up; the agent
runs them as plain commands, so this is effectively free once the `/dev/kvm` allowance + recipe land.
The screenshots double as preview-gallery frames and snapshot-test goldens.

## Agent surfacing

1. **`src/server/shipit-docs/android.md`** (baked into the session image at `/shipit-docs/`) — the
   headless commands, the mount paths (`ANDROID_SDK_ROOT=/opt/android-sdk`), recording/verifying
   Paparazzi goldens, the **debug/inspect commands** (static: `apkanalyzer`/`aapt2`; runtime: `adb
   logcat`, `uiautomator dump`, `adb shell` against a running instance), rendered-screen preview as the
   in-session visual loop, and the **emulator Compose recipe** (the canonical service the agent adds on
   request, reached over `adb connect` — not a service ShipIt builds).
2. **`.claude/skills/android-build` skill** — discloses by description, loads when a task touches an
   Android project; carries the build → lint → render/snapshot → read-the-PNG-diff → attach-to-PR loop,
   the debug loop (read `assembleDebug`/test output → for runtime failures, read `adb logcat` and
   `uiautomator dump` off the running instance), the interactive loop (snapshot → `input tap` →
   `screencap`, or a Maestro flow), and **dropping in the emulator Compose service** when the user wants a
   live device. Per `docs/209-cross-agent-skill-disclosure`, one skill covers both Claude and Codex.

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
- **Phase 3 (`/dev/kvm` allowance + emulator recipe):** The platform work for the whole emulator tier is
  small: add the narrowly-scoped **`/dev/kvm` `devices:` allowance** to the compose generator (gated like
  `docker-socket: true`, no `privileged`) and ship a **canonical emulator Compose recipe** in `compose.md`
  + the skill. Confirm host KVM. After this, the user (with the agent) adds the emulator service and the
  rest is existing primitives.
- **Phase 4 (agent debug/control + interactive preview — mostly free):** With the emulator service up, the
  agent reaches it over `adb connect` and runs `adb logcat`, the **interactive triad** (`uiautomator dump`
  snapshot, `adb shell input tap/text/keyevent` press, `adb exec-out screencap` screenshot), `adb install`,
  and `adb shell`; the image's web UI shows in the preview pane via `x-shipit-preview`. Optional polish:
  wrap the triad as `browser_*`-style agent tools and/or add **Maestro** to the toolchain.
- **Phase 5 (P3 / instrumented):** Firebase Test Lab (or GMD on KVM CI) for instrumented tests and
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
- **Host KVM + device passthrough.** The emulator service needs `/dev/kvm` on whatever host runs it —
  verify the deployment instance offers KVM (bare-metal/nested-virt), and implement the narrowly-scoped
  `devices: ["/dev/kvm"]` allowance in the compose generator (no `privileged`, gated like `docker-socket`).
  If the host can't do KVM, the emulator moves to a dedicated KVM pool or P3 (Firebase) — same
  emulator-as-service shape, different placement.
- **Emulator resource weight.** A KVM emulator is ~2–4 GiB RAM + real CPU; co-locating it in the session's
  Compose stack competes with the agent and web previews. Start on-demand (like heavy preview services),
  and consider a pool for scale.
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
- Compose generator (`compose-generator.ts`) — a narrowly-scoped **`devices: ["/dev/kvm"]` allowance**
  (no `privileged`, gated like `docker-socket: true`). The one hard platform dependency for the emulator tier.
- Canonical **emulator Compose recipe** in `compose.md` + the Android skill (the agent drops it in); no
  ShipIt-built emulator image or WebRTC bridge — the recipe's image provides the web UI and adb.
- (Optional) `browser_*`-style agent tool wrappers around the `adb` triad + Maestro in the toolchain — polish,
  not required (the agent can run the `adb` commands directly).
- Preview proxy / preview-store — rendered-screen gallery (P1); the emulator's interactive UI uses the
  **existing** `x-shipit-preview` path, no new route.
- `src/server/shipit-docs/android.md` + `.claude/skills/android-build/SKILL.md` — new, agent surfacing.
- `.github/workflows/android.yml` — GMD/Firebase job is a Phase 5 addition.
</content>
