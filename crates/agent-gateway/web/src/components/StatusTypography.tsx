import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ReactNode } from "react";

export function StatusLabel({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 text-muted-foreground text-tiny tracking-0p18em uppercase">{children}</p>
  );
}

export function StatusHeading({ children }: { children: ReactNode }) {
  return <h3 className="m-0 text-foreground tracking-minus-0p035em mt-2px text-lg">{children}</h3>;
}

export function StatusSectionHeader({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "mb-10px flex flex-none items-center justify-between gap-10px text-xs text-muted-foreground",
        "[&>svg]:text-xs [&>span]:text-xs",
      )}
    >
      {children}
    </div>
  );
}
