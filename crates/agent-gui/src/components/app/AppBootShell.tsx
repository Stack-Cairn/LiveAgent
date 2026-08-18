import { PaneLoadingSkeleton } from "./PaneLoadingSkeleton";

export function AppBootShell(props: { loadingLabel: string }) {
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
          <PaneLoadingSkeleton label={props.loadingLabel} />
        </div>
      </main>
    </div>
  );
}
