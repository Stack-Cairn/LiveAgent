import path from "node:path";

/**
 * The diff engine (`@git-diff-view/core`) imports a highlighter that registers
 * every highlight.js grammar (~1 MB of script) at module load. The chat
 * transcript only uses the engine to compute diff rows, so that cost landed on
 * app startup. This plugin makes the engine start with no grammars and exposes
 * a loader (see `lib/shared/diffHighlightGrammars.ts`) that registers them in
 * a separate chunk; the highlighted git review view awaits it before it mounts.
 *
 * Only the production build is affected. In dev the dependency is pre-bundled
 * untouched, and the loader then resolves immediately because the grammars are
 * already registered.
 */
export const DIFF_HIGHLIGHT_GRAMMARS_KEY = "liveagent.diffHighlightGrammars";

const TARGET = /[\\/]@git-diff-view[\\/]lowlight[\\/]dist[\\/]esm[\\/]index\.mjs$/;
const IMPORT_LINE = "import { createLowlight, all } from 'lowlight';";
const CREATE_LINE = "const lowlight = createLowlight(all);";

type TransformContext = {
  resolve(source: string, importer?: string): Promise<{ id: string } | null>;
  warn(message: string): void;
};

export function lazyDiffHighlightGrammars() {
  return {
    name: "liveagent-lazy-diff-grammars",
    apply: "build" as const,
    async transform(this: TransformContext, code: string, id: string) {
      if (!TARGET.test(id)) return null;
      const resolved = await this.resolve("lowlight", id);
      if (!resolved || !code.includes(IMPORT_LINE) || !code.includes(CREATE_LINE)) {
        this.warn(`${id} changed shape; diff grammars stay in the eager bundle`);
        return null;
      }
      const libDir = path.join(path.dirname(resolved.id), "lib");
      const core = JSON.stringify(path.join(libDir, "index.js"));
      const all = JSON.stringify(path.join(libDir, "all.js"));
      const key = JSON.stringify(DIFF_HIGHLIGHT_GRAMMARS_KEY);
      return {
        code: code.replace(IMPORT_LINE, `import { createLowlight } from ${core};`).replace(
          CREATE_LINE,
          [
            "const lowlight = createLowlight({});",
            "let liveagentGrammarsLoad;",
            `globalThis[Symbol.for(${key})] = () =>`,
            `  (liveagentGrammarsLoad ??= import(${all}).then((module) => {`,
            "    lowlight.register(module.grammars);",
            "  }));",
          ].join("\n"),
        ),
        map: null,
      };
    },
  };
}
