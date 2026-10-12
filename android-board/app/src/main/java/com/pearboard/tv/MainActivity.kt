package com.pearboard.tv

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var webViewDestroyed = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // A path handler gets the path *after* its prefix ("/web/index.html" → "index.html"),
        // but the files live under assets/web/, so put the "web/" back.
        val assets = WebViewAssetLoader.AssetsPathHandler(this)
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/web/") { path -> assets.handle("web/$path") }
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // localStorage caches (weather, iCal)
            // Assets come through WebViewAssetLoader over https, never file://.
            settings.allowFileAccess = false
            // Honour <meta viewport width=1920> and scale the 1080p page to the screen
            // (the portrait layout is drawn rotated inside it, see style.css).
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webViewClient = PearboardWebViewClient(assetLoader, ::onRendererGone)
        }
        setContentView(webView)
        webView.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/web/index.html")
        webView.requestFocus()
    }

    // The renderer died (crash or killed for memory) and took the page with it.
    // A WebView can't be reused after that: drop it and rebuild the activity,
    // which loads a fresh WebView, instead of leaving a blank wall screen.
    private fun onRendererGone() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        webViewDestroyed = true
        recreate()
    }

    // Back closes the day panel when it's open; otherwise it leaves the app.
    // Relies on not opting into predictive back (android:enableOnBackInvokedCallback); revisit when targetSdk ≥ 36.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webViewDestroyed) return
        webView.evaluateJavascript("window.pearboardBack ? window.pearboardBack() : false") { consumed ->
            if (consumed != "true") finish()
        }
    }

    // Menu (≡) and Play/Pause switch between the month and week views. Handled here
    // because the WebView doesn't hand these keys to the page as usable keydowns.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode in VIEW_TOGGLE_KEYS) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 && !webViewDestroyed) {
                webView.evaluateJavascript("window.pearboardToggleView && window.pearboardToggleView()", null)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onResume() {
        super.onResume()
        if (!webViewDestroyed) webView.onResume()
    }

    override fun onPause() {
        if (!webViewDestroyed) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        if (!webViewDestroyed) webView.destroy()
        super.onDestroy()
    }

    private companion object {
        val VIEW_TOGGLE_KEYS = setOf(
            KeyEvent.KEYCODE_MENU,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE,
        )
    }

    private class PearboardWebViewClient(
        private val assetLoader: WebViewAssetLoader,
        private val onRendererGone: () -> Unit,
    ) : WebViewClient() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? {
            val url = request.url
            if (url.host == WebViewAssetLoader.DEFAULT_DOMAIN) {
                val calendar = CALENDAR_PATH.matchEntire(url.path ?: "")
                if (calendar != null) return IcsProxy.fetch(calendar.groupValues[1].toInt())
                PhotoProxy.handle(request.method, url.path ?: "")?.let { return it }
            }
            return assetLoader.shouldInterceptRequest(url)
        }

        companion object {
            private val CALENDAR_PATH = Regex("/calendar/(\\d{1,2})\\.ics")
        }

        // Only called on API 26+; returning true keeps the app process alive.
        @TargetApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w("MainActivity", "WebView renderer gone (crashed: ${detail.didCrash()}), recreating")
            onRendererGone()
            return true
        }
    }
}
