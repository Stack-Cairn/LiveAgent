import { Badge } from "@liveagent/ui/components/ui/badge";
import { TabsList, TabsTrigger } from "@liveagent/ui/components/ui/tabs";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ComponentType, ReactNode } from "react";

export type ResourceTabItem<Value extends string> = {
  value: Value;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  countLabel?: ReactNode;
};

export function ResourceTabsList<Value extends string>(props: {
  value: Value;
  items: readonly ResourceTabItem<Value>[];
  ariaLabel?: string;
  className?: string;
  triggerClassName?: string;
  variant?: "default" | "segmented";
}) {
  return (
    <TabsList
      aria-label={props.ariaLabel}
      variant={props.variant}
      className={cn(
        "max-w-full shrink-0 justify-start overflow-x-auto",
        props.variant !== "segmented" && "h-8 rounded-lg bg-muted p-1",
        "text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        props.className,
      )}
    >
      {props.items.map((item) => {
        const Icon = item.icon;
        const active = props.value === item.value;
        return (
          <TabsTrigger
            key={item.value}
            value={item.value}
            variant={props.variant}
            className={cn(
              "group relative shrink-0 gap-1.5",
              props.variant !== "segmented" && "rounded-md px-3",
              "hover:text-foreground data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm",
              props.triggerClassName,
            )}
          >
            {Icon ? <Icon className="size-3.5" /> : null}
            <span>{item.label}</span>
            {item.countLabel !== null && item.countLabel !== undefined ? (
              <Badge
                variant={active ? "secondary" : "muted"}
                className={cn(
                  "ml-0.5 h-5 px-1.5 text-tiny tabular-nums",
                  props.variant === "segmented" &&
                    "border-0 bg-transparent px-0 text-current shadow-none",
                )}
              >
                {item.countLabel}
              </Badge>
            ) : null}
          </TabsTrigger>
        );
      })}
    </TabsList>
  );
}
