import { readFileSync } from "node:fs";

const tokenSource = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const values = new Map(
  [
    ...tokenSource.matchAll(
      /(--(?:ui-[\w-]+|ease-[\w-]+|(?:spacing|text|leading|radius|tracking|font-weight)-(?:minus-)?[0-9][\w-]*)):\s*([^;]+);/g,
    ),
  ].map(([, name, value]) => [name, value.trim()]),
);

export function resolveStyleValues(source, resolving = new Set()) {
  return source.replace(
    /var\((--(?:ui-[\w-]+|ease-[\w-]+|(?:spacing|text|leading|radius|tracking|font-weight)-(?:minus-)?[0-9][\w-]*))\)/g,
    (_, name) => {
      const value = values.get(name);
      if (value === undefined) throw new Error(`Undefined style variable: ${name}`);
      if (resolving.has(name)) throw new Error(`Circular style variable: ${name}`);
      return resolveStyleValues(value, new Set([...resolving, name]));
    },
  );
}

export function readStyleSource(url) {
  const source = readFileSync(url, "utf8").replace(
    /@import\s+"(\.\/[^"]+)";/g,
    (_, relative) => readStyleSource(new URL(relative, url)),
  );
  return resolveStyleValues(source);
}
