package com.shipit.wrapper

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Tiny wrapper around [EncryptedSharedPreferences] holding the single piece of
 * runtime config we need: the user's ShipIt host URL.
 *
 * We intentionally don't persist credentials here — those live in the WebView's
 * cookie store, which Android already encrypts at rest.
 */
class Prefs(context: Context) {
    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var shipitUrl: String?
        get() = prefs.getString(KEY_URL, null)?.takeIf { it.isNotBlank() }
        set(value) {
            prefs.edit().apply {
                if (value.isNullOrBlank()) remove(KEY_URL) else putString(KEY_URL, value)
            }.apply()
        }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val FILE_NAME = "shipit_prefs"
        private const val KEY_URL = "shipit_url"
    }
}
