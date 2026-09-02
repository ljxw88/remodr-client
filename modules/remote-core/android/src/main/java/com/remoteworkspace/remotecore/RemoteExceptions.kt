package com.remoteworkspace.remotecore

import expo.modules.kotlin.exception.CodedException

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
