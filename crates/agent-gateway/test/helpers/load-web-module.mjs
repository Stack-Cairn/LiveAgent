import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];

function createDefaultMocks() {
  return {
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
    : path.resolve(new URL("../../web", import.meta.url).pathname);
  const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
  const ts = requireFromRoot("typescript");
  const cache = new Map();
  const mocks = new Map([
    ...Object.entries(createDefaultMocks()),
    ...Object.entries(options.mocks ?? {}),
  ]);

  function resolveLocal(specifier, parentDir = rootDir) {
    if (specifier.startsWith("@/")) {
      return resolveAsFileOrDirectory(
        path.join(rootDir, "src", specifier.slice("@/".length)),
      );
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
    if (specifier.startsWith(".") || path.isAbsolute(specifier) || specifier.startsWith("@/")) {
      const resolved = resolveLocal(specifier, parentDir);
      if (mocks.has(resolved)) return mocks.get(resolved);
    }
    return undefined;
  }

  function loadModule(specifier, parentDir = rootDir) {
    const mock = resolveMock(specifier, parentDir);
    if (mock !== undefined) return mock;

    const isRootRelative =
      specifier.startsWith("src/") ||
      specifier.startsWith("test/") ||
      specifier.startsWith("@/");

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
      nextSpecifier.startsWith(".") || path.isAbsolute(nextSpecifier) || nextSpecifier.startsWith("@/")
        ? resolveLocal(nextSpecifier, dirname)
        : requireFromRoot.resolve(nextSpecifier);

    const outputText = transpiled.outputText.replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(filePath).href),
    );
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
