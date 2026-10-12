import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { BASE, accessJwt, fetchPath, imageBytes, insertMessage, newId } from "./helpers.js";

async function pageFetch(path, init = {}, jwtOptions) {
  const headers = Object.assign({ "Cf-Access-Jwt-Assertion": await accessJwt(jwtOptions) }, init.headers);
  return fetchPath(path, Object.assign({}, init, { headers }));
}

function upload({
  text = "Bonne fête!", type = "image/jpeg", kind = "jpeg", size = 1000, photo = true, headers,
} = {}) {
  const form = new FormData();
  const bytes = kind ? imageBytes(kind, size) : new Uint8Array(size).fill(0x41);
  if (photo) form.append("photo", new File([bytes], "p.jpg", { type }));
  if (text !== null) form.append("text", text);
  return { method: "POST", body: form, headers };
}

// Calls the Worker directly, so a test can hand it a doctored env.
async function workerFetch(path, init, testEnv) {
  const headers = Object.assign({ "Cf-Access-Jwt-Assertion": await accessJwt() }, init.headers);
  return worker.fetch(new Request(BASE + path, Object.assign({}, init, { headers })), testEnv);
}

async function storedRow(res) {
  const { id } = await res.json();
  return env.DB.prepare("SELECT * FROM messages WHERE id = ?1").bind(id).first();
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

  it("403s with a JWT that has no email", async () => {
    const res = await pageFetch("/api/messages", {}, { email: null });
    expect(res.status).toBe(403);
  });

  it("ignores DEV_ACCESS_EMAIL when Access is configured", async () => {
    const res = await worker.fetch(new Request("http://localhost/api/messages"),
      Object.assign({}, env, { DEV_ACCESS_EMAIL: "dev@example.com" }));
    expect(res.status).toBe(403);
  });

  it("honours DEV_ACCESS_EMAIL on localhost when ACCESS_AUD is unset", async () => {
    const devEnv = Object.assign({}, env, { DEV_ACCESS_EMAIL: "dev@example.com", ACCESS_AUD: undefined });
    expect((await worker.fetch(new Request("http://localhost/api/messages"), devEnv)).status).toBe(200);
    expect((await worker.fetch(new Request(BASE + "/api/messages"), devEnv)).status).toBe(403);
  });
});

describe("Cross-site requests", () => {
  it("403s a POST from another origin", async () => {
    const res = await pageFetch("/api/messages", upload({ headers: { Origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("403s a POST marked cross-site by the browser", async () => {
    const res = await pageFetch("/api/messages", upload({ headers: { "Sec-Fetch-Site": "cross-site" } }));
    expect(res.status).toBe(403);
  });

  it("403s a DELETE from another origin, and keeps the message", async () => {
    const id = await insertMessage();
    const res = await pageFetch(`/api/messages/${id}`, { method: "DELETE", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT 1 FROM messages WHERE id = ?1").bind(id).first()).not.toBeNull();
  });

  it("accepts a same-origin POST", async () => {
    const res = await pageFetch("/api/messages",
      upload({ headers: { Origin: BASE, "Sec-Fetch-Site": "same-origin" } }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/messages", () => {
  it("stores the photo and text, signed with the sender's first name", async () => {
    const res = await pageFetch("/api/messages", upload());
    expect(res.status).toBe(201);
    const { id } = await res.clone().json();
    expect(id).toMatch(/^[a-f0-9]{32}$/);

    const row = await storedRow(res);
    expect(row).toMatchObject({ text: "Bonne fête!", author: "Tomy", content_type: "image/jpeg", seen_at: null });
    expect(await env.PHOTOS.head(`photos/${id}`)).not.toBeNull();
  });

  it("signs unknown senders with the start of their email", async () => {
    const res = await pageFetch("/api/messages", upload(), { email: "marie@example.com" });
    expect((await storedRow(res)).author).toBe("marie");
  });

  it("accepts an empty caption", async () => {
    const res = await pageFetch("/api/messages", upload({ text: "" }));
    expect(res.status).toBe(201);
  });

  it("stores a whitespace-only caption as empty", async () => {
    const res = await pageFetch("/api/messages", upload({ text: "  \n\t " }));
    expect(res.status).toBe(201);
    expect((await storedRow(res)).text).toBe("");
  });

  it("treats a file in the text field as no caption", async () => {
    const opts = upload({ text: null });
    opts.body.append("text", new File(["hello"], "t.txt", { type: "text/plain" }));
    const res = await pageFetch("/api/messages", opts);
    expect(res.status).toBe(201);
    expect((await storedRow(res)).text).toBe("");
  });

  it("stores the type found in the bytes, not the declared one", async () => {
    const res = await pageFetch("/api/messages", upload({ type: "image/jpeg", kind: "png" }));
    expect(res.status).toBe(201);
    expect((await storedRow(res)).content_type).toBe("image/png");
  });

  it("recognises WebP", async () => {
    const res = await pageFetch("/api/messages", upload({ type: "image/webp", kind: "webp" }));
    expect((await storedRow(res)).content_type).toBe("image/webp");
  });

  it("rejects a missing photo", async () => {
    const res = await pageFetch("/api/messages", upload({ photo: false }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "photo_missing" });
  });

  it("rejects other file types", async () => {
    const res = await pageFetch("/api/messages", upload({ type: "image/gif", kind: null }));
    expect(res.status).toBe(415);
  });

  it("rejects bytes that aren't an image, whatever the declared type", async () => {
    const res = await pageFetch("/api/messages", upload({ type: "image/jpeg", kind: null }));
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "photo_type" });
  });

  it("rejects photos over 2 MB", async () => {
    const res = await pageFetch("/api/messages", upload({ size: 2 * 1024 * 1024 + 1 }));
    expect(res.status).toBe(413);
  });

  it("rejects an oversized body from its Content-Length, before reading it", async () => {
    const res = await workerFetch("/api/messages",
      upload({ headers: { "Content-Length": String(100 * 1024 * 1024) } }), env);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "photo_too_big" });
  });

  it("rejects captions over 200 characters", async () => {
    const res = await pageFetch("/api/messages", upload({ text: "é".repeat(201) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "text_too_long" });
  });

  it("removes the stored photo when the database insert fails", async () => {
    let key = null;
    const photos = {
      put(k, ...rest) { key = k; return env.PHOTOS.put(k, ...rest); },
      delete(k) { return env.PHOTOS.delete(k); },
    };
    const failingDb = { prepare() { throw new Error("D1 down"); } };
    const res = await workerFetch("/api/messages", upload(),
      Object.assign({}, env, { DB: failingDb, PHOTOS: photos }));
    expect(res.status).toBe(500);
    expect(key).not.toBeNull();
    expect(await env.PHOTOS.head(key)).toBeNull();
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
  it("serves the photo to the upload page, with defensive headers", async () => {
    const id = await insertMessage({ photo: "xyz" });
    const res = await pageFetch(`/api/photo/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
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

  it("still succeeds when the photo can't be deleted", async () => {
    const id = await insertMessage();
    const photos = { delete() { throw new Error("R2 down"); } };
    const res = await workerFetch(`/api/messages/${id}`, { method: "DELETE" },
      Object.assign({}, env, { PHOTOS: photos }));
    expect(res.status).toBe(204);
    expect(await env.DB.prepare("SELECT 1 FROM messages WHERE id = ?1").bind(id).first()).toBeNull();
  });

  it("404s an unknown id", async () => {
    const res = await pageFetch(`/api/messages/${newId()}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
