package com.remoteworkspace.remotecore

import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.keepalive.KeepAliveRunner
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import org.junit.Assert.*
import org.junit.Test

class SshPolicyTest {
  @Test
  fun closesSocketBeforeSshjGoodbyeCanBlock() {
    val closed = mutableListOf<String>()
    val socket = object : java.net.Socket() {
      override fun close() { closed += "socket" }
    }
    val client = object : SSHClient() {
      override fun getSocket() = socket
      override fun close() { closed += "client" }
    }
    closeSshClient(client)
    assertEquals(listOf("socket", "client"), closed)
  }

  @Test
  fun explicitlyReplacesSshjUnacknowledgedDefaultAtConstruction() {
    CryptoProvider.ensureInstalled()
    assertSame(KeepAliveProvider.HEARTBEAT, DefaultConfig().keepAliveProvider)
    resilientSshClient().use { client ->
      val keepAlive = client.connection.keepAlive
      assertTrue(keepAlive is KeepAliveRunner)
      assertEquals(10, keepAlive.keepAliveInterval)
      assertEquals(3, (keepAlive as KeepAliveRunner).maxAliveCount)
      assertEquals(15_000, client.connectTimeout)
      assertEquals(15_000, client.timeout)
    }
  }

  @Test
  fun disconnectedTransportIsNeverALiveCachedSession() {
    resilientSshClient().use { client ->
      val record = SessionRecord("session", "host", client, null, null)
      assertEquals("connected", record.status)
      assertFalse(record.isLive())
      val chain = JumpChain(listOf(client), emptyList())
      assertFalse(chain.isLive())
    }
  }
}
