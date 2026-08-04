# android-overlay-test

A **standalone native Android app** that deliberately targets an Android SDK
platform **not baked** into the session image, to validate ShipIt's on-demand
SDK **overlay** — the "a build needs a component the base lacks; provision it and
retry" path from `docs/213-agent-android-build/plan.md`.

The baked image ships `android-34` and `android-35` (build-tools `34.0.0`/`35.0.0`).
This app sets `compileSdk = 33`, which the base lacks on purpose. It uses **only
the `android.*` framework (no androidx)** — an AndroidX artifact compiled against
API 34 would force `compileSdk 34` and defeat the off-matrix exercise.

> Do **not** bump `compileSdk` to a baked level. The off-matrix value *is* the test.

## What it proves

Verified in a fresh session on the rebuilt image — there are two outcomes, both good:

### 1. AGP SDK auto-download (the default) — self-heals with no agent step

```bash
./gradlew :app:assembleDebug
# BUILD SUCCESSFUL — AGP fetched platforms;android-33 itself.
```

The baked image pre-accepts SDK licenses and makes the SDK dirs writable, so
AGP's built-in SDK auto-download provisions the missing platform transparently
at build time. The common "off-matrix compileSdk" case needs **zero** manual work.

### 2. Explicit `sdkmanager` remediation — the fallback / NDK path

For components AGP does **not** auto-fetch (NDK, CMake), or when auto-download is
disabled, the agent provisions the exact missing component and retries:

```bash
./gradlew :app:assembleDebug -Pandroid.builder.sdkDownload=false
# FAILURE: Failed to find target with hash string 'android-33' in: /opt/android-sdk

sdkmanager "platforms;android-33"      # install exactly what's missing
./gradlew :app:assembleDebug -Pandroid.builder.sdkDownload=false
# BUILD SUCCESSFUL — app/build/outputs/apk/debug/app-debug.apk
```

## Caveat — provisioning is not yet persistent

On-demand installs land in the container's writable layer (over the read-only
baked SDK). They are **re-fetched after a container restart**. A persistent
per-session SDK overlay is tracked as future work (see the docs/213 checklist).

## Toolchain

AGP 8.5.2 · Kotlin 2.0.21 · Gradle 8.7 (own committed wrapper). Separate Gradle
root from `android/` and `android-snapshot-test/`; Node tooling ignores it; build
artifacts are gitignored at the repo root.
