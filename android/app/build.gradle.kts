plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Single source of truth for the user-visible version: the root package.json
// (one level above the android/ Gradle root). Keeps the app-info "version"
// string in lockstep with the rest of the project instead of a hand-edited
// literal that silently goes stale. Parsed with a regex to avoid pulling a JSON
// dependency into the build classpath; falls back to "0.0.0" if the file is
// missing (e.g. the android/ dir built in isolation).
val projectVersionName: String = run {
    val packageJson = rootDir.parentFile?.resolve("package.json")
    val fallback = "0.0.0"
    if (packageJson?.exists() == true) {
        Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
            .find(packageJson.readText())
            ?.groupValues?.get(1)
            ?: fallback
    } else {
        fallback
    }
}

android {
    namespace = "com.shipit.wrapper"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.shipit.wrapper"
        minSdk = 26
        // API 35 (Android 15) is the minimum target Google Play accepts for new
        // submissions. Targeting 35 also opts the app into enforced edge-to-edge
        // — see MainActivity/SettingsActivity inset handling and themes.xml.
        targetSdk = 35
        // versionCode must strictly increase or Android refuses to install the
        // new APK over the old one (INSTALL_FAILED_VERSION_DOWNGRADE). Both CI
        // and local builds use the SAME scale — epoch seconds — so a newer build
        // always outranks an older one no matter where it was built (CI sets
        // ANDROID_VERSION_CODE to `date +%s`; see android.yml). Locally we fall
        // back to the same computation, so a hand-run `gradle assembleDebug`
        // also outranks whatever is on the device. Fits in an Int until 2038.
        versionCode = System.getenv("ANDROID_VERSION_CODE")?.toIntOrNull()
            ?: (System.currentTimeMillis() / 1000).toInt()
        // Read from the root package.json (see projectVersionName above) so the
        // app-info "version" tracks the project version automatically.
        versionName = projectVersionName
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            // Populated from environment variables in CI. Locally these will be
            // null and the release variant will fall back to the debug signing
            // config (which is fine — local debug installs only).
            val keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // Use the release signing config only when CI provided a keystore.
            // Otherwise fall through to the default (debug) signing so local
            // `gradle assembleRelease` doesn't error on missing credentials.
            val keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (keystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
