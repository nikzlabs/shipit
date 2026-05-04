# Keep WebView JS bridge methods (none today, but reserved for future bridges).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Standard Kotlin metadata.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,RuntimeVisibleTypeAnnotations
