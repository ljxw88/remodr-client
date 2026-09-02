package com.remoteworkspace.remotecore

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RemoteCoreModule : Module() {
  private lateinit var manager: SessionManager
  private lateinit var knownHosts: KnownHostsStore
  private lateinit var secrets: SecretStore

  override fun definition() = ModuleDefinition {
    Name("RemoteCore")

    Events("onSessionChange", "onHerdrMessage")

    OnCreate {
      val context = appContext.reactContext
        ?: appContext.currentActivity
        ?: throw IllegalStateException("Missing Android context")
      knownHosts = KnownHostsStore(context)
      secrets = SecretStore(context)
      manager = SessionManager(knownHosts, secrets)
    }

    AsyncFunction("connect") { options: Map<String, Any?> ->
      @Suppress("UNCHECKED_CAST")
      val hops = (options["jumpHops"] as? List<Map<String, Any?>>) ?: emptyList()
      val snapshot = manager.connect(
        hostId = options["hostId"] as String,
        hostname = options["hostname"] as String,
        port = (options["port"] as Number).toInt(),
        username = options["username"] as String,
        password = options["password"] as String?,
        privateKey = options["privateKey"] as String?,
        passphrase = options["passphrase"] as String?,
        credentialId = options["credentialId"] as String?,
        credentialType = options["credentialType"] as String?,
        acceptedFingerprint = options["acceptedHostKeyFingerprint"] as String?,
        jumpHops = hops,
      )
      sendEvent("onSessionChange", snapshot)
      snapshot
    }

    AsyncFunction("disconnect") { sessionId: String ->
      manager.disconnect(sessionId)
    }

    AsyncFunction("disconnectHost") { hostId: String ->
      manager.disconnectHost(hostId)
    }

    Function("getSession") { hostId: String ->
      manager.getByHost(hostId)
    }

    Function("listSessions") {
      manager.list()
    }

    AsyncFunction("startHerdrBridge") { sessionId: String ->
      val context = appContext.reactContext
        ?: appContext.currentActivity
        ?: throw HerdrBridgeException("Missing Android context")
      val source = context.assets.open("herdr_mobile_bridge.py").use { it.readBytes() }
      manager.startHerdrBridge(sessionId, source) { bridgeId, message ->
        sendEvent(
          "onHerdrMessage",
          mapOf("bridgeId" to bridgeId, "message" to message),
        )
      }
    }

    AsyncFunction("requestHerdrBridge") { bridgeId: String, requestJson: String ->
      manager.requestHerdrBridge(bridgeId, requestJson)
    }

    AsyncFunction("stopHerdrBridge") { bridgeId: String ->
      manager.stopHerdrBridge(bridgeId)
    }

    AsyncFunction("exec") { sessionId: String, command: String ->
      manager.exec(sessionId, command)
    }

    AsyncFunction("sftpList") { sessionId: String, path: String ->
      manager.sftpList(sessionId, path)
    }

    AsyncFunction("sftpMkdir") { sessionId: String, path: String ->
      manager.sftpMkdir(sessionId, path)
    }

    AsyncFunction("sftpRename") { sessionId: String, from: String, to: String ->
      manager.sftpRename(sessionId, from, to)
    }

    AsyncFunction("sftpRemove") { sessionId: String, path: String ->
      manager.sftpRemove(sessionId, path)
    }

    AsyncFunction("sftpDownload") { sessionId: String, remotePath: String, localPath: String ->
      manager.sftpDownload(sessionId, remotePath, localPath)
    }

    AsyncFunction("sftpUpload") { sessionId: String, localPath: String, remotePath: String ->
      manager.sftpUpload(sessionId, localPath, remotePath)
    }

    AsyncFunction("openLocalForward") { sessionId: String, bindHost: String, bindPort: Int, destHost: String, destPort: Int ->
      manager.openLocalForward(sessionId, bindHost, bindPort, destHost, destPort)
    }

    AsyncFunction("closeForward") { tunnelId: String ->
      manager.closeForward(tunnelId)
    }

    Function("listForwards") { sessionId: String ->
      manager.listForwards(sessionId)
    }

    AsyncFunction("saveSecret") { id: String, secret: String ->
      secrets.save(id, secret)
    }

    Function("hasSecret") { id: String ->
      secrets.contains(id)
    }

    AsyncFunction("deleteSecret") { id: String ->
      secrets.delete(id)
    }

    Function("listKnownHosts") {
      knownHosts.list()
    }

    AsyncFunction("removeKnownHost") { hostname: String, port: Int ->
      knownHosts.remove(hostname, port)
    }

  }
}
