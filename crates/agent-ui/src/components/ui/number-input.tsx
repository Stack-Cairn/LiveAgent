import { NumberField } from "@base-ui/react/number-field";
import { ChevronDown, ChevronUp, Minus, Plus } from "@liveagent/ui/components/IconSet";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

export type NumberInputProps = Omit<
  React.ComponentPropsWithoutRef<typeof NumberField.Root>,
  "className"
> & {
  variant?: "chevrons" | "plus-minus";
  className?: string;
  inputClassName?: string;
  rootClassName?: string;
  placeholder?: string;
  "aria-label"?: string;
  incrementLabel?: string;
  decrementLabel?: string;
};

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      variant = "chevrons",
      className,
      inputClassName,
      rootClassName,
      placeholder,
      "aria-label": ariaLabel,
      incrementLabel = "Increase value",
      decrementLabel = "Decrease value",
      ...props
    },
    ref,
  ) => (
    <NumberField.Root className={cn("w-full", rootClassName)} {...props}>
      <NumberField.Group
        className={cn(
          "relative inline-flex h-9 w-full items-stretch overflow-hidden whitespace-nowrap rounded-md border border-input bg-background text-sm shadow-xs outline-none transition-[color,box-shadow]",
          "focus-within:border-input focus-within:outline-hidden focus-within:ring-0 focus-within:ring-offset-0",
          "data-[invalid]:border-destructive data-[invalid]:ring-3 data-[invalid]:ring-destructive/20 dark:data-[invalid]:ring-destructive/40",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          className,
        )}
      >
        {variant === "plus-minus" ? (
          <NumberField.Decrement
            aria-label={decrementLabel}
            className="flex w-9 shrink-0 items-center justify-center border-r border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </NumberField.Decrement>
        ) : null}
        <NumberField.Input
          ref={ref}
          aria-label={ariaLabel}
          placeholder={placeholder}
          className={cn(
            "min-w-0 flex-1 bg-transparent px-3 py-2 text-foreground tabular-nums outline-none",
            variant === "plus-minus" && "text-center",
            inputClassName,
          )}
        />
        {variant === "plus-minus" ? (
          <NumberField.Increment
            aria-label={incrementLabel}
            className="flex w-9 shrink-0 items-center justify-center border-l border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </NumberField.Increment>
        ) : (
          <div className="flex w-7 shrink-0 flex-col border-l border-input">
            <NumberField.Increment
              aria-label={incrementLabel}
              className="flex min-h-0 flex-1 items-center justify-center border-b border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
            </NumberField.Increment>
            <NumberField.Decrement
              aria-label={decrementLabel}
              className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </NumberField.Decrement>
          </div>
        )}
      </NumberField.Group>
    </NumberField.Root>
  ),
);

NumberInput.displayName = "NumberInput";
