import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

const sectionHeaderVariants = cva("font-medium uppercase tracking-wide text-muted-foreground", {
  variants: {
    size: {
      tiny: "text-tiny",
      xs: "text-xs",
    },
  },
  defaultVariants: { size: "tiny" },
});

type SectionHeaderProps = Omit<React.HTMLAttributes<HTMLElement>, "className"> &
  VariantProps<typeof sectionHeaderVariants> & {
    className?: string;
    render?: React.ReactElement;
  };

/**
 * Uppercase eyebrow label above a group of rows (menus, details panes,
 * dialogs). Settings pages use SettingsSection for their titled sections.
 */
export const SectionHeader = React.forwardRef<HTMLElement, SectionHeaderProps>(
  ({ className, size, render, ...props }, ref) =>
    useRender({
      defaultTagName: "div",
      render,
      ref,
      props: { ...props, className: cn(sectionHeaderVariants({ size }), className) },
    }),
);

SectionHeader.displayName = "SectionHeader";
