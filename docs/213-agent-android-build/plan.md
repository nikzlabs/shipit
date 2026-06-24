---
description: Make ShipIt build, test, debug & preview Android apps for any repo — including web/Android monorepos — with a platform-provided toolchain (headless Paparazzi rendering) and the emulator as a user-defined Compose service.
issue: https://linear.app/shipit-ai/issue/SHI-170
---

# 213 — Android build, test & preview as a ShipIt platform capability

## Summary

ShipIt should be a place you build Android apps. Any repo with an Android/Gradle project — including a
**monorepo** that holds a web app and Android modules, like ShipIt itself — should get a build → test →
debug → **preview** loop in-session, using the **same `shipit.yaml` + Compose model as web**.

Today the `android/` wrapper builds only in GitHub Actions, and a session container has no Java, SDK,
Gradle, or preview — so the agent edits Kotlin/XML blind and the user sees nothing run. The web side has
a tight loop (preview pane + Playwright); the Android side has none.

`android/` exercises the build/lint path, but it's a thin **WebView shell** — `layoutlib` can't render
it and it has no native UI, so it can't validate the rendering, emulator, or interactive-control parts of
the loop. The proper dogfood/validation target is a **real native test app**, which the new-repo Android
template (**SHI-205**) will produce; set it up once that template exists.

## Recommendation

1. **Declare Android explicitly in `shipit.yaml`.** A repo opts in with an `android:` list of module
   paths — the same "you declare it" model as `compose:`. ShipIt doesn't guess whether a repo is Android.
   The toolchain itself is then **derived** from the Gradle build, not re-declared.
2. **Provide the build toolchain platform-side.** A common SDK + JDK + Gradle base (baked into the session
   image like the agent CLIs / Playwright, or a shared mount) plus a per-session overlay for
   repo-specific components — so there's no per-repo SDK install; a repo's own Gradle deps still download
   per build.
3. **Headless build/test/debug needs no emulator or KVM.** Once the toolchain lands (Phase 1),
   `assembleDebug`, `lint`, JVM/Robolectric tests, and **Paparazzi** (renders Views and Compose
   `@Preview`s to PNG via `layoutlib`, no device) run on the existing container runtime — plus reading
   build/test output, which is most debugging. This unblocks the sibling API-35 edge-to-edge work.
4. **The running app is an emulator Compose service.** Runtime debugging (`adb logcat`), driving the app
   (tap / screenshot / view-hierarchy snapshot), and the interactive preview all come from one
   **user-declared emulator service** reached over `adb` — not bespoke ShipIt infra. ShipIt ships the
   recipe and one enabler (a gated `/dev/kvm` device allowance); a cloud device farm (Firebase Test Lab)
   covers hosts without KVM.

## Two runtime surfaces

Everything below sorts into one of two places an Android app can run, which is the spine of the design:

- **Headless (the toolchain in the session container).** The SDK + JDK available to the agent. Compiles,
  lints, runs JVM/Robolectric tests, and renders screens via `layoutlib` (Paparazzi) — **no device**.
- **A running app (a Compose service).** A real Android OS for anything that only exists while code
  executes: runtime logs/crashes, touch interaction, live view hierarchy, the streamed screen. This is an
  **emulator service in the session's Compose stack** (the same primitive as a web preview), or a cloud
  device (Firebase). The agent reaches it over `adb` (TCP `adb connect`); the user sees it via the image's
  web UI in the preview pane.

The only platform-level subtlety is the running-app surface needing KVM:

- The emulator runs in a **service container**, not the session container — so the session container's lack
  of `/dev/kvm` is irrelevant (web previews don't run there either).
- `/dev/kvm` is a **host** capability. A bare-metal or nested-virt instance has it; a basic cloud VM may
  not (verify with `kvm-ok` on the host). Without it, the emulator is too slow to be useful, so fall back
  to Firebase.
- Passing it in uses `devices: ["/dev/kvm:/dev/kvm"]` — a device-cgroup allow that does **not** need
  `privileged` (which ShipIt's compose generator rejects). The generator doesn't handle `devices:` today,
  so ShipIt must add a **narrowly-scoped allowance** for `/dev/kvm`, gated like the existing
  `docker-socket: true` flag. This is the one hard platform dependency for the whole emulator tier.

## The build toolchain

The agent runs `gradle` in the session container, so it needs a common SDK + JDK + Gradle **base**. A
single fixed SDK/JDK can't cover every repo (different `compileSdk`/build-tools/NDK/AGP), so a
**per-session writable overlay** for repo-specific components is required *regardless of where the base
lives* — that's the load-bearing piece. The base then has two reasonable homes:

| Option | Verdict |
|---|---|
| **A. Bake the base into the session-worker image + per-session overlay** | **Recommended (simplest).** Same pattern the image already uses for the agent CLIs, Playwright + Chrome — a Dockerfile step (`sdkmanager` a common API-level/build-tools matrix, JDK 11+17, a Gradle cache), bumped via the existing Renovate cadence. Always present, no attach logic. Cost: ~2–3 GB on the universal image — in line with the heavy tooling already baked, which the team accepts. |
| **B. Shared read-only mount + per-session overlay** | Equivalent, attached only to Android sessions; keeps the universal image lean and lets the SDK matrix update without a session-image rebuild. Worth it only if universal-image size/cold-start becomes a concern — at the cost of new base-store provisioning + attach machinery. |
| **C. Per-repo `agent.install`** | Re-downloads the SDK on every cold re-clone and duplicates a platform-shared binary per repo. Stays an escape hatch for an exotic toolchain, not the default. |

**Chosen: A.** Bake the pinned base — cmdline-tools, platform-tools, a matrix of common API levels +
build-tools (licenses pre-accepted), a Gradle distribution cache, and JDK 11 + 17 — into the
session-worker image (`Dockerfile.session-worker.*`), exactly as the agent CLIs and Playwright browser
are baked today. (Image *size* isn't the deciding factor: the image already carries Claude/Codex/Playwright/
Chrome that most sessions never use; this is the same trade, made deliberately.) A **per-session overlay**
provisions any repo-declared component the base lacks — an off-matrix `compileSdk`, an NDK, a CMake
toolchain — before the first build. Gradle and the JDK are selected from the project's AGP: the repo's
`./gradlew` when committed, else a baked version via a documented AGP→Gradle→JDK matrix. If keeping the
universal image lean ever matters more than simplicity, B is a drop-in swap — the overlay and resolver are
identical.

### Derived, not declared

The toolchain is **not** a `shipit.yaml` field by default. Unlike web — where the toolchain isn't fully
captured in-repo and `agent.install` fills the gap — an Android project already pins its requirements in
build-tool-native places: `compileSdk`/`targetSdk`/`ndkVersion`/CMake in `build.gradle(.kts)` + version
catalogs, the Gradle version in the wrapper, and the JDK implied by the AGP version. ShipIt reads those
and provisions them; re-declaring versions in `shipit.yaml` would only add a second source of truth that
drifts. The variance is bounded — JDK ~2–3 values, Gradle a documented matrix, SDK platform/build-tools a
cheap range, NDK/CMake a heavy minority — so an **optional** per-project override exists for just two
cases: heavy/exact pre-provisioning (fetch the right ~1 GB NDK up front) and resolver blind spots. It
supplements the derived set, the same role `install-inputs` plays for web.

### Requirement discovery — staged resolver

Repos declare versions in many ways (literals, version catalogs, `gradle.properties`, `buildSrc`/
convention plugins), so discovery is staged rather than a single regex:

1. **Static scan** — `build.gradle(.kts)`, `gradle.properties`, `libs.versions.toml` for the common cases.
2. **Gradle query** — when a value is unresolved or comes from a convention plugin, a lightweight
   init/query task prints the resolved `compileSdk`/AGP.
3. **Error-driven retry** — a "missing platform/NDK/CMake" build error provisions that exact component
   into the overlay and reruns, so the long tail self-heals.

### Declaration & monorepos

ShipIt itself is the shape to design for: a Node/React web app plus the `android/` Gradle project in one
repo. The `android:` key sits alongside the existing web config and neither replaces the other:

```yaml
agent:
  install: npm install          # web toolchain
compose: docker-compose.yml     # all Compose previews live here — web services AND, if you add one,
                                # the Android emulator service (see "Running app" below)
android:
  - project: android            # path to the Gradle project/module — explicit opt-in, like compose:
    preview: rendered           # rendered (platform gallery) | none.
                                # The emulator preview isn't a mode here — it's a Compose service in
                                # docker-compose.yml above.
    # toolchain is derived from the Gradle build; optional overrides for blind spots / pre-provisioning:
    # sdk: ["ndk;26.1.10909125", "cmake;3.22.1"]
    # jdk: 17
```

- **Declaration is explicit**, not inferred — `android:` opts the repo in, the same way `compose:` opts
  in a web stack. Listing each module makes monorepos and per-app preview selection unambiguous and avoids
  guessing off stray `.gradle` files. (The staged resolver then reads *versions* from the named project;
  it doesn't decide *whether* the repo is Android — the declaration does.)
- Builds are **path-scoped** to the module — `(cd android && ./gradlew :app:assembleDebug)` (or
  `./gradlew -p android …`), not a repo-root invocation — so the web build is untouched and the toolchain
  serves whichever module the `android:` entry names.
- The emulator preview is **a Compose service the user adds to `docker-compose.yml`** alongside any web
  services — `compose:` covers both. Nothing about declaring an Android build precludes an Android preview.
- **Prereq for `android/`:** commit the pinned Gradle wrapper (8.7), missing today though doc 116 assumed
  it was present. Repos without a wrapper fall back to the baked Gradle matched to their AGP.

## Headless: build, test & static debug (no emulator)

All of this runs in the session container with no device, on the existing runtime once Phase 1 lands:

- **`assembleDebug`** — full compile + packaging; the core "did I break the build?" signal.
- **`lint`** — manifest/resource/accessibility + edge-to-edge/inset checks (API-35-relevant).
- **JVM unit tests + Robolectric** — pure logic and Android-framework-on-the-JVM behavior.
- **Paparazzi / Roborazzi** — render Views and Compose `@Preview`s to PNG via `layoutlib`, diffed against
  committed goldens. Pin Paparazzi to the repo's AGP (this repo: AGP 8.5.2 / Kotlin 1.9.24 / Gradle 8.7)
  and bump together. (Google's official Compose Preview Screenshot Testing needs AGP 9; Paparazzi/Roborazzi
  fit until then.) For `android/` specifically the main surface is a `WebView`, which `layoutlib` doesn't
  render, so Paparazzi covers the chrome/insets/settings screen; for general native UIs coverage is high.
- **Static inspection** — `apkanalyzer` and `aapt2` (in the baked SDK) dump the merged manifest,
  resource table, DEX/method counts, and dependency tree without a device.

Most debugging is reading the output above — compile errors, lint findings, and test stack traces. The
limit is that `layoutlib` renders a static view tree and never *runs* the app, so anything that appears
only while code executes (lifecycle, threading, prod-path exceptions) needs the running-app surface.

## Running app: debug, drive & preview (an emulator Compose service)

The interactive emulator is **a Compose service the user declares** (with the agent's help) — the same
primitive ShipIt already uses for every long-running preview (dev server, Prisma Studio, log tailer —
CLAUDE.md §5). ShipIt builds no emulator service, WebRTC bridge, or APK-push pipeline; it ships a recipe
and the `/dev/kvm` allowance described above:

```yaml
# docker-compose.yml — the recipe ShipIt ships; the agent drops it in on request
services:
  emulator:
    image: budtmo/docker-android:emulator_14   # or an AOSP emulator-webrtc image
    devices: ["/dev/kvm:/dev/kvm"] # hardware accel — the gated allowance permits exactly this mapping
    ports: ["6080:6080"]           # preview metadata: x-shipit-preview proxies ports[0]'s container port (the web UI)
    expose: ["5555"]               # adb, reachable on the Compose network by service name
    x-shipit-preview: auto         # renders the web UI in the preview pane
```

ShipIt strips host port bindings (services are reached through the preview proxy on the session network,
not published ports), so `ports[0]` is **preview metadata** — which container port the proxy renders —
and the agent reaches adb over the Compose network by **service DNS**, `adb connect emulator:5555`. With
the service up, all three running-app capabilities fall out of existing primitives:

- **Runtime debugging.** `adb logcat` — crashes, exceptions, `Log.*` output; the first thing to read when
  something fails at runtime. (`adb shell` for install/launch, permissions, `run-as` data, intents.)
- **Driving the app — press buttons, screenshot, snapshot.** The Android analog of the Playwright tools
  the agent already uses for web (`browser_click` / `browser_take_screenshot` / `browser_snapshot`), over
  `adb`:
  - **Raw `adb` triad (the baseline).** `uiautomator dump` → view-hierarchy XML with each element's
    `resource-id`/`text`/`bounds` (**snapshot**); `adb shell input tap/text/keyevent` (**press**, using
    coordinates from the dump); `adb exec-out screencap -p` (**screenshot**). No framework — the
    baked platform-tools ship `adb`. ShipIt can wrap these as agent tools mirroring `browser_*`.
  - **Maestro (optional ergonomic layer).** CLI-first YAML flows (`tapOn`, `takeScreenshot`), tolerant
    selectors, auto-wait — resilient "tap Login, screenshot" steps without computing coordinates.
  - **Appium / Espresso / UI Automator** — heavier alternatives: Appium if ShipIt ever wants one WebDriver
    protocol across web and mobile; Espresso/UI Automator as committed instrumented tests (see below).
- **Interactive preview.** The emulator image's own web UI (noVNC/WebRTC) is shown by the **existing**
  preview pane via `x-shipit-preview` — nothing for ShipIt to build. This is the user-facing, touchable
  view; the agent's debug/drive loop above only needs the emulator adb-reachable, not the UI.

**No KVM on the host?** Point the same flows at **Firebase Test Lab** (or a device cloud): it runs the app
on real/virtual cloud devices and returns logcat, screenshots, and video as inline PR-card artifacts. Also
the home for **instrumented tests** (`connectedAndroidTest`, Espresso/UI Automator) and Gradle Managed
Devices on a KVM CI runner.

Out of scope: an interactive debugger / breakpoints (JDWP attach) and profiling (CPU/memory/jank) — heavy,
device-bound, and not part of the agent loop.

## Preview tiers

The web preview pane sets the bar: see your change run, inside ShipIt. Android reaches it in tiers, in
priority order:

- **P1 — rendered-screen gallery (headless, zero-KVM, first).** Reuse the `layoutlib` renderer behind
  Paparazzi to render screens to PNGs and show a gallery in the preview pane, refreshed on change. The
  platform owns the wiring so the user authors no test code: inject the renderer via a Gradle init script,
  generate the harness as **uncommitted source** under a ShipIt-managed dir, discover screens via
  **ComposablePreviewScanner** (Compose) with a manifest/`res/layout` fallback (Views). Static (no touch),
  but real hardware-free visual feedback, and it doubles as the Paparazzi golden source.
- **P2 — interactive emulator.** The emulator Compose service above; its web UI is the touchable preview.
  ShipIt's own `android/` is the easy case — a WebView shell whose preview is just the web preview pointed
  at a dev URL; general native apps are what motivate P2.
- **P3 — cloud device farm.** Firebase Test Lab for real-device validation when the host can't offer KVM.

## Agent surfacing

1. **`src/server/shipit-docs/android.md`** (baked into the session image at `/shipit-docs/`) — the
   headless commands, the SDK env (`ANDROID_SDK_ROOT`, `JAVA_HOME`), Paparazzi golden record/verify,
   the static (`apkanalyzer`/`aapt2`) and runtime (`adb logcat` / `uiautomator dump` / `input tap` /
   `screencap`) debug commands, and the **emulator Compose recipe** (the canonical service the agent adds
   on request, reached over `adb connect`).
2. **`.claude/skills/android-build` skill** — discloses by description, loads when a task touches an
   Android project; carries the loops: build → lint → render → read-the-PNG-diff → PR; read
   build/test output, then `adb logcat`/`uiautomator dump` for runtime failures; and drop in the emulator
   service when the user wants a live device. Per `docs/209-cross-agent-skill-disclosure`, one skill covers
   both Claude and Codex.

## Phased plan

Each phase is shippable on its own and ordered by value-per-effort.

- **Phase 0 — prereqs.** Commit the Gradle wrapper (8.7) under `android/`; add the `shipit.yaml`
  `android:` schema (explicit opt-in) and the staged version resolver for the named project.
- **Phase 1 — build toolchain (any repo).** Bake the SDK+JDK base into the session-worker image (a
  Dockerfile step, like the agent CLIs / Playwright) + the per-session overlay; resolve Gradle/JDK from
  `./gradlew` or the AGP matrix. Verify `assembleDebug` + `lint` + a JVM test green for (a) a generic repo
  whose `compileSdk`/JDK differ from the baked default (exercises the overlay) and (b) a web/Android
  monorepo where the Android build is path-scoped and the web preview is unaffected. Ship
  `shipit-docs/android.md` + the skill. This alone ends blind editing — build, lint, test, and static
  debug all work.
- **Phase 2 — P1 rendered preview.** The platform render harness (Paparazzi/Roborazzi via init script,
  ComposablePreviewScanner + manifest/`res/layout` discovery) wired into the preview pane. First visual
  feedback for agent and user.
- **Phase 3 — running-app enabler.** The narrowly-scoped `/dev/kvm` `devices:` allowance in the compose
  generator + the canonical emulator Compose recipe in `compose.md` and the skill. Confirm host KVM.
- **Phase 4 — runtime debug, drive & interactive preview (mostly free).** With the emulator service up,
  the agent reaches it over `adb connect`: `logcat`, the interactive triad, `install`. The image's web UI
  shows via `x-shipit-preview`. Optional polish: `browser_*`-style tool wrappers and/or Maestro.
- **Phase 5 — instrumented / cloud (P3).** Firebase Test Lab (or GMD on a KVM CI runner) for instrumented
  tests and real-device validation, surfaced as inline PR artifacts.

## Relationship to other work

- **Unblocks the API-35 edge-to-edge bump (sibling session).** Phase 1 lets it compile + lint the
  `targetSdk`/`compileSdk` 35 change; Phase 2 lets it verify the insets visually. High-leverage to land
  Phase 1 + a minimal Paparazzi golden alongside that bump.
- **SHI-53** tracks the WebView wrapper feature (doc 116). This doc is the platform build/test/preview
  capability — distinct lifecycle, its own tracker item (**SHI-170**, under umbrella **SHI-204**; sibling
  **SHI-205** = an Android project template for new repos).

## Risks / open questions

- **Baked-base matrix sizing.** Which API levels / build-tools / JDKs to bake is a trade: too many grows
  the universal image, too few pushes more repos onto the slower overlay path. Tune from real repo
  telemetry. (If the image growth becomes the binding constraint, switch the base to a mount — option B —
  without touching the overlay.)
- **Version-resolution accuracy.** With declaration explicit, ShipIt knows *which* module; the staged
  resolver still has to read the right `compileSdk`/NDK/CMake/AGP from however the repo declares them
  (literals, version catalogs, `gradle.properties`, `buildSrc`/convention plugins). Gate the Gradle-query
  stage behind a static-scan miss to keep it cheap; the error-driven retry backstops the rest.
- **Host KVM + the `/dev/kvm` allowance.** The emulator needs KVM on whatever host runs it — verify the
  deployment instance offers it, and implement the gated `devices:` allowance (no `privileged`). No KVM →
  Firebase, same flows.
- **Emulator weight (not a special downside).** On a self-hosted box everything shares the host, so the
  emulator "competing for resources" isn't unique to it — it's just **heavy** (~2–4 GiB + real CPU). As a
  Compose service it's governed by **per-service Compose resource limits** plus host/deployment capacity,
  and started **on-demand** (like the dogfood `dev` service) rather than every boot. (The `agent.memory`/
  `cpu` ceilings size the *agent/session* container, not Compose services — a different knob.) A separate
  KVM pool is only for scale-out/multi-tenant or a no-KVM main host — not the standard single-box deployment.
- **Paparazzi ↔ AGP coupling** (an AGP bump can break renders; pin and bump together) and the
  **WebView-not-renderable** caveat.

## Key files (when implemented — not yet changed)

- **Session setup** (`shared/session-config.ts`, container-lifecycle) — the `android:` schema (explicit
  opt-in), path-scoped staged version resolver, the per-session overlay + env (`ANDROID_SDK_ROOT`,
  `JAVA_HOME`), Gradle/JDK resolution, composed with the existing web config.
- **`Dockerfile.session-worker.*`** — bake the SDK+JDK base (JDK 11 + 17, cmdline-tools, the
  API-level/build-tools matrix with licenses accepted, Gradle cache), like the agent-CLI / Playwright
  installs already there. The AGP→Gradle→JDK matrix + overlay-provisioning live in session setup above.
- **`android/gradlew`, `android/gradle/wrapper/*`** — new, the pinned 8.7 wrapper (Phase 0).
- **Render harness** — injected Gradle init script + generated uncommitted harness; ComposablePreviewScanner
  + manifest/`res/layout` discovery (Phase 2). A native test app (from the SHI-205 template) adds
  Paparazzi/Roborazzi to exercise the render path end to end.
- **Compose generator** (`compose-generator.ts`) — the narrowly-scoped `devices: ["/dev/kvm:/dev/kvm"]` allowance
  (no `privileged`, gated like `docker-socket: true`) + the canonical emulator recipe in `compose.md`. The
  emulator's web UI uses the existing `x-shipit-preview` path — no new preview route.
- **(Optional) agent tooling** — `browser_*`-style wrappers around the `adb` triad + Maestro in the
  toolchain. Polish; the agent can run the `adb` commands directly.
- **`src/server/shipit-docs/android.md` + `.claude/skills/android-build/SKILL.md`** — new, agent surfacing.
- **`.github/workflows/android.yml`** — a GMD/Firebase job is a Phase 5 addition.
