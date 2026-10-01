import type { MermaidConfig } from "@streamdown/mermaid";
import { useSyncExternalStore } from "react";

const configs = {
  light: { theme: "default" },
  dark: { theme: "dark" },
} satisfies Record<string, MermaidConfig>;

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    // Both hosts apply the effective theme (including system changes) to html.
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

function snapshot() {
  return document.documentElement.classList.contains("dark");
}

export function useMermaidConfig() {
  const dark = useSyncExternalStore(subscribe, snapshot, () => false);
  return configs[dark ? "dark" : "light"];
}
