package com.remoteworkspace.remotecore

import net.schmizz.sshj.common.SecurityUtils
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Security
import javax.crypto.KeyAgreement

object CryptoProvider {
  @Synchronized
  fun ensureInstalled() {
    if (!supportsX25519()) {
      // Android's provider is also named BC, but it is a stripped implementation.
      Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
      Security.addProvider(BouncyCastleProvider())
    }

    try {
      SecurityUtils.setSecurityProvider(BouncyCastleProvider.PROVIDER_NAME)
      KeyAgreement.getInstance("X25519", BouncyCastleProvider.PROVIDER_NAME)
      KeyFactory.getInstance("X25519", BouncyCastleProvider.PROVIDER_NAME)
      KeyPairGenerator.getInstance("X25519", BouncyCastleProvider.PROVIDER_NAME)
    } catch (_: Exception) {
      throw CryptoProviderException()
    }
  }

  private fun supportsX25519(): Boolean {
    val provider = Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) ?: return false
    return runCatching {
      KeyAgreement.getInstance("X25519", provider)
      KeyFactory.getInstance("X25519", provider)
      KeyPairGenerator.getInstance("X25519", provider)
    }.isSuccess
  }
}
