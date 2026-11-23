import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseTypeScriptSource,
  staticStringValue,
  walkSyntaxTree,
} from "../../../../scripts/typescript-source-tools.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import {
  translationNamespaceDirectory,
  translationNamespaceFiles,
  translationNamespaceOf,
} from "../helpers/translation-namespaces.mjs";

// Feature translations load with their feature: a namespace module registers
// its messages when it is evaluated, so every module that can render one of its
// keys must import it. Then the messages are in place before that module's
// first render (no raw keys) without the startup bundle carrying them.

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sourceRoots = ["crates/agent-ui/src", "crates/agent-gui/src", "crates/agent-gateway/web/src"];
const locales = ["zh-CN", "en-US"];
const NAMESPACE_IMPORT = /^@liveagent\/ui\/i18n\/namespaces\/([A-Za-z]+)$/;

function namespaceMessages() {
  const messages = new Map(); // namespace -> { locale -> Map(key -> value) }
  for (const fileName of translationNamespaceFiles()) {
    const namespace = translationNamespaceOf(fileName);
    const file = path.join(translationNamespaceDirectory, fileName);
    const tables = messages.get(namespace) ?? { "zh-CN": new Map(), "en-US": new Map() };
    messages.set(namespace, tables);
    const fileLocale = /ZhCN\.ts$/.test(fileName)
      ? "zh-CN"
      : /EnUS\.ts$/.test(fileName)
        ? "en-US"
        : undefined;
    const visit = (node, locale) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "ObjectProperty") {
        const key = staticStringValue(node.key);
        if (locales.includes(key)) return visit(node.value, key);
        const value = staticStringValue(node.value);
        if (locale && key !== undefined && value !== undefined) {
          assert.ok(!tables[locale].has(key), `${fileName} defines ${locale} ${key} twice`);
          tables[locale].set(key, value);
        }
        return;
      }
      for (const [field, child] of Object.entries(node)) {
        if (field === "loc" || field.endsWith("Comments")) continue;
        if (Array.isArray(child)) for (const item of child) visit(item, locale);
        else if (child && typeof child.type === "string") visit(child, locale);
      }
    };
    visit(parseTypeScriptSource(readFileSync(file, "utf8"), file).program, fileLocale);
  }
  return messages;
}

function sourceFilesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "i18n") files.push(...sourceFilesUnder(absolutePath));
    } else if (/\.[jt]sx?$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function placeholders(value) {
  return [...new Set([...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]))].sort();
}

const messages = namespaceMessages();
const namespaceOfKey = new Map();
for (const [namespace, tables] of messages) {
  for (const key of tables["en-US"].keys()) namespaceOfKey.set(key, namespace);
}

test("feature namespaces exist and keep both locales aligned", () => {
  assert.ok(messages.size >= 10, `expected the feature namespaces, found ${[...messages.keys()]}`);
  for (const [namespace, tables] of messages) {
    const zhKeys = [...tables["zh-CN"].keys()].sort();
    const enKeys = [...tables["en-US"].keys()].sort();
    assert.ok(enKeys.length > 0, `${namespace} has no messages`);
    assert.deepEqual(enKeys, zhKeys, `${namespace} locale key sets differ`);
    for (const key of zhKeys) {
      assert.deepEqual(
        placeholders(tables["en-US"].get(key)),
        placeholders(tables["zh-CN"].get(key)),
        `${namespace} locale placeholders differ for ${key}`,
      );
    }
  }
});

test("each message lives in one place: core table, one namespace or a host override", () => {
  const loader = createTsModuleLoader();
  const core = loader.loadModule("@liveagent/ui/i18n/sharedTranslations.ts").SHARED_TRANSLATIONS;
  const hostOverrides = [
    ["GUI", loader.loadModule("src/i18n/config.ts").GUI_TRANSLATION_OVERRIDES],
    [
      "WebUI",
      createTsModuleLoader({
        rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
      }).loadModule("src/i18n/config.ts").WEBUI_TRANSLATION_OVERRIDES,
    ],
  ];
  const seen = new Map();
  for (const [namespace, tables] of messages) {
    for (const key of tables["en-US"].keys()) {
      assert.ok(!seen.has(key), `${key} is in namespaces ${seen.get(key)} and ${namespace}`);
      seen.set(key, namespace);
      for (const locale of locales) {
        assert.ok(!Object.hasOwn(core[locale], key), `${key} is in the core table and ${namespace}`);
        for (const [host, overrides] of hostOverrides) {
          assert.ok(
            !Object.hasOwn(overrides[locale], key),
            `${key} (${namespace}) is overridden by the ${host} host; keep it in the core table`,
          );
        }
      }
    }
  }
});

test("every module that references a namespace key imports that namespace", () => {
  const missing = [];
  for (const root of sourceRoots) {
    for (const file of sourceFilesUnder(path.join(repositoryRoot, root))) {
      const source = readFileSync(file, "utf8");
      const syntaxTree = parseTypeScriptSource(source, file);
      const imported = new Set();
      const required = new Map(); // namespace -> first referencing line
      const requireKey = (key, node) => {
        const namespace = namespaceOfKey.get(key);
        if (namespace && !required.has(namespace)) required.set(namespace, node.loc.start.line);
      };
      const requirePrefix = (prefix, node) => {
        if (!prefix.includes(".")) return;
        for (const key of namespaceOfKey.keys()) if (key.startsWith(prefix)) requireKey(key, node);
      };
      for (const statement of syntaxTree.program.body) {
        if (statement.type !== "ImportDeclaration") continue;
        const match = NAMESPACE_IMPORT.exec(statement.source.value);
        if (match) imported.add(match[1]);
      }
      walkSyntaxTree(syntaxTree, (node) => {
        if (node.type === "ImportDeclaration") return;
        const value = staticStringValue(node);
        if (value !== undefined) {
          requireKey(value, node);
        } else if (node.type === "TemplateLiteral") {
          // `settings.section.${id}` style keys.
          requirePrefix(node.quasis[0]?.value.cooked ?? "", node);
        } else if (node.type === "BinaryExpression" && node.operator === "+") {
          const left = staticStringValue(node.left);
          if (left !== undefined) requirePrefix(left, node);
        }
      });
      for (const [namespace, line] of required) {
        if (imported.has(namespace)) continue;
        missing.push(
          `${path.relative(repositoryRoot, file)}:${line} renders ${namespace} messages; add import "@liveagent/ui/i18n/namespaces/${namespace}";`,
        );
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("the core i18n modules do not load feature namespaces", () => {
  const coreModules = [
    "crates/agent-ui/src/i18n/hostTranslations.ts",
    "crates/agent-ui/src/i18n/sharedTranslations.ts",
    "crates/agent-ui/src/i18n/index.ts",
    "crates/agent-ui/src/i18n/LocaleContext.tsx",
    "crates/agent-gui/src/i18n/config.ts",
    "crates/agent-gateway/web/src/i18n/config.ts",
  ];
  for (const relative of coreModules) {
    const source = readFileSync(path.join(repositoryRoot, relative), "utf8");
    assert.doesNotMatch(
      source,
      /["'][^"'\n]*\/namespaces\/[^"'\n]*["']/,
      `${relative} must not import namespaces`,
    );
  }
});
