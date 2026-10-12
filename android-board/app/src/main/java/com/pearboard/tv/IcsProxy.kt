package com.pearboard.tv

import android.os.SystemClock
import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Serves /calendar/<n>.ics to the web UI by downloading the n-th secret Google
 * Calendar iCal address natively. Keeps the addresses out of JS and sidesteps CORS.
 *
 * 404 = no calendar n configured at build time, 502 = download failed.
 */
object IcsProxy {
    private const val TAG = "IcsProxy"

    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000 // per read() call, so a trickling server can outlast it...
    private const val TOTAL_TIMEOUT_MS = 30_000L // ...which is what this cap on the whole download is for

    fun fetch(index: Int): WebResourceResponse {
        val icalUrl = BuildConfig.CALENDAR_URLS.getOrNull(index)
        if (icalUrl.isNullOrBlank()) return error(404, "Not configured")

        val deadline = SystemClock.elapsedRealtime() + TOTAL_TIMEOUT_MS
        return try {
            val conn = URL(icalUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            try {
                val status = conn.responseCode
                if (status == HttpURLConnection.HTTP_OK) {
                    val body = conn.inputStream.use { readBefore(it, deadline) }
                    if (body == null) {
                        Log.w(TAG, "iCal download took over ${TOTAL_TIMEOUT_MS / 1000} s")
                        error(502, "Too slow")
                    } else {
                        WebResourceResponse(
                            "text/calendar", "utf-8", 200, "OK",
                            mapOf("Cache-Control" to "no-store"),
                            ByteArrayInputStream(body),
                        )
                    }
                } else {
                    Log.w(TAG, "iCal download $index returned HTTP $status")
                    error(502, "Upstream $status")
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            // Also covers a mistyped ICAL_URL (non-http scheme, bad host): never crash the page load.
            Log.w(TAG, "iCal download $index failed", e)
            error(502, "Fetch failed")
        }
    }

    // Reads the whole stream, or returns null once the deadline has passed.
    private fun readBefore(input: InputStream, deadline: Long): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            if (SystemClock.elapsedRealtime() > deadline) return null
            val n = input.read(buffer)
            if (n < 0) return out.toByteArray()
            out.write(buffer, 0, n)
        }
    }

    private fun error(code: Int, reason: String) = WebResourceResponse(
        "text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
}
