// Input and Textarea share the same field surface and interaction states.
export const textFieldClassName =
  "flex w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:border-input focus-visible:outline-hidden focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50";

export const plainTextFieldClassName = [
  "border-0 bg-settings-tile-hover shadow-none transition-[background-color,box-shadow]",
  "focus:bg-background focus:outline-hidden focus:ring-2 focus:ring-ring/25",
  "focus-visible:ring-2 focus-visible:ring-ring/25",
  "aria-invalid:ring-2 aria-invalid:ring-destructive/50 aria-invalid:focus:ring-destructive/50 aria-invalid:focus-visible:ring-destructive/50",
].join(" ");
