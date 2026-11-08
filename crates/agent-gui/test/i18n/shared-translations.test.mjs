import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseTypeScriptSource,
  staticStringValue,
  walkSyntaxTree,
} from "../../../../scripts/typescript-source-tools.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sharedSourceRoot = fileURLToPath(new URL("../../../agent-ui/src/", import.meta.url));
const guiSourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const webRoot = fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url));
const webSourceRoot = path.join(webRoot, "src");
const guiLoader = createTsModuleLoader();
const guiTranslations = guiLoader.loadModule("src/i18n/config.ts").translations;
const webTranslations = createTsModuleLoader({ rootDir: webRoot }).loadModule(
  "src/i18n/config.ts",
).translations;
const sharedTranslations = guiLoader.loadModule(
  "@liveagent/ui/i18n/sharedTranslations.ts",
).SHARED_TRANSLATIONS;
const hostTranslations = [
  ["GUI", guiTranslations],
  ["WebUI", webTranslations],
];
const locales = ["zh-CN", "en-US"];
const nonTranslationLiterals = new Set([
  "settings.customHeaderImportError.",
  "settings.customHeaderImportIssue.",
  "settings.gradle",
  "settings.gradle.kts",
]);

function sourceFilesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(absolutePath));
    } else if (/\.[jt]sx?$/.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function sourceReference(file, node) {
  return `${path.relative(repositoryRoot, file)}:${node.loc?.start.line ?? 1}`;
}

function collectLiteralTranslationArguments(node, literals = []) {
  const value = staticStringValue(node);
  if (value !== undefined) {
    literals.push({ node, value });
  } else if (node?.type === "ParenthesizedExpression") {
    collectLiteralTranslationArguments(node.expression, literals);
  } else if (node?.type === "ConditionalExpression") {
    collectLiteralTranslationArguments(node.consequent, literals);
    collectLiteralTranslationArguments(node.alternate, literals);
  }
  return literals;
}

function addReference(references, key, reference) {
  const current = references.get(key) ?? [];
  current.push(reference);
  references.set(key, current);
}

function collectTranslationKeys(sourceRoot, collectTranslationLikeLiterals = false) {
  const directKeys = new Map();
  const translationLikeLiterals = new Map();
  const knownRoots = new Set(
    hostTranslations.flatMap(([, translations]) =>
      locales.flatMap((locale) =>
        Object.keys(translations[locale]).map((key) => key.split(".")[0]),
      ),
    ),
  );

  for (const file of sourceFilesUnder(sourceRoot)) {
    const syntaxTree = parseTypeScriptSource(readFileSync(file, "utf8"), file);

    walkSyntaxTree(syntaxTree, (node) => {
      const literalValue = staticStringValue(node);
      if (literalValue !== undefined) {
        const key = literalValue;
        const root = key.split(".")[0];
        if (
          collectTranslationLikeLiterals &&
          key.includes(".") &&
          knownRoots.has(root) &&
          !nonTranslationLiterals.has(key)
        ) {
          addReference(translationLikeLiterals, key, sourceReference(file, node));
        }
      }

      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        (node.callee.name === "t" || node.callee.name === "translate") &&
        node.arguments.length > 0
      ) {
        for (const literal of collectLiteralTranslationArguments(node.arguments[0])) {
          addReference(directKeys, literal.value, sourceReference(file, literal.node));
        }
      }
    });
  }

  return { directKeys, translationLikeLiterals };
}

function placeholders(value) {
  return [
    ...new Set([...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1])),
  ].sort();
}

const sharedTranslationKeys = collectTranslationKeys(sharedSourceRoot, true);
const hostSourceTranslations = [
  ["GUI", guiTranslations, collectTranslationKeys(guiSourceRoot).directKeys],
  ["WebUI", webTranslations, collectTranslationKeys(webSourceRoot).directKeys],
];
const builtinToolCatalog = guiLoader.loadModule(
  "@liveagent/ui/lib/tools/builtinToolCatalog.ts",
);
const imagingErrors = guiLoader.loadModule("@liveagent/ui/lib/imaging/errors.ts");
const { TOOL_ACTIVITY_CATEGORIES, TUNNEL_TOOL_ACTIONS } = guiLoader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);
const dynamicTranslationKeys = [
  ...[
    "preparing",
    "receiving",
    "resolving",
    "finalizing",
    "completed",
    "failed",
    "cancelled",
  ].map((phase) => `chat.workspaceCloneTaskPhase.${phase}`),
  ...["allow", "ask", "deny"].map((policy) => `settings.toolPolicy.${policy}`),
  ...["idle", "queued", "running", "completed", "failed", "cancelled", "files"].map(
    (status) => `workspaceSftp.transfer.${status}`,
  ),
  ...["5h", "weekly", "monthly", "quota"].map(
    (window) => `settings.providerUsageWindow.${window}`,
  ),
  ...[
    "empty",
    "invalid-json",
    "unsupported-json",
    "unterminated-quote",
    "no-valid",
    "failed",
  ].map((error) => `settings.customHeaderImportError.${error}`),
  ...[
    "invalid-item",
    "unsupported-value",
    "invalid-key",
    "reserved",
    "invalid-value",
    "malformed-header",
  ].map((reason) => `settings.customHeaderImportIssue.${reason}`),
  ...imagingErrors.IMAGE_ERROR_CODES.map((code) => `imageStudio.error.${code}`),
  "imageStudio.error.IMAGE_EMPTY_RESULT",
  "imageStudio.error.generic",
  ...TOOL_ACTIVITY_CATEGORIES.flatMap((category) => [
    `chat.tool.batch.${category}`,
    `chat.tool.batch.${category}.running`,
    ...(category === "other" ? ["running"] : ["running", "completed", "failed"]).map(
      (phase) => `chat.tool.activity.${category}.${phase}`,
    ),
  ]),
  // getToolActivityTitleKey: TunnelManager rows read `chat.tool.tunnel.${action}.${phase}`.
  ...TUNNEL_TOOL_ACTIONS.flatMap((action) =>
    ["running", "completed", "failed"].map((phase) => `chat.tool.tunnel.${action}.${phase}`),
  ),
  // FileOperationKind in assistantBubbleUtils: tool rows read `chat.tool.file.${kind}.${phase}`.
  ...["read", "create", "edit", "delete"].flatMap((kind) =>
    ["running", "completed", "failed"].map((phase) => `chat.tool.file.${kind}.${phase}`),
  ),
  ...builtinToolCatalog.BUILTIN_TOOL_CATEGORIES.map((category) => category.labelKey),
  ...builtinToolCatalog.BUILTIN_TOOL_CATALOG.flatMap((entry) => [
    `settings.builtinTool.${entry.id}.name`,
    `settings.builtinTool.${entry.id}.desc`,
  ]),
];

test("both hosts provide every shared literal translation key", () => {
  const requiredKeys = new Map([
    ...sharedTranslationKeys.translationLikeLiterals,
    ...sharedTranslationKeys.directKeys,
  ]);

  for (const [host, translations] of hostTranslations) {
    for (const locale of locales) {
      for (const [key, references] of requiredKeys) {
        assert.ok(
          Object.hasOwn(translations[locale], key),
          `${host} ${locale} is missing ${key}, used at ${references.join(", ")}`,
        );
      }
    }
  }
});

test("host translation overrides contain no identical shared messages", () => {
  for (const locale of locales) {
    for (const [key, value] of Object.entries(guiTranslations[locale])) {
      if (!Object.hasOwn(webTranslations[locale], key)) continue;
      if (webTranslations[locale][key] !== value) continue;
      assert.equal(
        sharedTranslations[locale][key],
        value,
        `${locale} identical host message ${key} must live in shared translations`,
      );
    }
  }
});

test("each host provides every literal translation key used by its own source", () => {
  for (const [host, translations, directKeys] of hostSourceTranslations) {
    for (const locale of locales) {
      for (const [key, references] of directKeys) {
        assert.ok(
          Object.hasOwn(translations[locale], key),
          `${host} ${locale} is missing ${key}, used at ${references.join(", ")}`,
        );
      }
    }
  }
});

test("both hosts provide every audited dynamic translation key", () => {
  for (const [host, translations] of hostTranslations) {
    for (const locale of locales) {
      for (const key of dynamicTranslationKeys) {
        assert.ok(
          Object.hasOwn(translations[locale], key),
          `${host} ${locale} is missing ${key}`,
        );
      }
    }
  }
});

test("both hosts keep locale keys and placeholders aligned", () => {
  for (const [host, translations] of hostTranslations) {
    const zhKeys = Object.keys(translations["zh-CN"]).sort();
    const enKeys = Object.keys(translations["en-US"]).sort();
    assert.deepEqual(enKeys, zhKeys, `${host} locale key sets differ`);

    for (const key of zhKeys) {
      assert.deepEqual(
        placeholders(translations["en-US"][key]),
        placeholders(translations["zh-CN"][key]),
        `${host} locale placeholders differ for ${key}`,
      );
    }
  }
});

// Tool batch headers and tool rows put a verb before a target ("Ran pnpm test",
// "读取 App.tsx"); a label that wraps or crowds the target out defeats the point.
const TOOL_LABEL_MAX_COLUMNS = 20;
const toolLabelKey = /^chat\.tool\.(batch|activity|file)\./;

function labelColumns(value) {
  let columns = 0;
  for (const character of value) columns += /[\u3000-\u9fff\uff00-\uffef]/.test(character) ? 2 : 1;
  return columns;
}

test("tool activity labels stay short in every locale", () => {
  for (const [host, translations] of hostTranslations) {
    for (const locale of locales) {
      const keys = Object.keys(translations[locale]).filter((key) => toolLabelKey.test(key));
      assert.ok(keys.length > 50, `${host} ${locale} tool labels were not found`);
      for (const key of keys) {
        const value = translations[locale][key];
        assert.ok(
          labelColumns(value) <= TOOL_LABEL_MAX_COLUMNS,
          `${host} ${locale} ${key} is too long for a tool header: ${value}`,
        );
      }
    }
  }
});

test("shell rows name the command instead of a separate title string", () => {
  for (const [host, translations] of hostTranslations) {
    for (const locale of locales) {
      for (const phase of ["running", "completed", "failed"]) {
        assert.ok(
          !Object.hasOwn(translations[locale], `chat.tool.shell.${phase}Title`),
          `${host} ${locale} still ships chat.tool.shell.${phase}Title`,
        );
      }
    }
  }
});
