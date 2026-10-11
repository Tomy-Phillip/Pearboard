// es2017-syntax.test.js catches new syntax; this catches newer runtime APIs that
// parse fine but don't exist on an old Fire TV WebView (~Chromium 61) and would
// throw at run time. ical.js is vendored and left alone.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = path.join(__dirname, "..", "app", "src", "main", "assets", "web");
const FILES = ["app.js", "calendar-worker.js", "calendar-ics.js"];

const RULES = [
  // The stock API 25 Android TV emulator ships WebView 55.
  { name: "String.prototype.padStart/padEnd (Chrome 57)", re: /\.pad(Start|End)\(/ },
  { name: "Promise.prototype.finally (Chrome 63)", re: /\.finally\(/ },
  { name: "globalThis (Chrome 71)", re: /\bglobalThis\b/ },
  { name: "Array.prototype.flat (Chrome 69)", re: /\.flat\(/ },
  { name: "Array.prototype.flatMap (Chrome 69)", re: /\.flatMap\(/ },
  { name: "Object.fromEntries (Chrome 73)", re: /\bObject\.fromEntries\b/ },
  { name: "String.prototype.replaceAll (Chrome 85)", re: /\.replaceAll\(/ },
  { name: "Promise.allSettled (Chrome 76)", re: /\bPromise\.allSettled\b/ },
  { name: "structuredClone (Chrome 98)", re: /\bstructuredClone\b/ },
];

function findViolations(src) {
  const out = [];
  src.split("\n").forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) out.push(`line ${i + 1}: ${rule.name} — ${line.trim()}`);
    }
  });
  return out;
}

test("the guard catches each unsupported API", () => {
  const bad = [
    "s.padStart(2, '0');",
    "p.finally(done);",
    "const g = globalThis;",
    "a.flat();",
    "a.flatMap(f);",
    "Object.fromEntries(pairs);",
    "s.replaceAll('a', 'b');",
    "Promise.allSettled(ps);",
    "structuredClone(o);",
  ].join("\n");
  assert.strictEqual(findViolations(bad).length, RULES.length);
  // try/finally blocks and look-alike names stay allowed.
  const ok = "try { a(); } finally { b(); }\nconst flatten = x.flatten(); o.replace(/a/g, 'b');";
  assert.deepStrictEqual(findViolations(ok), []);
});

for (const name of FILES) {
  test(`${name} only uses runtime APIs an old Chromium WebView has`, () => {
    const violations = findViolations(fs.readFileSync(path.join(WEB_DIR, name), "utf8"));
    assert.deepStrictEqual(violations, [], `${name}:\n` + violations.join("\n"));
  });
}
