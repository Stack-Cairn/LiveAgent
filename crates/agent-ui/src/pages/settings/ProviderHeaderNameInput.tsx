import * as React from "react";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../../components/ui/autocomplete";
import { Input } from "../../components/ui/input";

type Props = Omit<React.ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
  value: string;
  suggestions: readonly string[];
  onValueChange: (value: string) => void;
  onComplete: () => void;
};

/** A free-form header name with optional presets, not a constrained select. */
export const ProviderHeaderNameInput = React.forwardRef<HTMLInputElement, Props>(
  ({ value, suggestions, onValueChange, onComplete, variant, ...props }, ref) => (
    <Autocomplete
      value={value}
      items={suggestions}
      autoHighlight
      openOnInputClick
      onValueChange={(next, details) => {
        onValueChange(next);
        if (details.reason === "item-press") onComplete();
      }}
    >
      <AutocompleteInput
        ref={ref}
        render={<Input variant={variant} />}
        {...props}
        onKeyDown={(event) => {
          // Base UI owns suggestion navigation and selection. Enter without
          // an active option advances to the header value, as before.
          if (event.key === "Enter" && !event.currentTarget.getAttribute("aria-activedescendant")) {
            event.preventDefault();
            onComplete();
          }
        }}
      />
      <AutocompletePopup className="data-[empty]:hidden">
        <AutocompleteList>
          {(preset: string) => (
            <AutocompleteItem key={preset} value={preset} className="font-mono text-xs">
              {preset}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  ),
);
ProviderHeaderNameInput.displayName = "ProviderHeaderNameInput";
