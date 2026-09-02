package com.remoteworkspace.remotecore

import android.util.Base64
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import java.security.MessageDigest
import java.security.PublicKey

fun sshSha256Fingerprint(key: PublicKey): String {
  val type = KeyType.fromKey(key)
  val buffer = Buffer.PlainBuffer()
  type.putPubKeyIntoBuffer(key, buffer)
  val digest = MessageDigest.getInstance("SHA-256").digest(buffer.compactData)
  val encoded = Base64.encodeToString(digest, Base64.NO_WRAP).trimEnd('=')
  return "SHA256:$encoded"
}
