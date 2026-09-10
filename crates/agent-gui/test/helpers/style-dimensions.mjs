import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { splitUtility } from "../../../../scripts/lib/style-classes.mjs";
const require = createRequire(new URL("../../package.json", import.meta.url));
const parser = require("@babel/parser");
/** Structural size assertion: independent of class order and size-* versus separate height/width notation. */
export function staticDimensionCandidates(source, tag, requiredClasses = []) {
  const candidates = [];
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.type === "JSXOpeningElement" && n.name.name === tag) {
      const attr = n.attributes.find((a) => a.name?.name === "className");
      const value =
        attr?.value?.type === "StringLiteral"
          ? attr.value.value
          : attr?.value?.expression?.callee?.name === "cn"
            ? attr.value.expression.arguments
                .filter((a) => a.type === "StringLiteral")
                .map((a) => a.value)
                .join(" ")
            : null;
      if (value !== null) {
        const tokens = value.split(/\s+/);
        if (requiredClasses.every((c) => tokens.includes(c))) {
          let width, height;
          for (const t of tokens) {
            const { prefix, utility } = splitUtility(t);
            if (prefix) continue;
            if (utility.startsWith("size-")) width = height = utility.slice(5);
            else if (utility.startsWith("w-")) width = utility.slice(2);
            else if (utility.startsWith("h-")) height = utility.slice(2);
          }
          candidates.push({ width, height });
        }
      }
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "loc" || k === "extra") continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  }
  walk(parser.parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] }));
  return candidates;
}
export function assertJsxDimensions(source, tag, expected, requiredClasses = []) {
  const candidates = staticDimensionCandidates(source, tag, requiredClasses);
  assert.ok(
    candidates.some((c) => c.width === expected.width && c.height === expected.height),
    `${tag} must retain dimensions ${JSON.stringify(expected)}; received ${JSON.stringify(candidates)}`,
  );
}
