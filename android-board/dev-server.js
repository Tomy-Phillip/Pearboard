// Serves the web UI the way MainActivity does, for working on it in a desktop browser:
// /web/* from the bundled assets, /calendar.ics from ICS_FILE (defaults to the sample).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = path.join(__dirname, "app", "src", "main", "assets", "web");
const ICS_FILE = process.env.ICS_FILE || path.join(__dirname, "test", "fixtures", "sample.ics");
const PORT = Number(process.env.PORT) || 8123;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function send(res, file, type, missingStatus) {
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(missingStatus || 404).end();
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(data);
  });
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  // An unreadable ICS_FILE plays the part of a failed download (IcsProxy answers 502).
  if (pathname === "/calendar.ics") return send(res, ICS_FILE, "text/calendar; charset=utf-8", 502);
  if (pathname.startsWith("/web/")) {
    const file = path.join(WEB_DIR, path.normalize(decodeURIComponent(pathname.slice(5))));
    if (file.startsWith(WEB_DIR + path.sep)) {
      return send(res, file, TYPES[path.extname(file)] || "application/octet-stream");
    }
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`http://localhost:${PORT}/web/index.html`));
