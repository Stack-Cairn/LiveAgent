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
