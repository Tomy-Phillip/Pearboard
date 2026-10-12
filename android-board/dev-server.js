// Serves the web UI the way MainActivity does, for working on it in a desktop browser:
// /web/* from the bundled assets, /web/config.js like the build generates it, and
// /calendar/<n>.ics from the files in DEV_CALENDARS (defaults to the two samples).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = path.join(__dirname, "app", "src", "main", "assets", "web");
const FIXTURES = path.join(__dirname, "test", "fixtures");
const PORT = Number(process.env.PORT) || 8123;
const COLORS = ["red", "green", "blue", "amber", "purple", "teal"];

// DEV_CALENDARS="Nom=/chemin/a.ics;Autre=/chemin/b.ics" — same order as CAL_1, CAL_2…
const CALENDARS = (process.env.DEV_CALENDARS
  || `Tomy=${path.join(FIXTURES, "sample.ics")};Lily=${path.join(FIXTURES, "sample-2.ics")}`)
  .split(";")
  .filter(Boolean)
  .map((entry, i) => {
    const eq = entry.indexOf("=");
    return { name: entry.slice(0, eq), file: entry.slice(eq + 1), color: COLORS[i % COLORS.length] };
  });

// none = upright portrait page; ccw / cw = rotated like on the TV.
const CONFIG_JS =
  "window.PEARBOARD = " + JSON.stringify({
    rotation: process.env.ROTATION || "none",
    calendars: CALENDARS.map((c) => ({ name: c.name, color: c.color })),
  }) + ";\n" +
  "document.documentElement.setAttribute(\"data-rotate\", window.PEARBOARD.rotation);\n";

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
  const calendar = /^\/calendar\/(\d+)\.ics$/.exec(pathname);
  if (calendar) {
    const cal = CALENDARS[Number(calendar[1])];
    if (!cal) return res.writeHead(404).end();
    // An unreadable file plays the part of a failed download (IcsProxy answers 502).
    return send(res, cal.file, "text/calendar; charset=utf-8", 502);
  }
  if (pathname === "/web/config.js") {
    return res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" }).end(CONFIG_JS);
  }
  if (pathname.startsWith("/web/")) {
    const file = path.join(WEB_DIR, path.normalize(decodeURIComponent(pathname.slice(5))));
    if (file.startsWith(WEB_DIR + path.sep)) {
      return send(res, file, TYPES[path.extname(file)] || "application/octet-stream");
    }
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`http://localhost:${PORT}/web/index.html`));
