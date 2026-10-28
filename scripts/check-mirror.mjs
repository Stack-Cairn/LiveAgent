#!/usr/bin/env node

// The v2 hosts consume agent-ui directly instead of maintaining byte copies.
// Check the full existing UI boundary rules, both alias roots, and ownership of
// the shared sidebar tree so a host-local shadow cannot bypass those updates.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const boundary = spawnSync(process.execPath, [join(root, "scripts/check-ui-boundaries.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (boundary.status !== 0) process.exit(boundary.status ?? 1);

const shared = resolve(root, "crates/agent-ui/src");
const hosts = ["crates/agent-gui", "crates/agent-gateway/web"];
for (const host of hosts) {
  const configPath = join(root, host, "tsconfig.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const aliases = config.compilerOptions?.paths?.["@liveagent/ui/*"];
  if (!Array.isArray(aliases) || aliases.length !== 1 ||
      resolve(dirname(configPath), aliases[0].replace(/[/\\]\*$/, "")) !== shared) {
    throw new Error(`${host}: @liveagent/ui must resolve to the shared agent-ui/src`);
  }
  for (const entry of readdirSync(join(shared, "lib/sidebar"), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
    const shadow = join(root, host, "src/lib/sidebar", entry.name);
    if (existsSync(shadow)) throw new Error(`${host}: duplicate shared sidebar module ${entry.name}`);
  }
}
console.log("Mirror check passed: full UI boundaries, both shared aliases, and sidebar single ownership.");
