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
 * Serves /calendar/<n>.ics to the web UI by downloading the n-th calendar's secret
 * Google Calendar iCal address(es) natively. Keeps the addresses out of JS and
 * sidesteps CORS. A calendar with several addresses is served as one merged feed.
 *
 * 404 = no calendar n configured at build time, 502 = a download failed. One
 * failed address fails the whole calendar, so the page keeps its last complete
 * feed instead of caching one with half the events missing.
 */
object IcsProxy {
    private const val TAG = "IcsProxy"

    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000 // per read() call, so a trickling server can outlast it...
    private const val TOTAL_TIMEOUT_MS = 30_000L // ...which is what this cap on each download is for

    private class DownloadFailed(val reason: String) : Exception(reason)

    fun fetch(index: Int): WebResourceResponse {
        val icalUrls = BuildConfig.CALENDAR_URLS.getOrNull(index)
        if (icalUrls.isNullOrEmpty()) return error(404, "Not configured")

        return try {
            val bodies = icalUrls.mapIndexed { part, url -> download(url, "$index.$part") }
            val body = if (bodies.size == 1) bodies[0] else merge(bodies.map { String(it, Charsets.UTF_8) })
            WebResourceResponse(
                "text/calendar", "utf-8", 200, "OK",
                mapOf("Cache-Control" to "no-store"),
                ByteArrayInputStream(body),
            )
        } catch (e: DownloadFailed) {
            error(502, e.reason)
        } catch (e: Exception) {
            // Also covers a mistyped ICAL_URL (non-http scheme, bad host): never crash the page load.
            Log.w(TAG, "iCal download $index failed", e)
            error(502, "Fetch failed")
        }
    }

    private fun download(icalUrl: String, label: String): ByteArray {
        val deadline = SystemClock.elapsedRealtime() + TOTAL_TIMEOUT_MS
        val conn = URL(icalUrl).openConnection() as HttpURLConnection
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        try {
            val status = conn.responseCode
            if (status != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "iCal download $label returned HTTP $status")
                throw DownloadFailed("Upstream $status")
            }
            return conn.inputStream.use { readBefore(it, deadline) } ?: run {
                Log.w(TAG, "iCal download $label took over ${TOTAL_TIMEOUT_MS / 1000} s")
                throw DownloadFailed("Too slow")
            }
        } finally {
            conn.disconnect()
        }
    }

    /**
     * One VCALENDAR holding every feed's components (VTIMEZONE, VEVENT, …): the
     * first feed's header, then each feed's body between its header and its
     * END:VCALENDAR. An event both feeds share is shown once by calendar-ics.js.
     */
    internal fun merge(feeds: List<String>): ByteArray {
        val out = StringBuilder()
        feeds.forEachIndexed { i, feed ->
            val lines = feed.split("\r\n", "\n")
            val begin = lines.indexOfFirst { it.trim() == "BEGIN:VCALENDAR" }
            val end = lines.indexOfLast { it.trim() == "END:VCALENDAR" }
            if (begin < 0 || end < begin) throw DownloadFailed("Not an iCalendar feed")
            val firstComponent = (begin + 1 until end)
                .firstOrNull { lines[it].startsWith("BEGIN:") } ?: end
            val from = if (i == 0) begin else firstComponent
            for (line in lines.subList(from, end)) out.append(line).append("\r\n")
        }
        out.append("END:VCALENDAR\r\n")
        return out.toString().toByteArray(Charsets.UTF_8)
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
