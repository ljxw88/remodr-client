package com.remoteworkspace.remotecore

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AttemptRegistryTest {
  private class Resource : AutoCloseable {
    var closed = false
    override fun close() { closed = true }
  }

  @Test
  fun olderAcquiredSessionCannotReplaceOrCloseLatestHostSession() {
    val registry = AttemptRegistry<String, Resource>(Any())
    val older = registry.begin("host")
    val newer = registry.begin("host")
    val latestSession = Resource()
    assertTrue(registry.publish(newer, latestSession))
    val staleAcquiredSession = Resource()
    if (!registry.publish(older, staleAcquiredSession)) staleAcquiredSession.close()
    assertTrue(staleAcquiredSession.closed)
    assertSame(latestSession, registry.current("host"))
    assertFalse(latestSession.closed)
  }

  @Test
  fun disconnectHostInvalidatesPendingAttemptEvenWithoutPublishedSession() {
    val registry = AttemptRegistry<String, Resource>(Any())
    val pending = registry.begin("host")
    assertNull(registry.invalidate("host"))
    assertFalse(registry.publish(pending, Resource()))
    assertNull(registry.current("host"))
    val replacement = registry.begin("host")
    assertTrue(registry.publish(replacement, Resource()))
  }

  @Test
  fun olderBridgeStartOnlyDetachesWhatExistedWhenItObtainedGeneration() {
    val registry = AttemptRegistry<String, Resource>(Any())
    val initial = Resource()
    assertTrue(registry.publish(registry.begin("ssh"), initial))
    val olderStart = registry.begin("ssh")
    assertSame(initial, olderStart.previous)
    val newerStart = registry.begin("ssh")
    assertNull(newerStart.previous)
    val newestBridge = Resource()
    assertTrue(registry.publish(newerStart, newestBridge))
    olderStart.previous!!.close()
    val obsoleteBridge = Resource()
    if (!registry.publish(olderStart, obsoleteBridge)) obsoleteBridge.close()
    assertTrue(initial.closed)
    assertTrue(obsoleteBridge.closed)
    assertSame(newestBridge, registry.current("ssh"))
    assertFalse(newestBridge.closed)
  }

  @Test
  fun delayedOldBridgeEofCannotInvalidateReplacement() {
    val registry = AttemptRegistry<String, Resource>(Any())
    val oldBridge = Resource()
    assertTrue(registry.publish(registry.begin("ssh"), oldBridge))
    val replacement = registry.begin("ssh")
    val newBridge = Resource()
    assertTrue(registry.publish(replacement, newBridge))
    assertFalse(registry.remove("ssh", oldBridge))
    assertTrue(registry.isCurrent(replacement, newBridge))
  }

  @Test
  fun detachedResourceCleanupDoesNotHoldPublicationLock() {
    val registry = AttemptRegistry<String, Resource>(Any())
    assertTrue(registry.publish(registry.begin("host"), Resource()))
    val detached = CountDownLatch(1)
    val permitCleanup = CountDownLatch(1)
    val executor = Executors.newSingleThreadExecutor()
    try {
      val cleanup = executor.submit {
        val attempt = registry.begin("host")
        detached.countDown()
        assertTrue(permitCleanup.await(3, TimeUnit.SECONDS))
        attempt.previous!!.close()
      }
      assertTrue(detached.await(3, TimeUnit.SECONDS))
      val latest = registry.begin("host")
      assertTrue(registry.publish(latest, Resource()))
      permitCleanup.countDown()
      cleanup.get(3, TimeUnit.SECONDS)
      assertFalse(registry.current("host")!!.closed)
    } finally {
      permitCleanup.countDown()
      executor.shutdownNow()
    }
  }

  @Test
  fun explicitStopInvalidatesPublishedAttemptWithoutAffectingOtherHost() {
    val registry = AttemptRegistry<String, Resource>(Any())
    val first = registry.begin("one")
    val second = registry.begin("two")
    val firstResource = Resource()
    val secondResource = Resource()
    assertTrue(registry.publish(first, firstResource))
    assertTrue(registry.publish(second, secondResource))
    assertTrue(registry.remove("one", firstResource))
    assertFalse(registry.isCurrent(first, firstResource))
    assertFalse(registry.publish(first, Resource()))
    assertTrue(registry.isCurrent(second, secondResource))
  }
}
