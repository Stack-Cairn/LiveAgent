/**
 * Browser-only replacement for the Bun sandbox fallback.
 *
 * The desktop WebView and gateway browser cannot use `node:fs`, but Vite still
 * resolves a static require while bundling. Keep the impossible branch
 * explicit instead of externalizing a Node builtin into browser output.
 */
export function readFileSync(): never {
  throw new Error("node:fs is unavailable in the browser runtime");
}
