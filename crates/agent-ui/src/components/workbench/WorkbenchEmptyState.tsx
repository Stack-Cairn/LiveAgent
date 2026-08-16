export type WorkbenchEmptyStateProps = {
  title: string;
  description?: string;
};

/** Droppable empty-canvas placeholder shown when the pane tree is empty. */
export function WorkbenchEmptyState(props: WorkbenchEmptyStateProps) {
  return (
    <div
      data-workbench-empty-state=""
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-1.5 p-8 text-center"
    >
      <p className="text-sm font-medium text-muted-foreground">{props.title}</p>
      {props.description ? (
        <p className="max-w-sm text-xs text-muted-foreground/70">{props.description}</p>
      ) : null}
    </div>
  );
}
