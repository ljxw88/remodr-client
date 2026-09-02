package com.remoteworkspace.remotecore

import net.schmizz.sshj.transport.verification.HostKeyVerifier
import java.security.PublicKey

class AppHostKeyVerifier(
  private val store: KnownHostsStore,
  private val hostname: String,
  private val port: Int,
  private val acceptedFingerprint: String?,
) : HostKeyVerifier {
  var lastFingerprint: String? = null
    private set

  override fun verify(hostname: String, port: Int, key: PublicKey): Boolean {
    val fingerprint = sshSha256Fingerprint(key)
    lastFingerprint = fingerprint
    val stored = store.fingerprintFor(this.hostname, this.port)
      ?: store.fingerprintFor(hostname, port)
    if (stored == null) {
      if (acceptedFingerprint != null && acceptedFingerprint == fingerprint) {
        store.trust(hostname, port, fingerprint)
        return true
      }
      throw HostKeyUnknownException(fingerprint)
    }
    if (stored == fingerprint) {
      return true
    }
    throw HostKeyMismatchException(fingerprint)
  }

  override fun findExistingAlgorithms(hostname: String?, port: Int): MutableList<String> {
    return mutableListOf()
  }
}
