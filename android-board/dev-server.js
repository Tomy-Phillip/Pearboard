// Serves the web UI the way MainActivity does, for working on it in a desktop browser:
// /web/* from the bundled assets, /web/config.js like the build generates it, and
// /calendar/<n>.ics from the files in DEV_CALENDARS (defaults to the two samples).
// DEV_PHOTOS=1 turns remote photos on and mocks /photos/* (photo-relay/) with two
// fake photos in memory, dropped as the page marks them seen.
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
    photos: !!process.env.DEV_PHOTOS,
  }) + ";\n" +
  "document.documentElement.setAttribute(\"data-rotate\", window.PEARBOARD.rotation);\n";

// DEV_PHOTOS=1: two fake remote photos, removed as the page marks them seen.
const devPhotos = process.env.DEV_PHOTOS ? [
  { id: "a".repeat(32), text: "Bonne fête Lily ! 🎉", author: "Tomy", createdAt: Date.now() - 5 * 60000, hue: 20 },
  { id: "b".repeat(32), text: "", author: "Lily", createdAt: Date.now() - 60000, hue: 200 },
] : [];

// A 1080×1920 stand-in for a phone photo: a gradient in the photo's hue, its author in large text.
function devPhotoSvg(p) {
  const name = p.author.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${p.hue}, 70%, 60%)"/>
    <stop offset="1" stop-color="hsl(${p.hue + 40}, 60%, 30%)"/>
  </linearGradient></defs>
  <rect width="1080" height="1920" fill="url(#g)"/>
  <text x="540" y="860" font-family="sans-serif" font-size="200" font-weight="700"
        fill="#ffffff" fill-opacity="0.8" text-anchor="middle">${name}</text>
</svg>`;
}

// Same routes as MainActivity's /photos/* proxy, answered from devPhotos.
function servePhotos(req, res, pathname) {
  if (req.method === "GET" && pathname === "/photos/messages") {
    const messages = devPhotos.map(({ hue, ...m }) => m);
    return res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ messages }));
  }
  const photo = /^\/photos\/photo\/([0-9a-f]{32})$/.exec(pathname);
  if (req.method === "GET" && photo) {
    const p = devPhotos.find((x) => x.id === photo[1]);
    if (!p) return res.writeHead(404).end();
    return res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }).end(devPhotoSvg(p));
  }
  const seen = /^\/photos\/seen\/([0-9a-f]{32})$/.exec(pathname);
  if (req.method === "POST" && seen) {
    const i = devPhotos.findIndex((x) => x.id === seen[1]);
    if (i !== -1) devPhotos.splice(i, 1);
    return res.writeHead(204).end();
  }
  return res.writeHead(404).end();
}

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
  if (pathname.startsWith("/photos/")) return servePhotos(req, res, pathname);
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
