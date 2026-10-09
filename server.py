#!/usr/bin/env python3
"""Static file server for Pearboard.

Same as `python3 -m http.server`, but every response carries
`Cache-Control: no-cache` so Chromium revalidates app.js / style.css on each
reload. Without it, an auto-reload after an update could keep serving the old
files from the browser's heuristic cache.
"""
import functools
import http.server
import os

HOST = "127.0.0.1"
PORT = 8000
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer((HOST, PORT), handler) as httpd:
        httpd.serve_forever()
