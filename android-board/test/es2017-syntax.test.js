// The Fire TV's WebView may be an old Chromium (~61): every script it loads must
// parse as ES2017 — no ?., ??, numeric separators, optional catch binding, etc.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const WEB_DIR = path.join(__dirname, "..", "app", "src", "main", "assets", "web");

for (const name of fs.readdirSync(WEB_DIR).filter((f) => f.endsWith(".js")).sort()) {
  test(`${name} parses as ES2017`, () => {
    const src = fs.readFileSync(path.join(WEB_DIR, name), "utf8");
    try {
      acorn.parse(src, { ecmaVersion: 2017, sourceType: "script" });
    } catch (err) {
      const where = err.loc ? `${err.loc.line}:${err.loc.column + 1}` : "?";
      assert.fail(`${name}:${where} is not ES2017 — ${err.message}`);
    }
  });
}
