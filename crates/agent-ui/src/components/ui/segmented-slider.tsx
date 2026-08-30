import * as React from "react";

import { cn } from "../../lib/shared/utils";

export type SegmentedSliderOption<T extends string> = {
  value: T;
  label: string;
};

type SegmentedSliderProps<T extends string> = {
  value: T;
  options: readonly SegmentedSliderOption<T>[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

/**
 * 等宽分段的状态滑块：滑动指示块按选中档位平移，语义上是单选组。
 * 底层是同名原生 radio，Tab 进出分组、方向键换档由浏览器原生承担。
 */
export function SegmentedSlider<T extends string>(props: SegmentedSliderProps<T>) {
  const { value, options, onValueChange, disabled = false, className } = props;
  const groupName = React.useId();
  const segmentCount = Math.max(options.length, 1);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      role="radiogroup"
      aria-label={props["aria-label"]}
      data-slot="segmented-slider"
      className={cn(
        "relative grid h-7 shrink-0 rounded-lg bg-muted p-0.5 text-muted-foreground",
        disabled && "opacity-60",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${segmentCount}, minmax(0, 1fr))` }}
    >
      {/* 滑动指示块：恒为一档宽，translateX 以自身宽度为单位滑到选中档。 */}
      <span
        aria-hidden
        data-slot="segmented-slider-thumb"
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-background shadow-sm transition-transform duration-200 ease-out"
        style={{
          width: `calc((100% - 4px) / ${segmentCount})`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "relative inline-flex min-w-0 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-[11px] font-medium leading-none transition-colors",
            "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            disabled ? "cursor-not-allowed" : "cursor-pointer",
            option.value === value ? "text-foreground" : "hover:text-foreground/80",
          )}
        >
          <input
            type="radio"
            className="sr-only"
            name={groupName}
            value={option.value}
            checked={option.value === value}
            disabled={disabled}
            onChange={() => onValueChange(option.value)}
          />
          <span className="truncate">{option.label}</span>
        </label>
      ))}
    </div>
  );
}
