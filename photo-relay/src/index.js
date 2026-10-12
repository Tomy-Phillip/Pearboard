// Pearboard photo relay: upload page + API behind Cloudflare Access, and a
// token-protected API for the TV. See docs/plans/2026-10-12-remote-photos-design.md.

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
  return new Response(obj.body, {
    headers: { "Content-Type": row.content_type, "Cache-Control": "private, max-age=86400" },
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/tv/")) return await handleTv(request, env, url.pathname);
      if (url.pathname.startsWith("/api/")) return notFound();
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: "internal" }, 500);
    }
  },
};
