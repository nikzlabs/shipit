---
description: Give the in-container agent a real Android toolchain so it can compile, lint, and snapshot-test android/ changes instead of editing blind — headless (Paparazzi/Robolectric) first, emulator later.
issue: https://linear.app/shipit-ai/issue/SHI-170
---

# 213 — Agent builds & tests Android changes in-container

## Recommendation (lead)

**Give the agent a headless Android build/test tier first; do not attempt an in-container emulator.**

1. **Phase 1 — headless toolchain (do this).** Install JDK 17 + Android cmdline-tools + SDK
   (platform/build-tools 35) **scoped to the ShipIt repo** via `agent.install` in
   `shipit.yaml`, landing in a **workspace-relative, gitignored** SDK root
   (`/workspace/.android-sdk`) so it survives idle-resume on the workspace volume and only
   re-downloads on a true cold re-clone. Commit the missing **Gradle wrapper** so builds are
   pinned and don't depend on a network `gradle` install. This unlocks
   `gradle :app:assembleDebug`, `gradle :app:lint`, and **JVM unit tests**.
2. **Phase 2 — headless UI verification (the high-value part).** Add **Paparazzi** for
   layout/screenshot snapshot tests that render Views via `layoutlib` **on the JVM with no
   emulator**, and optionally **Robolectric** for JVM-side Android unit tests. This is what
   lets the agent *see* an inset/edge-to-edge change — directly unblocking the sibling API-35
   edge-to-edge work, which is being done blind today.
3. **Phase 3 — emulator/instrumented tier (punt).** Instrumented tests and *live* device
   screenshots need an emulator, which needs KVM. **The session container exposes no
   `/dev/kvm`** (measured — see below), so this is **not achievable in-container**. Keep it in
   CI via **Gradle Managed Devices** (which itself needs a KVM-capable runner) or a cloud
   device farm (**Firebase Test Lab**). Document this as a known ceiling, not a TODO to grind on.

Rationale in one line: ~95% of the value (does it compile? does lint pass? did the layout/insets
change as intended?) is reachable **without** an emulator, and the emulator tier is blocked by a
hardware capability the container runtime doesn't provide. So we build the cheap, high-value tier
now and treat the emulator tier as a CI/cloud concern.

## The gap today

The Android app (`android/`) builds **only** in GitHub Actions
(`.github/workflows/android.yml`, manual `workflow_dispatch`: JDK 17 +
`android-actions/setup-android` + Gradle 8.7). Inside a session container the agent has **no Java,
no Android SDK, no Gradle**, so when it edits Kotlin/XML under `android/` it cannot:

- compile (`assembleDebug`) — so a typo or bad API reference ships unverified,
- run `lint` — so resource/manifest/inset regressions go uncaught,
- run unit or snapshot tests — so behavior and **layout** changes are unverifiable,
- screenshot the result — so UI work (the API-35 edge-to-edge bump) is **truly blind**.

The web side has a tight loop (preview pane + Playwright browser tools). The Android side has
nothing equivalent. This doc closes the *build/test* half of that gap. A user-facing *live
preview* of the Android app is explicitly **out of scope** (see "Future work").

## Container reality check (measured, this session)

| Capability | State in the session container | Consequence |
|---|---|---|
| `/dev/kvm` | **absent** (`ls /dev/kvm` → No such file or directory; no `vmx`/`svm` exposed) | No hardware-accelerated emulator. Instrumented/live-screenshot tier is **out** in-container. |
| JDK | **absent** (`java` not on PATH) | Must be installed before any Gradle invocation. |
| Gradle | **absent** + **no committed wrapper** (`android/gradlew` and `gradle/wrapper/` do not exist) | CI leans on `gradle/actions/setup-gradle`; in-container we must install Gradle 8.7 *or* (better) commit the wrapper. |
| Memory | ShipIt's own `shipit.yaml` declares `agent.memory: 6144`; host ~15 GiB | A Gradle build with `-Xmx2g` (current `gradle.properties`) fits, but competes with lint/typecheck/agent. Headroom is adequate, not generous. |
| Disk | `/workspace` 150 GB, ~34 GB free | SDK (~1–1.5 GB) + Gradle caches + first-build Maven deps (~1–2 GB) fit comfortably. |

The KVM absence is the load-bearing fact: it cleanly partitions the work into "headless = yes,
emulator = no (in-container)".

## Two tiers

### Tier A — headless (SDK + JDK only, no emulator) — **viable now**

Everything here runs on the JVM with only the SDK installed:

- **`gradle :app:assembleDebug`** — full compile + resource processing + APK packaging. The
  strongest "did I break the build?" signal. No device needed.
- **`gradle :app:lint`** — Android Lint: manifest, resource, accessibility, and **inset/edge-to-edge**
  checks (e.g. `EdgeToEdge`/`VisibleForTesting` style lints). Directly relevant to the API-35 work.
- **JVM unit tests** (`gradle :app:testDebugUnitTest`) — plain JUnit over pure-Kotlin logic
  (`Prefs`, URL validation in `SettingsActivity.validate()`, `isTailnetHost()`). The wrapper has
  real testable logic here today and **zero tests**.
- **Robolectric** — runs Android-framework-dependent unit tests on the JVM (no emulator) by
  providing a sandboxed Android runtime. Good for testing `Activity`/`Intent`/`SharedPreferences`
  behavior. Moderate add (a test dependency + `testOptions { unitTests.isIncludeAndroidResources = true }`).
- **Paparazzi** — **the key UI capability.** Renders Android Views/layouts via `layoutlib`
  **on the JVM**, captures a PNG, and diffs it against a committed golden. **No emulator, no
  `/dev/kvm`.** This is how the agent can verify that an edge-to-edge/inset change actually moves
  the WebView/cog the way it intended, and attach a real screenshot to the PR. Paparazzi tracks
  AGP closely; the repo is on **AGP 8.5.2 / Kotlin 1.9.24 / Gradle 8.7 / compileSdk 34**, which a
  current Paparazzi release supports (Paparazzi 1.3.x line targets the AGP 8.4–8.5 range). Pin
  Paparazzi to a version matched to the AGP in use and bump them together — an AGP change is the
  usual thing that breaks/fixes Paparazzi renders.

Caveat for Paparazzi here: the wrapper's main surface is a **`WebView`**, which `layoutlib`
does **not** render (no live web engine). Paparazzi's value is for the **chrome around** the
WebView — the settings cog overlay, insets/system-bar padding, the settings screen layout — which
is exactly the surface the API-35 edge-to-edge change touches. Snapshot the container layout and
the system-bar inset application, not the web content.

### Tier B — emulator / instrumented — **not in-container; CI/cloud only**

- **Instrumented tests** (`connectedAndroidTest`, Espresso/UIAutomator) and **live full-app
  screenshots** (including rendered WebView content) require a running Android OS = an emulator
  (or physical device). The emulator needs KVM for usable speed; software/swiftshader mode is too
  slow and still wants graphics shims. **No `/dev/kvm` → not viable in the session container.**
- **Options that exist, all outside the container:**
  - **Gradle Managed Devices (GMD)** — declarative emulator definitions Gradle spins up for
    `connectedCheck`. Still needs a **KVM-capable runner**; works on bare-metal/nested-virt CI
    (e.g. larger Linux GitHub runners with KVM), not on a non-virt container host.
  - **Firebase Test Lab / cloud device farm** — real/virtual devices in the cloud; the build
    happens in CI, tests run remotely, screenshots come back as artifacts. The realistic path if
    instrumented coverage is ever wanted.
  - **Containerized Android (Redroid) / emulator-in-container scripts** — exist, but are heavy,
    fragile, and still effectively want hardware accel or a separate VM. Not recommended for the
    ShipIt agent loop.

Be explicit with the user: **the agent will not run the app on a screen in-container.** That is the
*preview* problem, deferred (see Future work). What the agent *can* do is compile, lint,
unit/Robolectric-test, and **Paparazzi-snapshot the layout** — enough to stop editing blind.

## Where the toolchain should live

The agent runs in the **session-worker image** (fixed per deploy; not swappable per repo). So the
SDK must reach that container one of three ways:

| Option | How | Cost / re-run behavior | Verdict |
|---|---|---|---|
| **A. `agent.install` in ShipIt's `shipit.yaml`** (install SDK to `/workspace/.android-sdk`, gitignored) | A setup step downloads cmdline-tools + accepts licenses + `sdkmanager` installs platform/build-tools; JDK 17 via download or apt | First install ~3–8 min, ~1–1.5 GB. **Scoped to the ShipIt repo only.** Persists across idle-resume on the workspace volume; re-downloads only on a true cold re-clone. `agent.install`'s content-keyed skip won't recognize an SDK install command, so it falls back to commit-only skip — acceptable since the SDK dir itself persists. | **Recommended.** No image bloat for unrelated sessions; self-contained; git-revertable. |
| **B. Bake into `Dockerfile.session-worker.*`** | Add JDK + SDK layers to the worker image | Instant availability, no per-session download. **But adds ~1.5+ GB to an image every session pulls/runs**, penalizing the ~99% of sessions that never touch Android. | **Rejected.** Violates "don't tax every session for one repo's need." |
| **C. `docker/agent-cli`-style pinned layer** | Same as B, just organized differently | Same image-bloat problem as B | **Rejected** for the same reason. |
| **D. Dedicated Compose build service with a prebuilt android-sdk image** | A service mounts `/workspace` and runs builds | The **agent runs in the agent container, not the service**, and orchestrator↔container is HTTP-only (no `docker exec`). The agent can't easily drive a one-shot build in another container. | **Rejected** for the agent loop (good fit only for a future *preview* service). |

**Chosen: Option A.** It keeps the cost on the one repo that needs it, survives the common
idle/resume path, and is a pure `shipit.yaml` + script change with no platform image change. The
honest downside — a cold re-clone re-downloads the SDK — is a few minutes amortized against a warm
SDK dir most of the time, and is far cheaper than taxing every session's image pull.

### Concrete Phase-1 install shape (illustrative, not yet wired)

```yaml
# shipit.yaml (ShipIt's own repo) — append to agent.install
agent:
  install:
    - npm install
    - bash android/scripts/install-sdk.sh   # idempotent: skips if /workspace/.android-sdk is populated
```

`install-sdk.sh` (sketch): install Temurin JDK 17 → fetch cmdline-tools → set
`ANDROID_SDK_ROOT=/workspace/.android-sdk` → `sdkmanager --licenses` →
`sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"`. Add `.android-sdk/` to
`.gitignore`. Export `ANDROID_SDK_ROOT`/`JAVA_HOME` for the agent (the skill/docs tell the agent to
source them). Commit the **Gradle wrapper** (`gradlew` + `gradle/wrapper/`) pinned to 8.7 so builds
don't need a network `gradle` install — this also fixes a latent gap (doc 116 claimed the wrapper
was committed; it is not).

Only wire this up for real once the team confirms the cold-install cost is acceptable; this doc
recommends it but does not implement it (per the session brief).

## Agent surfacing

The agent must *discover* this capability the moment a task touches `android/`:

1. **A `src/server/shipit-docs/` entry** (e.g. `android.md`) — baked into the session image at
   `/shipit-docs/android.md`. Documents: the headless commands (`assembleDebug`, `lint`,
   `testDebugUnitTest`, Paparazzi `recordPaparazziDebug`/`verifyPaparazziDebug`), where the SDK is
   (`ANDROID_SDK_ROOT=/workspace/.android-sdk`), the **emulator ceiling** (no in-container device —
   don't try to launch one), and that *live app preview is not available*. This is the agent's
   primary reference and matches how every other platform capability is documented.
2. **A `.claude/skills/android-build` skill** — discloses by description ("build/test/snapshot the
   Android wrapper in `android/`") and loads only when the task matches. Per
   `docs/209-cross-agent-skill-disclosure`, both Claude and Codex auto-disclose the same
   `.claude/skills/`, so one skill covers both backends. The skill carries the step-by-step loop:
   set env → `assembleDebug` → `lint` → run/record Paparazzi → read the golden PNG diff → attach to
   PR. Always-on invariants (e.g. "never try to start an emulator in-container") can also be a one
   liner in the docs; the procedural detail belongs in the skill.

## Phased plan

- **Phase 0 (prereq, cheap):** Commit the Gradle wrapper (8.7) under `android/`; add `.android-sdk/`
  to `.gitignore`. No toolchain yet — just removes the wrapper gap and the network-`gradle`
  dependency.
- **Phase 1 (headless build/lint/unit):** `install-sdk.sh` + `agent.install` wiring; verify
  `assembleDebug` + `lint` + a first JVM unit test (e.g. for `isTailnetHost()`/URL validation) run
  green in-container. Ship the `shipit-docs/android.md` + skill.
- **Phase 2 (headless UI snapshots):** Add Paparazzi (pinned to the AGP), write the first golden for
  the settings-cog overlay + system-bar insets, optionally add Robolectric. This is the piece that
  lets the agent *see* edge-to-edge changes.
- **Phase 3 (emulator, CI/cloud only):** If instrumented coverage is ever needed, add a GMD job on a
  KVM-capable CI runner or a Firebase Test Lab job — **not** in the session container. Surface
  results as PR artifacts so they still land inside ShipIt.

## Relationship to other work

- **Unblocks the API-35 edge-to-edge bump (sibling session, currently blind).** Phase 1 lets that
  session at least compile and lint its `targetSdk`/`compileSdk` 35 change in-container; Phase 2
  (Paparazzi) lets it verify the inset/system-bar handling visually instead of guessing. Sequencing
  Phase 1 + a minimal Paparazzi golden ahead of (or alongside) that bump is high-leverage.
- **SHI-53** tracks the Android **WebView wrapper** feature (doc 116). This doc is a **distinct
  concern** — the agent's *build/test toolchain*, not the app itself — so it gets its **own tracker
  item** rather than piling onto SHI-53. The two are linked by subject but have different lifecycles.

## Future work (explicitly deferred — do NOT design now)

- **User-facing live Android preview** (render the running app for the user, like the web preview
  pane). This is the *preview* problem and is blocked by the same KVM ceiling for a real emulator;
  alternatives (cloud-streamed device, Redroid) are heavy and out of scope here. No dedicated
  tracker item exists yet; if pursued, it is a new doc + issue, related to SHI-53 but separate from
  this one. **Noted as future work only.**

## Risks / open questions

- **Cold-re-clone re-download.** Option A re-fetches the SDK on a true cold re-clone (workspace
  volume gone). Mitigation: keep the install idempotent and fast (warm `/dep-cache`-style reuse is
  npm-only today; the SDK download has no shared cache unless we add one). Acceptable; flag if cold
  re-clones turn out to be frequent for this repo.
- **Paparazzi ↔ AGP coupling.** Any AGP bump can break Paparazzi renders. Pin both and bump together;
  the Paparazzi `verify` task is itself the canary.
- **WebView not renderable by layoutlib.** Paparazzi covers the chrome/insets, not web content — set
  expectations so the agent doesn't try to snapshot the chat UI through the wrapper.
- **Memory contention.** A Gradle build (`-Xmx2g`) alongside the agent + lint/typecheck on a 6 GiB
  cap is feasible but not roomy; watch for OOM and consider a lower Gradle heap or bumping the cap
  for Android-heavy sessions.
- **JDK install method.** Temurin via download vs. apt (`openjdk-17-jdk`) — apt is simpler but the
  package isn't in the base image; downloading a known-good Temurin tarball into the workspace SDK
  root is the most self-contained. Decide in Phase 1.

## Key files (to touch when implemented — not yet changed)

- `shipit.yaml` — append the SDK install step to `agent.install`.
- `android/scripts/install-sdk.sh` — **new**, idempotent JDK 17 + SDK installer to `/workspace/.android-sdk`.
- `android/gradlew`, `android/gradle/wrapper/*` — **new**, commit the pinned 8.7 wrapper (Phase 0).
- `android/app/build.gradle.kts` — add Paparazzi/Robolectric plugins+deps (Phase 2); `compileSdk`/`targetSdk` 35 lands via the sibling API-35 work.
- `.gitignore` — add `android/.android-sdk/` (and keep `android/.paparazzi/` failure diffs out of commits as appropriate).
- `src/server/shipit-docs/android.md` — **new**, agent-facing build/test reference.
- `.claude/skills/android-build/SKILL.md` — **new**, the build/test/snapshot loop skill.
- `.github/workflows/android.yml` — unchanged for Phase 1–2; a GMD/Firebase job is a Phase 3 addition.
</content>
</invoke>
