import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// typescript 7 (native tsc) no longer ships the JS compiler API the loader
// needs (transpileModule/ModuleKind), so the transpile step stays on the
// aliased typescript 6 package.
import ts from "typescript-transpile";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

// Real json-parse/validation implementations from pi-ai (imported by file URL
// to bypass the package exports map) so argument-integrity and schema-check
// code paths behave exactly like runtime.
const piAiJsonParse = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js",
    import.meta.url,
  ).href
);
const piAiValidation = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/utils/validation.js",
    import.meta.url,
  ).href
);
const piAiEventStream = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
    import.meta.url,
  ).href
);
const piAiRetry = await import(
  new URL("../../node_modules/@earendil-works/pi-ai/dist/utils/retry.js", import.meta.url).href
);
const piAiProvidersAll = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/providers/all.js",
    import.meta.url,
  ).href
);
const piAiModels = await import(
  new URL(
    "../../node_modules/@earendil-works/pi-ai/dist/models.js",
    import.meta.url,
  ).href
);

function createDefaultMocks() {
  const typeboxMock = {
    Type: {
      Object(properties = {}, options = {}) {
        return { type: "object", properties, ...options };
      },
      String(options = {}) {
        return { type: "string", ...options };
      },
      Number(options = {}) {
        return { type: "number", ...options };
      },
      Integer(options = {}) {
        return { type: "integer", ...options };
      },
      Null(options = {}) {
        return { type: "null", ...options };
      },
      Any(options = {}) {
        return { ...options };
      },
      Record(key, value, options = {}) {
        return { type: "object", propertyNames: key, additionalProperties: value, ...options };
      },
      Boolean(options = {}) {
        return { type: "boolean", ...options };
      },
      Literal(value, options = {}) {
        return { const: value, ...options };
      },
      Union(anyOf = [], options = {}) {
        return { anyOf, ...options };
      },
      Optional(schema) {
        return { ...schema, optional: true };
      },
      Array(items, options = {}) {
        return { type: "array", items, ...options };
      },
    },
  };

  return {
    "@earendil-works/pi-ai": {
      getModel(id, config = {}) {
        return {
          id,
          provider: config.provider ?? "mock",
          api: config.api ?? "mock",
          maxTokens: config.maxTokens ?? 128_000,
          ...config,
        };
      },
      streamSimple() {
        throw new Error("streamSimple mock was not expected to be called");
      },
      validateToolArguments: piAiValidation.validateToolArguments,
      parseJsonWithRepair: piAiJsonParse.parseJsonWithRepair,
      parseStreamingJson: piAiJsonParse.parseStreamingJson,
      repairJson: piAiJsonParse.repairJson,
      getSupportedThinkingLevels: piAiModels.getSupportedThinkingLevels,
      clampThinkingLevel: piAiModels.clampThinkingLevel,
      isRetryableAssistantError: piAiRetry.isRetryableAssistantError,
      createAssistantMessageEventStream: piAiEventStream.createAssistantMessageEventStream,
      EventStream: class EventStream {
        constructor() {
          throw new Error("EventStream mock was not expected to be constructed");
        }
      },
    },
    "@earendil-works/pi-ai/api/anthropic-messages": {
      stream() {
        throw new Error("stream (anthropic-messages) mock was not expected to be called");
      },
    },
    "@earendil-works/pi-ai/api/openai-completions": {
      stream() {
        throw new Error("stream (openai-completions) mock was not expected to be called");
      },
    },
    "@earendil-works/pi-ai/api/openai-responses": {
      stream() {
        throw new Error("stream (openai-responses) mock was not expected to be called");
      },
    },
    "@earendil-works/pi-ai/api/google-generative-ai": {
      stream() {
        throw new Error("stream (google-generative-ai) mock was not expected to be called");
      },
    },
    "@earendil-works/pi-ai/providers/all": {
      getBuiltinModel: piAiProvidersAll.getBuiltinModel,
      getBuiltinModels: piAiProvidersAll.getBuiltinModels,
      getBuiltinProviders: piAiProvidersAll.getBuiltinProviders,
    },
    "@earendil-works/pi-ai/compat": {
      EventStream: piAiEventStream.EventStream,
      validateToolArguments: piAiValidation.validateToolArguments,
      streamSimple() {
        throw new Error("streamSimple mock was not expected to be called");
      },
    },
    "@tauri-apps/api/core": {
      invoke() {
        throw new Error("tauri invoke mock was not expected to be called");
      },
    },
    typebox: typeboxMock,
    "react/jsx-runtime": {
      jsx(type, props, key) {
        return { type, props: props ?? {}, key: key ?? null };
      },
      jsxs(type, props, key) {
        return { type, props: props ?? {}, key: key ?? null };
      },
      Fragment: Symbol.for("react.fragment"),
    },
  };
}

function createIconModuleMock(specifier) {
  if (specifier.endsWith("?raw")) {
    return {
      __esModule: true,
      default: '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
    };
  }

  const iconName = specifier.split("/").pop() || "icon";
  return {
    __esModule: true,
    default(props) {
      return { type: iconName, props: props ?? {} };
    },
  };
}

function hasExtension(filePath) {
  return path.extname(filePath).length > 0;
}

function resolveAsFileOrDirectory(candidate) {
  if (hasExtension(candidate) && fs.existsSync(candidate)) {
    return candidate;
  }

  for (const ext of DEFAULT_EXTENSIONS) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt)) return withExt;
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    for (const ext of DEFAULT_EXTENSIONS) {
      const indexPath = path.join(candidate, `index${ext}`);
      if (fs.existsSync(indexPath)) return indexPath;
    }
  }

  throw new Error(`Cannot resolve module path: ${candidate}`);
}

export function createTsModuleLoader(options = {}) {
  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
  const cache = new Map();
  const defaultMocks = createDefaultMocks();
  const mocks = new Map(Object.entries(defaultMocks));
  // Tests conventionally override a mocked module by supplying only the
  // handful of exports they care about (e.g. { getModel() {...} } for
  // "@earendil-works/pi-ai"), expecting every other default export — like
  // the real isRetryableAssistantError/createAssistantMessageEventStream —
  // to keep working underneath. Shallow-merge instead of replacing so those
  // partial overrides don't silently drop unrelated default exports.
  for (const [specifier, override] of Object.entries(options.mocks ?? {})) {
    const base = defaultMocks[specifier];
    const isPlainMerge =
      base &&
      typeof base === "object" &&
      !Array.isArray(base) &&
      override &&
      typeof override === "object" &&
      !Array.isArray(override);
    mocks.set(specifier, isPlainMerge ? { ...base, ...override } : override);
  }

  function resolveLocal(specifier, parentDir = rootDir) {
    const candidate = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(parentDir, specifier);
    return resolveAsFileOrDirectory(candidate);
  }

  function resolveMock(specifier, parentDir) {
    if (specifier.startsWith("~icons/")) return createIconModuleMock(specifier);
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
      const resolved = resolveLocal(specifier, parentDir);
      if (mocks.has(resolved)) return mocks.get(resolved);
    }
    return undefined;
  }

  function loadModule(specifier, parentDir = rootDir) {
    const mock = resolveMock(specifier, parentDir);
    if (mock !== undefined) return mock;

    if (specifier === "@earendil-works/pi-agent-core") {
      const packageJson = requireFromRoot.resolve("@earendil-works/pi-agent-core/package.json");
      return loadModule(path.join(path.dirname(packageJson), "dist/agent.js"));
    }

    const isRootRelative =
      specifier.startsWith("src/") ||
      specifier.startsWith("test/") ||
      specifier.startsWith("src-tauri/");

    if (!isRootRelative && !specifier.startsWith(".") && !path.isAbsolute(specifier)) {
      return requireFromRoot(specifier);
    }

    const filePath = resolveLocal(specifier, isRootRelative ? rootDir : parentDir);
    if (cache.has(filePath)) return cache.get(filePath).exports;

    if (filePath.endsWith(".json")) {
      const jsonModule = { exports: JSON.parse(fs.readFileSync(filePath, "utf8")) };
      cache.set(filePath, jsonModule);
      return jsonModule.exports;
    }

    const source = fs.readFileSync(filePath, "utf8");
    const transpiled = ts.transpileModule(source, {
      fileName: filePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        moduleResolution: ts.ModuleResolutionKind.Node10 ?? ts.ModuleResolutionKind.NodeJs,
        resolveJsonModule: true,
        ignoreDeprecations: "6.0",
      },
      reportDiagnostics: true,
    });

    const diagnostics = transpiled.diagnostics ?? [];
    const fatalDiagnostics = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (fatalDiagnostics.length > 0) {
      const message = ts.formatDiagnosticsWithColorAndContext(fatalDiagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => rootDir,
        getNewLine: () => "\n",
      });
      throw new Error(message);
    }

    const module = { exports: {} };
    cache.set(filePath, module);

    const dirname = path.dirname(filePath);
    const localRequire = (nextSpecifier) => loadModule(nextSpecifier, dirname);
    localRequire.resolve = (nextSpecifier) =>
      nextSpecifier.startsWith(".") || path.isAbsolute(nextSpecifier)
        ? resolveLocal(nextSpecifier, dirname)
        : requireFromRoot.resolve(nextSpecifier);

    const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${transpiled.outputText}\n})`;
    const script = new vm.Script(wrapped, { filename: filePath });
    const previousWindow = globalThis.window;
    if (typeof globalThis.window === "undefined") {
      globalThis.window = {
        setTimeout,
        clearTimeout,
      };
    }

    try {
      const compiled = script.runInThisContext();
      compiled(module.exports, localRequire, module, filePath, dirname);
    } finally {
      if (typeof previousWindow === "undefined") {
        delete globalThis.window;
      } else {
        globalThis.window = previousWindow;
      }
    }
    return module.exports;
  }

  return {
    rootDir,
    loadModule,
    resolveLocal,
  };
}
