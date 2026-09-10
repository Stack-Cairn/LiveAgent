import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { textFieldClassName } from "./text-field-styles";

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(textFieldClassName, "min-h-80px py-2", className)}
        ref={ref}
        {...props}
      />
    );
  },
);

Textarea.displayName = "Textarea";
