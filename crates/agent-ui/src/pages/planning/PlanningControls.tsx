import { cloneElement, type ReactElement, type ReactNode, useId } from "react";
import {
  FormField,
  FormFieldDescription,
  FormFieldLabel,
} from "../../components/settings/FormField";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { translate } from "../../lib/planning/i18n";
import { PLANNING_COLORS } from "../../lib/planning/layers";

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
export { PLANNING_COLORS };

/** Round colour swatches (Google-style) instead of the browser's colour input. */
const COLOR_NAMES: Record<string, string> = {
  "#2563eb": "blue",
  "#0f766e": "teal",
  "#16a34a": "green",
  "#7c3aed": "purple",
  "#db2777": "pink",
  "#dc2626": "red",
  "#d97706": "amber",
  "#64748b": "slate",
};
/** Screen readers hear "蓝色", not "#2563EB"; other colors read as "自定义 #hex". */
export function colorName(color: string) {
  const key = COLOR_NAMES[color.toLowerCase()];
  return key
    ? translate(`planner.color.${key}`)
    : translate("planner.color.custom", { hex: color });
}

/** Round color swatches (Google-style) as a radio group: Tab enters once, arrows move. */
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
  const current = palette.find((c) => c.toLowerCase() === value.toLowerCase());
  const colors = current ? palette : [value, ...palette];
  const labelId = useId();
  return (
    <div className="space-y-2">
      <span id={labelId} className={hideLabel ? "sr-only" : "block text-sm text-muted-foreground"}>
        {label}
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        value={current ?? value}
        disabled={disabled}
        onValueChange={(next) => onChange(String(next))}
        className="flex flex-wrap gap-2.5"
      >
        {colors.map((swatch) => (
          <RadioGroupItem
            key={swatch}
            value={swatch}
            aria-label={colorName(swatch)}
            title={colorName(swatch)}
            className="size-6 rounded-full ring-1 ring-border ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-ring/40 data-checked:ring-2 data-checked:ring-ring data-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            style={{ backgroundColor: swatch }}
          />
        ))}
      </RadioGroup>
    </div>
  );
}
