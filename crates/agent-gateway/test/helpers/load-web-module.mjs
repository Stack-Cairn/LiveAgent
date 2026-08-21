import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transpileTypeScriptModule } from "../../../../scripts/typescript-source-tools.mjs";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];

// pi-ai ships an import-only exports map, so the loader's CJS require() path
// cannot reach it. Import the real model catalog by file URL (bypassing the
// exports map) so settings code sees the exact runtime data.
const piAiModels = await import(
  new URL(
    "../../web/node_modules/@earendil-works/pi-ai/dist/models.js",
    import.meta.url,
  ).href
);
const piAiProvidersAll = await import(
  new URL(
    "../../web/node_modules/@earendil-works/pi-ai/dist/providers/all.js",
    import.meta.url,
  ).href
);

function createDefaultMocks() {
  return {
    "@earendil-works/pi-ai": {
      getSupportedThinkingLevels: piAiModels.getSupportedThinkingLevels,
      clampThinkingLevel: piAiModels.clampThinkingLevel,
    },
    "@earendil-works/pi-ai/providers/all": {
      getBuiltinModels: piAiProvidersAll.getBuiltinModels,
      getBuiltinModel: piAiProvidersAll.getBuiltinModel,
    },
    "@sinclair/typebox": {
      Type: {
        Object(properties = {}) {
          return { type: "object", properties };
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
        Boolean(options = {}) {
          return { type: "boolean", ...options };
        },
        Optional(schema) {
          return { ...schema, optional: true };
        },
        Array(items, options = {}) {
          return { type: "array", items, ...options };
        },
      },
    },
    "@tauri-apps/api/core": {
      invoke() {
        throw new Error("tauri invoke mock was not expected to be called");
      },
    },
    "@tauri-apps/api/event": {
      listen() {
        throw new Error("tauri listen mock was not expected to be called");
      },
    },
    "@tauri-apps/plugin-opener": {
      openUrl() {
        throw new Error("tauri openUrl mock was not expected to be called");
      },
    },
    "react/jsx-runtime": {
      jsx(type, props, key) {
        return { type, props: props ?? {}, key: key ?? null };
      },
      jsxs(type, props, key) {
        return { type, props: props ?? {}, key: key ?? null };
      },
      Fragment: Symbol.for("react.fragment"),
    },
    "lucide-react": new Proxy({}, {
      get(_target, prop) {
        return function Icon(props) {
          return { type: String(prop), props: props ?? {} };
        };
      },
    }),
  };
}

function createIconMock(specifier) {
  if (specifier.endsWith("?raw")) {
    return "<svg aria-hidden=\"true\"></svg>";
  }
  return function Icon(props) {
    return { type: specifier, props: props ?? {} };
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

export function createWebModuleLoader(options = {}) {
  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : path.resolve(fileURLToPath(new URL("../../web", import.meta.url)));
  const hostSourceDir = path.join(rootDir, "src");
  const sharedSourceDir = fileURLToPath(new URL("../../../agent-ui/src", import.meta.url));
  const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
  const cache = new Map();
  const mocks = new Map([
    ...Object.entries(createDefaultMocks()),
    ...Object.entries(options.mocks ?? {}),
  ]);

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
    if (specifier.startsWith("@/")) {
      const relativePath = specifier.slice("@/".length);
      return resolveAsFileOrDirectory(path.join(hostSourceDir, relativePath));
    }
    if (specifier === "@") {
      return resolveAsFileOrDirectory(path.join(rootDir, "src"));
    }

    const candidate = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(parentDir, specifier);
    return resolveAsFileOrDirectory(candidate);
  }

  function resolveMock(specifier, parentDir) {
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (specifier.startsWith("~icons/")) return createIconMock(specifier);
    if (
      specifier.startsWith(".") ||
      path.isAbsolute(specifier) ||
      specifier.startsWith("@/") ||
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

    const isRootRelative =
      specifier.startsWith("src/") ||
      specifier.startsWith("test/") ||
      specifier.startsWith("@/") ||
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

    if (filePath.endsWith(".css")) {
      const cssModule = { exports: {} };
      cache.set(filePath, cssModule);
      return cssModule.exports;
    }

    const source = fs.readFileSync(filePath, "utf8");
    const outputText = transpileTypeScriptModule(source, filePath);

    const module = { exports: {} };
    cache.set(filePath, module);

    const dirname = path.dirname(filePath);
    const localRequire = (nextSpecifier) => loadModule(nextSpecifier, dirname);
    localRequire.resolve = (nextSpecifier) =>
      nextSpecifier.startsWith(".") ||
      path.isAbsolute(nextSpecifier) ||
      nextSpecifier.startsWith("@/") ||
      nextSpecifier.startsWith("@liveagent/ui/") ||
      nextSpecifier.startsWith("@liveagent/app/") ||
      nextSpecifier.startsWith("@liveagent/adapters/")
        ? resolveLocal(nextSpecifier, dirname)
        : requireFromRoot.resolve(nextSpecifier);

    const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${outputText}\n})`;
    const script = new vm.Script(wrapped, { filename: filePath });
    const compiled = script.runInThisContext();
    compiled(module.exports, localRequire, module, filePath, dirname);
    return module.exports;
  }

  return {
    rootDir,
    loadModule,
    resolveLocal,
  };
}
