import { Combobox } from "@base-ui/react";
import { cn } from "../../lib/shared/utils";
import { Check, ChevronDown, Search } from "../IconSet";
import { useZoneFontScaleStyle } from "../ui/zone-font-scale";
import { SETTINGS_PICKER_TRIGGER_CLASS } from "./SettingsSelect";

export type SettingsComboboxOption = {
  value: string;
  label: string;
  style?: React.CSSProperties;
};

type SettingsComboboxProps = {
  value: string;
  options: readonly SettingsComboboxOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  triggerClassName?: string;
};

export function SettingsCombobox({
  value,
  options,
  onValueChange,
  ariaLabel,
  searchPlaceholder,
  emptyLabel,
  triggerClassName,
}: SettingsComboboxProps) {
  const zoneStyle = useZoneFontScaleStyle();
  const selectedOption = options.find((option) => option.value === value) ?? null;

  return (
    <Combobox.Root
      items={options}
      value={selectedOption}
      autoHighlight
      itemToStringLabel={(option) => option.label}
      isItemEqualToValue={(option, selected) => option.value === selected.value}
      onValueChange={(option) => {
        if (option) onValueChange(option.value);
      }}
    >
      <Combobox.Trigger
        aria-label={ariaLabel}
        className={cn(
          SETTINGS_PICKER_TRIGGER_CLASS,
          "min-w-32 justify-between data-[popup-open]:bg-settings-tile-hover",
          triggerClassName,
        )}
      >
        <span className="min-w-0 truncate" style={selectedOption?.style}>
          {selectedOption?.label}
        </span>
        <Combobox.Icon>
          <ChevronDown className="size-3.5 opacity-40" />
        </Combobox.Icon>
      </Combobox.Trigger>

      <Combobox.Portal>
        <Combobox.Positioner
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="layer-popover"
          style={zoneStyle}
        >
          <Combobox.Popup
            aria-label={ariaLabel}
            initialFocus={false}
            className={cn(
              "w-80 min-w-(--anchor-width) max-w-(--available-width) overflow-hidden",
              "origin-(--transform-origin) rounded-2xl bg-popover p-1 shadow-lg",
              "text-sm text-popover-foreground outline-none",
              "transition-[transform,scale,opacity] duration-150",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
            )}
          >
            <div className="p-1.5">
              <div
                className={cn(
                  "flex h-8 items-center gap-2 rounded-lg bg-settings-tile-hover px-2.5",
                )}
              >
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <Combobox.Input
                  aria-label={searchPlaceholder}
                  placeholder={searchPlaceholder}
                  className={cn(
                    "min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none",
                    "placeholder:text-muted-foreground",
                  )}
                />
              </div>
            </div>

            <Combobox.Empty>
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {emptyLabel}
              </div>
            </Combobox.Empty>
            <Combobox.List className="max-h-72 overflow-y-auto overscroll-contain p-1">
              {(option: SettingsComboboxOption) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className={cn(
                    "flex min-h-8 cursor-default items-center gap-2",
                    "rounded-lg px-2.5 py-1.5 text-sm outline-none select-none",
                    "data-[highlighted]:bg-settings-tile-hover data-[selected]:bg-settings-active",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate" style={option.style}>
                    {option.label}
                  </span>
                  <Combobox.ItemIndicator className="flex size-4 shrink-0 items-center justify-center">
                    <Check className="size-3.5" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
