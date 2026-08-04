// Standalone native Android app used to validate ShipIt's headless snapshot-test
// path (Paparazzi → layoutlib → PNG, no emulator). The android/ wrapper is a
// WebView shell that layoutlib cannot render, so it can't exercise this path;
// this module gives the platform a real Compose UI to render. See
// docs/213-agent-android-build/plan.md (Phase 2) and android-snapshot-test/README.md.
//
// Versions track Paparazzi's supported toolchain (AGP 8.5.2 / Kotlin 2.0.21),
// all compatible with the baked SDK (android-34, build-tools 34.0.0) and Gradle 8.7.
// Kotlin 2.0 moves the Compose compiler into its own plugin (kotlin.plugin.compose).
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("app.cash.paparazzi") version "1.3.5" apply false
}
