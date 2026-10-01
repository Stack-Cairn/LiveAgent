import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { plainTextFieldClassName, textFieldClassName } from "./text-field-styles";

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  variant?: "default" | "plain";
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant = "default", ...props }, ref) => {
    return (
      <textarea
        className={cn(
          textFieldClassName,
          "min-h-80px py-2",
          variant === "plain" && plainTextFieldClassName,
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);

Textarea.displayName = "Textarea";
