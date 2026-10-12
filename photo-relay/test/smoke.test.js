import { SELF } from "cloudflare:test";
import { it, expect } from "vitest";

it("answers unknown API paths with a JSON 404", async () => {
  const res = await SELF.fetch("https://pearboard.test/api/tv/nope", {
    headers: { Authorization: "Bearer test-tv-token" },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
