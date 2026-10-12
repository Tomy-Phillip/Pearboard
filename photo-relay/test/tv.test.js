import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { insertMessage, tvFetch, newId } from "./helpers.js";

describe("TV token", () => {
  it("rejects a missing token", async () => {
    const res = await tvFetch("/api/tv/messages", {}, "");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await tvFetch("/api/tv/messages", {}, "wrong");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/tv/messages", () => {
  it("lists only unseen messages, oldest first", async () => {
    const b = await insertMessage({ text: "deux", createdAt: 2000 });
    const a = await insertMessage({ text: "un", createdAt: 1000 });
    await insertMessage({ text: "vu", createdAt: 1500, seenAt: 3000 });

    const res = await tvFetch("/api/tv/messages");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.map((m) => [m.id, m.text])).toEqual([[a, "un"], [b, "deux"]]);
    expect(body.messages[0]).toEqual({ id: a, text: "un", author: "Tomy", createdAt: 1000, seenAt: null });
  });

  it("returns an empty list when nothing is waiting", async () => {
    const res = await tvFetch("/api/tv/messages");
    expect(await res.json()).toEqual({ messages: [] });
  });
});

describe("GET /api/tv/photo/:id", () => {
  it("serves the photo with its content type", async () => {
    const id = await insertMessage({ photo: "abc" });
    const res = await tvFetch(`/api/tv/photo/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(await res.text()).toBe("abc");
  });

  it("404s an unknown id", async () => {
    const res = await tvFetch(`/api/tv/photo/${newId()}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tv/messages/:id/seen", () => {
  it("marks the message seen so it leaves the list", async () => {
    const id = await insertMessage();
    const res = await tvFetch(`/api/tv/messages/${id}/seen`, { method: "POST" });
    expect(res.status).toBe(204);

    const row = await env.DB.prepare("SELECT seen_at FROM messages WHERE id = ?1").bind(id).first();
    expect(row.seen_at).toBeTypeOf("number");
    const list = await (await tvFetch("/api/tv/messages")).json();
    expect(list.messages).toEqual([]);
  });

  it("is idempotent and keeps the first seen time", async () => {
    const id = await insertMessage({ seenAt: 1234 });
    const res = await tvFetch(`/api/tv/messages/${id}/seen`, { method: "POST" });
    expect(res.status).toBe(204);
    const row = await env.DB.prepare("SELECT seen_at FROM messages WHERE id = ?1").bind(id).first();
    expect(row.seen_at).toBe(1234);
  });

  it("404s an unknown id", async () => {
    const res = await tvFetch(`/api/tv/messages/${newId()}/seen`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

it("answers unknown TV paths with a JSON 404", async () => {
  const res = await tvFetch("/api/tv/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
