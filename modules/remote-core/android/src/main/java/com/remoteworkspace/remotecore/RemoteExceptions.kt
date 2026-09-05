package com.remoteworkspace.remotecore

import expo.modules.kotlin.exception.CodedException
import net.schmizz.sshj.connection.ConnectionException
import net.schmizz.sshj.sftp.Response.StatusCode
import net.schmizz.sshj.sftp.SFTPException
import net.schmizz.sshj.transport.TransportException
import net.schmizz.sshj.userauth.UserAuthException
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.Collections
import java.util.IdentityHashMap

class HostKeyUnknownException(fingerprint: String) :
  CodedException("ERR_HOST_KEY_UNKNOWN", "Untrusted host key $fingerprint", null)

class HostKeyMismatchException(fingerprint: String) :
  CodedException("ERR_HOST_KEY_MISMATCH", "Host key mismatch $fingerprint", null)

class AuthenticationException :
  CodedException("ERR_AUTHENTICATION", "Authentication failed", null)

class NetworkException(cause: Throwable? = null) :
  CodedException("ERR_NETWORK", "Could not reach the server", cause)

class TimeoutException :
  CodedException("ERR_TIMEOUT", "The connection timed out", null)

class SessionNotFoundException :
  CodedException("ERR_SESSION", "SSH session is not connected", null)

class CryptoProviderException :
  CodedException("ERR_CRYPTO_PROVIDER", "SSH cryptography could not be initialized", null)

class SshConnectionException :
  CodedException("ERR_SSH_CONNECTION", "SSH negotiation failed", null)

class HerdrBridgeException : CodedException {
  constructor(message: String) : super("ERR_HERDR_BRIDGE", message, null)
  constructor(message: String, cause: Throwable) :
    super("ERR_HERDR_BRIDGE", message, cause)
}

class BridgeClosedException(message: String = "Herdr bridge is closed", cause: Throwable? = null) :
  CodedException("ERR_BRIDGE_CLOSED", message, cause)

class BridgeTimeoutException(message: String, cause: Throwable? = null) :
  CodedException("ERR_BRIDGE_TIMEOUT", message, cause)

internal fun nativeCauses(error: Throwable): List<Throwable> {
  val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
  return generateSequence(error) { it.cause }.takeWhile { seen.add(it) }.toList()
}

internal fun mapSshOperationError(
  error: Throwable,
  fallback: () -> CodedException,
): CodedException {
  val causes = nativeCauses(error)
  causes.filterIsInstance<CodedException>().firstOrNull { it.code != "ERR_HERDR_BRIDGE" }?.let { return it }
  if (causes.any { it is UserAuthException }) return AuthenticationException()
  if (causes.any { it is SocketTimeoutException || it is java.util.concurrent.TimeoutException }) {
    return TimeoutException()
  }
  causes.filterIsInstance<SFTPException>().firstOrNull()?.let { sftp ->
    when (sftp.statusCode) {
      StatusCode.NO_CONNECTION, StatusCode.CONNECITON_LOST -> return NetworkException(error)
      StatusCode.UNKNOWN -> Unit
      // SFTP exceptions also extend IOException, but permission/quota/path
      // errors are not transport loss and must not enter an endless retry.
      else -> return fallback()
    }
  }
  if (causes.any { it is TransportException || it is ConnectionException }) return SshConnectionException()
  if (causes.any { it is IOException }) return NetworkException(error)
  return causes.filterIsInstance<CodedException>().firstOrNull() ?: fallback()
}
