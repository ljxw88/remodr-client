package com.remoteworkspace.remotecore

import org.junit.Assert.assertNotNull
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Security
import javax.crypto.KeyAgreement

class CryptoProviderTest {
  @Test
  fun installsProviderWithX25519Support() {
    Security.removeProvider("BC")

    CryptoProvider.ensureInstalled()

    assertNotNull(KeyAgreement.getInstance("X25519", "BC"))
    assertNotNull(KeyFactory.getInstance("X25519", "BC"))
    assertNotNull(KeyPairGenerator.getInstance("X25519", "BC"))
  }
}
