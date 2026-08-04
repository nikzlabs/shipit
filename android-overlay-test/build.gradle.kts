// Standalone native Android app that deliberately targets an SDK platform NOT
// baked into the session image (compileSdk 33; the image bakes only android-34
// and android-35). Its purpose is to exercise the on-demand per-session SDK
// *overlay*: the first build fails with a precise "missing platform" error, the
// agent (or ShipIt) installs exactly that component via sdkmanager, and the
// rebuild goes green. See docs/213-agent-android-build/plan.md (the overlay /
// "on-demand provisioning" path) and android-overlay-test/README.md.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
