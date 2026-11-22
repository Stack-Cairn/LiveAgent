import type { MermaidConfig } from "@streamdown/mermaid";

// Same surface as the `mermaid` plugin from @streamdown/mermaid, but the
// diagram engine (~1 MB with its layout and parser chunks) is only fetched
// when the first diagram renders. Rendering was already asynchronous, so
// callers see no behavioural difference.
type MermaidModule = typeof import("@streamdown/mermaid");
type MermaidRenderer = ReturnType<MermaidModule["mermaid"]["getMermaid"]>;

let engine: Promise<MermaidModule> | null = null;

export const mermaid = {
  getMermaid(config?: MermaidConfig) {
    return {
      async render(...args: Parameters<MermaidRenderer["render"]>) {
        engine ??= import("@streamdown/mermaid");
        const { mermaid: plugin } = await engine.catch((error: unknown) => {
          engine = null;
          throw error;
        });
        return plugin.getMermaid(config).render(...args);
      },
    };
  },
};
