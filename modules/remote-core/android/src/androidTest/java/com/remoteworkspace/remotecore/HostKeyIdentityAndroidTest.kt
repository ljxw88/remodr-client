package com.remoteworkspace.remotecore

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyPairGenerator
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class HostKeyIdentityAndroidTest {
  @Test
  fun forwardedConnectionsPinTheDestinationNotEphemeralLoopbackPort() {
    val store = KnownHostsStore(InstrumentationRegistry.getInstrumentation().targetContext)
    val hostname = "jump-test-${UUID.randomUUID()}.invalid"
    val key = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair().public
    val fingerprint = sshSha256Fingerprint(key)
    try {
      val untrusted = AppHostKeyVerifier(store, hostname, 22, null)
      assertThrows(HostKeyUnknownException::class.java) { untrusted.verify("127.0.0.1", 45123, key) }
      assertTrue(AppHostKeyVerifier(store, hostname, 22, fingerprint).verify("127.0.0.1", 45123, key))
      assertEquals(fingerprint, store.fingerprintFor(hostname, 22))
      assertNull(store.fingerprintFor("127.0.0.1", 45123))
      assertTrue(AppHostKeyVerifier(store, hostname, 22, null).verify("127.0.0.1", 49123, key))
      val changed = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair().public
      assertThrows(HostKeyMismatchException::class.java) {
        AppHostKeyVerifier(store, hostname, 22, null).verify("127.0.0.1", 49123, changed)
      }
    } finally {
      store.remove(hostname, 22)
    }
  }
}
