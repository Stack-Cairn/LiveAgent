import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { transpileTypeScriptModule } from "../../../../scripts/typescript-source-tools.mjs";

// Minimal TS loader for the vendored virtual-core source: the package has
// zero runtime dependencies, so only relative specifiers need resolving.
const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
const EXTENSIONS = [".ts", ".js"];

function resolveRelative(specifier, parentDir) {
  const candidate = path.resolve(parentDir, specifier);
  if (path.extname(candidate) && fs.existsSync(candidate)) return candidate;
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(`${candidate}${ext}`)) return `${candidate}${ext}`;
  }
  throw new Error(`Cannot resolve module path: ${candidate}`);
}

const cache = new Map();

function loadFile(filePath) {
  if (cache.has(filePath)) return cache.get(filePath).exports;
  const source = fs.readFileSync(filePath, "utf8");
  const outputText = transpileTypeScriptModule(source, filePath);
  const module = { exports: {} };
  cache.set(filePath, module);
  const dirname = path.dirname(filePath);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) {
      throw new Error(`virtual-core must stay dependency-free; got import of ${specifier}`);
    }
    return loadFile(resolveRelative(specifier, dirname));
  };
  const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${outputText}\n})`;
  const compiled = new vm.Script(wrapped, { filename: filePath }).runInThisContext();
  compiled(module.exports, localRequire, module, filePath, dirname);
  return module.exports;
}

export function loadVirtualCore() {
  return loadFile(path.join(srcDir, "index.ts"));
}
