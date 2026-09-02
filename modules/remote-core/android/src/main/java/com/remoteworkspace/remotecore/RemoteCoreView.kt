package com.remoteworkspace.remotecore

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

@SuppressLint("SetJavaScriptEnabled")
class RemoteCoreView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val webView = WebView(context)
  private var manager: SessionManager? = null
  private var ptyId: String? = null
  private var ready = false
  private val pending = ArrayDeque<ByteArray>()
  private var cols = 80
  private var rows = 24

  init {
    webView.setBackgroundColor(Color.parseColor("#0E0F10"))
    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = true
    webView.addJavascriptInterface(Bridge(), "AndroidBridge")
    webView.webViewClient = object : WebViewClient() {
      override fun onPageFinished(view: WebView?, url: String?) {
        ready = true
        applySize()
        while (pending.isNotEmpty()) {
          dispatch(pending.removeFirst())
        }
      }
    }
    addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    webView.loadUrl("file:///android_asset/terminal.html")
  }

  fun bind(nextPtyId: String?, nextManager: SessionManager) {
    ptyId?.let { manager?.detachView(it, this) }
    manager = nextManager
    ptyId = nextPtyId
    nextPtyId?.let { nextManager.attachView(it, this) }
  }

  fun setColumns(value: Int) {
    cols = value
    applySize()
    ptyId?.let { manager?.resizePty(it, cols, rows) }
  }

  fun setRows(value: Int) {
    rows = value
    applySize()
    ptyId?.let { manager?.resizePty(it, cols, rows) }
  }

  fun writeOutput(bytes: ByteArray) {
    post {
      if (!ready) {
        pending.addLast(bytes)
      } else {
        dispatch(bytes)
      }
    }
  }

  private fun applySize() {
    if (!ready) return
    webView.evaluateJavascript("window.setSize($cols,$rows)", null)
  }

  private fun dispatch(bytes: ByteArray) {
    val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
    webView.evaluateJavascript("window.writeOutput('$encoded')", null)
  }

  inner class Bridge {
    @JavascriptInterface
    fun write(data: String) {
      val id = ptyId ?: return
      manager?.writePty(id, data)
    }
  }
}
