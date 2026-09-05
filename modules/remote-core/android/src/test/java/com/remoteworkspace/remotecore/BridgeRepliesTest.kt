package com.remoteworkspace.remotecore

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class BridgeRepliesTest {
  @Test
  fun closeFailsAllWaitersAndRejectsNewRequests() {
    val replies = BridgeReplies()
    val first = replies.add("one")
    val second = replies.add("two")
    val error = BridgeClosedException()

    assertTrue(replies.close(error))
    assertFalse(replies.close(BridgeTimeoutException("late timeout")))
    for (future in listOf(first, second)) {
      assertSame(error, assertThrows(ExecutionException::class.java) { future.get(1, TimeUnit.SECONDS) }.cause)
    }
    assertSame(error, assertThrows(BridgeClosedException::class.java) { replies.add("three") })
  }

  @Test
  fun responseCompletesOnlyItsOwnRequestAndRejectsDuplicateIds() {
    val replies = BridgeReplies()
    val first = replies.add("one")
    val second = replies.add("two")
    assertThrows(HerdrBridgeException::class.java) { replies.add("one") }
    replies.complete("one", "response")
    assertEquals("response", first.get(1, TimeUnit.SECONDS))
    assertFalse(second.isDone)
    replies.close(BridgeClosedException())
  }

  @Test
  fun delayedOldResponseCannotCompleteNewBridge() {
    val old = BridgeReplies()
    old.add("request")
    old.close(BridgeClosedException())
    val replacement = BridgeReplies()
    val response = replacement.add("request")
    old.complete("request", "old")
    assertFalse(response.isDone)
    replacement.complete("request", "new")
    assertEquals("new", response.get(1, TimeUnit.SECONDS))
  }

  @Test
  fun distinguishesTimeoutClosureAndExistingNativeFailures() {
    assertEquals(
      "ERR_BRIDGE_TIMEOUT",
      bridgeFailure(java.util.concurrent.TimeoutException(), "request timeout").code,
    )
    assertEquals("ERR_BRIDGE_CLOSED", bridgeFailure(IOException("EOF"), "timeout").code)
    val auth = AuthenticationException()
    assertSame(auth, bridgeFailure(ExecutionException(auth), "timeout"))
    val hostKey = HostKeyMismatchException("SHA256:changed")
    assertSame(hostKey, bridgeFailure(ExecutionException(hostKey), "timeout"))
  }
}
