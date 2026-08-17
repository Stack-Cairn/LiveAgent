import type { PaneNode, WorkbenchLayout } from "@liveagent/ui/lib/workbench/types";
import { readRestorableWorkbenchLayoutCrashShadow } from "../../pages/chat/workbench/layoutStorage";
import { PaneLoadingSkeleton } from "./PaneLoadingSkeleton";

function BootPaneTree(props: { layout: WorkbenchLayout; node: PaneNode; loadingLabel: string }) {
  const { layout, node, loadingLabel } = props;
  if (node.type === "leaf") {
    const surface = layout.panes[node.paneId]?.surface;
    const variant =
      surface?.kind === "localTerminal" || surface?.kind === "sshTerminal"
        ? "terminal"
        : "conversation";
    return <PaneLoadingSkeleton label={loadingLabel} variant={variant} />;
  }

  const horizontal = node.axis === "horizontal";
  return (
    <div
      className={
        horizontal ? "flex h-full min-h-0 min-w-0" : "flex h-full min-h-0 min-w-0 flex-col"
      }
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{ flex: `0 0 calc(${node.ratio * 100}% - 3px)` }}
      >
        <BootPaneTree layout={layout} node={node.first} loadingLabel={loadingLabel} />
      </div>
      <div
        className={
          horizontal
            ? "w-1.5 shrink-0 border-x border-border/25"
            : "h-1.5 shrink-0 border-y border-border/25"
        }
        aria-hidden
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <BootPaneTree layout={layout} node={node.second} loadingLabel={loadingLabel} />
      </div>
    </div>
  );
}

export function AppBootShell(props: { loadingLabel: string }) {
  const layout = readRestorableWorkbenchLayoutCrashShadow();
  return (
    <div
      data-app-boot-shell=""
      className="flex h-full min-h-0 w-full overflow-hidden bg-background"
    >
      <aside className="flex w-[272px] shrink-0 flex-col border-r border-border/50 bg-[hsl(var(--sidebar-bg))] px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-2" aria-hidden>
          <div className="h-7 w-7 rounded-lg bg-muted-foreground/10" />
          <div className="h-2 w-20 rounded-full bg-muted-foreground/15" />
        </div>
        <div className="space-y-3 px-2" aria-hidden>
          <div className="h-2 w-16 rounded-full bg-muted-foreground/12" />
          <div className="h-8 rounded-lg bg-muted-foreground/7" />
          <div className="h-8 rounded-lg bg-muted-foreground/7" />
          <div className="h-8 rounded-lg bg-muted-foreground/7" />
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header
          className="flex h-12 shrink-0 items-center justify-between border-b border-border/45 px-4"
          aria-hidden
        >
          <div className="h-2 w-24 rounded-full bg-muted-foreground/12" />
          <div className="flex gap-2">
            <div className="h-7 w-7 rounded-md bg-muted-foreground/8" />
            <div className="h-7 w-7 rounded-md bg-muted-foreground/8" />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          {layout?.root ? (
            <BootPaneTree layout={layout} node={layout.root} loadingLabel={props.loadingLabel} />
          ) : (
            <PaneLoadingSkeleton label={props.loadingLabel} />
          )}
        </div>
      </main>
    </div>
  );
}
