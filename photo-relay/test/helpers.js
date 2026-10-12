import { env, SELF } from "cloudflare:test";
import { SignJWT, importJWK } from "jose";

export const BASE = "https://pearboard.test";

export function newId() {
  return crypto.randomUUID().replace(/-/g, "");
}

export function fetchPath(path, init) {
  return SELF.fetch(BASE + path, init);
}

// Inserts a message straight into D1 + R2, bypassing the upload API.
export async function insertMessage({
  id = newId(), text = "Salut", author = "Tomy",
  createdAt = Date.now(), seenAt = null, photo = "fake-jpeg-bytes",
} = {}) {
  await env.PHOTOS.put(`photos/${id}`, photo);
  await env.DB.prepare(
    "INSERT INTO messages (id, text, author, photo_key, content_type, created_at, seen_at)" +
    " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).bind(id, text, author, `photos/${id}`, "image/jpeg", createdAt, seenAt).run();
  return id;
}

export function tvFetch(path, init = {}, token = env.TV_TOKEN) {
  const headers = Object.assign({ Authorization: `Bearer ${token}` }, init.headers);
  return fetchPath(path, Object.assign({}, init, { headers }));
}

// Image bytes: a real magic-byte prefix, padded with zeros up to `size`.
export const MAGIC = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

export function imageBytes(kind = "jpeg", size = 1000) {
  const bytes = new Uint8Array(size);
  bytes.set(MAGIC[kind]);
  return bytes;
}

// A Cloudflare Access JWT signed with the test key (see vitest.config.js).
// email: null leaves the claim out.
export async function accessJwt({
  email = "tomy@example.com",
  aud = env.ACCESS_AUD,
  issuer = `https://${env.ACCESS_TEAM_DOMAIN}`,
  expiresIn = "1h",
} = {}) {
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK), "RS256");
  return new SignJWT(email === null ? {} : { email })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}
