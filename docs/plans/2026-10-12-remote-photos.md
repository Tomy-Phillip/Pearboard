# Remote Photos Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Send a photo with a caption from a phone (anywhere) and show it full screen on the Pearboard TV until a remote key is pressed; photos queue up and each key press moves to the next.

**Architecture:** A Cloudflare Worker (`photo-relay/`) stores messages in D1 and photos in R2. It serves a phone upload page behind Cloudflare Access, with the Access JWT verified in the Worker, and a token-protected API for the TV. The Android app proxies `/photos/*` from the WebView to the Worker in Kotlin, adding the secret token, like it already does for `/calendar/<n>.ics`. The page polls every 30 s and runs a small queue module (`photo-queue.js`).

**Tech Stack:** Cloudflare Workers (JS modules), D1, R2, Workers static assets, `jose` (JWT), Vitest + `@cloudflare/vitest-pool-workers`, Kotlin (Android WebView), plain ES2017 JS for the TV page, `node --test`.

**Design:** `docs/plans/2026-10-12-remote-photos-design.md` (read it first).

**Branch:** `feature/android-board` (no worktree; the user chose a simple branch).

**Commits:** every commit message ends with a blank line then
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Hard rules carried over from the Android work:**
- TV-side JS (`android-board/app/src/main/assets/web/*.js`) must parse as ES2017. This means no `?.`, no `??`, no object spread `{...x}`, no optional catch binding `catch {}`, and no `.finally(`/`padStart`/`flat`. `npm test` in `android-board/` enforces this. The Worker (`photo-relay/`) and its upload page run on modern runtimes and are exempt.
- TV CSS must avoid `inset:`, flexbox `gap`, `clamp()`/`min()`/`max()`. Use `top/right/bottom/left` and margins.
- Secrets (`PHOTOS_TOKEN`, `TV_TOKEN`, Access values, `AUTHORS` emails) are never committed. They go in `android-board/local.properties` (git-ignored), `photo-relay/.dev.vars` (git-ignored) or `wrangler secret put`.
- Use the Edit/Write tools for file changes. Bash is for running commands and git.
- Check `git status` before each commit. Never stage `*.stackdump`, `node_modules/`, `.wrangler/`, `.dev.vars`, `local.properties` or the root `.gitignore` change (`.gstack/`).

---

## Part A: the Cloudflare Worker (`photo-relay/`)

### Task 1: Scaffold the Worker project with a passing smoke test

**Files:**
- Create: `photo-relay/package.json`
- Create: `photo-relay/wrangler.toml`
- Create: `photo-relay/migrations/0001_messages.sql`
- Create: `photo-relay/vitest.config.js`
- Create: `photo-relay/test/apply-migrations.js`
- Create: `photo-relay/test/smoke.test.js`
- Create: `photo-relay/src/index.js`
- Create: `photo-relay/public/index.html` (placeholder, real page in Task 5)
- Create: `photo-relay/.gitignore`

**Step 1: Install tooling**

```bash
cd photo-relay
npm init -y
npm view @cloudflare/vitest-pool-workers@0.8 peerDependencies
```

Install the pool at `0.8.x`, the `vitest` version its `peerDependencies` asks for, plus `wrangler` and `jose`. Pin exact versions in `package.json`:

```bash
npm install -D --save-exact @cloudflare/vitest-pool-workers@0.8 vitest@<peer version> wrangler
npm install --save-exact jose
```

If `0.8.x` won't install, use the newest pool version. If its config API differs from `defineWorkersConfig` used below, follow its README for the equivalent, and note that in the commit message.

Then edit `package.json` so it has `"private": true`, `"type": "module"`, and these scripts:

```json
"scripts": {
  "test": "vitest run",
  "dev": "wrangler dev",
  "deploy": "wrangler deploy"
}
```

Keep the `dependencies`/`devDependencies` that npm wrote. Set `"name": "pearboard-photo-relay"`.

**Step 2: Write config and schema**

`photo-relay/.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
*.stackdump
```

`photo-relay/wrangler.toml`:

```toml
name = "pearboard-photos"
main = "src/index.js"
compatibility_date = "2024-09-23"

# The upload page (public/) is served as static assets; /api/* reaches the Worker.
[assets]
directory = "./public"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "pearboard-photos"
# Filled in from `wrangler d1 create pearboard-photos` (see README). Not a secret.
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "PHOTOS"
bucket_name = "pearboard-photos"

# Secrets, set with `wrangler secret put` (or .dev.vars locally), never here:
#   TV_TOKEN            token the TV sends as "Authorization: Bearer …"
#   ACCESS_TEAM_DOMAIN  e.g. "myteam.cloudflareaccess.com"
#   ACCESS_AUD          the Access application's Audience (AUD) tag
#   AUTHORS             "email=Name;email=Name" for the "de Tomy" line
```

`photo-relay/migrations/0001_messages.sql`:

```sql
-- One row per photo sent from the upload page. Times are ms since the epoch.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- 32 hex chars
  text TEXT NOT NULL,            -- caption, may be empty, at most 200 chars
  author TEXT NOT NULL,          -- first name shown on the TV
  photo_key TEXT NOT NULL,       -- R2 key, "photos/<id>"
  content_type TEXT NOT NULL,    -- image/jpeg | image/png | image/webp
  created_at INTEGER NOT NULL,
  seen_at INTEGER                -- NULL until passed on the TV
);
CREATE INDEX messages_unseen ON messages (seen_at, created_at);
```

`photo-relay/vitest.config.js`:

```js
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { generateKeyPair, exportJWK } from "jose";

// Tests sign their own Cloudflare Access JWTs: a throwaway key pair whose public
// half the Worker trusts through ACCESS_JWKS_JSON (test-only binding).
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = Object.assign(await exportJWK(publicKey), { kid: "test", alg: "RS256" });
  const priv = Object.assign(await exportJWK(privateKey), { kid: "test", alg: "RS256" });
  return {
    test: {
      setupFiles: ["./test/apply-migrations.js"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              TV_TOKEN: "test-tv-token",
              ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
              ACCESS_AUD: "test-aud",
              AUTHORS: "tomy@example.com=Tomy",
              ACCESS_JWKS_JSON: JSON.stringify({ keys: [pub] }),
              TEST_ACCESS_PRIVATE_JWK: JSON.stringify(priv),
            },
          },
        },
      },
    },
  };
});
```

`photo-relay/test/apply-migrations.js`:

```js
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`photo-relay/public/index.html` (placeholder):

```html
<!doctype html>
<meta charset="utf-8">
<title>Pearboard — photos</title>
```

**Step 3: Write the failing smoke test**

`photo-relay/test/smoke.test.js`:

```js
import { SELF } from "cloudflare:test";
import { it, expect } from "vitest";

it("answers unknown API paths with a JSON 404", async () => {
  const res = await SELF.fetch("https://pearboard.test/api/tv/nope", {
    headers: { Authorization: "Bearer test-tv-token" },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
```

**Step 4: Run and verify it fails**

Run: `cd photo-relay && npm test`
Expected: FAIL. `src/index.js` is missing.

**Step 5: Minimal Worker**

`photo-relay/src/index.js`:

```js
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
```

**Step 6: Run and verify it passes**

Run: `npm test`
Expected: 1 passed.

**Step 7: Commit**

```bash
git add photo-relay
git commit -m "Scaffold the photo relay Worker (D1, R2, Vitest)"
```

---

### Task 2: TV API (token, unseen list, photo, mark seen)

**Files:**
- Create: `photo-relay/test/helpers.js`
- Create: `photo-relay/test/tv.test.js`
- Modify: `photo-relay/src/index.js`
- Delete: `photo-relay/test/smoke.test.js` (covered by tv.test.js)

**Step 1: Test helpers**

`photo-relay/test/helpers.js`:

```js
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

// A Cloudflare Access JWT signed with the test key (see vitest.config.js).
export async function accessJwt({
  email = "tomy@example.com",
  aud = env.ACCESS_AUD,
  issuer = `https://${env.ACCESS_TEAM_DOMAIN}`,
  expiresIn = "1h",
} = {}) {
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK), "RS256");
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}
```

**Step 2: Write failing tests**

`photo-relay/test/tv.test.js`:

```js
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
```

Delete `photo-relay/test/smoke.test.js`.

**Step 3: Run and verify they fail**

Run: `npm test`
Expected: FAIL. Every request gets 404, and the 401 and 200 expectations fail.

**Step 4: Implement**

Replace `photo-relay/src/index.js` with:

```js
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
```

**Step 5: Run and verify they pass**

Run: `npm test`
Expected: all tv.test.js tests pass.

**Step 6: Commit**

```bash
git add photo-relay
git commit -m "Photo relay: token-protected TV API (unseen list, photo, seen)"
```

---

### Task 3: Cloudflare Access JWT verification

**Files:**
- Create: `photo-relay/src/access.js`
- Create: `photo-relay/test/access.test.js`

**Step 1: Write failing tests**

`photo-relay/test/access.test.js`:

```js
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { verifyAccess, authorName } from "../src/access.js";
import { accessJwt } from "./helpers.js";

describe("verifyAccess", () => {
  it("accepts a JWT signed by the team key, for our audience", async () => {
    const payload = await verifyAccess(await accessJwt(), env);
    expect(payload.email).toBe("tomy@example.com");
  });

  it("rejects another audience", async () => {
    await expect(verifyAccess(await accessJwt({ aud: "other" }), env)).rejects.toThrow();
  });

  it("rejects another issuer", async () => {
    await expect(verifyAccess(await accessJwt({ issuer: "https://evil.cloudflareaccess.com" }), env))
      .rejects.toThrow();
  });

  it("rejects an expired JWT", async () => {
    await expect(verifyAccess(await accessJwt({ expiresIn: "-1m" }), env)).rejects.toThrow();
  });

  it("rejects a JWT signed by another key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "tomy@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`)
      .setAudience(env.ACCESS_AUD)
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(verifyAccess(forged, env)).rejects.toThrow();
  });
});

describe("authorName", () => {
  it("maps a known email to its first name, ignoring case", () => {
    expect(authorName("Tomy@Example.com", "tomy@example.com=Tomy;lily@example.com=Lily")).toBe("Tomy");
  });

  it("falls back to the part before @", () => {
    expect(authorName("marie.d@example.com", "tomy@example.com=Tomy")).toBe("marie.d");
  });

  it("copes with an empty or missing list", () => {
    expect(authorName("x@y.z", "")).toBe("x");
    expect(authorName("x@y.z", undefined)).toBe("x");
  });
});
```

**Step 2: Run and verify they fail**

Run: `npm test`
Expected: FAIL. `../src/access.js` can't be resolved.

**Step 3: Implement**

`photo-relay/src/access.js`:

```js
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access signs a JWT for every request it lets through and sends it as
// Cf-Access-Jwt-Assertion. Checking it here means a misconfigured Access policy
// (or a request that reaches the Worker some other way) still can't use the page API.
let remoteKeys = null;
let remoteKeysUrl = null;

function teamKeys(env) {
  // Test-only: vitest.config.js provides its own public key.
  if (env.ACCESS_JWKS_JSON) return createLocalJWKSet(JSON.parse(env.ACCESS_JWKS_JSON));
  const url = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  if (remoteKeysUrl !== url) {
    remoteKeys = createRemoteJWKSet(new URL(url)); // fetches and caches the team's keys
    remoteKeysUrl = url;
  }
  return remoteKeys;
}

// Resolves with the JWT payload ({ email, … }); rejects if it isn't valid for us.
export async function verifyAccess(token, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error("Access not configured");
  const { payload } = await jwtVerify(token, teamKeys(env), {
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    audience: env.ACCESS_AUD,
  });
  return payload;
}

// AUTHORS = "tomy@example.com=Tomy;lily@example.com=Lily"
export function authorName(email, authors) {
  const wanted = email.toLowerCase();
  for (const pair of String(authors || "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim().toLowerCase() === wanted) return pair.slice(eq + 1).trim();
  }
  return email.split("@")[0];
}
```

**Step 4: Run and verify they pass**

Run: `npm test`
Expected: all pass.

**Step 5: Commit**

```bash
git add photo-relay
git commit -m "Photo relay: verify Cloudflare Access JWTs and map emails to names"
```

---

### Task 4: Upload page API (create, history, photo, delete)

**Files:**
- Create: `photo-relay/test/page.test.js`
- Modify: `photo-relay/src/index.js`

**Step 1: Write failing tests**

`photo-relay/test/page.test.js`:

```js
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
```

**Step 2: Run and verify they fail**

Run: `npm test`
Expected: FAIL. `/api/messages` answers 404 instead of 403, 201, and so on.

**Step 3: Implement**

In `photo-relay/src/index.js`:

1. Add at the top: `import { verifyAccess, authorName } from "./access.js";`
2. Add constants and handlers above `export default`:

```js
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 200;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const HISTORY_LIMIT = 30;

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The signed-in sender's email, or null. DEV_ACCESS_EMAIL (in .dev.vars) stands in
// for Access under `wrangler dev`, and only for requests to localhost.
async function accessEmail(request, env, url) {
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (env.DEV_ACCESS_EMAIL && local) return env.DEV_ACCESS_EMAIL;
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
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return json({ error: "bad_form" }, 400);
  }
  const photo = form.get("photo");
  const text = String(form.get("text") || "").trim();
  if (!(photo instanceof File)) return json({ error: "photo_missing" }, 400);
  if (!PHOTO_TYPES.includes(photo.type)) return json({ error: "photo_type" }, 415);
  if (photo.size > MAX_PHOTO_BYTES) return json({ error: "photo_too_big" }, 413);
  if (Array.from(text).length > MAX_TEXT_CHARS) return json({ error: "text_too_long" }, 400);

  const id = newId();
  const key = `photos/${id}`;
  await env.PHOTOS.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } });
  await env.DB.prepare(
    "INSERT INTO messages (id, text, author, photo_key, content_type, created_at)" +
    " VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(id, text, author, key, photo.type, Date.now()).run();
  return json({ id }, 201);
}

async function handlePage(request, env, url) {
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
    await env.PHOTOS.delete(row.photo_key);
    return new Response(null, { status: 204 });
  }

  return notFound();
}
```

3. In `fetch`, replace `if (url.pathname.startsWith("/api/")) return notFound();` with
   `if (url.pathname.startsWith("/api/")) return await handlePage(request, env, url);`

**Step 4: Run and verify they pass**

Run: `npm test`
Expected: all pass (tv, access, page).

**Step 5: Commit**

```bash
git add photo-relay
git commit -m "Photo relay: upload page API behind Cloudflare Access"
```

---

### Task 5: Upload page (phone)

**Files:**
- Modify: `photo-relay/public/index.html`
- Create: `photo-relay/public/upload.js`
- Create: `photo-relay/public/upload.css`

This page runs on modern phone browsers only, so modern JS is fine. It has no automated test; check it manually in Step 3.

**Step 1: Write the page**

`photo-relay/public/index.html`:

```html
<!doctype html>
<html lang="fr-CA">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pearboard — photos</title>
  <link rel="stylesheet" href="upload.css">
</head>
<body>
  <main>
    <h1>Envoyer au Pearboard</h1>

    <form id="form">
      <label class="pick" id="pick">
        <input type="file" id="file" accept="image/*" hidden>
        <img id="preview" alt="" hidden>
        <span id="pick-label">Choisir une photo</span>
      </label>
      <textarea id="text" maxlength="200" rows="3" placeholder="Votre message (facultatif)"></textarea>
      <div class="count"><span id="count">0</span> / 200</div>
      <button type="submit" id="send" disabled>Envoyer au Pearboard</button>
      <p class="status" id="status" role="status"></p>
    </form>

    <h2>Derniers envois</h2>
    <ul class="history" id="history"></ul>
  </main>
  <script src="upload.js" type="module"></script>
</body>
</html>
```

`photo-relay/public/upload.css`:

```css
:root { --bg: #f2f4f3; --card: #fff; --text: #1d2320; --muted: #6b716e; --accent: #1d2320; --ok: #2f8a4c; --err: #b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1012; --card: #191d20; --text: #e8ebe9; --muted: #949b97; --accent: #e8ebe9; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.4 system-ui, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 16px; }
h1 { font-size: 24px; margin: 8px 0 16px; }
h2 { font-size: 18px; margin: 28px 0 12px; }
form { background: var(--card); border-radius: 20px; padding: 16px; display: grid; gap: 12px; }
.pick { display: grid; place-items: center; min-height: 180px; border: 2px dashed var(--muted); border-radius: 14px; overflow: hidden; cursor: pointer; }
.pick img { width: 100%; max-height: 420px; object-fit: contain; display: block; }
#pick-label { padding: 24px; font-weight: 600; }
.pick.has-photo { border-style: solid; }
.pick.has-photo #pick-label { display: none; }
textarea { width: 100%; font: inherit; padding: 12px; border-radius: 12px; border: 1px solid var(--muted); background: transparent; color: inherit; resize: vertical; }
.count { text-align: right; color: var(--muted); font-size: 13px; margin-top: -8px; }
button { font: inherit; font-weight: 600; padding: 14px; border: 0; border-radius: 12px; background: var(--accent); color: var(--bg); }
button:disabled { opacity: 0.4; }
.status { margin: 0; min-height: 1.4em; }
.status.ok { color: var(--ok); }
.status.err { color: var(--err); }
.history { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.history li { display: grid; grid-template-columns: 64px 1fr auto; gap: 12px; align-items: center; background: var(--card); border-radius: 14px; padding: 8px; }
.history img { width: 64px; height: 64px; object-fit: cover; border-radius: 10px; }
.history .meta { color: var(--muted); font-size: 13px; }
.history .del { background: transparent; color: var(--err); padding: 8px; font-weight: 500; }
```

`photo-relay/public/upload.js`:

```js
// Phone upload page: shrink the photo in the browser, post it with the caption,
// and list recent sends with their "seen on the TV" state.
const MAX_LONG = 1920;
const MAX_SHORT = 1080;
const $ = (id) => document.getElementById(id);
let shrunk = null; // Blob ready to send

const timeFmt = new Intl.DateTimeFormat("fr-CA", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// Upright (EXIF orientation), at most 1080×1920 (either way round), JPEG.
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const long = Math.max(bmp.width, bmp.height);
  const short = Math.min(bmp.width, bmp.height);
  const scale = Math.min(1, MAX_LONG / long, MAX_SHORT / short);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.85));
}

function setStatus(msg, kind = "") {
  $("status").textContent = msg;
  $("status").className = `status ${kind}`;
}

$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  shrunk = null;
  $("send").disabled = true;
  if (!file) return;
  setStatus("Préparation de la photo…");
  try {
    shrunk = await shrink(file);
    $("preview").src = URL.createObjectURL(shrunk);
    $("preview").hidden = false;
    $("pick").classList.add("has-photo");
    $("send").disabled = false;
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("Impossible de lire cette photo.", "err");
  }
});

$("text").addEventListener("input", () => {
  $("count").textContent = Array.from($("text").value).length;
});

const ERRORS = {
  photo_type: "Format non pris en charge (JPEG, PNG ou WebP).",
  photo_too_big: "Photo trop lourde (2 Mo max).",
  text_too_long: "Message trop long (200 caractères max).",
  forbidden: "Session expirée : rechargez la page.",
};

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!shrunk) return;
  $("send").disabled = true;
  setStatus("Envoi…");
  const form = new FormData();
  form.append("photo", new File([shrunk], "photo.jpg", { type: "image/jpeg" }));
  form.append("text", $("text").value.trim());
  try {
    const res = await fetch("/api/messages", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(ERRORS[body.error] || `Erreur ${res.status}`);
    }
    setStatus("Envoyé ! La photo apparaîtra sur la TV d'ici une minute.", "ok");
    $("form").reset();
    $("count").textContent = "0";
    $("preview").hidden = true;
    $("pick").classList.remove("has-photo");
    shrunk = null;
    loadHistory();
  } catch (err) {
    setStatus(err.message, "err");
    $("send").disabled = false;
  }
});

async function loadHistory() {
  const res = await fetch("/api/messages", { cache: "no-store" });
  if (!res.ok) return;
  const { messages } = await res.json();
  $("history").replaceChildren(...messages.map((m) => {
    const li = document.createElement("li");
    const img = document.createElement("img");
    img.src = `/api/photo/${m.id}`;
    img.loading = "lazy";
    img.alt = "";
    const info = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = m.text || "(sans texte)";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${m.author} · ${timeFmt.format(m.createdAt)} · ` +
      (m.seenAt ? `Vue le ${timeFmt.format(m.seenAt)}` : "En attente");
    info.append(text, meta);
    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "Supprimer";
    del.addEventListener("click", async () => {
      if (!confirm("Supprimer cette photo ?")) return;
      const r = await fetch(`/api/messages/${m.id}`, { method: "DELETE" });
      if (r.ok) loadHistory();
    });
    li.append(img, info, del);
    return li;
  }));
}

loadHistory();
```

**Step 2: Local dev setup**

Create `photo-relay/.dev.vars`. It is git-ignored; never commit it:

```
DEV_ACCESS_EMAIL=tomy@example.com
TV_TOKEN=dev-token
AUTHORS=tomy@example.com=Tomy
```

**Step 3: Manual check**

```bash
cd photo-relay
npx wrangler d1 migrations apply pearboard-photos --local
npx wrangler dev
```

Use `/browse` (gstack) on `http://localhost:8787/`. Upload a large test image with `$B upload "#file" <path>`; you can create one with Python/Pillow in the scratchpad. Type a caption, submit, and check that:
- the status shows "Envoyé !";
- the history lists the item as "En attente" with a thumbnail.

Then run:

```bash
curl -s -H "Authorization: Bearer dev-token" http://localhost:8787/api/tv/messages
```

It should list the message. Delete the item from the page (`$B dialog-accept`, then click "Supprimer") and confirm it disappears. Stop `wrangler dev` and run `browse stop`.

**Step 4: Run tests and commit**

Run: `npm test`. It must still pass.

```bash
git add photo-relay/public
git commit -m "Photo relay: phone upload page with in-browser resize and history"
```

---

### Task 6: Photo relay README (setup and deploy)

**Files:**
- Create: `photo-relay/README.md`
- Modify: `README.md` (root: add a `photo-relay/` row to its table)

**Step 1: Write `photo-relay/README.md`** in French. Include these sections:

- **À quoi ça sert**: one paragraph, plus a link to the design doc.
- **Mise en place (une fois)**: exact commands, in order:
  1. `npm install`
  2. `npx wrangler login`
  3. `npx wrangler d1 create pearboard-photos`. Copy the printed `database_id` into `wrangler.toml`. It is not a secret, so it can be committed.
  4. `npx wrangler r2 bucket create pearboard-photos`
  5. `npx wrangler d1 migrations apply pearboard-photos --remote`
  6. `npx wrangler deploy`. Note the URL `https://pearboard-photos.<sous-domaine>.workers.dev`.
  7. **Cloudflare Access** (tableau de bord Cloudflare → Zero Trust; choose a team name and the Free plan):
     - Access → Applications → Add → Self-hosted. Domain: the workers.dev host. Policy "Famille": Action Allow, Include Emails, your email(s). Save, then copy the **Application Audience (AUD) Tag**.
     - Add a second Self-hosted application on the same domain with path `api/tv`. Policy: Action **Bypass**, Include **Everyone**. The TV uses its own token there.
  8. Secrets, each entered at the prompt:
     - `npx wrangler secret put ACCESS_TEAM_DOMAIN`, e.g. `monequipe.cloudflareaccess.com`
     - `npx wrangler secret put ACCESS_AUD`
     - `npx wrangler secret put AUTHORS`, e.g. `tomy@…=Tomy;lily@…=Lily`
     - `npx wrangler secret put TV_TOKEN`, generated with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it for `local.properties`.
  9. Check: opening the URL on a phone asks for the email code, then shows the page. `curl https://…/api/tv/messages` without a token returns `{"error":"unauthorized"}`. That proves the bypass works and the token is still required.
- **Ajouter une personne**: add the email to the Access policy and to `AUTHORS`.
- **Développer en local**: `.dev.vars` contents (from Task 5), `npx wrangler d1 migrations apply pearboard-photos --local`, `npm run dev`, `npm test`.
- **Changer le jeton de la TV**: `npx wrangler secret put TV_TOKEN`, then update `PHOTOS_TOKEN` in `android-board/local.properties` and rebuild the APK.

**Step 2:** Read the root `README.md` and add a `photo-relay/` row to its table, matching the existing columns. Description: « Relais Cloudflare pour envoyer des photos au Pearboard depuis un téléphone ».

**Step 3: Commit**

```bash
git add photo-relay/README.md README.md
git commit -m "Document photo relay setup and deploy"
```

---

## Part B: the Android app

### Task 7: Build config and Kotlin proxy

**Files:**
- Modify: `android-board/app/build.gradle.kts`
- Create: `android-board/app/src/main/java/com/pearboard/tv/PhotoProxy.kt`
- Modify: `android-board/app/src/main/java/com/pearboard/tv/MainActivity.kt` (`shouldInterceptRequest`)

This project has no JVM unit tests. Verification is a build plus the dev and TV checks in Tasks 9 and 10.

**Step 1: `build.gradle.kts`**

After the `rotation` block, add:

```kotlin
// Remote photos (photo-relay/): Worker address and the TV's token. Both optional;
// without PHOTOS_URL the feature is off.
val photosUrl: String = localProp("PHOTOS_URL").trimEnd('/')
val photosToken: String = localProp("PHOTOS_TOKEN")
require(photosUrl.isEmpty() || photosToken.isNotEmpty()) {
    "PHOTOS_URL is set in local.properties but PHOTOS_TOKEN is missing"
}
```

In `defaultConfig`, after the `CALENDAR_URLS` field:

```kotlin
        buildConfigField("String", "PHOTOS_URL", javaString(photosUrl))
        buildConfigField("String", "PHOTOS_TOKEN", javaString(photosToken))
```

In the `webConfigJson` map, add `"photos" to photosUrl.isNotEmpty(),`. This tells the page only whether the feature is on, never the URL or token.

**Step 2: `PhotoProxy.kt`**

```kotlin
package com.pearboard.tv

import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Relays the page's /photos/* requests to the photo-relay Worker's TV API,
 * adding the secret token, which never reaches JS:
 *   GET  /photos/messages    → GET  {PHOTOS_URL}/api/tv/messages
 *   GET  /photos/photo/<id>  → GET  {PHOTOS_URL}/api/tv/photo/<id>
 *   POST /photos/seen/<id>   → POST {PHOTOS_URL}/api/tv/messages/<id>/seen
 * The Worker's status (200, 204, 401, 404…) is passed through; 502 = unreachable.
 */
object PhotoProxy {
    private const val TAG = "PhotoProxy"
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 20_000

    private val PHOTO = Regex("/photos/photo/([a-f0-9]{32})")
    private val SEEN = Regex("/photos/seen/([a-f0-9]{32})")

    /** The response for a /photos/ request, or null when the path isn't one of ours. */
    fun handle(method: String, path: String): WebResourceResponse? {
        if (!path.startsWith("/photos/")) return null
        val base = BuildConfig.PHOTOS_URL
        if (base.isEmpty()) return plain(404, "Not configured")
        val photo = PHOTO.matchEntire(path)
        val seen = SEEN.matchEntire(path)
        return when {
            method == "GET" && path == "/photos/messages" -> forward("GET", "$base/api/tv/messages")
            method == "GET" && photo != null -> forward("GET", "$base/api/tv/photo/${photo.groupValues[1]}")
            method == "POST" && seen != null -> forward("POST", "$base/api/tv/messages/${seen.groupValues[1]}/seen")
            else -> plain(404, "Not found")
        }
    }

    private fun forward(method: String, url: String): WebResourceResponse = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.requestMethod = method
            conn.setRequestProperty("Authorization", "Bearer ${BuildConfig.PHOTOS_TOKEN}")
            if (method == "POST") {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(0)
                conn.outputStream.close()
            }
            val status = conn.responseCode
            val stream = if (status < 400) conn.inputStream else conn.errorStream
            val body = stream?.use { it.readBytes() } ?: ByteArray(0)
            val mime = (conn.contentType ?: "application/octet-stream").substringBefore(';').trim()
            if (status >= 400) Log.w(TAG, "$method ${URL(url).path} → HTTP $status")
            WebResourceResponse(
                mime, "utf-8", status, conn.responseMessage?.takeIf { it.isNotBlank() } ?: "Status",
                mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(body),
            )
        } finally {
            conn.disconnect()
        }
    } catch (e: Exception) {
        // Also covers a 3xx (WebResourceResponse rejects those) and a mistyped PHOTOS_URL.
        Log.w(TAG, "$method ${url.substringAfter("/api/")} failed", e)
        plain(502, "Fetch failed")
    }

    private fun plain(code: Int, reason: String) = WebResourceResponse(
        "text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
}
```

**Step 3: `MainActivity.kt`**

In `PearboardWebViewClient.shouldInterceptRequest`, inside the `if (url.host == WebViewAssetLoader.DEFAULT_DOMAIN) { … }` block, after the calendar match, add:

```kotlin
                PhotoProxy.handle(request.method, url.path ?: "")?.let { return it }
```

**Step 4: Build**

Run from `android-board/`: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL. `app/build/generated/config-assets/web/config.js` contains `"photos":false`, unless `local.properties` already has `PHOTOS_URL`.

**Step 5: Commit**

```bash
git add android-board/app/build.gradle.kts android-board/app/src/main/java/com/pearboard/tv/PhotoProxy.kt android-board/app/src/main/java/com/pearboard/tv/MainActivity.kt
git commit -m "Android: proxy /photos/* to the photo relay with the TV token"
```

---

### Task 8: Photo queue module (TV page logic, TDD)

**Files:**
- Create: `android-board/app/src/main/assets/web/photo-queue.js`
- Create: `android-board/test/photo-queue.test.js`
- Modify: `android-board/test/runtime-api.test.js` (add `"photo-queue.js"` to `FILES`)

**Step 1: Write failing tests**

`android-board/test/photo-queue.test.js`:

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PhotoQueue = require("../app/src/main/assets/web/photo-queue.js");

const msg = (id, createdAt) => ({ id, text: "t" + id, author: "Tomy", createdAt });

test("starts empty", () => {
  const q = PhotoQueue.create();
  assert.equal(q.current(), null);
  assert.equal(q.size(), 0);
});

test("keeps the server's order and doesn't duplicate on later polls", () => {
  const q = PhotoQueue.create();
  assert.equal(q.merge([msg("a", 1), msg("b", 2)]), 2);
  assert.equal(q.merge([msg("a", 1), msg("b", 2), msg("c", 3)]), 1);
  assert.deepEqual(q.ids(), ["a", "b", "c"]);
  assert.equal(q.current().id, "a");
});

test("a message arriving while one is shown goes to the end", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1)]);
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.equal(q.current().id, "a");
  assert.equal(q.size(), 2);
});

test("dismiss moves to the next and remembers the seen id to send", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.equal(q.dismiss(), "a");
  assert.equal(q.current().id, "b");
  assert.deepEqual(q.unsentSeen(), ["a"]);
});

test("a dismissed message is not re-queued while its seen is unsent", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1)]);
  q.dismiss();
  // The server still lists it (the "seen" POST failed): don't show it again.
  assert.equal(q.merge([msg("a", 1)]), 0);
  assert.equal(q.current(), null);
});

test("markSent clears the pending seen; the id is forgotten once the server drops it", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1)]);
  q.dismiss();
  q.markSent("a");
  assert.deepEqual(q.unsentSeen(), []);
  // Still listed by a poll that raced the POST: still not shown.
  assert.equal(q.merge([msg("a", 1)]), 0);
  // Server no longer lists it: forgotten (keeps memory bounded).
  q.merge([]);
  assert.equal(q.knows("a"), false);
});

test("skip drops the current message without marking it seen, so a later poll brings it back", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1), msg("b", 2)]);
  q.skip();
  assert.equal(q.current().id, "b");
  assert.deepEqual(q.unsentSeen(), []);
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.deepEqual(q.ids(), ["b", "a"]);
});

test("ignores malformed entries", () => {
  const q = PhotoQueue.create();
  assert.equal(q.merge([null, {}, { id: 5 }, msg("a", 1)]), 1);
  assert.deepEqual(q.ids(), ["a"]);
});
```

**Step 2: Run and verify they fail**

Run from `android-board/`: `node --test test/photo-queue.test.js`
Expected: FAIL. The module can't be found.

**Step 3: Implement**

`android-board/app/src/main/assets/web/photo-queue.js`. It must be ES2017, so no object spread, no `?.`, no `??`:

```js
/* The TV's queue of remote photos: what to show next, and which "seen" reports
 * still have to reach the server. UMD so node --test can load it too. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PhotoQueue = factory();
})(this, function () {
  "use strict";

  function create() {
    const queue = [];      // messages to show; queue[0] is the one on screen
    const passed = {};     // id → true once passed on the TV, until the server stops listing it
    let unsent = [];       // passed ids whose "seen" hasn't been acknowledged

    function isQueued(id) {
      return queue.some(function (m) { return m.id === id; });
    }

    return {
      // Adds the server's unseen messages that aren't queued or already passed,
      // in the server's order (oldest first). Returns how many were added.
      merge: function (messages) {
        const listed = {};
        let added = 0;
        (messages || []).forEach(function (m) {
          if (!m || typeof m.id !== "string") return;
          listed[m.id] = true;
          if (passed[m.id] || isQueued(m.id)) return;
          queue.push(m);
          added++;
        });
        // Passed ids the server no longer lists (their "seen" landed): forget them.
        Object.keys(passed).forEach(function (id) {
          if (!listed[id] && unsent.indexOf(id) === -1) delete passed[id];
        });
        return added;
      },
      current: function () { return queue.length ? queue[0] : null; },
      size: function () { return queue.length; },
      ids: function () { return queue.map(function (m) { return m.id; }); },
      knows: function (id) { return !!passed[id] || isQueued(id); },
      // The viewer pressed a key: drop the shown message and remember to report it.
      dismiss: function () {
        const m = queue.shift();
        if (!m) return null;
        passed[m.id] = true;
        unsent.push(m.id);
        return m.id;
      },
      // The shown message's photo wouldn't load: drop it for now; the next poll re-adds it.
      skip: function () { queue.shift(); },
      unsentSeen: function () { return unsent.slice(); },
      markSent: function (id) {
        unsent = unsent.filter(function (x) { return x !== id; });
      },
    };
  }

  return { create: create };
});
```

Add `"photo-queue.js"` to `FILES` in `android-board/test/runtime-api.test.js`.

**Step 4: Run and verify they pass**

Run from `android-board/`: `npm test`
Expected: all pass, including `photo-queue.js parses as ES2017` and its runtime-API guard.

**Step 5: Commit**

```bash
git add android-board/app/src/main/assets/web/photo-queue.js android-board/test/photo-queue.test.js android-board/test/runtime-api.test.js
git commit -m "TV page: photo queue (order, dismiss, pending seen, skip)"
```

---

### Task 9: TV page — full-screen photo view, polling, remote keys

**Files:**
- Modify: `android-board/app/src/main/assets/web/index.html`
- Modify: `android-board/app/src/main/assets/web/style.css`
- Modify: `android-board/app/src/main/assets/web/app.js`
- Modify: `android-board/dev-server.js` (mock `/photos/*`)

**Step 1: `index.html`**

1. Before `<script src="app.js" defer></script>`, add `<script src="photo-queue.js" defer></script>`. Deferred scripts run in order.
2. Inside `.card--clock`, as its last child, add:

```html
        <div class="photo-warning hidden" id="photo-warning">Photos : jeton refusé</div>
```

3. As the last child of `#stage`, after `#day-panel`, add:

```html
    <!-- A photo sent from the phone (photo-relay/): full screen until a key is pressed. -->
    <div class="photo-view hidden" id="photo-view">
      <img class="photo-img" id="photo-img" alt="" />
      <div class="photo-caption">
        <div class="photo-text" id="photo-text"></div>
        <div class="photo-meta">
          <span id="photo-from"></span>
          <span class="photo-count" id="photo-count"></span>
        </div>
      </div>
    </div>
```

**Step 2: `style.css`**

Append the rules below. They avoid `inset`, flexbox `gap` and `clamp`, and the bandeau stays dark in both themes:

```css
/* =========================================================================
 * Remote photo — full screen over everything until a key is pressed
 * ========================================================================= */

.photo-view {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  background: #000000;
}

.photo-img { display: block; width: 100%; height: 100%; object-fit: cover; }

.photo-caption {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 160px 60px 64px;
  background: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.85) 55%);
  color: #ffffff;
}

.photo-text { font-size: 64px; font-weight: 600; line-height: 1.2; }
.photo-text:empty { display: none; }

.photo-meta { display: flex; align-items: baseline; margin-top: 18px; font-size: 32px; opacity: 0.85; }
.photo-count { margin-left: auto; }

.photo-warning {
  position: absolute;
  top: 22px;
  right: 30px;
  font-size: 20px;
  color: var(--warning);
}
```

**Step 3: `app.js`**

Make these edits in order. Stick to ES2017; `try { } finally { }` blocks are allowed, but `.finally(` is not.

1. `CONFIG`: add `PHOTOS_POLL_MS: 30 * 1000, // remote photos, when config.js says photos: true`.
2. After `const CALENDARS = …`, add:

```js
// Remote photos (photo-relay/): on when the build has a PHOTOS_URL.
const photos = BOARD.photos && window.PhotoQueue ? window.PhotoQueue.create() : null;
const photoView = { showing: false, loadingId: null, polling: false };
```

3. `dom`: add
   - `photoView: $("photo-view")`
   - `photoImg: $("photo-img")`
   - `photoText: $("photo-text")`
   - `photoFrom: $("photo-from")`
   - `photoCount: $("photo-count")`
   - `photoWarning: $("photo-warning")`
4. `formatAge`: support days. Replace the last line (`return \`${Math.round(min / 60)} h\`;`) with:

```js
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} j`;
```

5. Add a new section before the "Navigation" section:

```js
/* =========================================================================
 * Remote photos — polled through MainActivity's /photos/* proxy
 * ========================================================================= */

function renderPhotoMeta() {
  const m = photos.current();
  if (!m) return;
  dom.photoText.textContent = m.text || "";
  dom.photoFrom.textContent = `de ${m.author} · il y a ${formatAge(Date.now() - m.createdAt)}`;
  dom.photoCount.textContent = photos.size() > 1 ? `1 / ${photos.size()}` : "";
}

// Preloads the queue's first photo, then shows it; with an empty queue, back to the board.
function showCurrentPhoto() {
  const m = photos.current();
  if (!m) {
    photoView.showing = false;
    dom.photoView.classList.add("hidden");
    dom.photoImg.removeAttribute("src");
    focusCell(state.focusedDateKey);
    return;
  }
  if (photoView.loadingId === m.id) return;
  photoView.loadingId = m.id;
  const img = new Image();
  img.onload = () => {
    photoView.loadingId = null;
    if (photos.current() !== m) return; // dismissed or skipped meanwhile
    dom.photoImg.src = img.src;
    renderPhotoMeta();
    dom.photoView.classList.remove("hidden");
    photoView.showing = true;
  };
  img.onerror = () => {
    photoView.loadingId = null;
    console.warn("[photos] photo failed to load:", m.id);
    if (photos.current() === m) photos.skip(); // not marked seen: the next poll retries it
    showCurrentPhoto();
  };
  img.src = `/photos/photo/${m.id}`;
}

// Any remote key while a photo is up: pass it (marked seen) and show the next.
function advancePhoto() {
  if (photoView.loadingId) return; // next photo still loading; ignore extra presses
  photos.dismiss();
  sendSeen();
  showCurrentPhoto();
}

async function sendSeen() {
  for (const id of photos.unsentSeen()) {
    try {
      const r = await fetch(`/photos/seen/${id}`, { method: "POST" });
      // 404: deleted from the upload page meanwhile, nothing left to report.
      if (r.ok || r.status === 404) photos.markSent(id);
    } catch (err) {
      console.warn("[photos] seen not sent, will retry:", id, err);
    }
  }
}

async function pollPhotos() {
  if (photoView.polling) return;
  photoView.polling = true;
  try {
    await sendSeen();
    const r = await fetch("/photos/messages", { cache: "no-store" });
    dom.photoWarning.classList.toggle("hidden", r.status !== 401);
    if (!r.ok) return;
    const body = await r.json();
    photos.merge(body.messages || []);
    if (photoView.showing) renderPhotoMeta();
    else showCurrentPhoto();
  } catch (err) {
    console.warn("[photos] poll failed:", err);
  } finally {
    photoView.polling = false;
  }
}

function startPhotos() {
  if (!photos) return;
  pollPhotos();
  setInterval(pollPhotos, CONFIG.PHOTOS_POLL_MS);
}
```

6. `window.pearboardBack`: right after `state.lastInputAt = Date.now(); …`, add
   `if (photoView.showing) { advancePhoto(); return true; }`
7. `window.pearboardToggleView`: right after `state.lastInputAt = Date.now(); …`, add
   `if (photoView.showing) { advancePhoto(); return; }`
8. Replace `wireEvents` with the version below. `markInput` must be registered **before** the photo key handler, which swallows every key while a photo is up:

```js
function wireEvents() {
  dom.dayPanelClose.addEventListener("click", closeDayPanel);
  // Capture phase so the idle timer sees every key and click, whatever handles it.
  const markInput = () => { state.lastInputAt = Date.now(); };
  document.addEventListener("keydown", markInput, true);
  document.addEventListener("click", markInput, true);
  // A photo on screen takes every key: it moves to the next photo and does nothing else.
  document.addEventListener("keydown", (e) => {
    if (!photoView.showing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) advancePhoto();
  }, true);
  document.addEventListener("keydown", onKeyDown);
}
```

9. In `tickClock`'s `if (now.getSeconds() === 0) { … }` block, add `if (photoView.showing) renderPhotoMeta();` so "il y a N min" stays current.
10. `init`: after `startCalendar();`, add `startPhotos();`.

`renderCalendar` and the idle reset keep focusing calendar cells underneath the photo. That's harmless, because keys are captured at the document level while a photo shows.

**Step 4: `dev-server.js` mock**

Add an in-memory mock, enabled with `DEV_PHOTOS=1`, so the view can be checked in a desktop browser:

- In the `CONFIG_JS` object, add `photos: !!process.env.DEV_PHOTOS`.
- Keep a list:

```js
// DEV_PHOTOS=1: two fake remote photos, removed as the page marks them seen.
const devPhotos = process.env.DEV_PHOTOS ? [
  { id: "a".repeat(32), text: "Bonne fête Lily ! 🎉", author: "Tomy", createdAt: Date.now() - 5 * 60000, hue: 20 },
  { id: "b".repeat(32), text: "", author: "Lily", createdAt: Date.now() - 60000, hue: 200 },
] : [];
```

- Routes, matched before the `/web/` branch:
  - `GET /photos/messages` → JSON `{ messages: devPhotos.map(({ hue, ...m }) => m) }`. This is fine because `dev-server.js` runs in Node and isn't shipped to the TV.
  - `GET /photos/photo/<id>` → an SVG 1080×1920 with a gradient using the photo's `hue` and its author in large text, Content-Type `image/svg+xml`. Return 404 if the id is unknown.
  - `POST /photos/seen/<id>` → remove that id from `devPhotos`, then answer 204.
  - Any other `/photos/*` → 404.
- Update the file's header comment to mention `DEV_PHOTOS`.

**Step 5: Verify in a desktop browser**

```bash
cd android-board
npm test
DEV_PHOTOS=1 npm run dev     # leave running (background)
```

Use `/browse` (gstack). Set `viewport 1080x1920` and `goto http://localhost:8123/web/index.html`. Then:
- `wait "#photo-view:not(.hidden)"`, then take a screenshot. Expect the photo full screen, the caption « Bonne fête Lily ! 🎉 », « de Tomy · il y a 5 min » and « 1 / 2 ».
- `press ArrowRight`, then take a screenshot. Expect the second photo, with no caption line, « de Lily », and no counter.
- `press ArrowRight` again. Expect the board back with the photo view hidden. Check that `js "document.activeElement.dataset.date"` is today's date: the photo's keys didn't move the calendar.
- `reload`. No photo shows, because the mock dropped both once they were marked seen.

Stop the dev server, then run `browse stop`.

**Step 6: Commit**

```bash
git add android-board/app/src/main/assets/web android-board/dev-server.js
git commit -m "TV page: full-screen remote photos, any key moves to the next"
```

---

### Task 10: Docs and end-to-end on the TV

**Files:**
- Modify: `android-board/README.md`

**Step 1: README**

Add a section **Photos à distance** to `android-board/README.md`:
- It links to `photo-relay/README.md` for the Cloudflare side.
- `local.properties` gets two lines:

  ```properties
  PHOTOS_URL=https://pearboard-photos.<sous-domaine>.workers.dev
  PHOTOS_TOKEN=<le TV_TOKEN du Worker>
  ```

- The photo arrives within about 30 s. Any key moves to the next photo. After the last one, the board comes back.
- « Photos : jeton refusé » in the clock card means `PHOTOS_TOKEN` and `TV_TOKEN` differ.

Also:
- Add a remote-table row: `| N'importe quelle touche (photo affichée) | Photo suivante ; après la dernière, retour au tableau |`.
- Add `DEV_PHOTOS=1 npm run dev   # avec deux photos d'exemple` to the dev section.

**Step 2: Commit**

```bash
git add android-board/README.md
git commit -m "Document remote photos on the TV side"
```

**Step 3: End to end (needs the user)**

This step needs the user's Cloudflare account. Ask the user to run the `photo-relay/README.md` setup and fill `PHOTOS_URL` and `PHOTOS_TOKEN` in `android-board/local.properties`. Then:

1. `cd android-board && ./gradlew assembleDebug`, then `"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" -s 192.168.18.16:5555 install -r app/build/outputs/apk/debug/app-debug.apk` and relaunch the app.
2. The user sends two photos from the phone.
3. Within about 30 s, the TV shows photo 1 with « 1 / 2 ». Check with `adb exec-out screencap -p`, rotated upright with Pillow (`rotate(90, expand=True)`) for review.
4. Send `adb shell input keyevent 22`. Photo 2 appears without a counter. Send another key; the board comes back.
5. The upload page history shows both as « Vue le … ».
6. Wrong token: set a wrong `PHOTOS_TOKEN`, rebuild and reinstall. « Photos : jeton refusé » appears. Restore the right token, then rebuild and reinstall.

Report results honestly, with screenshots. Never commit `local.properties`.
