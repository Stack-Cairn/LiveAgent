import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("--output is required");
const output = process.argv[outputIndex + 1];
const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
  encoding: "utf8",
});
const candidates = status
  .split("\0")
  .filter(Boolean)
  .map((entry) => entry.slice(3).split(" -> ").at(-1))
  .filter((path) => {
    if (/^(docs|scripts|\.liveagent)\//.test(path)) return false;
    if (/\/(test|tests)\//.test(path) || /_test\.go$|\.test\.mjs$/.test(path)) return false;
    return /^(crates\/agent-(gui|ui|gateway)\/)/.test(path);
  })
  .sort();
const files = [];
for (const path of candidates) {
  const data = await readFile(path);
  files.push({ path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  note: "Generated after runtime freeze; includes tracked and untracked modified production files, excludes tests/docs/scripts/local config.",
  files,
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, files: files.length }));
