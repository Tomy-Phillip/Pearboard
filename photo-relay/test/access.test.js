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
