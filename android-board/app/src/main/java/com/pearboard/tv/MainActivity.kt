package com.pearboard.tv

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.util.Log
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
            // Honour <meta viewport width=1920> and scale the 1080p layout to the screen.
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

    private class PearboardWebViewClient(
        private val assetLoader: WebViewAssetLoader,
        private val onRendererGone: () -> Unit,
    ) : WebViewClient() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? {
            val url = request.url
            if (url.host == WebViewAssetLoader.DEFAULT_DOMAIN && url.path == "/calendar.ics") {
                return IcsProxy.fetch()
            }
            return assetLoader.shouldInterceptRequest(url)
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
