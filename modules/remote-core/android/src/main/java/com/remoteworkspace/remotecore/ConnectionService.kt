package com.remoteworkspace.remotecore

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

internal object ConnectionServiceController {
  private val main = Handler(Looper.getMainLooper())
  private var generation = 0L
  private var wanted = false
  private var completion: ((Boolean) -> Unit)? = null
  private var service: ConnectionService? = null
  var listener: ((Boolean, String?) -> Unit)? = null

  fun eligibility(context: Context, foreground: Boolean): Map<String, Any?> {
    val reason = when {
      Build.VERSION.SDK_INT < 26 -> "unavailable"
      !foreground -> "not-foreground"
      Build.VERSION.SDK_INT >= 33 &&
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED ->
        "notification-permission-denied"
      !context.getSystemService(NotificationManager::class.java).areNotificationsEnabled() ->
        "notifications-disabled"
      context.getSystemService(NotificationManager::class.java)
        .getNotificationChannel(ConnectionService.CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE ->
        "notification-channel-disabled"
      else -> null
    }
    return buildMap {
      put("eligible", reason == null)
      if (reason != null) put("reason", reason)
    }
  }

  fun request(context: Context, active: Boolean, label: String, foreground: Boolean, done: (Boolean) -> Unit) {
    if (!active) {
      stop(context, "stopped")
      done(false)
      return
    }
    val eligibility = eligibility(context, foreground)
    if (eligibility["eligible"] != true) {
      // Revoking permission must not kill SSH or the rest of the application.
      if (service == null || eligibility["reason"] != "not-foreground") {
        stop(context, eligibility["reason"] as? String ?: "unavailable")
      }
      done(service != null)
      return
    }
    service?.let {
      if (runCatching { it.updateNotification(label) }.isSuccess) {
        done(true)
      } else {
        stop(context, "notification-failed")
        done(false)
      }
      return
    }
    completion?.invoke(false)
    completion = done
    wanted = true
    val token = ++generation
    try {
      context.startForegroundService(
        Intent(context, ConnectionService::class.java)
          .putExtra("generation", token)
          .putExtra("label", label.take(100)),
      )
      main.postDelayed({
        if (generation == token && completion != null) stop(context, "start-timeout")
      }, 5_000)
    } catch (_: SecurityException) {
      stop(context, "permission-denied")
    } catch (_: IllegalStateException) {
      // Includes API 31+ ForegroundServiceStartNotAllowedException and exhausted
      // API 35 dataSync budgets; never retry from a background timer.
      stop(context, "background-start-denied")
    } catch (_: RuntimeException) {
      stop(context, "unavailable")
    }
  }

  fun accepts(token: Long): Boolean = wanted && token == generation

  fun hasOwnership(): Boolean = wanted

  fun started(instance: ConnectionService) {
    service = instance
    completion?.invoke(true)
    completion = null
    publish(true, null)
  }

  fun stopped(instance: ConnectionService, token: Long, reason: String) {
    if (service !== instance && token != generation) return
    service = null
    wanted = false
    ++generation
    completion?.invoke(false)
    completion = null
    publish(false, reason)
  }

  fun stop(context: Context, reason: String) {
    wanted = false
    ++generation
    completion?.invoke(false)
    completion = null
    val running = service
    service = null
    if (running != null) running.finish(reason)
    else runCatching { context.stopService(Intent(context, ConnectionService::class.java)) }
    publish(false, reason)
  }

  private fun publish(active: Boolean, reason: String?) {
    runCatching { listener?.invoke(active, reason) }
  }
}

class ConnectionService : Service() {
  companion object {
    const val CHANNEL = "remote-workspace-connection"
    private const val NOTIFICATION = 4107
    private const val STOP = "com.remoteworkspace.remotecore.STOP_CONNECTION_SERVICE"
  }

  private var stopReason = "service-destroyed"
  private var finished = false
  private var ownershipToken = -1L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (finished) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (intent?.action == STOP) {
      finish("user-stopped")
      return START_NOT_STICKY
    }
    if (intent == null || !ConnectionServiceController.accepts(intent.getLongExtra("generation", -1))) {
      if (!ConnectionServiceController.hasOwnership()) finish("ownership-ended")
      return START_NOT_STICKY
    }
    ownershipToken = intent.getLongExtra("generation", -1)
    try {
      val notification = notification(intent.getStringExtra("label").orEmpty())
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION, notification)
      }
      ConnectionServiceController.started(this)
    } catch (_: SecurityException) {
      finish("permission-denied")
    } catch (_: RuntimeException) {
      finish("foreground-start-denied")
    }
    return START_NOT_STICKY
  }

  fun updateNotification(label: String) {
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(label))
  }

  fun finish(reason: String) {
    if (finished) return
    finished = true
    stopReason = reason
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    ConnectionServiceController.stopped(this, ownershipToken, reason)
  }

  // Android 15 owns the cumulative dataSync 6h/24h budget across service runs.
  // Restarting short runs does not bypass it. Stop immediately when it expires.
  override fun onTimeout(startId: Int, fgsType: Int) {
    finish("timeout")
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    finish("task-removed")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    ConnectionServiceController.stopped(this, ownershipToken, stopReason)
    super.onDestroy()
  }

  private fun notification(label: String): Notification {
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL, "Remote connection", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Visible status while syncing remote sessions and queued messages"
        setShowBadge(false)
      },
    )
    val stopIntent = PendingIntent.getService(
      this, 0, Intent(this, ConnectionService::class.java).setAction(STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(
        this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    return Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_connection)
      .setContentTitle(applicationInfo.loadLabel(packageManager))
      .setContentText(label.take(100).ifBlank { "Syncing remote sessions and queued messages" })
      .setStyle(Notification.BigTextStyle().bigText(
        "${label.take(100).ifBlank { "Syncing remote sessions and queued messages" }}. " +
          "Android may pause network or execution; reopen the app to resume. " +
          "Stopping background sync does not terminate remote agents.",
      ))
      .setContentIntent(openIntent)
      .setDeleteIntent(stopIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .apply {
        if (Build.VERSION.SDK_INT >= 31) setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
      }
      .addAction(Notification.Action.Builder(null, "Stop background sync", stopIntent).build())
      .build()
  }
}
