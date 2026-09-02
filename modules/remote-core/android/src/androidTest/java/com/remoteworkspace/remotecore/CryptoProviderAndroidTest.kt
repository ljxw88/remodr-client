package com.remoteworkspace.remotecore

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyFactory
import java.security.KeyPairGenerator
import javax.crypto.KeyAgreement

@RunWith(AndroidJUnit4::class)
class CryptoProviderAndroidTest {
  @Test
  fun replacesAndroidProviderWithX25519Support() {
    CryptoProvider.ensureInstalled()

    assertNotNull(KeyAgreement.getInstance("X25519", "BC"))
    assertNotNull(KeyFactory.getInstance("X25519", "BC"))
    assertNotNull(KeyPairGenerator.getInstance("X25519", "BC"))
  }
}
