package com.pearboard.tv

import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Serves /calendar.ics to the web UI by downloading the secret Google Calendar
 * iCal address natively. Keeps the address out of JS and sidesteps CORS.
 *
 * 404 = no ICAL_URL configured at build time, 502 = download failed.
 */
object IcsProxy {
    private const val TAG = "IcsProxy"

    fun fetch(): WebResourceResponse {
        val icalUrl = BuildConfig.ICAL_URL
        if (icalUrl.isBlank()) return error(404, "Not configured")

        return try {
            val conn = URL(icalUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            try {
                val status = conn.responseCode
                if (status == HttpURLConnection.HTTP_OK) {
                    val body = conn.inputStream.use { it.readBytes() }
                    WebResourceResponse(
                        "text/calendar", "utf-8", 200, "OK",
                        mapOf("Cache-Control" to "no-store"),
                        ByteArrayInputStream(body),
                    )
                } else {
                    Log.w(TAG, "iCal download returned HTTP $status")
                    error(502, "Upstream $status")
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            // Also covers a mistyped ICAL_URL (non-http scheme, bad host): never crash the page load.
            Log.w(TAG, "iCal download failed", e)
            error(502, "Fetch failed")
        }
    }

    private fun error(code: Int, reason: String) = WebResourceResponse(
        "text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
}
