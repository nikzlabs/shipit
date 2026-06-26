# Android — build, test & preview

ShipIt bakes an Android build toolchain into every session container, so you can
build, lint, and test any Android/Gradle repo **with no per-repo setup**. There
are **no Android-specific `shipit.yaml` fields** — the toolchain is always
present, the same way `git`, the agent CLIs, and Playwright are.

This page is the reference for working on Android in a session. The two surfaces:

1. **Headless** — the toolchain in *this* container. Compile, lint, run
   JVM/Robolectric tests, and render screens with **snapshot tests** (no device).
2. **A running app** — an emulator declared as a Compose service (needs host
   KVM), reached over `adb`. Its web UI is the interactive preview.

## What's baked in

| Tool | Location / env | Notes |
|---|---|---|
| **JDK 17** | `JAVA_HOME=/opt/java` (on `PATH`) | Covers AGP 8.x. `/opt/java` is a stable symlink (arch-independent). |
| **Android SDK** | `ANDROID_SDK_ROOT=/opt/android-sdk` (also `ANDROID_HOME`) | `cmdline-tools/latest` (`sdkmanager`), `platform-tools` (`adb`), platforms `android-34`+`android-35`, build-tools `34.0.0`+`35.0.0`. Licenses pre-accepted. |
| **Gradle 8.7** | `/opt/gradle/bin` (on `PATH`) | A baked fallback. Prefer the repo's `./gradlew` when it's committed. |

A repo's own Gradle/Maven dependencies still download per build — only the
platform toolchain is baked.

## Headless: build, lint, test

Run Gradle from the **Gradle project root** (the dir with `settings.gradle(.kts)`
+ the wrapper). In a monorepo (e.g. a web app plus an `android/` module), just
`cd` into that dir first — there's nothing to configure.

```bash
cd android                       # the Gradle root in this repo
./gradlew assembleDebug          # full compile + package — "did I break the build?"
./gradlew lint                   # manifest/resource/accessibility + edge-to-edge/inset checks
./gradlew test                   # JVM unit tests (+ Robolectric, if the repo uses it)
```

- **Prefer `./gradlew`** (the committed wrapper pins the exact Gradle version). It
  self-fetches its distribution on first run; that one-time download is lost when
  the container restarts. To skip it, run the baked **`gradle`** instead — it's
  8.7 on `PATH`.
- Builds are **path-scoped** to the module — run them from the Android dir so a
  monorepo's web build is untouched.

### Reading build output is most of debugging

Compile errors, lint findings, and test stack traces are right there in the
command output — read them and fix the root cause. The headless toolchain never
*runs* the app, so anything that only appears while code executes (lifecycle,
threading, runtime exceptions) needs the running-app surface below.

## Visual verification = snapshot tests

**"Did my padding/inset/layout change render right?"** is answered by a
**snapshot test** — not a screenshot of a running app. Snapshot tests render a
screen to a PNG on the JVM with **no device**, and the test itself sets up the
data it renders (realistic state, specific window insets, locale, theme), then
diffs against a committed golden image.

Two mature libraries, both headless on the baked toolchain:

- **Paparazzi** — renders Views and Compose `@Preview`s via `layoutlib`.
- **Roborazzi** — renders via Robolectric.

```bash
# Paparazzi (task names follow the variant, e.g. ...Debug):
./gradlew verifyPaparazziDebug   # check current renders against committed goldens
./gradlew recordPaparazziDebug   # regenerate goldens after an intended visual change

# Roborazzi:
./gradlew verifyRoborazziDebug
./gradlew recordRoborazziDebug
```

Workflow when you change UI:

1. Run `verify…`. A failure writes a **diff PNG** (e.g. under
   `<module>/build/paparazzi/failures/` or `…/outputs/roborazzi/`).
2. **Look at the diff** — read the failure PNG, and **surface it to the user with
   the `present` tool** (see `/shipit-docs/present.md`) so they can see the
   before/after without a device.
3. If the change is intended, run `record…` to update the golden and commit it.

If the repo has **no** snapshot tests yet and the change is visual, adding a
small Paparazzi/Roborazzi test for the affected screen is the right way to make
the change verifiable — pin the library to the repo's AGP and bump them together.
(`layoutlib` can't render a `WebView`, so a WebView-only screen isn't
snapshot-testable; cover the surrounding native chrome instead.)

## Static inspection (no device)

```bash
apkanalyzer apk summary app/build/outputs/apk/debug/app-debug.apk
aapt2 dump badging  app/build/outputs/apk/debug/app-debug.apk   # merged manifest, perms
```

`apkanalyzer` also dumps the resource table, DEX/method counts, and dependency
tree — useful for size/regression questions without running anything.

## On-demand SDK components

The baked SDK covers the common matrix above. If a build needs something else —
an off-matrix `compileSdk`, an NDK, CMake — Gradle fails with a precise "missing
package" error. Install exactly what it names, then re-run:

```bash
sdkmanager --list                          # what's installed / available
sdkmanager --install "platforms;android-33"
sdkmanager --install "ndk;26.1.10909125" "cmake;3.22.1"
```

On-demand installs land under `ANDROID_SDK_ROOT` and are **lost on container
restart** (only `/workspace` and `/persist` persist) — they're cheap to
re-install on demand. The JDK is 17; if a repo's AGP needs a different JDK, that's
a rare case — surface it to the user.

## The running app: emulator as a Compose service

For anything that needs a *live* Android OS — runtime logs, touch interaction,
the interactive preview — declare an **emulator as a Compose service** in
`docker-compose.yml`, the same primitive as any other preview. This needs
`/dev/kvm` on the **host** (hardware acceleration); without it the emulator is
too slow — fall back to a cloud device farm (below).

```yaml
# docker-compose.yml — add alongside any web preview services
services:
  emulator:
    image: budtmo/docker-android:emulator_14   # or an AOSP emulator-webrtc image
    devices: ["/dev/kvm:/dev/kvm"] # hardware accel (the platform allowlists exactly this mapping)
    ports: ["6080:6080"]           # the emulator's web UI — rendered in the preview pane
    expose: ["5555"]               # adb, reachable on the Compose network by service name
    x-shipit-preview: auto         # shows the web UI as the interactive preview
```

ShipIt reaches services by **service DNS on the Compose network** (host ports
aren't published), so connect adb by service name:

```bash
adb connect emulator:5555
adb devices
```

### Debug a running app

```bash
adb logcat                                   # crashes, exceptions, Log.* — read this first
adb install app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.example/.MainActivity
```

### Drive a running app — the Android analog of the browser tools

The `adb` triad mirrors `browser_snapshot` / `browser_click` /
`browser_take_screenshot`:

```bash
adb exec-out uiautomator dump /dev/tty       # SNAPSHOT: view hierarchy (resource-id/text/bounds)
adb shell input tap <x> <y>                  # PRESS: tap at coordinates from the dump
adb shell input text "hello"                 # type
adb shell input keyevent KEYCODE_BACK        # keys
adb exec-out screencap -p > /tmp/.shot.png   # SCREENSHOT (then surface with `present`)
```

For resilient flows without computing coordinates, **Maestro** (YAML: `tapOn`,
`takeScreenshot`, auto-wait) is a good optional layer.

### No KVM on the host?

Use **Firebase Test Lab** (or another device cloud): it runs instrumented / robo
tests in **batch** on real and virtual devices and returns logcat, screenshots,
and video. It's automated test execution, **not** a live interactive preview or
an `adb connect` target — but it covers regression validation and instrumented
tests (`connectedAndroidTest`, Espresso/UI Automator) where there's no local KVM.

## Network / blocked repositories

Session containers run behind a default-deny egress firewall. The common build
repositories are on the allowlist, so a standard build resolves fine:
**Maven Central** (`repo.maven.apache.org`, `repo1.maven.org`), **Google Maven**
(`dl.google.com`, `maven.google.com`), the **Gradle** distribution + plugin
portal (`*.gradle.org`), and **Sonatype** (`*.sonatype.org`).

If a build pulls from a repo that *isn't* on that list — **JitPack**
(`jitpack.io`), a private Nexus/Artifactory, a company mirror — Gradle fails at
resolution with `UnknownHostException` / "Could not resolve host". That's an
**egress** block, not a toolchain problem. The fix is to add the host to the
session's egress allowlist (Settings → Network, or the durable allowlist) — tell
the user which host is blocked and let them approve it; don't try to route around
the firewall.

## Quick reference

| Goal | Command |
|---|---|
| Build | `./gradlew assembleDebug` |
| Lint | `./gradlew lint` |
| Unit tests | `./gradlew test` |
| Visual check | `./gradlew verifyPaparazziDebug` → read/`present` the diff PNG |
| Update goldens | `./gradlew recordPaparazziDebug` |
| Inspect APK | `apkanalyzer apk summary <apk>` |
| Add an SDK package | `sdkmanager --install "<package>"` |
| Live device logs | `adb connect emulator:5555 && adb logcat` |
