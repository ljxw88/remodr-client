package com.remoteworkspace.remotecore

internal class AttemptRegistry<K, V : Any>(private val lock: Any) {
  data class Attempt<K, V>(val key: K, val generation: Long, val previous: V?)
  private data class Slot<V>(var generation: Long = 0, var value: V? = null)
  private val slots = mutableMapOf<K, Slot<V>>()

  fun begin(key: K): Attempt<K, V> = synchronized(lock) {
    val slot = slots.getOrPut(key) { Slot() }
    Attempt(key, ++slot.generation, slot.value).also { slot.value = null }
  }

  fun publish(attempt: Attempt<K, V>, value: V): Boolean = synchronized(lock) {
    val slot = slots[attempt.key] ?: return@synchronized false
    if (slot.generation != attempt.generation || slot.value != null) return@synchronized false
    slot.value = value
    true
  }

  fun isCurrent(attempt: Attempt<K, V>, value: V): Boolean = synchronized(lock) {
    val slot = slots[attempt.key]
    slot != null && slot.generation == attempt.generation && slot.value === value
  }

  fun current(key: K): V? = synchronized(lock) { slots[key]?.value }

  fun invalidate(key: K): V? = begin(key).previous

  fun remove(key: K, value: V): Boolean = synchronized(lock) {
    val slot = slots[key] ?: return@synchronized false
    if (slot.value !== value) return@synchronized false
    ++slot.generation
    slot.value = null
    true
  }
}
