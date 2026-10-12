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
