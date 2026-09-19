import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/shared/utils";

export function SettingsSection({
  title,
  description,
  actions,
  className,
  children,
  ...props
}: ComponentProps<"section"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section {...props} className={cn("space-y-3", className)}>
      {title || description || actions ? (
        <div
          className={cn(
            "settings-section-heading-row flex min-w-0 items-end justify-between gap-4 px-1",
            "web:max-820:items-start web:max-820:gap-3 web:max-640:flex-col",
            "desktop:max-640:flex-col desktop:max-640:items-stretch",
          )}
        >
          <div className="settings-section-title-group min-w-0">
            {title ? (
              <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="settings-section-actions flex shrink-0 items-center gap-2 web:max-640:w-full web:max-640:flex-wrap">
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function SettingsCard({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("space-y-1.5", className)} />;
}

export function SettingsRow({
  title,
  description,
  control,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div
      {...props}
      className={cn(
        "settings-card-row flex items-center justify-between gap-5",
        "rounded-xl bg-settings-tile px-4 py-3.5",
        "web:max-640:flex-col web:max-640:items-stretch web:max-640:gap-3 web:max-640:p-3",
        "desktop:max-640:flex-col desktop:max-640:items-stretch desktop:max-640:gap-3 desktop:max-640:p-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <div className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <div
        className={cn(
          "flex min-w-0 shrink-0 items-center justify-end",
          "web:max-640:w-full web:max-640:justify-start",
          "desktop:max-640:w-full desktop:max-640:justify-start",
        )}
      >
        {control}
      </div>
    </div>
  );
}
