package com.remoteworkspace.remotecore

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

class SecretStore(context: Context) {
  private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
    "remote_workspace_credentials",
    MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
    context,
    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
  )

  fun save(id: String, secret: String) {
    prefs.edit().putString(id, secret).apply()
  }

  fun get(id: String): String? = prefs.getString(id, null)

  fun contains(id: String): Boolean = prefs.contains(id)

  fun delete(id: String) {
    prefs.edit().remove(id).apply()
  }
}
