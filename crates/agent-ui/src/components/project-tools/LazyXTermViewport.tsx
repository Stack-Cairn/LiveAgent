import { type ComponentProps, type CSSProperties, lazy, Suspense } from "react";
import { cn } from "../../lib/shared/utils";
import type { XTermViewport as XTermViewportImpl } from "./XTermViewport";

// xterm and its WebGL renderer are ~550 KB of script that no startup screen
// needs; hosts mount this wrapper so the terminal engine loads with the first
// terminal instead of with the app shell.
const LoadedXTermViewport = lazy(() =>
  import("./XTermViewport").then((module) => ({ default: module.XTermViewport })),
);

export type XTermViewportProps = ComponentProps<typeof XTermViewportImpl>;

export function preloadXTermViewport() {
  return import("./XTermViewport");
}

export function XTermViewport(props: XTermViewportProps) {
  // Same background as the mounted viewport, so the swap does not flash.
  const style = {
    "--project-terminal-background": `var(--terminal-${props.theme}-background)`,
  } as CSSProperties;
  return (
    <Suspense
      fallback={
        <div
          style={style}
          className={cn(
            "project-terminal-viewport relative size-full min-h-0 overflow-hidden bg-[var(--project-terminal-background)]",
            props.className,
          )}
        />
      }
    >
      <LoadedXTermViewport {...props} />
    </Suspense>
  );
}
