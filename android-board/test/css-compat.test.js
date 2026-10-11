// The Fire TV's WebView may be an old Chromium (~61): style.css must avoid CSS
// it doesn't know — `inset` (87), flexbox `gap` (84), clamp()/min()/max() (79).
// Grid containers use the old grid-gap / grid-row-gap / grid-column-gap names.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CSS_PATH = path.join(__dirname, "..", "app", "src", "main", "assets", "web", "style.css");

const RULES = [
  { name: "inset shorthand", re: /(^|[;{\s])inset\s*:/ },
  { name: "clamp()", re: /(^|[^\w-])clamp\(/ },
  { name: "min()/max()", re: /(^|[^\w-])(min|max)\(/ },
  { name: "gap/row-gap/column-gap (use grid-gap or margins)", re: /(^|[;{\s])(row-|column-)?gap\s*:/ },
];

// Blanks out /* comments */ but keeps newlines so line numbers still match.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

function findViolations(css) {
  const out = [];
  stripComments(css).split("\n").forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) out.push(`line ${i + 1}: ${rule.name} — ${line.trim()}`);
    }
  });
  return out;
}

test("the guard catches each unsupported feature", () => {
  const bad = [
    ".a { inset: 0; }",
    ".b { font-size: clamp(1px, 2vw, 3px); }",
    ".c { width: min(10px, 5vw); }",
    ".d { gap: 4px; }",
    ".e { row-gap: 4px; }",
    ".f {\n  column-gap: 4px;\n}",
  ].join("\n");
  assert.strictEqual(findViolations(bad).length, 6);
  const ok = [
    "/* inset: 0; gap: 2px; clamp(1px, 2px, 3px) */",
    ".a { grid-gap: 4px; grid-row-gap: 2px; grid-column-gap: 3px; }",
    ".b { grid-template-columns: minmax(0, 1fr); min-height: 0; max-width: 10px; }",
    ".c { box-shadow: inset 0 0 2px #000; }",
  ].join("\n");
  assert.deepStrictEqual(findViolations(ok), []);
});

test("style.css only uses CSS an old Chromium WebView understands", () => {
  const violations = findViolations(fs.readFileSync(CSS_PATH, "utf8"));
  assert.deepStrictEqual(violations, [], "style.css:\n" + violations.join("\n"));
});
