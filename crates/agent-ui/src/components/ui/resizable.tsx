// shadcn/ui Base UI Resizable, adapted to the project's tokens (MIT).
// https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/resizable.tsx
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "../../lib/shared/utils";
export function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex size-full min-h-0 min-w-0 aria-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}
export function ResizablePanel(props: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}
export function ResizableHandle({
  className,
  withHandle,
  ...props
}: ResizablePrimitive.SeparatorProps & { withHandle?: boolean }) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative z-10 flex w-px shrink-0 items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      {withHandle ? (
        <div className="pointer-events-none h-10 w-0.5 rounded-full bg-muted-foreground/35" />
      ) : null}
    </ResizablePrimitive.Separator>
  );
}
