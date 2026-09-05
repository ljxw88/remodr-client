package com.remoteworkspace.remotecore

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import net.schmizz.sshj.connection.channel.direct.Session
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.OutputStreamWriter
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

class HerdrBridgeSession(
  val id: String,
  val sshSessionId: String,
  private val session: Session,
  private val command: Session.Command,
  private val executor: ExecutorService,
  private val onMessage: (String, String) -> Unit,
  private val onClosed: (HerdrBridgeSession) -> Unit,
) {
  private val writer = BufferedWriter(OutputStreamWriter(command.outputStream, Charsets.UTF_8))
  private val hello = CompletableFuture<String>()
  private val pending = BridgeReplies()
  private val closed = AtomicBoolean(false)
  private val readers = CopyOnWriteArrayList<Future<*>>()

  fun start(): String {
    readers += executor.submit { readStdout() }
    readers += executor.submit { readStderr() }
    return try {
      hello.get(15, TimeUnit.SECONDS)
    } catch (error: Exception) {
      val failure = bridgeFailure(error, "Herdr bridge did not start")
      close(failure)
      throw failure
    }
  }

  fun request(requestJson: String): String {
    val requestId = try {
      JSONObject(requestJson).getString("id").also {
        if (it.isBlank()) throw IllegalArgumentException("Missing request ID")
      }
    } catch (error: Exception) {
      throw HerdrBridgeException("Invalid bridge request", error)
    }
    val response = pending.add(requestId)
    var write: Future<*>? = null
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(35)
    try {
      // A blocked channel write must not prevent timeout or stop from running.
      write = executor.submit {
        synchronized(writer) {
          if (closed.get()) throw BridgeClosedException()
          writer.write(requestJson)
          writer.newLine()
          writer.flush()
        }
      }
      write.get(remaining(deadline), TimeUnit.NANOSECONDS)
      return response.get(remaining(deadline), TimeUnit.NANOSECONDS)
    } catch (error: Exception) {
      val failure = bridgeFailure(error, "Herdr bridge request timed out")
      close(failure)
      throw failure
    } finally {
      pending.remove(requestId)
      write?.cancel(true)
    }
  }

  fun close(error: CodedException = BridgeClosedException()) {
    if (!closed.compareAndSet(false, true)) return
    pending.close(error)
    hello.completeExceptionally(error)
    onClosed(this)
    runCatching {
      onMessage(
        id,
        JSONObject()
          .put("protocol", 1)
          .put("type", "event")
          .put("event", "connection.closed")
          .put("data", JSONObject().put("code", error.code).put("message", error.message))
          .toString(),
      )
    }
    // Never BufferedWriter.close(): it flushes, acquiring the same lock as a
    // potentially blocked write. Closing the channel first unblocks its readers.
    val cleanup = Runnable {
      runCatching { command.close() }
      runCatching { session.close() }
      runCatching { command.inputStream.close() }
      runCatching { command.errorStream.close() }
      readers.forEach { it.cancel(true) }
    }
    try {
      executor.execute(cleanup)
    } catch (_: RejectedExecutionException) {
      cleanup.run()
    }
  }

  private fun readStdout() {
    var failure = BridgeClosedException("Herdr bridge disconnected")
    try {
      command.inputStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
        for (line in lines) {
          if (closed.get()) break
          if (line.isBlank()) continue
          val message = runCatching { JSONObject(line) }.getOrNull()
          when (message?.optString("type")) {
            "hello" -> hello.complete(line)
            "response" -> pending.complete(message.optString("id"), line)
            else -> onMessage(id, line)
          }
        }
      }
    } catch (error: Exception) {
      failure = BridgeClosedException("Herdr bridge output stream closed", error)
    } finally {
      close(failure)
    }
  }

  private fun readStderr() {
    try {
      command.errorStream.bufferedReader(Charsets.UTF_8).useLines { lines ->
        for (line in lines) {
          if (closed.get()) break
          if (line.isNotBlank()) Log.d("HERDR_BRIDGE", line.take(500))
        }
      }
    } catch (_: Exception) {
    }
  }

  private fun remaining(deadline: Long): Long = (deadline - System.nanoTime()).coerceAtLeast(1)
}

internal fun bridgeFailure(error: Throwable, timeoutMessage: String): CodedException {
  nativeCauses(error).filterIsInstance<CodedException>()
    .firstOrNull { it.code != "ERR_HERDR_BRIDGE" }?.let { return it }
  val cause = if (error is ExecutionException) error.cause ?: error else error
  return when (cause) {
    is CodedException -> cause
    is TimeoutException -> BridgeTimeoutException(timeoutMessage, cause)
    is InterruptedException -> {
      Thread.currentThread().interrupt()
      BridgeClosedException("Herdr bridge operation interrupted", cause)
    }
    else -> BridgeClosedException("Herdr bridge disconnected", cause)
  }
}
