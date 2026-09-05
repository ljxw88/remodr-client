package com.remoteworkspace.remotecore

import java.util.concurrent.CompletableFuture

internal class BridgeReplies {
  private val pending = mutableMapOf<String, CompletableFuture<String>>()
  private var failure: Throwable? = null

  @Synchronized
  fun add(id: String): CompletableFuture<String> {
    failure?.let { throw it }
    if (pending.containsKey(id)) throw HerdrBridgeException("Duplicate in-flight bridge request")
    return CompletableFuture<String>().also { pending[id] = it }
  }

  @Synchronized
  fun complete(id: String, message: String) {
    pending.remove(id)?.complete(message)
  }

  @Synchronized
  fun remove(id: String) {
    pending.remove(id)
  }

  @Synchronized
  fun close(error: Throwable): Boolean {
    if (failure != null) return false
    failure = error
    pending.values.forEach { it.completeExceptionally(error) }
    pending.clear()
    return true
  }
}
