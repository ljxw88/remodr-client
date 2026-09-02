package com.remoteworkspace.remotecore

import android.util.Log
import net.schmizz.sshj.connection.channel.direct.Session
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.OutputStreamWriter
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

class HerdrBridgeSession(
  val id: String,
  val sshSessionId: String,
  private val session: Session,
  private val command: Session.Command,
  private val executor: ExecutorService,
  private val onMessage: (String, String) -> Unit,
) {
  private val writer = BufferedWriter(OutputStreamWriter(command.outputStream, Charsets.UTF_8))
  private val hello = CompletableFuture<String>()
  private val pending = ConcurrentHashMap<String, CompletableFuture<String>>()
  @Volatile private var closed = false

  fun start(): String {
    executor.execute { readStdout() }
    executor.execute { readStderr() }
    return try {
      hello.get(15, TimeUnit.SECONDS)
    } catch (error: Exception) {
      close()
      throw HerdrBridgeException("Herdr bridge did not start", error)
    }
  }

  fun request(requestJson: String): String {
    if (closed) {
      throw HerdrBridgeException("Herdr bridge is closed")
    }
    val requestId = try {
      JSONObject(requestJson).getString("id")
    } catch (error: Exception) {
      throw HerdrBridgeException("Invalid bridge request", error)
    }
    val response = CompletableFuture<String>()
    pending[requestId] = response
    try {
      synchronized(writer) {
        writer.write(requestJson)
        writer.newLine()
        writer.flush()
      }
      return response.get(35, TimeUnit.SECONDS)
    } catch (error: Exception) {
      pending.remove(requestId)
      throw HerdrBridgeException("Herdr bridge request timed out", error)
    }
  }

  fun close() {
    if (closed) {
      return
    }
    closed = true
    val error = HerdrBridgeException("Herdr bridge closed")
    pending.values.forEach { it.completeExceptionally(error) }
    pending.clear()
    hello.completeExceptionally(error)
    runCatching { writer.close() }
    runCatching { command.close() }
    runCatching { session.close() }
  }

  private fun readStdout() {
    try {
      command.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
        lines.forEach { line ->
          if (line.isBlank()) {
            return@forEach
          }
          val message = runCatching { JSONObject(line) }.getOrNull()
          when (message?.optString("type")) {
            "hello" -> hello.complete(line)
            "response" -> {
              val requestId = message.optString("id")
              pending.remove(requestId)?.complete(line)
            }
            else -> onMessage(id, line)
          }
        }
      }
    } catch (error: Exception) {
      if (!closed) {
        Log.w("HERDR_BRIDGE", "Bridge output stream closed", error)
      }
    } finally {
      if (!closed) {
        onMessage(
          id,
          """{"protocol":1,"type":"event","event":"connection.warning","data":{"code":"BRIDGE_CLOSED","message":"Herdr bridge disconnected."}}""",
        )
        close()
      }
    }
  }

  private fun readStderr() {
    try {
      command.errorStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
        lines.forEach { line ->
          if (line.isNotBlank()) {
            Log.d("HERDR_BRIDGE", line.take(500))
          }
        }
      }
    } catch (_: Exception) {
    }
  }
}
