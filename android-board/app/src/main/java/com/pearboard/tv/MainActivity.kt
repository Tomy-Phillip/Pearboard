package com.pearboard.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

class MainActivity : Activity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/web/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // localStorage caches (weather, iCal)
            // Honour <meta viewport width=1920> and scale the 1080p layout to the screen.
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webViewClient = PearboardWebViewClient(assetLoader)
        }
        setContentView(webView)
        webView.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/web/index.html")
        webView.requestFocus()
    }

    // Back closes the day panel when it's open; otherwise it leaves the app.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        webView.evaluateJavascript("window.pearboardBack ? window.pearboardBack() : false") { consumed ->
            if (consumed != "true") finish()
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private class PearboardWebViewClient(
        private val assetLoader: WebViewAssetLoader,
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
    }
}
