// Production builds load the diff engine without its syntax grammars (see
// crates/agent-ui/build/lazyDiffGrammars.ts) and publish a loader under this
// key once the engine module has evaluated. Elsewhere (dev server, node tests)
// the grammars are registered eagerly and there is nothing to wait for.
const LOADER_KEY = Symbol.for("liveagent.diffHighlightGrammars");

export function loadDiffHighlightGrammars(): Promise<void> {
  const load = (globalThis as Record<symbol, (() => Promise<void>) | undefined>)[LOADER_KEY];
  return load ? load() : Promise.resolve();
}
