// Pearboard photo relay: upload page + API behind Cloudflare Access, and a
// token-protected API for the TV. See docs/plans/2026-10-12-remote-photos-design.md.

import { verifyAccess, authorName } from "./access.js";

const ID = "([a-f0-9]{32})";

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function notFound() {
  return json({ error: "not_found" }, 404);
}

function toApi(row) {
  return {
    id: row.id,
    text: row.text,
    author: row.author,
    createdAt: row.created_at,
    seenAt: row.seen_at,
  };
}

// Constant-time comparison of the bearer token (hashing first evens out lengths).
async function tokenMatches(request, expected) {
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))),
  );
  return crypto.subtle.timingSafeEqual(a, b);
}

async function photoResponse(env, id) {
  const row = await env.DB.prepare("SELECT photo_key, content_type FROM messages WHERE id = ?1")
    .bind(id).first();
  if (!row) return notFound();
  const obj = await env.PHOTOS.get(row.photo_key);
  if (!obj) return notFound();
  // The bytes came from a sender: never let a browser sniff or run them as a page.
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}

async function handleTv(request, env, path) {
  if (!(await tokenMatches(request, env.TV_TOKEN))) return json({ error: "unauthorized" }, 401);

  if (request.method === "GET" && path === "/api/tv/messages") {
    const { results } = await env.DB.prepare(
      "SELECT id, text, author, created_at, seen_at FROM messages" +
      " WHERE seen_at IS NULL ORDER BY created_at, id",
    ).all();
    return json({ messages: results.map(toApi) });
  }

  let m = new RegExp(`^/api/tv/photo/${ID}$`).exec(path);
  if (request.method === "GET" && m) return photoResponse(env, m[1]);

  m = new RegExp(`^/api/tv/messages/${ID}/seen$`).exec(path);
  if (request.method === "POST" && m) {
    // Only the first "seen" counts; later ones (retries from the TV) change nothing.
    await env.DB.prepare("UPDATE messages SET seen_at = ?1 WHERE id = ?2 AND seen_at IS NULL")
      .bind(Date.now(), m[1]).run();
    const exists = await env.DB.prepare("SELECT 1 FROM messages WHERE id = ?1").bind(m[1]).first();
    return exists ? new Response(null, { status: 204 }) : notFound();
  }

  return notFound();
}

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 200;
const HISTORY_LIMIT = 30;

// The photo's real type, from its first bytes (the declared type is the sender's
// word for it), or null if it's none we accept.
function sniffPhotoType(bytes) {
  const at = (offset, sig) => sig.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp"; // RIFF….WEBP
  return null;
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The signed-in sender's email, or null. DEV_ACCESS_EMAIL (in .dev.vars) stands in
// for Access under `wrangler dev`: only for requests to localhost, and only where
// Access isn't configured (no ACCESS_AUD), so a stray secret can't open production.
async function accessEmail(request, env, url) {
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (env.DEV_ACCESS_EMAIL && local && !env.ACCESS_AUD) return env.DEV_ACCESS_EMAIL;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  try {
    const payload = await verifyAccess(token, env);
    return typeof payload.email === "string" ? payload.email : null;
  } catch (err) {
    console.warn("Access JWT rejected:", err.message);
    return null;
  }
}

async function createMessage(request, env, author) {
  // Refuse an obviously oversized body before buffering it. The header is optional
  // (chunked uploads), so the size check after parsing still stands.
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > MAX_PHOTO_BYTES + 64 * 1024) return json({ error: "photo_too_big" }, 413);

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return json({ error: "bad_form" }, 400);
  }
  const photo = form.get("photo");
  const rawText = form.get("text");
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!(photo instanceof File)) return json({ error: "photo_missing" }, 400);
  if (photo.size > MAX_PHOTO_BYTES) return json({ error: "photo_too_big" }, 413);
  if (Array.from(text).length > MAX_TEXT_CHARS) return json({ error: "text_too_long" }, 400);
  const bytes = new Uint8Array(await photo.arrayBuffer());
  const type = sniffPhotoType(bytes);
  if (!type) return json({ error: "photo_type" }, 415);

  const id = newId();
  const key = `photos/${id}`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  try {
    await env.DB.prepare(
      "INSERT INTO messages (id, text, author, photo_key, content_type, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(id, text, author, key, type, Date.now()).run();
  } catch (err) {
    // No row points at the photo: don't leave it behind in R2.
    try {
      await env.PHOTOS.delete(key);
    } catch (cleanupErr) {
      console.error("orphan photo", key, cleanupErr);
    }
    throw err;
  }
  return json({ id }, 201);
}

// Cookies ride along on cross-site requests too, so state-changing calls must come
// from the upload page itself. Browsers send at least one of these headers.
function crossSite(request, url) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") return true;
  const origin = request.headers.get("Origin");
  return origin !== null && origin !== url.origin;
}

async function handlePage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD" && crossSite(request, url)) {
    return json({ error: "forbidden" }, 403);
  }
  const email = await accessEmail(request, env, url);
  if (!email) return json({ error: "forbidden" }, 403);
  const path = url.pathname;

  if (path === "/api/messages" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, text, author, created_at, seen_at FROM messages ORDER BY created_at DESC, id LIMIT ?1",
    ).bind(HISTORY_LIMIT).all();
    return json({ messages: results.map(toApi) });
  }
  if (path === "/api/messages" && request.method === "POST") {
    return createMessage(request, env, authorName(email, env.AUTHORS));
  }

  let m = new RegExp(`^/api/photo/${ID}$`).exec(path);
  if (m && request.method === "GET") return photoResponse(env, m[1]);

  m = new RegExp(`^/api/messages/${ID}$`).exec(path);
  if (m && request.method === "DELETE") {
    const row = await env.DB.prepare("SELECT photo_key FROM messages WHERE id = ?1").bind(m[1]).first();
    if (!row) return notFound();
    await env.DB.prepare("DELETE FROM messages WHERE id = ?1").bind(m[1]).run();
    try {
      await env.PHOTOS.delete(row.photo_key);
    } catch (err) {
      // The message is gone either way; a leftover object is only wasted space.
      console.error("orphan photo", row.photo_key, err);
    }
    return new Response(null, { status: 204 });
  }

  return notFound();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/tv/")) return await handleTv(request, env, url.pathname);
      if (url.pathname.startsWith("/api/")) return await handlePage(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: "internal" }, 500);
    }
  },
};
