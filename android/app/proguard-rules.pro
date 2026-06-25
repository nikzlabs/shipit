# Keep WebView JS bridge methods (none today, but reserved for future bridges).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Standard Kotlin metadata.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,RuntimeVisibleTypeAnnotations

# Google Tink (pulled in by androidx.security:security-crypto, used for the
# EncryptedSharedPreferences in Prefs) references compile-only annotations that
# aren't on the Android runtime classpath. R8 in full mode treats these missing
# references as hard errors, failing the release build (bundleRelease) with
# "Missing class javax.annotation.Nullable ... referenced from ...PrimitiveSet".
# These classes are only used at compile time, so it's safe to tell R8 not to
# warn about them. See https://github.com/tink-crypto/tink-java/issues/5 and the
# AGP "Missing classes detected while running R8" guidance.
-dontwarn javax.annotation.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn com.google.api.client.http.**
-dontwarn org.joda.time.**

# Beyond the missing-class warnings above, Tink loads its key-type managers
# reflectively at runtime, so R8 must not strip or rename them — otherwise the
# build succeeds but EncryptedSharedPreferences.create() crashes on first launch
# (saving the ShipIt URL is core functionality, so that would brick the app).
# Keep the Tink and androidx.security.crypto classes intact in release builds.
-keep class com.google.crypto.tink.** { *; }
-keep class androidx.security.crypto.** { *; }
