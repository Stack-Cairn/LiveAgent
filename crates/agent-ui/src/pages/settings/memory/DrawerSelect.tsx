import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";

export type DrawerSelectOption = {
  value: string;
  label: string;
  description?: string;
};

export function DrawerSelect(props: {
  value: string;
  onValueChange: (value: string) => void;
  options: DrawerSelectOption[];
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { value, onValueChange, options, ariaLabel, placeholder, disabled, className } = props;
  const triggerClass = [
    "group/drawer-select inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-[13px] leading-none text-foreground/90 shadow-xs",
    "outline-none transition-colors duration-150",
    "hover:bg-accent/40",
    "data-[open]:bg-accent/50",
    "data-[placeholder]:text-muted-foreground",
    "focus-visible:outline-none focus-visible:ring-0",
    "disabled:cursor-not-allowed disabled:opacity-50",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} className={triggerClass}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="drawer-select-content min-w-(--anchor-width) rounded-xl border-border bg-background text-[13px] text-foreground/90 shadow-xl"
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            description={option.description}
            className="cursor-pointer py-1.5 text-[13px] leading-tight"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
