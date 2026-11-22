// Turns the test module loaders' path-string calls into `import` declarations
// knip can follow. Used as knip's `mjs` compiler (see knip.config.ts).
//
// Tests load TypeScript sources through test/helpers loaders:
//   const { a, b: c } = loader.loadModule("src/lib/chat/x.ts");
//   const mod = createTsModuleLoader({ mocks }).loadModule("src/lib/y.ts");
//   const env = { tools: loader.loadModule("src/lib/z.ts") };   // env.tools.a
// Without help, knip only sees a string, so those sources had to be entries
// and none of their exports were ever reported. The compiler appends, e.g.,
//   import { a as __knip1_0, b as __knip1_1 } from "../../src/lib/chat/x.ts";
// so only the exports a test actually reads count as used. When it cannot
// tell which exports are read (the module object is passed around, spread or
// indexed), it imports the namespace and every export counts as used.

// `const <binding> = ...loadModule("spec"` or `<key>: ...loadModule("spec"`.
// The loader expression may span lines but not statements; an object or
// array literal on the right binds its keys, not the module.
export const LOAD_MODULE_BINDING =
  /(?:(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=(?!\s*[{[])|([A-Za-z_$][\w$]*)\s*:)\s*(?:await\s+)?((?:(?!\b(?:const|let|var)\b)[^;])*?)\bloadModule\(\s*["'`]([^"'`]+)["'`]/g;
// Any loader call, optionally followed by a member read.
export const LOAD_MODULE_CALL = /\bloadModule\(\s*["'`]([^"'`]+)["'`]\s*(?:,[^)]*)?\)(\??\.([A-Za-z_$][\w$]*))?/g;

// Comments and plain string literals, so a binding named like a word in a
// test title is not mistaken for a use of the module object. Template
// literals stay: their `${...}` parts are code.
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

function destructuredNames(pattern) {
  const names = [];
  for (const part of pattern.slice(1, -1).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("...")) return "all";
    const name = trimmed.split(/[:=]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

function memberNames(text, binding, declaredAsProperty) {
  const code = text.replace(COMMENT_OR_STRING, '""');
  const escaped = binding.replace(/\$/g, "\\$");
  const names = new Set();
  for (const match of code.matchAll(new RegExp(`\\b${escaped}\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) names.add(match[1]);
  // Bare uses, not counting object keys (`{ palette: x }`) or members (`a.palette`).
  const uses = code.match(new RegExp(`(?<![\\w$.])${escaped}\\b(?!\\s*\\??\\.)(?!\\s*:(?!:))`, "g"))?.length ?? 0;
  // A `const` declaration is one bare use itself; any other (passing the
  // module object around, Object.keys(mod)) may read any export.
  return uses > (declaredAsProperty ? 0 : 1) ? "all" : [...names];
}

/**
 * The modules a test loads and the exports it reads from each:
 * `[{ specifier, names: string[] | "all" }]`. `names` is empty for a module
 * that is loaded but whose exports are not read.
 */
export function loaderCalls(text) {
  if (!text.includes("loadModule(")) return [];
  const calls = [];
  const covered = new Set();
  for (const match of text.matchAll(LOAD_MODULE_BINDING)) {
    const [whole, pattern, property, between, specifier] = match;
    // `= loader.loadModule("a").b` reads one member; the second pass handles it.
    const callEnd = text.indexOf(")", match.index + whole.length);
    if (/^\)\s*\??\./.test(text.slice(callEnd))) continue;
    if (/\bloadModule\(/.test(between)) continue;
    // A property binding only counts with a plain loader in front
    // (`tools: loader.loadModule(`), not a key inside the loader's options.
    if (property && !/^[\w$.\s]*$/.test(between)) continue;
    covered.add(match.index + whole.lastIndexOf("loadModule("));
    const binding = pattern ?? property;
    calls.push({
      specifier,
      names: binding.startsWith("{") ? destructuredNames(binding) : memberNames(text, binding, Boolean(property)),
    });
  }
  for (const match of text.matchAll(LOAD_MODULE_CALL)) {
    if (covered.has(match.index)) continue;
    // Unrecognized use of the module object: assume any export may be read.
    calls.push({ specifier: match[1], names: match[3] ? [match[3]] : "all" });
  }
  return calls;
}

/**
 * Appends the import declarations for `loaderCalls(text)`. `resolve` maps a
 * loader specifier to an import path relative to the test file, or null when
 * it is not a workspace source (the call is then left alone).
 */
export function appendLoaderImports(text, resolve) {
  const imports = [];
  for (const [index, call] of loaderCalls(text).entries()) {
    const from = resolve(call.specifier);
    if (!from) continue;
    const id = `__knip${index + 1}`;
    if (call.names === "all") imports.push(`import * as ${id} from "${from}"; console.log(${id});`);
    else if (call.names.length === 0) imports.push(`import "${from}";`);
    else {
      const bindings = call.names.map((name, position) => `${name} as ${id}_${position}`);
      imports.push(`import { ${bindings.join(", ")} } from "${from}";`);
    }
  }
  return imports.length > 0 ? `${text}\n${imports.join("\n")}\n` : text;
}
