---
name: android-build
description: "Build, test, debug, and preview Android apps inside a ShipIt session. Load when a task touches an Android/Gradle project (Kotlin/Java, build.gradle(.kts), AndroidManifest.xml, res/ layouts, Compose UI). Covers the baked toolchain (JDK/SDK/Gradle), the build → lint → snapshot-test loop, reading snapshot PNG diffs, on-demand SDK installs, and the emulator-as-Compose-service for a live device over adb."
user-invocable: true
---

# Android build, test & preview

The Android toolchain is **baked into every session container** — JDK 17, the
Android SDK, and Gradle 8.7 are always on `PATH`. A repo declares **nothing** to
build (no `shipit.yaml` Android fields). Full command reference and env paths:
**`/shipit-docs/android.md`** — read it for anything not covered here.

There are two surfaces: **headless** (build/lint/test/snapshot — this container,
no device) and **a running app** (an emulator Compose service over `adb`).

## Find the Gradle root first

Run Gradle from the dir with `settings.gradle(.kts)` + `gradlew`. In a monorepo
(web app + an `android/` module) just `cd` into it. If there are several Android
app modules, flavors, or Gradle roots, list them and pick — or ask the user which
to target. Don't guess off stray `.gradle` files.

```bash
cd android
./gradlew projects        # modules
./gradlew tasks --all     # available tasks (snapshot task names vary by library/variant)
```

## The core loop: build → lint → snapshot

```bash
./gradlew assembleDebug   # did I break the build?
./gradlew lint            # manifest/resource/accessibility + edge-to-edge/inset checks
./gradlew test            # JVM unit tests (+ Robolectric if used)
```

Prefer the committed `./gradlew` (pins the Gradle version). It downloads its dist
once per fresh container; run the baked `gradle` to skip that if needed.

**Reading the output is most of debugging** — compile errors, lint findings, and
test stack traces are in the command output. Fix the root cause from them.

## "Did my UI/inset/padding change render right?" → a snapshot test

This is the key habit: **visual verification is a snapshot test, not a
screenshot of a running app.** Snapshot tests (Paparazzi via `layoutlib`,
Roborazzi via Robolectric) render a screen to a PNG on the JVM with **no
device**, and the test sets up the data it renders — then diffs against a
committed golden.

```bash
./gradlew verifyPaparazziDebug    # check renders against goldens (or verifyRoborazziDebug)
./gradlew recordPaparazziDebug    # regenerate goldens after an intended visual change
```

Loop when you touch UI:

1. `verify…` → on failure it writes a **diff PNG** under the module's `build/`
   (e.g. `build/paparazzi/failures/`).
2. **Read the diff PNG, and `present` it to the user** (see
   `/shipit-docs/present.md`) so they see before/after with no device.
3. Intended change → `record…` to update the golden, and commit it.

If the repo has **no** snapshot tests and you're changing UI, adding a small one
for the affected screen is how you make the change verifiable. Pin the snapshot
library to the repo's AGP. (`layoutlib` can't render a `WebView` — cover native
chrome instead.)

## Missing SDK component?

A build that needs an off-matrix `compileSdk`, an NDK, or CMake fails with a
precise "missing package" error. Install exactly what it names and re-run — these
are ephemeral (re-installed on demand after a restart):

```bash
sdkmanager --install "platforms;android-33"
sdkmanager --install "ndk;26.1.10909125"
```

## Want a live device? Add an emulator Compose service

For runtime logs, touch interaction, or an interactive preview, add an emulator
to `docker-compose.yml` (needs `/dev/kvm` on the host) — the recipe and the full
`adb` debug/drive triad (`logcat`, `uiautomator dump` = snapshot, `input tap` =
press, `screencap` = screenshot, the Playwright-tools analog) are in
**`/shipit-docs/android.md`**. Its web UI becomes the interactive preview via
`x-shipit-preview`. No host KVM → Firebase Test Lab for batch test runs.

## Don't

- Don't add Android fields to `shipit.yaml` — the toolchain is ambient; there are
  none.
- Don't reach for the emulator to check a layout — a snapshot test is faster,
  deterministic, and needs no KVM.
- Don't run repo-root Gradle in a monorepo — scope to the Android module's dir so
  the web build is untouched.
