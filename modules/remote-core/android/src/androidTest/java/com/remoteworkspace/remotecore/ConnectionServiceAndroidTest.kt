package com.remoteworkspace.remotecore

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.app.Notification
import android.content.Context
import android.content.Intent
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ServiceTestActivity : Activity()

@RunWith(AndroidJUnit4::class)
class ConnectionServiceAndroidTest {
  @Test
  fun deniedNotificationPermissionOnlyDisablesTheService() {
    assumeTrue(Build.VERSION.SDK_INT >= 33)
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = object : ContextWrapper(instrumentation.targetContext) {
      override fun checkSelfPermission(permission: String): Int =
        if (permission == Manifest.permission.POST_NOTIFICATIONS) PackageManager.PERMISSION_DENIED
        else super.checkSelfPermission(permission)
    }
    instrumentation.runOnMainSync {
      assertEquals("notification-permission-denied", ConnectionServiceController.eligibility(context, true)["reason"])
      ConnectionServiceController.request(context, true, "Test", true) { assertFalse(it) }
    }
  }

  @Test
  fun backgroundStartIsDeniedWithoutCrashing() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    instrumentation.runOnMainSync {
      assertEquals(false, ConnectionServiceController.eligibility(context, false)["eligible"])
      ConnectionServiceController.request(context, true, "Test", false) {
        assertFalse(it)
      }
    }
  }

  @Test
  fun actualForegroundServiceStopsAndReportsAndroid35Timeout() {
    assumeTrue(Build.VERSION.SDK_INT >= 35)
    assertStartedServiceStops("timeout") { _, service ->
      InstrumentationRegistry.getInstrumentation().runOnMainSync {
        service.onTimeout(1, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      }
    }
  }

  @Test
  fun notificationDismissalStopsServiceAndReportsInactive() {
    assumeTrue(Build.VERSION.SDK_INT >= 26)
    assertStartedServiceStops("user-stopped") { context, _ ->
      val manager = context.getSystemService(NotificationManager::class.java)
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
      var notification: Notification? = null
      while (notification == null && System.nanoTime() < deadline) {
        notification = manager.activeNotifications
          .firstOrNull { it.notification.channelId == ConnectionService.CHANNEL }?.notification
        if (notification == null) Thread.sleep(25)
      }
      assertNotNull("Foreground notification was not posted", notification)
      assertNotNull(notification!!.deleteIntent)
      notification.deleteIntent.send()
    }
  }

  private fun assertStartedServiceStops(reason: String, stop: (Context, ConnectionService) -> Unit) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val permissionGranted = Build.VERSION.SDK_INT < 33 ||
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    if (!permissionGranted) {
      instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
    }
    val activity = instrumentation.startActivitySync(
      Intent(context, ServiceTestActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
    val started = CountDownLatch(1)
    val stopped = CountDownLatch(1)
    try {
      instrumentation.runOnMainSync {
        ConnectionServiceController.listener = { active, eventReason ->
          if (!active && eventReason == reason) stopped.countDown()
        }
        ConnectionServiceController.request(context, true, "Testing remote sync", true) {
          if (it) started.countDown()
        }
      }
      assertTrue("Service never acknowledged startForeground", started.await(5, TimeUnit.SECONDS))
      lateinit var service: ConnectionService
      instrumentation.runOnMainSync {
        val field = ConnectionServiceController::class.java.getDeclaredField("service").apply { isAccessible = true }
        service = field.get(ConnectionServiceController) as ConnectionService
      }
      stop(context, service)
      assertTrue("$reason did not report inactive", stopped.await(5, TimeUnit.SECONDS))
    } finally {
      instrumentation.runOnMainSync {
        ConnectionServiceController.stop(context, "test-finished")
        ConnectionServiceController.listener = null
        activity.finish()
      }
    }
  }
}
