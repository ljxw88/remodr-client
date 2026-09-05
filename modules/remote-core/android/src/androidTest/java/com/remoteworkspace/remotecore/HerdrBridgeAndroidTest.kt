package com.remoteworkspace.remotecore

import androidx.test.ext.junit.runners.AndroidJUnit4
import net.schmizz.sshj.connection.channel.direct.Session
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class HerdrBridgeAndroidTest {
  @Test
  fun eofReleasesPendingWaitAndEmitsOnlyOneTransportClosedEvent() {
    val executor = Executors.newCachedThreadPool()
    val input = PipedInputStream()
    val remote = PipedOutputStream(input)
    val wrote = CountDownLatch(1)
    val closed = CountDownLatch(1)
    val output = object : ByteArrayOutputStream() {
      override fun flush() {
        wrote.countDown()
      }
    }
    val command = Proxy.newProxyInstance(
      Session.Command::class.java.classLoader, arrayOf(Session.Command::class.java),
    ) { _, method, _ ->
      when (method.name) {
        "getInputStream" -> input
        "getErrorStream" -> ByteArrayInputStream(byteArrayOf())
        "getOutputStream" -> output
        "close" -> { input.close(); null }
        "isOpen" -> true
        else -> null
      }
    } as Session.Command
    val session = Proxy.newProxyInstance(
      Session::class.java.classLoader, arrayOf(Session::class.java),
    ) { _, _, _ -> null } as Session
    val events = java.util.concurrent.CopyOnWriteArrayList<String>()
    val bridge = HerdrBridgeSession(
      "old-bridge", "ssh", session, command, executor,
      { id, message ->
        assertEquals("old-bridge", id)
        events += message
        closed.countDown()
      },
      {},
    )
    try {
      remote.write("""{"type":"hello"}${"\n"}""".toByteArray())
      assertEquals("hello", JSONObject(bridge.start()).getString("type"))
      val request = executor.submit<String> { bridge.request("""{"id":"request","type":"request"}""") }
      assertTrue(wrote.await(2, TimeUnit.SECONDS))
      remote.close()
      val error = assertThrows(ExecutionException::class.java) { request.get(2, TimeUnit.SECONDS) }
      assertTrue(error.cause is BridgeClosedException)
      assertTrue(closed.await(2, TimeUnit.SECONDS))
      bridge.close()
      assertEquals(1, events.size)
      val event = JSONObject(events.single())
      assertEquals("connection.closed", event.getString("event"))
      assertEquals("ERR_BRIDGE_CLOSED", event.getJSONObject("data").getString("code"))
    } finally {
      bridge.close()
      remote.close()
      executor.shutdown()
      assertTrue("Bridge readers leaked", executor.awaitTermination(5, TimeUnit.SECONDS))
    }
  }
}
