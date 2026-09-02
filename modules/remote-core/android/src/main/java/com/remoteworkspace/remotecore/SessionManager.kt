package com.remoteworkspace.remotecore

import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Parameters
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile
import net.schmizz.sshj.userauth.password.PasswordUtils
import net.schmizz.sshj.xfer.FileSystemFile
import java.io.StringReader
import java.security.MessageDigest
import java.net.InetAddress
import java.net.ServerSocket
import java.util.EnumSet
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class SessionRecord(
  val sessionId: String,
  val hostId: String,
  val client: SSHClient,
  val jumpChain: JumpChain?,
  var fingerprint: String?,
  var status: String = "connected",
) {
  fun close() {
    runCatching { client.close() }
    jumpChain?.close()
  }
}

data class OpenedSsh(
  val client: SSHClient,
  val jumpChain: JumpChain? = null,
) {
  fun close() {
    runCatching { client.close() }
    jumpChain?.close()
  }
}

class JumpChain(
  private val clients: List<AutoCloseable>,
  private val forwards: List<AutoCloseable>,
) : AutoCloseable {
  override fun close() {
    forwards.asReversed().forEach { forward -> runCatching { forward.close() } }
    clients.asReversed().forEach { client -> runCatching { client.close() } }
  }
}

class SessionManager(
  private val knownHosts: KnownHostsStore,
  private val secrets: SecretStore,
) {
  private val sessions = ConcurrentHashMap<String, SessionRecord>()
  private val sessionsByHost = ConcurrentHashMap<String, String>()
  private val forwards = ConcurrentHashMap<String, LocalForward>()
  private val bridges = ConcurrentHashMap<String, HerdrBridgeSession>()
  private val io = Executors.newCachedThreadPool()

  fun connect(
    hostId: String,
    hostname: String,
    port: Int,
    username: String,
    password: String?,
    privateKey: String?,
    passphrase: String?,
    credentialId: String?,
    credentialType: String?,
    acceptedFingerprint: String?,
    jumpHops: List<Map<String, Any?>>,
  ): Map<String, Any?> {
    CryptoProvider.ensureInstalled()
    disconnectHost(hostId)
    val sessionId = UUID.randomUUID().toString()
    var opened: OpenedSsh? = null
    return try {
      val connection = if (jumpHops.isEmpty()) {
        OpenedSsh(
          openClient(
            hostname,
            port,
            username,
            password,
            privateKey,
            passphrase,
            credentialId,
            credentialType,
            acceptedFingerprint,
          ),
        )
      } else {
        openViaJumps(
          hostname,
          port,
          username,
          password,
          privateKey,
          passphrase,
          credentialId,
          credentialType,
          acceptedFingerprint,
          jumpHops,
        )
      }
      opened = connection
      val client = connection.client
      client.connection.keepAlive.keepAliveInterval = 30
      val fingerprint = knownHosts.fingerprintFor(hostname, port)
      val record = SessionRecord(
        sessionId,
        hostId,
        client,
        connection.jumpChain,
        fingerprint,
        "connected",
      )
      sessions[sessionId] = record
      sessionsByHost.put(hostId, sessionId)?.let { replacedSessionId ->
        if (replacedSessionId != sessionId) {
          disconnect(replacedSessionId)
        }
      }
      snapshot(record)
    } catch (error: Exception) {
      opened?.close()
      throw mapConnectError(error)
    }
  }

  fun disconnect(sessionId: String) {
    bridges.values
      .filter { it.sshSessionId == sessionId }
      .forEach { stopHerdrBridge(it.id) }
    forwards.keys.filter { it.startsWith(sessionId) }.forEach { closeForward(it) }
    sessions.remove(sessionId)?.let { record ->
      sessionsByHost.remove(record.hostId, sessionId)
      record.close()
    }
  }

  fun disconnectHost(hostId: String) {
    sessionsByHost[hostId]?.let { disconnect(it) }
  }

  fun getByHost(hostId: String): Map<String, Any?>? {
    val id = sessionsByHost[hostId] ?: return null
    return sessions[id]?.let { snapshot(it) }
  }

  fun list(): List<Map<String, Any?>> = sessions.values.map { snapshot(it) }

  fun startHerdrBridge(
    sessionId: String,
    bridgeBytes: ByteArray,
    onMessage: (String, String) -> Unit,
  ): Map<String, String> {
    val record = requireSession(sessionId)
    bridges.values
      .filter { it.sshSessionId == sessionId }
      .forEach { stopHerdrBridge(it.id) }
    val remotePath = deployHerdrBridge(record, bridgeBytes)
    val session = record.client.startSession()
    val command = try {
      session.exec(
        "HERDR_SOCKET=\"\$HOME/.config/herdr/herdr.sock\" " +
          "HERDR_SESSION=\"default\" python3 -u \"$remotePath\"",
      )
    } catch (error: Exception) {
      runCatching { session.close() }
      throw HerdrBridgeException("Could not launch Herdr bridge", error)
    }
    val bridgeId = UUID.randomUUID().toString()
    val bridge = HerdrBridgeSession(
      bridgeId,
      sessionId,
      session,
      command,
      io,
      onMessage,
    )
    bridges[bridgeId] = bridge
    return try {
      mapOf("bridgeId" to bridgeId, "hello" to bridge.start())
    } catch (error: Exception) {
      bridges.remove(bridgeId)
      throw error
    }
  }

  fun requestHerdrBridge(bridgeId: String, requestJson: String): String {
    val bridge = bridges[bridgeId] ?: throw HerdrBridgeException("Herdr bridge is not running")
    return bridge.request(requestJson)
  }

  fun stopHerdrBridge(bridgeId: String) {
    bridges.remove(bridgeId)?.close()
  }

  fun exec(sessionId: String, command: String): Map<String, Any?> {
    val record = requireSession(sessionId)
    val session = record.client.startSession()
    session.use {
      val cmd = it.exec(command)
      val stdoutTask = io.submit<ByteArray> { cmd.inputStream.readBytes() }
      val stderrTask = io.submit<ByteArray> { cmd.errorStream.readBytes() }
      try {
        cmd.join(30, TimeUnit.SECONDS)
        if (cmd.isOpen) {
          throw TimeoutException()
        }
        val stdout = stdoutTask.get(5, TimeUnit.SECONDS).toString(Charsets.UTF_8)
        val stderr = stderrTask.get(5, TimeUnit.SECONDS).toString(Charsets.UTF_8)
        return mapOf(
          "stdout" to stdout,
          "stderr" to stderr,
          "exitCode" to (cmd.exitStatus ?: -1),
        )
      } catch (_: java.util.concurrent.TimeoutException) {
        throw TimeoutException()
      } finally {
        runCatching { cmd.close() }
        stdoutTask.cancel(true)
        stderrTask.cancel(true)
      }
    }
  }

  fun sftpList(sessionId: String, path: String): List<Map<String, Any?>> {
    return withSftp(sessionId) { sftp ->
      sftp.ls(path).map { entry ->
        mapOf(
          "name" to entry.name,
          "path" to "$path/${entry.name}".replace("//", "/"),
          "isDirectory" to (entry.attributes.type == FileMode.Type.DIRECTORY),
          "size" to entry.attributes.size,
          "modified" to entry.attributes.mtime,
        )
      }
    }
  }

  fun sftpMkdir(sessionId: String, path: String) {
    withSftp(sessionId) { it.mkdir(path) }
  }

  fun sftpRename(sessionId: String, from: String, to: String) {
    withSftp(sessionId) { it.rename(from, to) }
  }

  fun sftpRemove(sessionId: String, path: String) {
    withSftp(sessionId) { sftp ->
      val stat = sftp.statExistence(path)
      if (stat != null && stat.type == FileMode.Type.DIRECTORY) {
        sftp.rmdir(path)
      } else {
        sftp.rm(path)
      }
    }
  }

  fun sftpDownload(sessionId: String, remotePath: String, localPath: String) {
    withSftp(sessionId) { it.get(remotePath, FileSystemFile(localPath)) }
  }

  fun sftpUpload(sessionId: String, localPath: String, remotePath: String) {
    withSftp(sessionId) { it.put(FileSystemFile(localPath), remotePath) }
  }

  fun openLocalForward(
    sessionId: String,
    bindHost: String,
    bindPort: Int,
    destHost: String,
    destPort: Int,
  ): Map<String, Any?> {
    val record = requireSession(sessionId)
    val tunnelId = "$sessionId:${UUID.randomUUID()}"
    val forward = createLocalForward(
      record.client,
      tunnelId,
      sessionId,
      bindHost,
      bindPort,
      destHost,
      destPort,
    )
    forwards[tunnelId] = forward
    return mapOf(
      "id" to tunnelId,
      "bindHost" to bindHost,
      "bindPort" to forward.bindPort,
      "destHost" to destHost,
      "destPort" to destPort,
    )
  }

  fun closeForward(tunnelId: String) {
    forwards.remove(tunnelId)?.close()
  }

  fun listForwards(sessionId: String): List<Map<String, Any?>> {
    return forwards.values.filter { it.sessionId == sessionId }.map {
      mapOf(
        "id" to it.id,
        "bindHost" to it.bindHost,
        "bindPort" to it.bindPort,
        "destHost" to it.destHost,
        "destPort" to it.destPort,
      )
    }
  }

  private fun <T> withSftp(sessionId: String, block: (SFTPClient) -> T): T {
    val record = requireSession(sessionId)
    record.client.newSFTPClient().use { return block(it) }
  }

  private fun deployHerdrBridge(record: SessionRecord, bridgeBytes: ByteArray): String {
    val hash = MessageDigest.getInstance("SHA-256")
      .digest(bridgeBytes)
      .joinToString("") { "%02x".format(it) }
    record.client.newSFTPClient().use { sftp ->
      val home = sftp.canonicalize(".")
      val directory = "$home/.local/share/remote-workspace"
      val bridgePath = "$directory/herdr_mobile_bridge.py"
      val hashPath = "$directory/herdr_mobile_bridge.sha256"
      val installedHash = readRemoteText(sftp, hashPath)
      if (installedHash?.trim() != hash) {
        runCatching { sftp.mkdirs(directory) }
        writeRemoteBytes(sftp, bridgePath, bridgeBytes)
        writeRemoteBytes(sftp, hashPath, hash.toByteArray(Charsets.UTF_8))
        sftp.chmod(bridgePath, 448)
      }
      return bridgePath
    }
  }

  private fun readRemoteText(sftp: SFTPClient, path: String): String? {
    val attributes = sftp.statExistence(path) ?: return null
    if (attributes.size > 4096) {
      return null
    }
    sftp.open(path, EnumSet.of(OpenMode.READ)).use { file ->
      val bytes = ByteArray(attributes.size.toInt())
      var offset = 0
      while (offset < bytes.size) {
        val read = file.read(offset.toLong(), bytes, offset, bytes.size - offset)
        if (read <= 0) {
          break
        }
        offset += read
      }
      return bytes.copyOf(offset).toString(Charsets.UTF_8)
    }
  }

  private fun writeRemoteBytes(sftp: SFTPClient, path: String, bytes: ByteArray) {
    sftp.open(
      path,
      EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.TRUNC),
    ).use { file ->
      var offset = 0
      while (offset < bytes.size) {
        val length = minOf(32768, bytes.size - offset)
        file.write(offset.toLong(), bytes, offset, length)
        offset += length
      }
    }
  }

  private fun requireSession(sessionId: String): SessionRecord {
    return sessions[sessionId] ?: throw SessionNotFoundException()
  }

  private fun snapshot(record: SessionRecord): Map<String, Any?> {
    return mapOf(
      "sessionId" to record.sessionId,
      "hostId" to record.hostId,
      "status" to record.status,
      "fingerprint" to record.fingerprint,
    )
  }

  private fun openViaJumps(
    hostname: String,
    port: Int,
    username: String,
    password: String?,
    privateKey: String?,
    passphrase: String?,
    credentialId: String?,
    credentialType: String?,
    acceptedFingerprint: String?,
    jumpHops: List<Map<String, Any?>>,
  ): OpenedSsh {
    val clients = mutableListOf<SSHClient>()
    val chainForwards = mutableListOf<LocalForward>()
    try {
      jumpHops.forEachIndexed { index, hop ->
        val hopHost = hop["hostname"] as String
        val hopPort = (hop["port"] as Number).toInt()
        val hopUser = hop["username"] as String
        val hopPassword = hop["password"] as String?
        val hopKey = hop["privateKey"] as String?
        val hopPassphrase = hop["passphrase"] as String?
        val hopCred = hop["credentialId"] as String?
        val hopCredentialType = hop["credentialType"] as String?
        val hopAccepted = hop["acceptedHostKeyFingerprint"] as String?
        val targetHost = if (index == jumpHops.lastIndex) hostname else jumpHops[index + 1]["hostname"] as String
        val targetPort = if (index == jumpHops.lastIndex) port else (jumpHops[index + 1]["port"] as Number).toInt()
        val client = if (clients.isEmpty()) {
          openClient(
            hopHost,
            hopPort,
            hopUser,
            hopPassword,
            hopKey,
            hopPassphrase,
            hopCred,
            hopCredentialType,
            hopAccepted,
          )
        } else {
          openClient(
            "127.0.0.1",
            chainForwards.last().bindPort,
            hopUser,
            hopPassword,
            hopKey,
            hopPassphrase,
            hopCred,
            hopCredentialType,
            hopAccepted,
          )
        }
        clients += client
        chainForwards += createLocalForward(
          client,
          "jump-$index",
          "jump",
          "127.0.0.1",
          0,
          targetHost,
          targetPort,
        )
      }
      return OpenedSsh(
        client = openClient(
          "127.0.0.1",
          chainForwards.last().bindPort,
          username,
          password,
          privateKey,
          passphrase,
          credentialId,
          credentialType,
          acceptedFingerprint,
        ),
        jumpChain = JumpChain(clients.toList(), chainForwards.toList()),
      )
    } catch (error: Exception) {
      chainForwards.asReversed().forEach(LocalForward::close)
      clients.asReversed().forEach { client -> runCatching { client.close() } }
      throw error
    }
  }

  private fun openClient(
    hostname: String,
    port: Int,
    username: String,
    password: String?,
    privateKey: String?,
    passphrase: String?,
    credentialId: String?,
    credentialType: String?,
    acceptedFingerprint: String?,
  ): SSHClient {
    val client = SSHClient()
    val verifier = AppHostKeyVerifier(knownHosts, hostname, port, acceptedFingerprint)
    client.addHostKeyVerifier(verifier)
    try {
      client.connectTimeout = 15000
      client.connect(hostname, port)
      val storedSecret = credentialId?.let(secrets::get)
      val secretPassword = password ?: storedSecret.takeIf { credentialType != "privateKey" }
      val secretKey = privateKey ?: storedSecret.takeIf { credentialType == "privateKey" }
      when {
        secretKey != null -> {
          val keyFile = OpenSSHKeyFile()
          val finder = if (passphrase.isNullOrEmpty()) {
            null
          } else {
            PasswordUtils.createOneOff(passphrase.toCharArray())
          }
          keyFile.init(StringReader(secretKey), finder)
          client.authPublickey(username, keyFile)
        }
        secretPassword != null -> client.authPassword(username, secretPassword)
        else -> throw AuthenticationException()
      }
      return client
    } catch (error: Exception) {
      runCatching { client.close() }
      throw error
    }
  }

  private fun createLocalForward(
    client: SSHClient,
    id: String,
    sessionId: String,
    bindHost: String,
    bindPort: Int,
    destHost: String,
    destPort: Int,
  ): LocalForward {
    val server = ServerSocket(bindPort, 50, InetAddress.getByName(bindHost))
    var forwarder: net.schmizz.sshj.connection.channel.direct.LocalPortForwarder? = null
    try {
      val params = Parameters(bindHost, server.localPort, destHost, destPort)
      val activeForwarder = client.newLocalPortForwarder(params, server)
      forwarder = activeForwarder
      val job = io.submit { runCatching { activeForwarder.listen() } }
      return LocalForward(
        id,
        sessionId,
        server,
        activeForwarder,
        job,
        bindHost,
        server.localPort,
        destHost,
        destPort,
      )
    } catch (error: Exception) {
      forwarder?.let { runCatching { it.close() } }
      runCatching { server.close() }
      throw error
    }
  }

  private fun mapConnectError(error: Exception): Exception {
    findCause<HostKeyUnknownException>(error)?.let { return it }
    findCause<HostKeyMismatchException>(error)?.let { return it }
    findCause<CryptoProviderException>(error)?.let { return it }
    findCause<AuthenticationException>(error)?.let { return it }
    findCause<java.net.SocketTimeoutException>(error)?.let { return TimeoutException() }
    findCause<net.schmizz.sshj.userauth.UserAuthException>(error)?.let {
      return AuthenticationException()
    }
    findCause<java.net.UnknownHostException>(error)?.let { return NetworkException() }
    findCause<java.net.ConnectException>(error)?.let { return NetworkException() }
    return SshConnectionException()
  }
}

private inline fun <reified T : Throwable> findCause(error: Throwable): T? {
  var current: Throwable? = error
  while (current != null) {
    if (current is T) {
      return current
    }
    current = current.cause
  }
  return null
}

class LocalForward(
  val id: String,
  val sessionId: String,
  private val server: ServerSocket,
  private val forwarder: net.schmizz.sshj.connection.channel.direct.LocalPortForwarder,
  private val job: java.util.concurrent.Future<*>,
  val bindHost: String,
  val bindPort: Int,
  val destHost: String,
  val destPort: Int,
) : AutoCloseable {
  override fun close() {
    runCatching { forwarder.close() }
    runCatching { server.close() }
    job.cancel(true)
  }
}
