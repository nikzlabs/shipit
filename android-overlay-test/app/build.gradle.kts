plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.shipit.overlaytest"
    // Deliberately OFF-matrix: the baked image ships android-34 and android-35
    // only. Building against 33 forces the on-demand overlay to provision
    // "platforms;android-33". Do NOT bump this to a baked level — that defeats
    // the whole point of the fixture.
    compileSdk = 33

    defaultConfig {
        applicationId = "com.shipit.overlaytest"
        minSdk = 24
        targetSdk = 33
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// No androidx dependencies on purpose: an AndroidX artifact compiled against
// API 34 would force compileSdk 34 and defeat the off-matrix (33) overlay
// exercise. This app uses only the android.* framework.
dependencies {
}
