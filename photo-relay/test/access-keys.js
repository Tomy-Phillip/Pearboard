import { env, fetchMock } from "cloudflare:test";
import { beforeAll } from "vitest";

// The Worker fetches the team's public keys from Cloudflare Access; serve the test
// key there instead, and fail any other outbound request. (In beforeAll: the pool
// resets fetchMock before each test file, after setup files have run.)
beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get(`https://${env.ACCESS_TEAM_DOMAIN}`)
    .intercept({ path: "/cdn-cgi/access/certs" })
    .reply(200, env.TEST_ACCESS_JWKS_JSON, { headers: { "Content-Type": "application/json" } })
    .persist();
});
