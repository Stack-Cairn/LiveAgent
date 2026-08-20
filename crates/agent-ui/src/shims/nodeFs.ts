/**
 * Browser-only replacement for pi-ai's Bun sandbox fallback.
 *
 * pi-ai conditionally requires `node:fs` only when it is running as a Bun
 * executable with an empty process environment. Neither the desktop WebView
 * nor the gateway browser can enter that branch, but Vite still resolves the
 * static require while bundling. Keep the impossible branch explicit instead
 * of externalizing a Node builtin into browser output.
 */
export function readFileSync(): never {
  throw new Error("node:fs is unavailable in the browser runtime");
}
