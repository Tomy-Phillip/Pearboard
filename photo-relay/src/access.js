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
