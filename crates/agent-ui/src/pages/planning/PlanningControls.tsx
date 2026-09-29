import { cloneElement, type ReactElement, type ReactNode, useId } from "react";
import {
  FormField,
  FormFieldDescription,
  FormFieldLabel,
} from "../../components/settings/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

/** Associate the planning forms' labels and descriptions with their shared controls. */
export function PlanningField({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: ReactNode;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
  className?: string;
}) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <FormField className={className}>
      <FormFieldLabel htmlFor={id}>{label}</FormFieldLabel>
      {cloneElement(children, {
        id,
        "aria-describedby":
          [children.props["aria-describedby"], descriptionId].filter(Boolean).join(" ") ||
          undefined,
      })}
      {description && <FormFieldDescription id={descriptionId}>{description}</FormFieldDescription>}
    </FormField>
  );
}

/** Options also supply the trigger label before the portaled menu first opens. */
export function PlanningSelect({
  value,
  onValueChange,
  options,
  disabled,
  id,
  className,
  ...a11y
}: {
  value: string | number;
  onValueChange(value: string): void;
  options: { value: string | number; label: ReactNode }[];
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const items = options.map((option) => ({ ...option, value: String(option.value) }));
  return (
    <Select value={String(value)} onValueChange={onValueChange} items={items} disabled={disabled}>
      <SelectTrigger id={id} variant="plain" className={className} {...a11y}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Palette for calendars and subscriptions; readable with both black and white text. */
export const PLANNING_COLORS = [
  "#2563EB",
  "#0F766E",
  "#16A34A",
  "#7C3AED",
  "#DB2777",
  "#DC2626",
  "#D97706",
  "#64748B",
];

/** Round colour swatches (Google-style) instead of the browser's colour input. */
export function ColorSwatches({
  value,
  onChange,
  disabled,
  label,
  palette = PLANNING_COLORS,
  hideLabel,
}: {
  value: string;
  onChange(color: string): void;
  disabled?: boolean;
  label: string;
  /** Swatches offered; the current value is prepended when it is not one of them. */
  palette?: readonly string[];
  /** The surrounding row already shows the label. */
  hideLabel?: boolean;
}) {
  const colors = palette.some((c) => c.toLowerCase() === value.toLowerCase())
    ? palette
    : [value, ...palette];
  return (
    <fieldset className="space-y-2">
      <legend className={hideLabel ? "sr-only" : "text-sm text-muted-foreground"}>{label}</legend>
      <div className="flex flex-wrap gap-2.5">
        {colors.map((swatch) => {
          const selected = swatch.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={selected}
              disabled={disabled}
              className="size-6 rounded-full ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-ring/40 aria-pressed:ring-2 aria-pressed:ring-ring disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: swatch }}
              onClick={() => onChange(swatch)}
            />
          );
        })}
      </div>
    </fieldset>
  );
}
