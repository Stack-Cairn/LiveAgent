import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { parseTypeScriptSource, staticStringValue, walkSyntaxTree } from "../../../../scripts/typescript-source-tools.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const forbiddenPackage = /(?:^|[^\w.-])(?:@[^/\s"']+\/)?pi-(?:ai|agent-core)(?=$|["'/:@\s)])/;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function sourceImports(source, path) {
  const imports = [];
  walkSyntaxTree(parseTypeScriptSource(source, path), (node) => {
    let specifier;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {
      specifier = node.source;
    } else if (node.type === "ImportExpression") {
      specifier = node.source;
    } else if (node.type === "TSImportType") {
      specifier = node.argument;
    } else if (node.type === "TSExternalModuleReference") {
      specifier = node.expression;
    } else if (node.type === "CallExpression" && (
      node.callee.type === "Import" ||
      (node.callee.type === "Identifier" && node.callee.name === "require")
    )) {
      specifier = node.arguments[0];
    }
    const value = staticStringValue(specifier);
    if (value !== undefined) imports.push(value);
  });
  return imports;
}

test("workspace and frontend manifests do not install the replaced model runtime", () => {
  for (const path of ["package.json", "crates/agent-gui/package.json", "crates/agent-gateway/web/package.json", "crates/agent-ui/package.json"]) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    for (const group of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dependency, version] of Object.entries(manifest[group] ?? {})) {
        assert.doesNotMatch(`${dependency} ${version}`, forbiddenPackage, `${path}: ${dependency}`);
      }
    }
    assert.doesNotMatch(JSON.stringify(manifest.pnpm ?? {}), forbiddenPackage, `${path}: pnpm configuration`);
  }
});

test("pnpm lockfile contains no replaced model runtime importers, packages, or snapshots", () => {
  assert.doesNotMatch(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), forbiddenPackage);
});

test("frontend source does not import or re-export the replaced model runtime", () => {
  for (const directory of ["crates/agent-gui/src", "crates/agent-ui/src", "crates/agent-gateway/web/src"]) {
    for (const path of sourceFiles(join(root, directory))) {
      for (const specifier of sourceImports(readFileSync(path, "utf8"), path)) {
        assert.doesNotMatch(specifier, forbiddenPackage, path);
      }
    }
  }
});

test("text runtime imports the actual K-brain client through the public LLM entry", () => {
  const runtimePath = join(root, "crates/agent-gui/src/lib/providers/runtime/textOnlyRuntime.ts");
  const runtimeImports = sourceImports(readFileSync(runtimePath, "utf8"), runtimePath);
  assert.ok(runtimeImports.includes("../../kbrain/client"));
  for (const specifier of runtimeImports) {
    assert.doesNotMatch(specifier, /(?:streamByApi|modelFactory|requestOptions|openAICompletionsStream|\/service\/)/);
  }
  const entryPath = join(root, "crates/agent-gui/src/lib/providers/llm.ts");
  const entry = parseTypeScriptSource(readFileSync(entryPath, "utf8"), entryPath);
  const exported = entry.program.body
    .filter((node) => node.type === "ExportNamedDeclaration" && node.source?.value === "./runtime/textOnlyRuntime")
    .flatMap((node) => node.specifiers.map((specifier) => specifier.exported.name));
  assert.ok(exported.includes("completeAssistantMessage"));
  assert.ok(exported.includes("streamAssistantMessage"));
});

test("supplier settings retain the requested visible name", () => {
  const source = readFileSync(join(root, "crates/agent-ui/src/i18n/translations/zhCNSettings.ts"), "utf8");
  assert.match(source, /"settings\.navProviders":\s*"供应商设置"/);
  assert.doesNotMatch(source, /"K-brain 模型设置"/);
});
