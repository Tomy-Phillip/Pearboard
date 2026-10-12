// Pearboard photo relay: upload page + API behind Cloudflare Access, and a
// token-protected API for the TV. See docs/plans/2026-10-12-remote-photos-design.md.

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: "internal" }, 500);
    }
  },
};
