import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { Button } from "./button";

type IconButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "size" | "variant" | "aria-label"
> & {
  /** Accessible name; also the native tooltip unless `nativeTitle` is false. */
  label: string;
  size?: "icon" | "icon-sm" | "icon-xs";
  /** `destructive` keeps the icon muted until hover, then tints it red. */
  tone?: "default" | "destructive";
  /** Set to false when a Tooltip already wraps the button. */
  nativeTitle?: boolean;
};

/**
 * Toolbar and row action with only an icon: ghost surface, muted icon that
 * reaches full contrast on hover, and a required accessible label.
 */
export const IconButton = React.forwardRef<HTMLElement, IconButtonProps>(
  (
    { label, size = "icon-sm", tone = "default", nativeTitle = true, title, className, ...props },
    ref,
  ) => (
    <Button
      ref={ref}
      variant="ghost"
      size={size}
      aria-label={label}
      title={nativeTitle ? (title ?? label) : title}
      className={cn(
        "rounded-lg text-muted-foreground",
        tone === "destructive"
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:text-foreground",
        className,
      )}
      {...props}
    />
  ),
);

IconButton.displayName = "IconButton";
