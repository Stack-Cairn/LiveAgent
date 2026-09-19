import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { plainTextFieldClassName, textFieldClassName } from "./text-field-styles";

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  variant?: "default" | "plain";
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant = "default", ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          textFieldClassName,
          "h-9 py-1 transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium",
          variant === "plain" && plainTextFieldClassName,
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);

Input.displayName = "Input";
