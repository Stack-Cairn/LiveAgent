// Platform adapter for the memory settings panel — gateway web end.
// This file is NOT mirrored: it is the ONLY module in pages/settings/memory
// that may import platform-specific dependencies (@radix-ui/react-select,
// lib/chat, shared UI chrome). Every sibling file is byte-identical with
// crates/agent-gui/src/pages/settings/memory and may only reach
// platform-specific code through the exports below.

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "../../../components/icons";

export {
  AlertTriangle,
  BookOpen,
  Brain,
  BrushCleaning,
  Check,
  ChevronDown,
  Folder,
  Globe2,
  History,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "../../../components/icons";
export { Button } from "../../../components/ui/button";
export { Input } from "../../../components/ui/input";
export { buildModelOptions } from "../../../lib/chat/chatPageHelpers";
export { parseModelValue, toModelValue } from "../../../lib/providers/llm";
export { ModelPicker } from "../modelPicker";
export { AgentActivationSwitch } from "../shared";

/** The web UI has no in-process organizer runner; runs are picked up by the
 *  connected desktop agent, so Run Now always reports the queued-remote path. */
export const canRunOrganizerLocally = false;

export function pokeMemoryOrganizer() {
  return false;
}

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
  const selected = options.find((option) => option.value === value);
  const triggerClass = [
    "group/drawer-select inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-foreground/[0.08] bg-white/55 px-3 text-[13px] leading-none text-foreground/90",
    "outline-none transition-[background-color,border-color,box-shadow] duration-150",
    "hover:border-foreground/[0.14] hover:bg-white/75",
    "data-[state=open]:border-foreground/[0.2] data-[state=open]:bg-white/85 data-[state=open]:shadow-[0_1px_0_rgba(255,255,255,0.65)_inset,0_2px_8px_-4px_rgba(15,23,42,0.08)]",
    "data-[placeholder]:text-muted-foreground",
    "focus-visible:outline-none focus-visible:ring-0",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "dark:bg-white/[0.04] dark:hover:bg-white/[0.06] dark:data-[state=open]:bg-white/[0.08]",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger aria-label={ariaLabel} className={triggerClass}>
        <span className="min-w-0 flex-1 truncate text-left">
          <SelectPrimitive.Value placeholder={placeholder}>
            {selected ? selected.label : placeholder}
          </SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 ease-out group-data-[state=open]/drawer-select:rotate-180" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={[
            "drawer-select-content z-[80] overflow-hidden rounded-xl border border-foreground/[0.08] bg-background/95 p-1 text-[13px] text-foreground/90",
            "shadow-[0_24px_48px_-24px_rgba(15,23,42,0.32),0_2px_6px_-3px_rgba(15,23,42,0.18)] backdrop-blur-2xl",
            "min-w-[var(--radix-select-trigger-width)]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
            "origin-[var(--radix-select-content-transform-origin)]",
            "dark:bg-background/90",
          ].join(" ")}
        >
          <SelectPrimitive.Viewport className="max-h-[min(320px,var(--radix-select-content-available-height))] overflow-y-auto p-0.5">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className={[
                  "relative flex w-full cursor-pointer select-none items-start gap-2 rounded-md py-1.5 pl-2.5 pr-8 leading-tight outline-none transition-colors",
                  "hover:bg-foreground/[0.05] focus:bg-foreground/[0.06] focus:text-foreground",
                  "data-[state=checked]:bg-primary/[0.08] data-[state=checked]:text-foreground",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
                ].join(" ")}
              >
                <span className="min-w-0 flex-1">
                  <SelectPrimitive.ItemText>
                    <span className="block truncate">{option.label}</span>
                  </SelectPrimitive.ItemText>
                  {option.description ? (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                <SelectPrimitive.ItemIndicator className="absolute right-2 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center text-primary">
                  <Check className="h-3.5 w-3.5" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
