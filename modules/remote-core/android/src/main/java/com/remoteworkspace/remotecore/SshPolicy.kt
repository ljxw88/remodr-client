package com.remoteworkspace.remotecore

import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.keepalive.KeepAliveRunner
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient

internal fun resilientSshClient(): SSHClient {
  // SSHJ 0.39 defaults to unacknowledged HEARTBEAT. The provider is consumed by
  // the SSHClient constructor, so changing it after construction is too late.
  val config = DefaultConfig().apply { keepAliveProvider = KeepAliveProvider.KEEP_ALIVE }
  return SSHClient(config).apply {
    connectTimeout = 15_000
    timeout = 15_000
    (connection.keepAlive as KeepAliveRunner).apply {
      keepAliveInterval = 10
      maxAliveCount = 3
    }

  }
}

internal fun closeSshClient(client: SSHClient) {
  // SSHJ disconnect writes a goodbye before closing its socket. Closing the
  // socket first releases a blocked TCP write instead of waiting behind it.
  runCatching { client.socket?.close() }
  runCatching { client.close() }
}
