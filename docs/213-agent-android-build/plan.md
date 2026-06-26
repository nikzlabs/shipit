---
description: Make ShipIt build, test & preview Android apps for any repo — including web/Android monorepos — with the build toolchain baked into the session image (the agent runs Gradle, including the repo's own snapshot tests) and the running app as a user-defined emulator Compose service. No new shipit.yaml fields.
issue: https://linear.app/shipit-ai/issue/SHI-170
---

# 213 — Android build, test & preview as a ShipIt platform capability

## Summary

ShipIt should be a place you build Android apps. Any repo with an Android/Gradle project — including a
**monorepo** that holds a web app and Android modules, like ShipIt itself — should get the same
build → test → preview loop the web side already has, with **no new `shipit.yaml` fields**: build and test
need no config at all, and the interactive preview is just an ordinary Compose service.

It comes down to two pieces:

1. **The agent runs Gradle in the session container.** Compile, lint, JVM/Robolectric tests, and —
   crucially — the repo's **own snapshot tests** (Paparazzi/Roborazzi), which render screens to PNGs on
   the JVM with no device. This needs the Android toolchain (SDK + JDK + Gradle) present in the session
   container.
2. **The running app is a preview that lives in a service container.** An emulator declared as a Compose
   service — the same primitive as any web preview — reachable by the **agent** over `adb` (logs, taps,
   screenshots) and by the **user** as its streamed web UI in the preview pane.

Today the `android/` wrapper builds only in GitHub Actions, and a session container has no Java, SDK,
Gradle, or preview — so the agent edits Kotlin/XML blind and the user sees nothing run. The web side has a
tight loop (preview pane + Playwright); the Android side has none.

`android/` exercises the build/lint path, but it's a thin **WebView shell** — `layoutlib` can't render it
and it has no native UI, so it can't validate the snapshot, emulator, or interactive-control parts of the
loop. The proper dogfood/validation target is a **real native test app**, which the new-repo Android
template (**SHI-205**) will produce; set it up once that template exists.

## Recommendation

1. **Bake the build toolchain into the session-worker image.** A common SDK + JDK + Gradle base baked into
   `Dockerfile.session-worker.*`, exactly as the agent CLIs and Playwright/Chrome are baked today. The
   toolchain is then **ambient** — present in every session — so a repo needs to declare *nothing* to get
   a working `./gradlew`. A small per-session overlay provisions any repo-specific component the base lacks
   (off-matrix `compileSdk`, an NDK), on demand.
2. **Visual verification is the repo's own snapshot tests, run headlessly.** "Did my inset/padding change
   render right?" is answered by a **snapshot test** — which sets up the screen with realistic data and
   renders it with **no device** (Paparazzi via `layoutlib`, Roborazzi via Robolectric) — diffed against a
   committed golden. The agent runs `./gradlew verifyPaparazziDebug` (or `recordPaparazziDebug` to update
   goldens) and reads the PNG diff. ShipIt builds **no** render harness of its own: a test that sets up its
   own state is strictly more useful than a platform gallery that renders `@Preview`s with no data.
3. **The running app is a user-declared emulator Compose service.** Runtime debugging (`adb logcat`),
   driving the app (tap / screenshot / view-hierarchy snapshot), and the interactive preview all come from
   **one emulator service in `docker-compose.yml`** reached over `adb` — not bespoke ShipIt infra. ShipIt
   ships the recipe and one enabler (a gated `/dev/kvm` device allowance); a cloud device farm (Firebase
   Test Lab) covers hosts without KVM.
4. **No new `shipit.yaml` fields.** Because the toolchain is ambient and the emulator is an ordinary
   Compose service, there is nothing Android-specific left to declare. Build and test for an existing
   Android repo need *no setup at all*; the interactive emulator is an ordinary Compose service edit — see
   [Why no `shipit.yaml` fields](#why-no-shipityaml-fields).

## Two runtime surfaces

Everything below sorts into one of two places an Android app can run, which is the spine of the design:

- **Headless — the toolchain in the session container.** The SDK + JDK available to the agent. Compiles,
  lints, runs JVM/Robolectric tests, and renders screens via `layoutlib` (snapshot tests) — **no device**.
- **A running app — a Compose service.** A real Android OS for anything that only exists while code
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
  so ShipIt must add a **narrowly-scoped allowlist** that permits exactly the `/dev/kvm:/dev/kvm` mapping
  and nothing else. The opt-in is the user adding the emulator service with that `devices:` entry to
  `docker-compose.yml` — **not** a new `shipit.yaml` field; an operator can disable it deployment-wide (an
  env/deployment setting) when a shared host shouldn't expose KVM. This is the one hard platform dependency
  for the whole emulator tier.

## Why no `shipit.yaml` fields

An earlier draft proposed an `android:` block (`project`, `preview`, `sdk`, `jdk`). Working through it, the
fields don't earn their place — and the decision that removes them is the one above: **baking the toolchain
into the image.** Field by field, against the test *"does the platform need this declared, or can the agent
just do it?"*:

- **A project/module path** — its job was to tell the platform "this is an Android session, attach the
  toolchain." But baked-in means the toolchain is *always there*; nothing to attach. The agent finds the
  Gradle root itself (`settings.gradle` + `gradlew`) and runs it — including in a monorepo, where it simply
  `cd`s into the Android dir. So there's nothing to scope. (Discovery is an **agent policy**, not a config
  field: locate Gradle roots, list modules/tasks via `./gradlew projects`/`tasks`, run the
  `com.android.application` module's task — `:app:…` by convention — and *ask* when a repo has several app
  modules, flavors, or roots. The skill carries this policy; ambiguity is resolved in chat, not YAML.)
- **SDK / NDK components** — provisioning is **on demand**: a build that needs an off-matrix platform or an
  NDK fails with a precise "missing X", and ShipIt (or the agent via `sdkmanager`, guided by shipit-docs)
  installs exactly X into the per-session overlay and retries. No up-front declaration.
- **JDK** — derived from the project's AGP version (a documented matrix), or the agent sets `JAVA_HOME`
  from the baked JDKs. No declaration.
- **A preview toggle** — the only field that *would* need platform knowledge is a managed render surface,
  and that surface is gone (recommendation 2). The **interactive** preview is the emulator, which is a
  Compose service declared in `docker-compose.yml` — not an `android:` field.

So the schema collapses to nothing. A repo with **pre-configured snapshot tests** integrates by *doing
nothing*: the agent runs `./gradlew verifyPaparazziDebug` against the ambient toolchain. A repo that wants
an interactive emulator adds a Compose service — the same way it would add any preview. This is the right
bar: *Android support is "it just works," not "fill in this YAML."*

(The interaction is worth stating plainly: a baked toolchain is what kills the declaration. A *mounted*
toolchain would need to know which sessions to attach it to — hence a flag or detection. Baked = ambient =
nothing to detect or declare.)

## Headless: build, test & static debug (the toolchain in the session container)

The agent runs `gradle` in the session container, so it needs a common SDK + JDK + Gradle **base**, baked
into the session-worker image like the agent CLIs and Playwright/Chrome already are: cmdline-tools,
platform-tools, a matrix of common API levels + build-tools (licenses pre-accepted), a Gradle distribution
cache, and JDK 11 + 17. A Dockerfile step (`sdkmanager …`), bumped on the existing Renovate cadence.

A single fixed SDK can't cover every repo, so a **per-session writable overlay** holds repo-specific
components the base lacks (an off-matrix `compileSdk`, an NDK, a CMake toolchain). It is provisioned **on
demand** — the long tail self-heals: a "missing platform/NDK/CMake" build error provisions that exact
component and reruns. **Gradle** comes from the project's wrapper when committed (else a baked version via
the documented **AGP→Gradle** matrix); the **JDK** is picked from the baked JDKs by the project's AGP
version (set via `JAVA_HOME` / Gradle toolchains — the wrapper pins Gradle, not the JDK). (Prereq for
`android/` specifically: commit the pinned Gradle wrapper (8.7), missing today though doc 116 assumed it
present.)

With that in place, all of this runs with **no device**:

- **`assembleDebug`** — full compile + packaging; the core "did I break the build?" signal.
- **`lint`** — manifest/resource/accessibility + edge-to-edge/inset checks (API-35-relevant).
- **JVM unit tests + Robolectric** — pure logic and Android-framework-on-the-JVM behavior.
- **Snapshot tests (Paparazzi / Roborazzi) — the visual verification.** They render Views and Compose
  `@Preview`s to PNG with **no device** — Paparazzi via `layoutlib`, Roborazzi via Robolectric — diffed
  against committed goldens. **The test sets up the data it renders**, which is exactly why this — not a
  platform gallery — answers "did my inset/padding change render right?". The agent runs
  `verifyPaparazziDebug` (check) / `recordPaparazziDebug` (update goldens) and reads the diff PNGs. Pin the
  snapshot lib to the repo's AGP (this repo: AGP 8.6.1 / Kotlin 1.9.24 / Gradle 8.7) and bump together.
  (Google's official Compose Preview Screenshot Testing runs its headless Gradle tasks on AGP 8.5+, but
  full IDE integration lands with AGP 9 — so Paparazzi/Roborazzi remain the mature headless choice for now.
  `layoutlib` can't render a `WebView`, so for `android/` snapshots cover the chrome/insets/settings screen;
  for general native UIs coverage is high.)
- **Static inspection** — `apkanalyzer` and `aapt2` (in the baked SDK) dump the merged manifest, resource
  table, DEX/method counts, and dependency tree without a device.

Most debugging is reading the output above — compile errors, lint findings, test stack traces, snapshot
diffs. The limit is that `layoutlib` renders a static view tree and never *runs* the app, so anything that
appears only while code executes (lifecycle, threading, prod-path exceptions) needs the running-app surface.

## Running app: debug, drive & preview (an emulator Compose service)

The interactive emulator is **a Compose service the user declares** (with the agent's help) — the same
primitive ShipIt already uses for every long-running preview (dev server, Prisma Studio, log tailer —
CLAUDE.md §5). ShipIt builds no emulator service, WebRTC bridge, or APK-push pipeline; it ships a recipe
and the `/dev/kvm` allowance described above:

```yaml
# docker-compose.yml — the recipe ShipIt ships; the agent drops it in on request,
# alongside any web preview services (one compose file holds both)
services:
  emulator:
    image: budtmo/docker-android:emulator_14   # or an AOSP emulator-webrtc image
    devices: ["/dev/kvm:/dev/kvm"] # hardware accel — the generator allowlists exactly this mapping
    ports: ["6080:6080"]           # preview metadata: x-shipit-preview proxies ports[0]'s container port (the web UI)
    expose: ["5555"]               # adb, reachable on the Compose network by service name
    x-shipit-preview: auto         # renders the web UI in the preview pane
```

ShipIt strips host port bindings (services are reached through the preview proxy on the session network,
not published ports), so `ports[0]` is **preview metadata** — which container port the proxy renders — and
the agent reaches adb over the Compose network by **service DNS**, `adb connect emulator:5555`. With the
service up, all three running-app capabilities fall out of existing primitives:

- **Runtime debugging.** `adb logcat` — crashes, exceptions, `Log.*` output; the first thing to read when
  something fails at runtime. (`adb shell` for install/launch, permissions, `run-as` data, intents.)
- **Driving the app — press buttons, screenshot, snapshot.** The Android analog of the Playwright tools the
  agent already uses for web (`browser_click` / `browser_take_screenshot` / `browser_snapshot`), over `adb`:
  - **Raw `adb` triad (the baseline).** `uiautomator dump` → view-hierarchy XML with each element's
    `resource-id`/`text`/`bounds` (**snapshot**); `adb shell input tap/text/keyevent` (**press**, using
    coordinates from the dump); `adb exec-out screencap -p` (**screenshot**). No framework — the baked
    platform-tools ship `adb`. ShipIt can wrap these as agent tools mirroring `browser_*`.
  - **Maestro (optional ergonomic layer).** CLI-first YAML flows (`tapOn`, `takeScreenshot`), tolerant
    selectors, auto-wait — resilient "tap Login, screenshot" steps without computing coordinates.
  - **Appium / Espresso / UI Automator** — heavier alternatives: Appium if ShipIt ever wants one WebDriver
    protocol across web and mobile; Espresso/UI Automator as committed instrumented tests (see below).
- **Interactive preview.** The emulator image's own web UI (noVNC/WebRTC) is shown by the **existing**
  preview pane via `x-shipit-preview` — nothing for ShipIt to build. This is the user-facing, touchable
  view; the agent's debug/drive loop above only needs the emulator adb-reachable, not the UI.

**No KVM on the host?** Run the app on **Firebase Test Lab** (or a device cloud) instead: it executes
instrumented / robo tests in **batch** on real and virtual cloud devices and returns logcat, screenshots,
and video as inline PR-card artifacts. It is **not** a live `adb`-interactive preview or a drop-in
`adb connect` replacement — it's automated test execution — but it covers regression validation where
there's no local KVM. Also the home for **instrumented tests** (`connectedAndroidTest`, Espresso/UI
Automator) and Gradle Managed Devices on a KVM CI runner.

Out of scope: an interactive debugger / breakpoints (JDWP attach) and profiling (CPU/memory/jank) — heavy,
device-bound, and not part of the agent loop.

## Preview, end to end

The web preview pane sets the bar: see your change run, inside ShipIt. Android reaches it two ways, neither
needing a new preview surface:

- **Interactive — the emulator's web UI.** The Compose service above; its streamed UI renders in the
  existing preview pane via `x-shipit-preview`. This is the touchable, user-facing preview. Requires KVM on
  the host; without it there is no live interactive preview (Firebase Test Lab covers automated regression
  validation, but in batch — not an interactive device).
- **Static — snapshot PNGs.** On any host, KVM or not, the agent runs the repo's snapshot tests and reads
  the rendered/diff PNGs. These are test artifacts, not a managed preview surface, but they're the
  zero-device visual signal for both the agent (read the diff) and the user (surface the PNG inline via the
  `present` tool or as a PR-card artifact). For ShipIt's own `android/`, the "preview" is just the web
  preview pointed at a dev URL inside the WebView — the native emulator matters for general apps.

## Agent surfacing

1. **`src/server/shipit-docs/android.md`** (baked into the session image at `/shipit-docs/`) — the headless
   commands, the SDK env (`ANDROID_SDK_ROOT`, `JAVA_HOME`), snapshot record/verify (`recordPaparazziDebug` /
   `verifyPaparazziDebug`), the static (`apkanalyzer`/`aapt2`) and runtime (`adb logcat` / `uiautomator
   dump` / `input tap` / `screencap`) debug commands, and the **emulator Compose recipe** (the canonical
   service the agent adds on request, reached over `adb connect`).
2. **`.claude/skills/android-build` skill** — discloses by description, loads when a task touches an Android
   project; carries the loops: build → lint → **run snapshot tests → read the PNG diff** → PR; read
   build/test output, then `adb logcat`/`uiautomator dump` for runtime failures; and drop in the emulator
   service when the user wants a live device. Per `docs/209-cross-agent-skill-disclosure`, one skill covers
   both Claude and Codex.

## Phased plan

Each phase is shippable on its own and ordered by value-per-effort.

- **Phase 1 — build toolchain (any repo).** Bake the SDK+JDK base into the session-worker image (a
  Dockerfile step, like the agent CLIs / Playwright) + the on-demand per-session overlay; resolve Gradle/JDK
  from `./gradlew` or the AGP matrix; commit the `android/` Gradle wrapper (8.7). Verify `assembleDebug` +
  `lint` + a JVM test green for (a) a generic repo whose `compileSdk`/JDK differ from the baked default
  (exercises the overlay) and (b) a web/Android monorepo where the Android build is run from its subdir and
  the web preview is unaffected. Ship `shipit-docs/android.md` + the skill. **This alone ends blind
  editing** — build, lint, JVM/Robolectric tests, and static debug all work, with **zero repo config**.
- **Phase 2 — snapshot tests as the visual signal.** Confirm the baked `layoutlib` runtime runs the repo's
  Paparazzi/Roborazzi tests headlessly; document `record`/`verify` in the skill; surface rendered/diff PNGs
  inline (`present` / PR artifact). Adds visual verification with no emulator and no platform harness. (A
  native test app from the SHI-205 template exercises this end to end.)
- **Phase 3 — running-app enabler.** The narrowly-scoped `/dev/kvm` `devices:` allowance in the compose
  generator + the canonical emulator Compose recipe in `compose.md` and the skill. Confirm host KVM.
- **Phase 4 — runtime debug, drive & interactive preview (mostly free).** With the emulator service up, the
  agent reaches it over `adb connect`: `logcat`, the interactive triad, `install`. The image's web UI shows
  via `x-shipit-preview`. Optional polish: `browser_*`-style tool wrappers and/or Maestro.
- **Phase 5 — instrumented / cloud.** Firebase Test Lab (or GMD on a KVM CI runner) for instrumented tests
  and real-device validation on no-KVM hosts, surfaced as inline PR artifacts.

## Implementation status (Phases 1–2 shipped)

Phases 1 and 2 are implemented. What landed and where:

- **Baked toolchain** (`Dockerfile.session-worker.prod` + `.dev`, after the Playwright block): JDK 17
  (`JAVA_HOME=/opt/java`, an arch-independent symlink), the Android SDK (`ANDROID_SDK_ROOT=/opt/android-sdk`
  — `cmdline-tools/latest`, `platform-tools`, platforms `android-34`+`android-35`, build-tools
  `34.0.0`+`35.0.0`, licenses pre-accepted), and Gradle 8.7 at `/opt/gradle`. SDK dirs are made
  world-writable (dirs only — small layer) so on-demand `sdkmanager` installs work as the unprivileged
  runtime user. The `.docker` worker variant inherits all of this (it `FROM`s the base).
- **Env at the launch boundary** (`container-lifecycle.ts` `buildEnv`): `ANDROID_SDK_ROOT`, `ANDROID_HOME`,
  `JAVA_HOME` mirrored like `PLAYWRIGHT_BROWSERS_PATH`, with a guard test (`container-lifecycle.test.ts`).
- **Gradle wrapper** committed under `android/` (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`) pinned to 8.7.
- **Agent surfacing**: `src/server/shipit-docs/android.md` (baked into every image at `/shipit-docs/` — the
  platform-global reference that reaches *any* repo) + the `.claude/skills/android-build` skill (covers
  ShipIt's own `android/` dogfood; the SHI-205 template / a future platform-injection step distributes it to
  user repos). `environment.md` + the docs `README.md` index updated.
- **Phase 2** is documentation over the same baked toolchain: `android.md` + the skill carry the
  `record`/`verify` snapshot loop and the **read-the-diff-PNG → `present` it** habit. No new orchestrator
  code — `present` already exists.

Two deliberate deviations from the design sketch above, both toward "the agent is the actor":

- **JDK 17 only** (not 11 + 17). It covers AGP 8.x, the current matrix; an 11 bake is a one-line addition if
  a repo needs it.
- **No orchestrator-side staged version resolver.** The simplest realization of the "derived / on-demand"
  principle is: the committed `./gradlew` self-resolves Gradle, the baked JDK 17 covers AGP 8.x, and a
  missing SDK component is installed **on demand by the agent** via `sdkmanager` (guided by `android.md`) —
  no build-interception code in the orchestrator. A persistent SDK overlay (so on-demand installs survive a
  restart) remains future work; today they re-install on demand.

**Not verifiable in-session** (needs the rebuilt image, which OOMs/`can't build` in a session container):
the actual green `assembleDebug`/`lint`/snapshot run against the baked toolchain. That gate runs in CI /
post-deploy on the new session-worker image.

## Relationship to other work

- **Unblocks the API-35 edge-to-edge bump (sibling session).** Phase 1 lets it compile + lint the
  `targetSdk`/`compileSdk` 35 change; Phase 2 lets it verify the insets visually via a snapshot test.
  High-leverage to land Phase 1 + a minimal snapshot golden alongside that bump.
- **SHI-53** tracks the WebView wrapper feature (doc 116). This doc is the platform build/test/preview
  capability — distinct lifecycle, its own tracker item (**SHI-170**, under umbrella **SHI-204**; sibling
  **SHI-205** = an Android project template for new repos).

## Risks / open questions

- **Baked-base matrix sizing.** Which API levels / build-tools / JDKs to bake is a trade: too many grows the
  universal image, too few pushes more repos onto the slower overlay path. Tune from real repo telemetry.
  (If image growth ever becomes the binding constraint, the base can move to a shared read-only mount
  without touching the on-demand overlay — but the simplicity of baking wins by default, matching the
  already-baked agent CLIs / Playwright.)
- **On-demand provisioning accuracy.** The overlay has to install the right `compileSdk`/NDK/CMake when a
  build needs it. The error-driven path (provision the exact missing component, retry) backstops the common
  case; document the `sdkmanager` commands in the skill so the agent can also provision directly.
- **Host KVM + the `/dev/kvm` allowance.** The emulator needs KVM on whatever host runs it — verify the
  deployment instance offers it, and implement the gated `devices:` allowance (no `privileged`). No KVM →
  Firebase, same flows.
- **Emulator weight (not a special downside).** On a self-hosted box everything shares the host, so the
  emulator "competing for resources" isn't unique to it — it's just **heavy** (~2–4 GiB + real CPU). As a
  Compose service it's governed by **per-service Compose resource limits** plus host/deployment capacity,
  and started **on-demand** (like the dogfood `dev` service) rather than every boot. A separate KVM pool is
  only for scale-out/multi-tenant or a no-KVM main host — not the standard single-box deployment.
- **Snapshot-lib ↔ AGP coupling** (an AGP bump can break renders; pin and bump together) and the
  **WebView-not-renderable** caveat.

## Key files (when implemented — not yet changed)

- **`Dockerfile.session-worker.*`** — bake the SDK+JDK base (JDK 11 + 17, cmdline-tools, the
  API-level/build-tools matrix with licenses accepted, Gradle cache), like the agent-CLI / Playwright
  installs already there. This is the bulk of Phase 1 and what makes the toolchain ambient.
- **Session setup** (`shared/session-config.ts`, container-lifecycle) — the on-demand per-session SDK
  overlay + env (`ANDROID_SDK_ROOT`, `JAVA_HOME`), AGP→Gradle→JDK resolution. **No `shipit.yaml` schema
  change** — Android needs no new config.
- **`android/gradlew`, `android/gradle/wrapper/*`** — new, the pinned 8.7 wrapper (Phase 1 prereq).
- **Compose generator** (`compose-generator.ts`) — an exact allowlist of the `devices: ["/dev/kvm:/dev/kvm"]`
  mapping (no `privileged`; opt-in is declaring the service, with an operator-level deployment disable — not
  a repo `shipit.yaml` field) + the canonical emulator recipe in `compose.md`. The emulator's web UI uses
  the existing `x-shipit-preview` path — no new preview route.
- **(Optional) agent tooling** — `browser_*`-style wrappers around the `adb` triad + Maestro in the
  toolchain. Polish; the agent can run the `adb` commands directly.
- **`src/server/shipit-docs/android.md` + `.claude/skills/android-build/SKILL.md`** — new, agent surfacing.
- **`.github/workflows/android.yml`** — a GMD/Firebase job is a Phase 5 addition.
