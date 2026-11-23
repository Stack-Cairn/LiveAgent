// The WebUI's first screen stays small: the login page must not pull in the
// signed-in app shell, and the heavy parts of the chat (math, code
// highlighting, the diff engine, voice input, ...) load with `import()` when
// first used. These checks walk the static import graph of the sources, the
// same graph the bundler turns into startup chunks.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const crates = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const webRoot = join(crates, "agent-gateway/web");
const webSrc = join(webRoot, "src");
const uiSrc = join(crates, "agent-ui/src");

// `import x from`, `import { a, type B } from`, `export * from`, `import "x"`;
// type-only imports and exports are erased and never load anything.
const STATIC_IMPORT =
  /^\s*(import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function resolveSource(specifier, fromFile) {
  let base;
  if (specifier.startsWith("@/")) base = join(webSrc, specifier.slice(2));
  else if (specifier.startsWith("@liveagent/ui/")) {
    base = join(uiSrc, specifier.slice("@liveagent/ui/".length));
  } else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every source file and package specifier reachable from `entry` without `import()`. */
function staticClosure(entry) {
  const files = new Set();
  const packages = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const [, , specifier] of stripComments(readFileSync(file, "utf8")).matchAll(
      STATIC_IMPORT,
    )) {
      const resolved = resolveSource(specifier, file);
      if (resolved) pending.push(resolved);
      else if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
        packages.add(specifier);
      }
    }
  }
  return { files, packages };
}

const relative = (file) => file.slice(crates.length + 1);

test("the startup entry reaches the login page but not the app shell", () => {
  const { files, packages } = staticClosure(join(webSrc, "main.tsx"));
  const reached = [...files].map(relative);
  assert.ok(reached.includes("agent-gateway/web/src/pages/LoginPage.tsx"));
  for (const shellModule of [
    "agent-gateway/web/src/app/GatewayApp.tsx",
    "agent-gateway/web/src/app/GatewayAppView.tsx",
    "agent-gateway/web/src/lib/gatewaySocket.ts",
    "agent-gateway/web/src/lib/settings/index.ts",
    "agent-ui/src/components/Markdown.tsx",
    "agent-ui/src/pages/chat/ChatComposerBar.tsx",
  ]) {
    assert.ok(!reached.includes(shellModule), `${shellModule} is in the startup bundle`);
  }
  for (const heavyPackage of ["streamdown", "@streamdown/math", "@streamdown/code", "shiki"]) {
    assert.ok(!packages.has(heavyPackage), `${heavyPackage} is in the startup bundle`);
  }
});

test("the app shell loads its heavy parts on first use", () => {
  const { files, packages } = staticClosure(join(webSrc, "app/GatewayApp.tsx"));
  const reached = new Set([...files].map(relative));
  for (const heavyPackage of ["@streamdown/math", "katex", "@streamdown/code", "@git-diff-view/file"]) {
    assert.ok(!packages.has(heavyPackage), `${heavyPackage} is imported statically`);
  }
  for (const lazyModule of [
    "agent-ui/src/lib/stt/audio.ts",
    "agent-ui/src/components/trajectory/TrajectoryView.tsx",
    "agent-ui/src/components/chat/image-annotation/ImageAnnotationDialog.tsx",
    "agent-ui/src/pages/settings/SettingsPage.tsx",
  ]) {
    assert.ok(!reached.has(lazyModule), `${lazyModule} is imported statically`);
  }
});

test("each lazy part is still imported dynamically", () => {
  const dynamicImports = (file) =>
    [...stripComments(readFileSync(file, "utf8")).matchAll(DYNAMIC_IMPORT)].map((match) => match[1]);
  const expectations = [
    [join(webSrc, "App.tsx"), "@/app/GatewayApp"],
    [join(uiSrc, "lib/markdownMath.ts"), "@streamdown/math"],
    [join(uiSrc, "lib/markdownCodeHighlight.ts"), "@streamdown/code"],
    [join(uiSrc, "lib/chat/diffEngine.ts"), "@git-diff-view/file"],
    [join(uiSrc, "pages/chat/useComposerStt.ts"), "@liveagent/ui/lib/stt/audio"],
    [join(webSrc, "app/lazySurfaces.tsx"), "@liveagent/ui/components/trajectory/TrajectoryView"],
    [
      join(uiSrc, "components/chat/image-annotation/useComposerImageAnnotation.tsx"),
      "./ImageAnnotationDialog",
    ],
  ];
  for (const [file, specifier] of expectations) {
    assert.ok(dynamicImports(file).includes(specifier), `${relative(file)} lazy-loads ${specifier}`);
  }
});

test("index.html does not preload math", () => {
  const sourceHtml = readFileSync(join(webRoot, "index.html"), "utf8");
  assert.doesNotMatch(sourceHtml, /modulepreload/);
  // The built page lists the startup chunks; check it too when a build exists.
  const builtHtmlPath = join(webRoot, "dist/index.html");
  if (!existsSync(builtHtmlPath)) return;
  const preloads = [
    ...readFileSync(builtHtmlPath, "utf8").matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g),
  ].map((match) => match[1]);
  for (const href of preloads) {
    assert.doesNotMatch(href, /katex|math/i, `${href} is preloaded at startup`);
  }
});
