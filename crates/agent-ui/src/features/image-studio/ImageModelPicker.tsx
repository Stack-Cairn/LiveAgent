import { useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ImageIcon, Package } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { menuSurfaceClassName } from "../../components/ui/menu-surface";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { useLocale } from "../../i18n";
import type { ImageTarget } from "../../lib/imaging/types";
import { cn } from "../../lib/shared/utils";
import { splitTargetName, targetDisabledText } from "./studioModel";
import type { Translate } from "./studioText";

// The popup mirrors the chat composer's model picker (ComposerModelControls):
// provider-grouped rows with capability badges and a check mark.

function modeBadges(target: ImageTarget, t: Translate) {
  const operations = target.capabilities.operations;
  return [
    operations.includes("generate") && t("imageStudio.textToImage"),
    (operations.includes("edit") || operations.includes("reference")) &&
      t("imageStudio.imageToImage"),
  ].filter((badge): badge is string => Boolean(badge));
}

function groupByProvider(targets: ImageTarget[], other: string) {
  const groups = new Map<string, ImageTarget[]>();
  for (const target of targets) {
    const provider = splitTargetName(target.name).provider ?? other;
    groups.set(provider, [...(groups.get(provider) ?? []), target]);
  }
  return [...groups.entries()];
}

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex h-6 items-center gap-1.5 bg-popover px-2.5 text-tiny font-medium uppercase tracking-wide text-muted-foreground">
      <span className="min-w-0 truncate">{label}</span>
      <span className="ml-auto tabular-nums">{count}</span>
    </div>
  );
}

function ModelRow({
  target,
  selected,
  onSelect,
}: {
  target: ImageTarget;
  selected: boolean;
  onSelect: () => void;
}) {
  const { model } = splitTargetName(target.name);
  const { t } = useLocale();
  return (
    <button
      type="button"
      data-model-option=""
      aria-pressed={selected}
      disabled={!target.enabled}
      title={target.enabled ? target.name : targetDisabledText(target, t)}
      onClick={onSelect}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "bg-settings-active font-medium text-foreground hover:bg-settings-active"
          : "text-foreground/90 hover:bg-settings-tile-hover hover:text-foreground",
      )}
    >
      <ImageIcon
        className={cn("size-3 shrink-0", selected ? "opacity-80" : "opacity-45")}
        strokeWidth={1.75}
      />
      <span className="min-w-0 flex-1 truncate">{model}</span>
      <span className="flex min-w-0 shrink-0 items-center gap-1 text-tiny font-normal text-muted-foreground">
        {target.enabled ? (
          modeBadges(target, t).map((badge) => (
            <span key={badge} className="rounded bg-muted/60 px-1 py-px">
              {badge}
            </span>
          ))
        ) : (
          <span className="max-w-36 truncate">{targetDisabledText(target, t)}</span>
        )}
      </span>
      <span className="size-3.5 shrink-0">{selected && <Check className="size-3.5" />}</span>
    </button>
  );
}

export function ImageModelPicker({
  id,
  targets,
  value,
  onChange,
  onOpen,
  className,
}: {
  id: string;
  targets: ImageTarget[];
  value: string;
  onChange: (targetId: string) => void;
  onOpen?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useLocale();
  const contentRef = useRef<HTMLDivElement>(null);
  const available = targets.filter((target) => target.enabled);
  const unavailable = targets.filter((target) => !target.enabled);
  const current = targets.find((target) => target.id === value);
  const missing = Boolean(value) && !current;
  const label = current
    ? splitTargetName(current.name).model
    : missing
      ? t("imageStudio.modelPicker.missing")
      : targets.length
        ? t("imageStudio.modelPicker.choose")
        : t("imageStudio.modelPicker.none");
  const warn = missing || (current && !current.enabled);
  const select = (targetId: string) => {
    onChange(targetId);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="ghost"
            title={current?.name ?? label}
            className={cn(
              "h-10 w-full min-w-0 justify-start gap-2 rounded-xl border border-border px-3 font-normal sm:w-64",
              open && "bg-muted/60",
              warn && "text-destructive",
              className,
            )}
          />
        }
      >
        {warn ? (
          <AlertTriangle className="size-4 shrink-0" />
        ) : (
          <Package className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            !current && !missing && "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        aria-label={t("imageStudio.modelPicker.choose")}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const rows = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button[data-model-option]:not(:disabled)",
            ),
          );
          const index = rows.indexOf(document.activeElement as HTMLButtonElement);
          const down = event.key === "ArrowDown";
          // From outside the list, Down enters at the top and Up at the bottom.
          const next =
            index < 0
              ? rows[down ? 0 : rows.length - 1]
              : rows[(index + (down ? 1 : -1) + rows.length) % rows.length];
          if (next) {
            event.preventDefault();
            next.focus();
          }
        }}
        className={cn(
          "flex max-h-[min(380px,75dvh)] w-[300px] max-w-[calc(100vw-16px)] flex-col overflow-y-auto",
          menuSurfaceClassName,
          "p-1.5 text-xs leading-5",
        )}
      >
        {available.length === 0 && (
          <p className="px-3 py-6 text-center text-muted-foreground">
            {t("imageStudio.modelPicker.noneHint")}
          </p>
        )}
        {groupByProvider(available, t("imageStudio.modelPicker.other")).map(([provider, items]) => (
          <div key={provider} className="space-y-0.5 pb-1.5 last:pb-0">
            <GroupHeader label={provider} count={items.length} />
            {items.map((target) => (
              <ModelRow
                key={target.id}
                target={target}
                selected={target.id === value}
                onSelect={() => select(target.id)}
              />
            ))}
          </div>
        ))}
        {unavailable.length > 0 && (
          <div className="space-y-0.5 border-t border-border/40 pt-1.5">
            <GroupHeader
              label={t("imageStudio.modelPicker.unavailable")}
              count={unavailable.length}
            />
            {unavailable.map((target) => (
              <ModelRow
                key={target.id}
                target={target}
                selected={target.id === value}
                onSelect={() => select(target.id)}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
