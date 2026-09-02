package com.remoteworkspace.remotecore

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionResourcesTest {
  @Test
  fun closesForwardsBeforeClientsInReverseCreationOrder() {
    val closed = mutableListOf<String>()
    val chain = JumpChain(
      clients = listOf(closeable("client-1", closed), closeable("client-2", closed)),
      forwards = listOf(closeable("forward-1", closed), closeable("forward-2", closed)),
    )

    chain.close()

    assertEquals(
      listOf("forward-2", "forward-1", "client-2", "client-1"),
      closed,
    )
  }

  private fun closeable(name: String, closed: MutableList<String>) =
    AutoCloseable { closed += name }
}
