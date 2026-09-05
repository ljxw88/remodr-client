package com.remoteworkspace.remotecore

import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Parameters
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile
import net.schmizz.sshj.userauth.password.PasswordUtils
import net.schmizz.sshj.xfer.FileSystemFile
import java.io.StringReader
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class SessionRecord(
  val sessionId: String,
  val hostId: String,
  val client: SSHClient,
  val jumpChain: JumpChain?,
  var fingerprint: String?,
  @Volatile var status: String = "connected",
) {
  fun isLive(): Boolean = status == "connected" &&
    client.isConnected && client.isAuthenticated && (jumpChain?.isLive() != false)

  fun close() {
    status = "disconnected"
    closeSshClient(client)
    jumpChain?.close()
  }
}

data class OpenedSsh(
  val client: SSHClient,
  val jumpChain: JumpChain? = null,
) {
  fun close() {
    closeSshClient(client)
    jumpChain?.close()
  }
}

class JumpChain(
  private val clients: List<AutoCloseable>,
  private val forwards: List<AutoCloseable>,
) : AutoCloseable {
  fun isLive(): Boolean = clients.all {
    it !is SSHClient || (it.isConnected && it.isAuthenticated)
  }

  override fun close() {
    forwards.asReversed().forEach { forward -> runCatching { forward.close() } }
    clients.asReversed().forEach { client ->
      if (client is SSHClient) closeSshClient(client) else runCatching { client.close() }
    }
  }
}

private data class DetachedSession(
  val record: SessionRecord?,
  val bridge: HerdrBridgeSession?,
  val forwards: List<LocalForward>,
) {
  fun close() {
    bridge?.close()
    forwards.forEach { it.close() }
    record?.close()
  }
}

class SessionManager(
  private val knownHosts: KnownHostsStore,
  private val secrets: SecretStore,
) {
  private val lifecycle = Any()
  private val sessions = ConcurrentHashMap<String, SessionRecord>()
  private val hostAttempts = AttemptRegistry<String, SessionRecord>(lifecycle)
  private val bridgeAttempts = AttemptRegistry<String, HerdrBridgeSession>(lifecycle)
  private val forwards = ConcurrentHashMap<String, LocalForward>()
  private val bridges = ConcurrentHashMap<String, HerdrBridgeSession>()
  private val io = Executors.newCachedThreadPool { task ->
    Thread(task, "remote-core-io").apply { isDaemon = true }
  }
  private val openingClients = ConcurrentHashMap.newKeySet<SSHClient>()
  private val destroyed = AtomicBoolean(false)

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
    val (attempt, detached) = synchronized(lifecycle) {
      if (destroyed.get()) throw SessionNotFoundException()
      val attempt = hostAttempts.begin(hostId)
      attempt to attempt.previous?.let { detachSessionLocked(it.sessionId) }
    }
    detached?.close()
    CryptoProvider.ensureInstalled()
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
      val fingerprint = knownHosts.fingerprintFor(hostname, port)
      val record = SessionRecord(
        sessionId,
        hostId,
        client,
        connection.jumpChain,
        fingerprint,
        "connected",
      )
      synchronized(lifecycle) {
        if (destroyed.get() || !hostAttempts.publish(attempt, record)) {
          throw SessionNotFoundException()
        }
        sessions[sessionId] = record
        opened = null
      }
      snapshot(record)
    } catch (error: Exception) {
      opened?.close()
      throw mapConnectError(error)
    }
  }

  fun disconnect(sessionId: String) {
    synchronized(lifecycle) { detachSessionLocked(sessionId) }.close()
  }

  fun disconnectHost(hostId: String) {
    val detached = synchronized(lifecycle) {
      hostAttempts.invalidate(hostId)?.let { detachSessionLocked(it.sessionId) }
    }
    detached?.close()
  }

  fun getByHost(hostId: String): Map<String, Any?>? {
    val record = hostAttempts.current(hostId) ?: return null
    if (!record.isLive()) {
      // Synchronous JS snapshots must not block while SSH channels drain.
      record.status = "disconnected"
      if (!destroyed.get()) runCatching { io.execute { disconnect(record.sessionId) } }
      return null
    }
    return snapshot(record)
  }

  fun list(): List<Map<String, Any?>> = sessions.values.mapNotNull { getByHost(it.hostId) }

  fun startHerdrBridge(
    sessionId: String,
    bridgeBytes: ByteArray,
    onMessage: (String, String) -> Unit,
  ): Map<String, String> = try {
    startHerdrBridgeSession(sessionId, bridgeBytes, onMessage)
  } catch (error: Exception) {
    throw mapSshOperationError(error) {
      if (error is IllegalStateException && sessions[sessionId]?.isLive() != true) {
        SessionNotFoundException()
      } else {
        HerdrBridgeException("Could not start or deploy Herdr bridge", error)
      }
    }
  }

  private fun startHerdrBridgeSession(
    sessionId: String,
    bridgeBytes: ByteArray,
    onMessage: (String, String) -> Unit,
  ): Map<String, String> {
    val record = requireSession(sessionId)
    val attempt = synchronized(lifecycle) {
      if (destroyed.get() || sessions[sessionId] !== record) throw SessionNotFoundException()
      bridgeAttempts.begin(sessionId).also { attempt ->
        attempt.previous?.let { bridges.remove(it.id, it) }
      }
    }
    attempt.previous?.close()
    val remotePath = deployHerdrBridge(record, bridgeBytes)
    val session = record.client.startSession()
    val command = try {
      session.exec(
        "REMOTE_WORKSPACE_DEVICE_ID=${shellQuote(record.hostId)} " +
          "HERDR_SOCKET=\"\$HOME/.config/herdr/herdr.sock\" " +
          "HERDR_SESSION=\"default\" python3 -u ${shellQuote(remotePath)}",
      )
    } catch (error: Exception) {
      runCatching { session.close() }
      throw error
    }
    val bridgeId = UUID.randomUUID().toString()
    val bridge = HerdrBridgeSession(
      bridgeId,
      sessionId,
      session,
      command,
      io,
      onMessage,
      { closed ->
        synchronized(lifecycle) {
          if (bridges.remove(closed.id, closed)) bridgeAttempts.remove(sessionId, closed)
        }
      },
    )
    return try {
      synchronized(lifecycle) {
        if (destroyed.get() || sessions[sessionId] !== record || !bridgeAttempts.publish(attempt, bridge)) {
          throw BridgeClosedException("Herdr bridge was superseded")
        }
        bridges[bridgeId] = bridge
      }
      val hello = bridge.start()
      synchronized(lifecycle) {
        if (destroyed.get() || sessions[sessionId] !== record || !bridgeAttempts.isCurrent(attempt, bridge)) {
          throw BridgeClosedException("Herdr bridge was superseded")
        }
      }
      mapOf("bridgeId" to bridgeId, "hello" to hello)
    } catch (error: Exception) {
      bridge.close()
      throw error
    }
  }

  fun requestHerdrBridge(bridgeId: String, requestJson: String): String {
    val bridge = bridges[bridgeId] ?: throw BridgeClosedException("Herdr bridge is not running")
    return bridge.request(requestJson)
  }

  fun stopHerdrBridge(bridgeId: String) {
    val bridge = synchronized(lifecycle) {
      bridges.remove(bridgeId)?.also { bridgeAttempts.remove(it.sshSessionId, it) }
    }
    bridge?.close()
  }

  fun close() {
    val detached = synchronized(lifecycle) {
      if (!destroyed.compareAndSet(false, true)) return
      sessions.keys.toList().map(::detachSessionLocked)
    }
    detached.forEach { it.close() }
    forwards.keys.toList().forEach(::closeForward)
    openingClients.forEach(::closeSshClient)
    io.shutdown()
    if (!io.awaitTermination(5, TimeUnit.SECONDS)) io.shutdownNow()
  }

  private fun detachSessionLocked(sessionId: String): DetachedSession {
    val record = sessions.remove(sessionId)
    if (record != null) hostAttempts.remove(record.hostId, record)
    val bridge = bridgeAttempts.invalidate(sessionId)
    if (bridge != null) bridges.remove(bridge.id, bridge)
    val detachedForwards = forwards.values.filter { it.sessionId == sessionId }
    detachedForwards.forEach { forwards.remove(it.id, it) }
    return DetachedSession(record, bridge, detachedForwards)
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
    val published = synchronized(lifecycle) {
      if (destroyed.get() || sessions[sessionId] !== record) false
      else {
        forwards[tunnelId] = forward
        true
      }
    }
    if (!published) {
      forward.close()
      throw SessionNotFoundException()
    }
    return mapOf(
      "id" to tunnelId,
      "bindHost" to bindHost,
      "bindPort" to forward.bindPort,
      "destHost" to destHost,
      "destPort" to destPort,
    )
  }

  fun closeForward(tunnelId: String) {
    val forward = synchronized(lifecycle) { forwards.remove(tunnelId) }
    forward?.close()
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
    record.client.newSFTPClient().use { sftp ->
      val home = sftp.canonicalize(".")
      val directory = "$home/.local/share/remote-workspace"
      return deployBridge(directory, bridgeBytes, SftpBridgeDeploymentStore(sftp))
    }
  }

  private fun requireSession(sessionId: String): SessionRecord {
    val record = sessions[sessionId] ?: throw SessionNotFoundException()
    if (destroyed.get() || !record.isLive()) {
      disconnect(sessionId)
      throw SessionNotFoundException()
    }
    return record
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
            verifiedHostname = hopHost,
            verifiedPort = hopPort,
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
            verifiedHostname = hopHost,
            verifiedPort = hopPort,
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
          verifiedHostname = hostname,
          verifiedPort = port,
        ),
        jumpChain = JumpChain(clients.toList(), chainForwards.toList()),
      )
    } catch (error: Exception) {
      chainForwards.asReversed().forEach(LocalForward::close)
      clients.asReversed().forEach(::closeSshClient)
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
    verifiedHostname: String = hostname,
    verifiedPort: Int = port,
  ): SSHClient {
    if (destroyed.get()) throw SessionNotFoundException()
    val client = resilientSshClient()
    openingClients.add(client)
    val verifier = AppHostKeyVerifier(knownHosts, verifiedHostname, verifiedPort, acceptedFingerprint)
    client.addHostKeyVerifier(verifier)
    try {
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
      if (destroyed.get()) throw SessionNotFoundException()
      return client
    } catch (error: Exception) {
      closeSshClient(client)
      throw error
    } finally {
      openingClients.remove(client)
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

  private fun shellQuote(value: String): String {
    return "'" + value.replace("'", "'\"'\"'") + "'"
  }

  private fun mapConnectError(error: Exception): Exception {
    return mapSshOperationError(error) { SshConnectionException() }
  }
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
