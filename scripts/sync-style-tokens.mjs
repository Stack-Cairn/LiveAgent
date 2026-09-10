import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const require = createRequire(new URL("../package.json", import.meta.url));
const postcss = require("postcss");
const target = new URL(
  "../crates/agent-ui/src/lib/shared/style-token-names.generated.json",
  import.meta.url,
);
export function tokenGroups(source) {
  const result = { shadow: [], backgroundImage: [], dropShadow: [] };
  const namespaces = {
    "--shadow-": "shadow",
    "--background-image-": "backgroundImage",
    "--drop-shadow-": "dropShadow",
  };
  postcss.parse(source).walkAtRules("theme", (theme) => {
    theme.walkDecls((decl) => {
      for (const [prefix, group] of Object.entries(namespaces)) {
        if (decl.prop.startsWith(prefix)) result[group].push(decl.prop.slice(prefix.length));
      }
    });
  });
  return Object.fromEntries(
    Object.entries(result).map(([key, values]) => [key, [...new Set(values)].sort()]),
  );
}
export function generatedTokenSource(source) {
  const groups = tokenGroups(source);
  return JSON.stringify(groups, null, 2) + "\n";
}
export function syncStyleTokens(check = false) {
  const expected = generatedTokenSource(
    readFileSync(new URL("../crates/agent-ui/src/styles/tokens.css", import.meta.url), "utf8"),
  );
  if (check) {
    let actual = "";
    try {
      actual = readFileSync(target, "utf8");
    } catch {}
    if (JSON.stringify(JSON.parse(actual || "null")) !== JSON.stringify(JSON.parse(expected))) throw new Error("Style token registry is stale. Run pnpm style:sync.");
  } else writeFileSync(target, expected);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    syncStyleTokens(process.argv.includes("--check"));
    console.log("Style token registry is current.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
