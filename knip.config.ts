// knip configuration (unused files, exports and dependencies) for the pnpm
// workspace. Run through scripts/check-knip.mjs, which compares the findings
// with scripts/budgets/knip-baseline.json; see docs/testing/ci-checks.md.
//
// Two kinds of module references are invisible to a static import graph:
//   - tests load TypeScript sources by path string through the module loaders
//     in test/helpers (`const { a } = loader.loadModule("src/lib/chat/x.ts")`).
//     The `mjs` compiler (scripts/knip-loader-imports.mjs) appends the
//     equivalent `import` declarations, with the names the test actually
//     reads, so knip checks which exports tests use instead of treating those
//     sources as entries whose exports never count as unused. Other path
//     strings in tests (source assertions through readFileSync) still make
//     the file an entry; keys of a loader's `mocks` map do not.
//   - shared UI code imports `@liveagent/app/*` and `@liveagent/adapters/*`,
//     which tsconfig resolves to the desktop app while the Gateway WebUI's
//     Vite config points them at its own src/ — so the WebUI copies are
//     entries.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { appendLoaderImports, LOAD_MODULE_CALL } from "./scripts/knip-loader-imports.mjs";

const root = __dirname;

const WORKSPACES = {
  gui: "crates/agent-gui",
  ui: "crates/agent-ui",
  webui: "crates/agent-gateway/web",
  virtualCore: "crates/virtual-core",
} as const;

function walk(dir: string, filter: (file: string) => boolean): string[] {
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(relative, filter));
    else if (filter(entry.name)) files.push(relative);
  }
  return files;
}

const SOURCE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveSource(base: string): string | null {
  for (const suffix of SOURCE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (/\.tsx?$/.test(candidate) && existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

// Specifier prefix -> source directory, per side (desktop or WebUI).
const GUI_PREFIXES: Array<[string, string]> = [
  ["@liveagent/ui/", `${WORKSPACES.ui}/src/`],
  ["@liveagent/app/", `${WORKSPACES.gui}/src/`],
  ["@liveagent/adapters/", `${WORKSPACES.gui}/src/agent-ui-adapters/`],
  ["src/", `${WORKSPACES.gui}/src/`],
];
const WEBUI_PREFIXES: Array<[string, string]> = [
  ["@liveagent/ui/", `${WORKSPACES.ui}/src/`],
  ["@liveagent/app/", `${WORKSPACES.webui}/src/`],
  ["@liveagent/adapters/", `${WORKSPACES.webui}/src/agent-ui-adapters/`],
  ["@/", `${WORKSPACES.webui}/src/`],
  ["src/", `${WORKSPACES.webui}/src/`],
];

const MODULE_STRING = /["'`]((?:\.{1,2}\/|src\/|@\/|@liveagent\/(?:ui|app|adapters)\/)[^"'`\s]+)["'`]/g;

/** Which loader a test uses decides how `src/` and `./` specifiers resolve. */
function loaderSide(text: string): { prefixes: Array<[string, string]>; base: string } {
  return /createWebModuleLoader|load-web-module/.test(text)
    ? { prefixes: WEBUI_PREFIXES, base: WORKSPACES.webui }
    : { prefixes: GUI_PREFIXES, base: WORKSPACES.gui };
}

/** knip's `mjs` compiler: see scripts/knip-loader-imports.mjs. */
function compileLoaderCalls(text: string, filename: string): string {
  if (!text.includes("loadModule(")) return text;
  const file = path.relative(root, filename);
  const side = loaderSide(text);
  return appendLoaderImports(text, (specifier: string) => {
    // The loaders resolve relative specifiers against their root, not the test file.
    let base: string | null = null;
    if (specifier.startsWith(".")) base = path.join(side.base, specifier);
    else {
      const prefix = side.prefixes.find(([from]) => specifier.startsWith(from));
      if (prefix) base = prefix[1] + specifier.slice(prefix[0].length);
    }
    const resolved = base ? (resolveSource(base.replace(/\.(m?js)$/, "")) ?? resolveSource(base)) : null;
    if (!resolved) return null;
    const relative = path.relative(path.dirname(file), resolved);
    return relative.startsWith(".") ? relative : `./${relative}`;
  });
}

/** Source files that test files reference by a path string other than a loader call. */
function testLoadedSources(): string[] {
  const found = new Set<string>();
  const scan = (dir: string, prefixes: Array<[string, string]>) => {
    for (const file of walk(dir, (name) => /\.(mjs|js|ts|tsx)$/.test(name))) {
      const raw = readFileSync(path.join(root, file), "utf8");
      // Loader calls in .mjs tests are handled by the compiler.
      const text = file.endsWith(".mjs") ? raw.replace(LOAD_MODULE_CALL, "") : raw;
      for (const match of text.matchAll(MODULE_STRING)) {
        // A key in a loader's `mocks` map replaces the module; it is not a use.
        if (/^\s*:/.test(text.slice(match.index + match[0].length))) continue;
        const specifier = match[1];
        let base: string | null = null;
        if (specifier.startsWith(".")) {
          base = path.join(path.dirname(file), specifier);
        } else {
          const prefix = prefixes.find(([from]) => specifier.startsWith(from));
          if (prefix) base = prefix[1] + specifier.slice(prefix[0].length);
        }
        const resolved = base ? resolveSource(base.replace(/\.(m?js)$/, "")) ?? resolveSource(base) : null;
        if (resolved) found.add(resolved);
      }
    }
  };
  scan(`${WORKSPACES.gui}/test`, GUI_PREFIXES);
  scan(`${WORKSPACES.gui}/perf`, GUI_PREFIXES);
  scan("crates/agent-gateway/test", WEBUI_PREFIXES);
  scan(`${WORKSPACES.webui}/test`, WEBUI_PREFIXES);
  scan(`${WORKSPACES.virtualCore}/test`, []);
  return [...found];
}

/** WebUI files that shared UI code reaches through `@liveagent/app` / `@liveagent/adapters`. */
function webuiAliasTargets(): string[] {
  const found = new Set<string>();
  const pattern = /["'](@liveagent\/(?:app|adapters)\/[^"']+)["']/g;
  for (const file of walk(`${WORKSPACES.ui}/src`, (name) => /\.tsx?$/.test(name))) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(pattern)) {
      const prefix = WEBUI_PREFIXES.find(([from]) => match[1].startsWith(from));
      if (!prefix) continue;
      const resolved = resolveSource(prefix[1] + match[1].slice(prefix[0].length));
      if (resolved) found.add(resolved);
    }
  }
  return [...found];
}

/** Entries grouped by the workspace that owns them, relative to that workspace. */
function entriesByWorkspace(files: string[]) {
  const groups: Record<string, string[]> = {};
  for (const file of files) {
    const workspace = Object.values(WORKSPACES).find((dir) => file.startsWith(`${dir}/`));
    if (!workspace) continue;
    groups[workspace] ??= [];
    groups[workspace].push(path.relative(workspace, file));
  }
  return groups;
}

const extra = entriesByWorkspace([...testLoadedSources(), ...webuiAliasTargets()]);

export default {
  compilers: { mjs: compileLoaderCalls },
  // Generated protobuf bindings export every message type.
  ignore: ["crates/agent-gateway/web/src/lib/proto/gen/**"],
  // unplugin-icons virtual modules.
  ignoreUnresolved: ["^~icons/"],
  // Tools the scripts call that are not npm binaries.
  ignoreBinaries: ["mise", "rustc", "tauri", "cargo", "go", "buf", "protoc", "xvfb-run", "dbus-run-session"],
  workspaces: {
    ".": {
      entry: ["scripts/**/*.mjs", "crates/agent-gateway/test/**/*.{mjs,js}"],
      project: ["scripts/**/*.mjs", "crates/agent-gateway/test/**/*.{mjs,js}"],
      // Gateway WebUI tests run from crates/agent-gateway/web and resolve
      // their packages there.
      ignoreDependencies: ["katex", "jsdom"],
    },
    [WORKSPACES.gui]: {
      entry: [
        "src/main.tsx",
        "perf/*.{mjs,ts,tsx}",
        "test/**/*.{mjs,js}",
        "browser-extension/*.js",
        ...(extra[WORKSPACES.gui] ?? []),
      ],
      project: ["src/**/*.{ts,tsx}", "perf/**/*.{mjs,ts,tsx}", "test/**/*.{mjs,js}"],
      // @svgr/*: loaded by unplugin-icons through local-pkg (see
      // pnpm-workspace.yaml packageExtensions). remend: test-only, resolved
      // through the shared UI package.
      ignoreDependencies: ["@svgr/core", "@svgr/plugin-jsx", "remend"],
    },
    "crates/agent-gui/e2e": {
      entry: ["wdio.conf.mjs", "specs/**/*.mjs", "scripts/*.mjs"],
      project: ["**/*.mjs"],
      // WebdriverIO loads the runner named in wdio.conf.mjs by package name.
      ignoreDependencies: ["@wdio/local-runner"],
    },
    [WORKSPACES.ui]: {
      // package.json exports `./*` -> `./src/*`, which makes every source file
      // a public entry. The package is private to this workspace, so report
      // exports that no app, test or harness imports anyway.
      includeEntryExports: true,
      entry: ["src/**/*.test.mjs", ...(extra[WORKSPACES.ui] ?? [])],
      project: ["src/**/*.{ts,tsx}", "src/**/*.test.mjs", "build/**/*.ts"],
    },
    [WORKSPACES.webui]: {
      entry: [
        "src/main.tsx",
        "src/shims/*.ts",
        "test/**/*.{mjs,js}",
        ...(extra[WORKSPACES.webui] ?? []),
      ],
      project: ["src/**/*.{ts,tsx}", "test/**/*.{mjs,js}"],
      // protoc-gen-es: invoked by `buf generate` (buf.gen.yaml).
      ignoreDependencies: ["@bufbuild/protoc-gen-es", "@svgr/core", "@svgr/plugin-jsx"],
    },
    [WORKSPACES.virtualCore]: {
      entry: ["src/index.ts", ...(extra[WORKSPACES.virtualCore] ?? [])],
      project: ["src/**/*.ts", "test/**/*.{mjs,js,ts}"],
    },
  },
};
