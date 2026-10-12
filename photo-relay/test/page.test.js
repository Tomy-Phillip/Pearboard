import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { accessJwt, fetchPath, insertMessage, newId } from "./helpers.js";

async function pageFetch(path, init = {}, jwtOptions) {
  const headers = Object.assign({ "Cf-Access-Jwt-Assertion": await accessJwt(jwtOptions) }, init.headers);
  return fetchPath(path, Object.assign({}, init, { headers }));
}

function upload({ text = "Bonne fête!", type = "image/jpeg", size = 1000, photo = true } = {}) {
  const form = new FormData();
  if (photo) form.append("photo", new File([new Uint8Array(size)], "p.jpg", { type }));
  form.append("text", text);
  return { method: "POST", body: form };
}

describe("Access check", () => {
  it("403s without the Access JWT", async () => {
    const res = await fetchPath("/api/messages");
    expect(res.status).toBe(403);
  });

  it("403s with a JWT for another audience", async () => {
    const res = await pageFetch("/api/messages", {}, { aud: "other" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/messages", () => {
  it("stores the photo and text, signed with the sender's first name", async () => {
    const res = await pageFetch("/api/messages", upload());
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(id).toMatch(/^[a-f0-9]{32}$/);

    const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?1").bind(id).first();
    expect(row).toMatchObject({ text: "Bonne fête!", author: "Tomy", content_type: "image/jpeg", seen_at: null });
    expect(await env.PHOTOS.head(`photos/${id}`)).not.toBeNull();
  });

  it("signs unknown senders with the start of their email", async () => {
    const res = await pageFetch("/api/messages", upload(), { email: "marie@example.com" });
    const { id } = await res.json();
    const row = await env.DB.prepare("SELECT author FROM messages WHERE id = ?1").bind(id).first();
    expect(row.author).toBe("marie");
  });

  it("accepts an empty caption", async () => {
    const res = await pageFetch("/api/messages", upload({ text: "" }));
    expect(res.status).toBe(201);
  });

  it("rejects a missing photo", async () => {
    const res = await pageFetch("/api/messages", upload({ photo: false }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "photo_missing" });
  });

  it("rejects other file types", async () => {
    const res = await pageFetch("/api/messages", upload({ type: "image/gif" }));
    expect(res.status).toBe(415);
  });

  it("rejects photos over 2 MB", async () => {
    const res = await pageFetch("/api/messages", upload({ size: 2 * 1024 * 1024 + 1 }));
    expect(res.status).toBe(413);
  });

  it("rejects captions over 200 characters", async () => {
    const res = await pageFetch("/api/messages", upload({ text: "é".repeat(201) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "text_too_long" });
  });
});

describe("GET /api/messages", () => {
  it("lists the 30 most recent, newest first, with their seen time", async () => {
    for (let i = 0; i < 32; i++) {
      await insertMessage({ text: `m${i}`, createdAt: i, seenAt: i === 31 ? 99 : null });
    }
    const res = await pageFetch("/api/messages");
    const { messages } = await res.json();
    expect(messages).toHaveLength(30);
    expect(messages[0]).toMatchObject({ text: "m31", seenAt: 99 });
    expect(messages[29].text).toBe("m2");
  });
});

describe("GET /api/photo/:id", () => {
  it("serves the photo to the upload page", async () => {
    const id = await insertMessage({ photo: "xyz" });
    const res = await pageFetch(`/api/photo/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("xyz");
  });
});

describe("DELETE /api/messages/:id", () => {
  it("removes the message and its photo", async () => {
    const id = await insertMessage();
    const res = await pageFetch(`/api/messages/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await env.DB.prepare("SELECT 1 FROM messages WHERE id = ?1").bind(id).first()).toBeNull();
    expect(await env.PHOTOS.head(`photos/${id}`)).toBeNull();
  });

  it("404s an unknown id", async () => {
    const res = await pageFetch(`/api/messages/${newId()}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
