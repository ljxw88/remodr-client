package com.remoteworkspace.remotecore

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class BridgeDeploymentTest {
  private val directory = "/home/user/.local/share/remote-workspace"
  private val source = ByteArray(109679) { (it % 127).toByte() }

  @Test
  fun ignoresStaleLegacyMarkerAndRepairsTruncatedVersionByVerifyingBytes() {
    val store = MemoryStore()
    store.files["$directory/herdr_mobile_bridge.py"] = source.copyOf(32768)
    store.files["$directory/herdr_mobile_bridge.sha256"] = "current marker".toByteArray()
    val version = bridgeVersionPath(directory, source)
    store.files[version] = source.copyOf(32768)
    assertEquals(version, deployBridge(directory, source, store))
    assertArrayEquals(source, store.files[version])
    assertEquals(1, store.writes)
    assertEquals(version, deployBridge(directory, source, store))
    assertEquals(1, store.writes)
  }

  @Test
  fun interruptedStaleDeployerCannotDamageAlreadyPublishedVersion() {
    val store = MemoryStore()
    val staleChecked = CountDownLatch(1)
    val resumeStale = CountDownLatch(1)
    val stale = object : BridgeDeploymentStore by store {
      override fun matches(path: String, bytes: ByteArray): Boolean {
        val result = store.matches(path, bytes)
        if (path == bridgeVersionPath(directory, source)) {
          staleChecked.countDown()
          assertTrue(resumeStale.await(3, TimeUnit.SECONDS))
        }
        return result
      }
      override fun writeExclusive(path: String, bytes: ByteArray) {
        store.files[path] = bytes.copyOf(32768)
        throw IOException("SSH disconnected during upload")
      }
    }
    val executor = Executors.newSingleThreadExecutor()
    try {
      val interrupted = executor.submit {
        assertThrows(IOException::class.java) { deployBridge(directory, source, stale) }
      }
      assertTrue(staleChecked.await(3, TimeUnit.SECONDS))
      val launched = deployBridge(directory, source, store)
      resumeStale.countDown()
      interrupted.get(3, TimeUnit.SECONDS)
      assertArrayEquals(source, store.files[launched])
      assertEquals(launched, deployBridge(directory, source, store))
      assertFalse(store.files.keys.any { it.endsWith(".upload.py") })
    } finally {
      resumeStale.countDown()
      executor.shutdownNow()
    }
  }

  @Test
  fun differentVersionsKeepTheirExactLaunchContents() {
    val store = MemoryStore()
    val first = deployBridge(directory, source, store)
    val otherSource = "different release".toByteArray()
    val second = deployBridge(directory, otherSource, store)
    assertNotEquals(first, second)
    assertArrayEquals(source, store.files[first])
    assertArrayEquals(otherSource, store.files[second])
  }

  @Test
  fun serversWithoutAtomicRenameOnlyLaunchUniqueVerifiedUploads() {
    val store = MemoryStore(atomicRename = false)
    val first = deployBridge(directory, source, store)
    val second = deployBridge(directory, source, store)
    assertNotEquals(first, second)
    assertArrayEquals(source, store.files[first])
    assertArrayEquals(source, store.files[second])
    assertFalse(store.files.containsKey(bridgeVersionPath(directory, source)))
  }

  @Test
  fun corruptCompleteUploadIsNeverPublishedOrReturned() {
    val store = MemoryStore()
    val corrupt = object : BridgeDeploymentStore by store {
      override fun writeExclusive(path: String, bytes: ByteArray) {
        store.writeExclusive(path, bytes.copyOf().also { it[0] = (it[0] + 1).toByte() })
      }
    }
    assertThrows(HerdrBridgeException::class.java) { deployBridge(directory, source, corrupt) }
    assertTrue(store.files.isEmpty())
  }

  private class MemoryStore(private val atomicRename: Boolean = true) : BridgeDeploymentStore {
    val files = ConcurrentHashMap<String, ByteArray>()
    var writes = 0

    override fun matches(path: String, bytes: ByteArray) = files[path]?.contentEquals(bytes) == true
    override fun mkdirs(path: String) {}
    override fun writeExclusive(path: String, bytes: ByteArray) {
      check(files.putIfAbsent(path, bytes.copyOf()) == null)
      writes++
    }
    override fun publishAtomically(staging: String, destination: String): Boolean {
      if (!atomicRename) return false
      files[destination] = files.remove(staging)!!
      return true
    }
    override fun remove(path: String) { files.remove(path) }
  }
}
