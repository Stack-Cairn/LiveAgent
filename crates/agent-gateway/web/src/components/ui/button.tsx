import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className"> &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    /** Base UI composition: replace the host element. */
    render?:
      | React.ReactElement
      | ((
          props: React.HTMLAttributes<HTMLElement>,
          state: Record<string, unknown>,
        ) => React.ReactElement);
  };

export const Button = React.forwardRef<HTMLElement, ButtonProps>(
  ({ className, variant, size, render, type = "button", ...props }, ref) => {
    return useRender({
      defaultTagName: "button",
      render,
      ref,
      props: {
        type: render ? undefined : type,
        ...props,
        className: cn(buttonVariants({ variant, size }), className),
      },
    });
  },
);

Button.displayName = "Button";

export { buttonVariants };
