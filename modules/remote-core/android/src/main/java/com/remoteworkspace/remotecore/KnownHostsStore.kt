package com.remoteworkspace.remotecore

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class KnownHostsStore(context: Context) {
  private val file = File(context.filesDir, "known_hosts.json")
  private val lock = Any()

  fun fingerprintFor(hostname: String, port: Int): String? {
    synchronized(lock) {
      return entries().firstOrNull { it.hostname == hostname && it.port == port }?.fingerprint
    }
  }

  fun trust(hostname: String, port: Int, fingerprint: String) {
    synchronized(lock) {
      val next = entries().filterNot { it.hostname == hostname && it.port == port }.toMutableList()
      next.add(Entry(hostname, port, fingerprint))
      write(next)
    }
  }

  fun remove(hostname: String, port: Int) {
    synchronized(lock) {
      write(entries().filterNot { it.hostname == hostname && it.port == port })
    }
  }

  fun list(): List<Map<String, Any>> {
    synchronized(lock) {
      return entries().map {
        mapOf(
          "hostname" to it.hostname,
          "port" to it.port,
          "fingerprint" to it.fingerprint,
        )
      }
    }
  }

  private data class Entry(val hostname: String, val port: Int, val fingerprint: String)

  private fun entries(): List<Entry> {
    if (!file.exists()) {
      return emptyList()
    }
    return try {
      val array = JSONArray(file.readText())
      buildList {
        for (i in 0 until array.length()) {
          val obj = array.getJSONObject(i)
          add(
            Entry(
              hostname = obj.getString("hostname"),
              port = obj.getInt("port"),
              fingerprint = obj.getString("fingerprint"),
            ),
          )
        }
      }
    } catch (_: Exception) {
      emptyList()
    }
  }

  private fun write(entries: List<Entry>) {
    val array = JSONArray()
    entries.forEach { entry ->
      array.put(
        JSONObject()
          .put("hostname", entry.hostname)
          .put("port", entry.port)
          .put("fingerprint", entry.fingerprint),
      )
    }
    file.writeText(array.toString())
  }
}
