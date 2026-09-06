package com.remoteworkspace.remotecore

import android.os.Handler
import android.os.Looper
import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import java.util.concurrent.Executors

class RemoteCoreModule : Module() {
  private lateinit var manager: SessionManager
  private lateinit var knownHosts: KnownHostsStore
  private lateinit var secrets: SecretStore
  private lateinit var serviceContext: Context
  private val workers = Executors.newCachedThreadPool { task ->
    Thread(task, "remote-core-call").apply { isDaemon = true }
  }
  private val networkScope = CoroutineScope(SupervisorJob() + workers.asCoroutineDispatcher())
  private val serviceListener: (Boolean, String?) -> Unit = { active, reason ->
    sendEvent("onConnectionServiceChange", buildMap<String, Any> {
      put("active", active)
      if (reason != null) put("reason", reason)
    })
  }

  private fun isForeground(): Boolean =
    (appContext.currentActivity as? LifecycleOwner)?.lifecycle?.currentState == Lifecycle.State.RESUMED

  override fun definition() = ModuleDefinition {
    Name("RemoteCore")

    Events("onSessionChange", "onHerdrMessage", "onConnectionServiceChange")

    OnCreate {
      val context = appContext.reactContext
        ?: appContext.currentActivity
        ?: throw IllegalStateException("Missing Android context")
      knownHosts = KnownHostsStore(context)
      secrets = SecretStore(context)
      manager = SessionManager(knownHosts, secrets)
      serviceContext = context.applicationContext
      ConnectionServiceController.listener = serviceListener
    }

    OnDestroy {
      val context = if (::serviceContext.isInitialized) serviceContext else null
      Handler(Looper.getMainLooper()).post {
        if (ConnectionServiceController.listener === serviceListener) {
          if (context != null) ConnectionServiceController.stop(context, "module-destroyed")
          ConnectionServiceController.listener = null
        }
      }
      networkScope.cancel()
      Thread({
        try {
          if (::manager.isInitialized) manager.close()
        } finally {
          workers.shutdownNow()
        }
      }, "remote-core-shutdown").apply { isDaemon = true }.start()
    }

    AsyncFunction("getConnectionServiceEligibility") {
      val context = appContext.reactContext
      if (context == null) {
        mapOf("eligible" to false, "reason" to "unavailable")
      } else {
        ConnectionServiceController.eligibility(
          context,
          isForeground(),
        )
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setConnectionService") { active: Boolean, label: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve(false)
      } else {
        ConnectionServiceController.request(
          context.applicationContext,
          active,
          label,
          isForeground(),
        ) { promise.resolve(it) }
      }
    }.runOnQueue(Queues.MAIN)

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
    }.runOnQueue(networkScope)

    AsyncFunction("disconnect") { sessionId: String ->
      manager.disconnect(sessionId)
    }.runOnQueue(networkScope)

    AsyncFunction("disconnectHost") { hostId: String ->
      manager.disconnectHost(hostId)
    }.runOnQueue(networkScope)

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
      val source = context.assets.open("herdr_mobile_bridge.pyz").use { it.readBytes() }
      manager.startHerdrBridge(sessionId, source) { bridgeId, message ->
        sendEvent(
          "onHerdrMessage",
          mapOf("bridgeId" to bridgeId, "message" to message),
        )
      }
    }.runOnQueue(networkScope)

    AsyncFunction("requestHerdrBridge") { bridgeId: String, requestJson: String ->
      manager.requestHerdrBridge(bridgeId, requestJson)
    }.runOnQueue(networkScope)

    AsyncFunction("stopHerdrBridge") { bridgeId: String ->
      manager.stopHerdrBridge(bridgeId)
    }.runOnQueue(networkScope)

    AsyncFunction("exec") { sessionId: String, command: String ->
      manager.exec(sessionId, command)
    }.runOnQueue(networkScope)

    AsyncFunction("sftpList") { sessionId: String, path: String ->
      manager.sftpList(sessionId, path)
    }.runOnQueue(networkScope)

    AsyncFunction("sftpMkdir") { sessionId: String, path: String ->
      manager.sftpMkdir(sessionId, path)
    }.runOnQueue(networkScope)

    AsyncFunction("sftpRename") { sessionId: String, from: String, to: String ->
      manager.sftpRename(sessionId, from, to)
    }.runOnQueue(networkScope)

    AsyncFunction("sftpRemove") { sessionId: String, path: String ->
      manager.sftpRemove(sessionId, path)
    }.runOnQueue(networkScope)

    AsyncFunction("sftpDownload") { sessionId: String, remotePath: String, localPath: String ->
      manager.sftpDownload(sessionId, remotePath, localPath)
    }.runOnQueue(networkScope)

    AsyncFunction("sftpUpload") { sessionId: String, localPath: String, remotePath: String ->
      manager.sftpUpload(sessionId, localPath, remotePath)
    }.runOnQueue(networkScope)

    AsyncFunction("openLocalForward") { sessionId: String, bindHost: String, bindPort: Int, destHost: String, destPort: Int ->
      manager.openLocalForward(sessionId, bindHost, bindPort, destHost, destPort)
    }.runOnQueue(networkScope)

    AsyncFunction("closeForward") { tunnelId: String ->
      manager.closeForward(tunnelId)
    }.runOnQueue(networkScope)

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
