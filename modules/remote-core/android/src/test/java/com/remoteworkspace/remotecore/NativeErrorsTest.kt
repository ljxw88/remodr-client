package com.remoteworkspace.remotecore

import expo.modules.kotlin.exception.CodedException
import net.schmizz.sshj.connection.ConnectionException
import net.schmizz.sshj.sftp.Response.StatusCode
import net.schmizz.sshj.sftp.SFTPException
import net.schmizz.sshj.transport.TransportException
import org.junit.Assert.*
import org.junit.Test
import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException

class NativeErrorsTest {
  private fun mapped(error: Throwable): CodedException =
    mapSshOperationError(error) { HerdrBridgeException("Deployment failed", error) }

  @Test
  fun preservesExistingNativeCodesThroughLaunchWrappers() {
    for (error in listOf(
      NetworkException(), TimeoutException(), SshConnectionException(),
      SessionNotFoundException(), AuthenticationException(),
      HostKeyUnknownException("unknown"), HostKeyMismatchException("changed"),
      CryptoProviderException(), BridgeClosedException(), BridgeTimeoutException("timeout"),
    )) {
      assertSame(error, mapped(HerdrBridgeException("Launch failed", RuntimeException(error))))
    }
    assertEquals("ERR_SESSION", SessionNotFoundException().code)
  }

  @Test
  fun mapsRawDeployAndChannelTransportFailuresToRetryableCodes() {
    assertEquals("ERR_NETWORK", mapped(ConnectException("refused")).code)
    assertEquals("ERR_NETWORK", mapped(SocketException("reset")).code)
    assertEquals("ERR_TIMEOUT", mapped(TransportException(SocketTimeoutException("timeout"))).code)
    assertEquals("ERR_TIMEOUT", mapped(SFTPException(java.util.concurrent.TimeoutException())).code)
    assertEquals("ERR_SSH_CONNECTION", mapped(ConnectionException("channel closed")).code)
    assertEquals("ERR_SSH_CONNECTION", mapped(TransportException("transport closed")).code)
    assertEquals("ERR_NETWORK", mapped(SFTPException(StatusCode.NO_CONNECTION, "offline")).code)
    assertEquals("ERR_NETWORK", mapped(SFTPException(StatusCode.CONNECITON_LOST, "lost")).code)
  }

  @Test
  fun remoteDeploymentPermissionAndQuotaFailuresRemainFatal() {
    for (status in listOf(StatusCode.PERMISSION_DENIED, StatusCode.QUOTA_EXCEEDED, StatusCode.NO_SUCH_PATH)) {
      assertEquals("ERR_HERDR_BRIDGE", mapped(SFTPException(status, "Cannot deploy")).code)
    }
  }

  @Test
  fun bridgeWaitPreservesNestedAuthAndNetworkCodes() {
    val auth = AuthenticationException()
    val network = NetworkException()
    assertSame(auth, bridgeFailure(java.util.concurrent.ExecutionException(RuntimeException(auth)), "timeout"))
    assertSame(network, bridgeFailure(java.util.concurrent.ExecutionException(RuntimeException(network)), "timeout"))
  }
}
