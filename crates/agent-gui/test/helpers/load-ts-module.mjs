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

// `import.meta` shims for modules loaded through the vm wrapper (which runs
// every module as a CommonJS function, where the meta-property is a parse
// error). `env` is empty so Vite-only guards like `import.meta.env.DEV` are
// falsy; `url` points at the loaded source file.
globalThis.__TEST_IMPORT_META_ENV__ ??= {};
globalThis.__TEST_IMPORT_META_URL__ ??= "file:///__test__/";

// Persistent `window` marking the runtime as a Tauri webview. Modules loaded
// through the vm wrapper branch on `isTauri()`/`__TAURI__` (e.g.
// tauriBridge), and tests mock `@tauri-apps/api/*` — so the desktop path must
// be active even after a module finishes loading, not just during it.
globalThis.window ??= {
  setTimeout,
  clearTimeout,
  __TAURI__: {},
  dispatchEvent() {
    return true;
  },
  addEventListener() {},
  removeEventListener() {},
};

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
  const hostSourceDir = path.join(rootDir, "src");
  const sharedSourceDir = fileURLToPath(new URL("../../../agent-ui/src", import.meta.url));
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
    if (specifier.startsWith("@liveagent/ui/")) {
      return resolveAsFileOrDirectory(
        path.join(sharedSourceDir, specifier.slice("@liveagent/ui/".length)),
      );
    }
    if (specifier.startsWith("@liveagent/app/")) {
      return resolveAsFileOrDirectory(
        path.join(hostSourceDir, specifier.slice("@liveagent/app/".length)),
      );
    }
    if (specifier.startsWith("@liveagent/adapters/")) {
      return resolveAsFileOrDirectory(
        path.join(hostSourceDir, "agent-ui-adapters", specifier.slice("@liveagent/adapters/".length)),
      );
    }

    const candidate = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(parentDir, specifier);
    return resolveAsFileOrDirectory(candidate);
  }

  function resolveMock(specifier, parentDir) {
    if (specifier.startsWith("~icons/")) return createIconModuleMock(specifier);
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (
      specifier.startsWith(".") ||
      path.isAbsolute(specifier) ||
      specifier.startsWith("@liveagent/ui/") ||
      specifier.startsWith("@liveagent/app/") ||
      specifier.startsWith("@liveagent/adapters/")
    ) {
      const resolved = resolveLocal(specifier, parentDir);
      if (mocks.has(resolved)) return mocks.get(resolved);
    }
    return undefined;
  }

  function loadModule(specifier, parentDir = rootDir) {
    const mock = resolveMock(specifier, parentDir);
    if (mock !== undefined) return mock;
    if (specifier.endsWith(".css")) return {};

    if (specifier === "@earendil-works/pi-agent-core") {
      const packageJson = requireFromRoot.resolve("@earendil-works/pi-agent-core/package.json");
      return loadModule(path.join(path.dirname(packageJson), "dist/agent.js"));
    }

    const isRootRelative =
      specifier.startsWith("src/") ||
      specifier.startsWith("test/") ||
      specifier.startsWith("src-tauri/") ||
      specifier.startsWith("@liveagent/ui/") ||
      specifier.startsWith("@liveagent/app/") ||
      specifier.startsWith("@liveagent/adapters/");

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
    // The vm wrapper runs each module as a CommonJS function, where the
    // `import.meta` meta-property is a parse error. Swap it for a test shim so
    // Vite-only code (e.g. `import.meta.env.*`) can still be loaded and unit
    // tested. The shim's `env` is empty and `url` points at the source file.
    const shimmedSource = source
      .replace(/\bimport\.meta\.env\b/g, "globalThis.__TEST_IMPORT_META_ENV__")
      .replace(/\bimport\.meta\.url\b/g, "globalThis.__TEST_IMPORT_META_URL__");
    const transpiled = ts.transpileModule(shimmedSource, {
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
      nextSpecifier.startsWith(".") ||
      path.isAbsolute(nextSpecifier) ||
      nextSpecifier.startsWith("@liveagent/ui/") ||
      nextSpecifier.startsWith("@liveagent/app/") ||
      nextSpecifier.startsWith("@liveagent/adapters/")
        ? resolveLocal(nextSpecifier, dirname)
        : requireFromRoot.resolve(nextSpecifier);

    const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${transpiled.outputText}\n})`;
    const script = new vm.Script(wrapped, { filename: filePath });
    const previousWindow = globalThis.window;
    if (typeof globalThis.window === "undefined") {
      globalThis.window = {
        setTimeout,
        clearTimeout,
        // Mark the runtime as a Tauri webview so modules that branch on
        // `isTauri()`/`__TAURI__` (e.g. tauriBridge) take the desktop path,
        // where tests mock `@tauri-apps/api/*` instead of hitting the
        // headless HTTP/WebSocket transport.
        __TAURI__: {},
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
