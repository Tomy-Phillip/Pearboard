package com.pearboard.tv

import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Relays the page's /photos/… requests to the photo-relay Worker's TV API,
 * adding the secret token, which never reaches JS:
 *   GET  /photos/messages    → GET  {PHOTOS_URL}/api/tv/messages
 *   GET  /photos/photo/<id>  → GET  {PHOTOS_URL}/api/tv/photo/<id>
 *   POST /photos/seen/<id>   → POST {PHOTOS_URL}/api/tv/messages/<id>/seen
 * The Worker's status (200, 204, 401, 404…) is passed through; 502 = unreachable.
 */
object PhotoProxy {
    private const val TAG = "PhotoProxy"
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 20_000

    private val PHOTO = Regex("/photos/photo/([a-f0-9]{32})")
    private val SEEN = Regex("/photos/seen/([a-f0-9]{32})")

    /** The response for a /photos/ request, or null when the path isn't one of ours. */
    fun handle(method: String, path: String): WebResourceResponse? {
        if (!path.startsWith("/photos/")) return null
        val base = BuildConfig.PHOTOS_URL
        if (base.isEmpty()) return plain(404, "Not configured")
        val photo = PHOTO.matchEntire(path)
        val seen = SEEN.matchEntire(path)
        return when {
            method == "GET" && path == "/photos/messages" -> forward("GET", "$base/api/tv/messages")
            method == "GET" && photo != null -> forward("GET", "$base/api/tv/photo/${photo.groupValues[1]}")
            method == "POST" && seen != null -> forward("POST", "$base/api/tv/messages/${seen.groupValues[1]}/seen")
            else -> plain(404, "Not found")
        }
    }

    private fun forward(method: String, url: String): WebResourceResponse = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.requestMethod = method
            conn.setRequestProperty("Authorization", "Bearer ${BuildConfig.PHOTOS_TOKEN}")
            if (method == "POST") {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(0)
                conn.outputStream.close()
            }
            val status = conn.responseCode
            val stream = if (status < 400) conn.inputStream else conn.errorStream
            val body = stream?.use { it.readBytes() } ?: ByteArray(0)
            val mime = (conn.contentType ?: "application/octet-stream").substringBefore(';').trim()
            if (status >= 400) Log.w(TAG, "$method ${URL(url).path} → HTTP $status")
            WebResourceResponse(
                mime, "utf-8", status, conn.responseMessage?.takeIf { it.isNotBlank() } ?: "Status",
                mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(body),
            )
        } finally {
            conn.disconnect()
        }
    } catch (e: Exception) {
        // Also covers a 3xx (WebResourceResponse rejects those) and a mistyped PHOTOS_URL.
        Log.w(TAG, "$method ${url.substringAfter("/api/")} failed", e)
        plain(502, "Fetch failed")
    }

    private fun plain(code: Int, reason: String) = WebResourceResponse(
        "text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
}
