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
    "group/drawer-select inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-foreground/[0.08] bg-white/55 px-3 text-[13px] leading-none text-foreground/90",
    "outline-none transition-[background-color,border-color,box-shadow] duration-150",
    "hover:border-foreground/[0.14] hover:bg-white/75",
    "data-[open]:border-foreground/[0.2] data-[open]:bg-white/85 data-[open]:shadow-[0_1px_0_rgba(255,255,255,0.65)_inset,0_2px_8px_-4px_rgba(15,23,42,0.08)]",
    "data-[placeholder]:text-muted-foreground",
    "focus-visible:outline-none focus-visible:ring-0",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "dark:bg-white/[0.04] dark:hover:bg-white/[0.06] dark:data-[open]:bg-white/[0.08]",
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
        className="drawer-select-content min-w-(--anchor-width) rounded-xl border-foreground/[0.08] bg-background/95 text-[13px] text-foreground/90 shadow-xl backdrop-blur-2xl dark:bg-background/90"
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
