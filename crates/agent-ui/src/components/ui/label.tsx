import * as React from "react";

import { cn } from "../../lib/shared/utils";

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: This primitive receives htmlFor or nested controls from its call sites.
  <label ref={ref} className={cn("text-sm font-medium leading-none", className)} {...props} />
));

Label.displayName = "Label";
