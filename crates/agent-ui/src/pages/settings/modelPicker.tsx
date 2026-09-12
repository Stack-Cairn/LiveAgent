import type { ProviderId } from "@liveagent/app/lib/settings/index";
import { Check, ChevronDown, Search } from "@liveagent/ui/components/IconSet";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useRef, useState } from "react";

// Shared searchable model picker. Platform adapters provide model options.

export type ModelPickerOption = {
  value: string;
  label: string;
  description?: string;
  providerName: string;
  providerId?: string;
  providerType?: ProviderId;
};

type ModelGroup = {
  id: string;
  name: string;
  providerType?: ProviderId;
  opts: ModelPickerOption[];
};

function groupOptionsByProvider(options: ModelPickerOption[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const byId = new Map<string, ModelGroup>();
  for (const option of options) {
    const id = option.providerId ?? option.providerName;
    let group = byId.get(id);
    if (!group) {
      group = { id, name: option.providerName, providerType: option.providerType, opts: [] };
      byId.set(id, group);
      groups.push(group);
    }
    group.opts.push(option);
  }
  return groups;
}

const TRIGGER_VARIANTS = {
  plain:
    "h-9 rounded-lg border-0 bg-settings-tile-hover text-sm shadow-none hover:bg-settings-active",
  default: "h-10 rounded-md border-input bg-background text-sm shadow-xs",
  compact: "h-9 rounded-md border-input bg-background text-sm shadow-xs hover:bg-accent/40",
  quiet:
    "h-9 rounded-lg border-foreground/10 bg-white/70 text-sm shadow-none dark:bg-background/40",
  dashed:
    "h-8 rounded-lg border-dashed border-foreground/[0.13] bg-transparent py-0 text-xs text-muted-foreground shadow-none hover:border-foreground/[0.24] hover:bg-foreground/[0.02]",
} as const;

function ModelOptionItem({
  selected,
  label,
  description,
  onSelect,
}: {
  selected: boolean;
  label: string;
  description?: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        "justify-between gap-3 overflow-hidden",
        selected && "bg-accent text-accent-foreground",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">{label}</span>
        {description ? (
          <span className="min-w-0 truncate text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {selected ? <Check className="size-3.5" /> : null}
      </span>
    </DropdownMenuItem>
  );
}

export function ModelPicker({
  options,
  value,
  onChange,
  disabled,
  placeholder,
  noneLabel,
  ariaLabel,
  variant = "default",
  collapsibleGroups = true,
  searchPlaceholder,
  emptyLabel,
}: {
  options: ModelPickerOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Trigger text when no model is selected. */
  placeholder: string;
  /** When set, a top entry with this label clears the selection (value ""). */
  noneLabel?: string;
  ariaLabel?: string;
  variant?: keyof typeof TRIGGER_VARIANTS;
  /** Opt into collapsible provider groups for dense model lists. */
  collapsibleGroups?: boolean;
  /** Search input placeholder; defaults to the shared model-search translation. */
  searchPlaceholder?: string;
  /** Empty search result label; defaults to the shared model-empty translation. */
  emptyLabel?: string;
}) {
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setExpandedGroups({});
    }
  }, [isOpen]);

  const normalizedSearch = search.trim().toLowerCase();
  const groups = groupOptionsByProvider(options);
  const selectedOption = options.find((option) => option.value === value);
  const selectedGroupId = selectedOption
    ? (selectedOption.providerId ?? selectedOption.providerName)
    : undefined;
  // 默认全部折叠，仅当前选中模型所在分组展开；搜索时强制展开所有匹配分组
  const isGroupExpanded = (id: string) =>
    normalizedSearch.length > 0 || (expandedGroups[id] ?? id === selectedGroupId);
  // 基于存储态取反（而非 isGroupExpanded）：搜索强制展开是只读覆盖，
  // 不应让搜索期间的点击把折叠态写坏
  const toggleGroup = (id: string) =>
    setExpandedGroups((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? id === selectedGroupId),
    }));

  const filteredGroups = normalizedSearch
    ? groups
        .map((group) => ({
          ...group,
          opts: group.opts.filter(
            (option) =>
              option.label.toLowerCase().includes(normalizedSearch) ||
              option.providerName.toLowerCase().includes(normalizedSearch) ||
              option.description?.toLowerCase().includes(normalizedSearch),
          ),
        }))
        .filter((group) => group.opts.length > 0)
    : groups;

  // Menu.Root is a fragment. When open, Base UI injects FocusGuard siblings
  // around the trigger; Tailwind v4 `space-y-*` then treats the trigger as
  // `:not(:last-child)` and adds margin-bottom, shifting fields below.
  // A single wrapper keeps those guards out of the parent spacing context.
  return (
    <div className="w-full min-w-0">
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            "flex w-full cursor-pointer items-center justify-between gap-2 border px-3 py-2 transition-colors",
            TRIGGER_VARIANTS[variant],
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
              {selectedOption ? selectedOption.label : placeholder}
            </span>
          </span>
          <ChevronDown
            className={cn("size-3.5 shrink-0 text-muted-foreground", isOpen && "rotate-180")}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          collisionPadding={8}
          className="w-(--anchor-width) min-w-64 max-w-[calc(100vw-32px)] overflow-hidden rounded-xl p-1 shadow-lg"
        >
          <div className="px-2 py-1.5">
            <div
              className={cn(
                "flex items-center gap-1.5",
                "h-8 rounded-lg bg-settings-tile-hover px-2.5",
              )}
            >
              <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
              <input
                ref={searchInputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder ?? t("chat.searchModel")}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto overscroll-contain px-1 pb-1">
            {noneLabel && !normalizedSearch ? (
              <ModelOptionItem
                selected={value === ""}
                onSelect={() => onChange("")}
                label={noneLabel}
              />
            ) : null}
            {filteredGroups.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                {emptyLabel ?? t("chat.noModelFound")}
              </div>
            ) : (
              filteredGroups.map((group, groupIndex) => {
                const expanded = isGroupExpanded(group.id);
                return (
                  <div key={group.id} className="flex flex-col gap-0.5">
                    {groupIndex > 0 || (noneLabel && !normalizedSearch) ? (
                      <DropdownMenuSeparator />
                    ) : null}
                    {collapsibleGroups ? (
                      <DropdownMenuItem
                        closeOnClick={false}
                        onSelect={() => toggleGroup(group.id)}
                        aria-expanded={expanded}
                        title={expanded ? t("chat.collapseProvider") : t("chat.expandProvider")}
                        className={cn("sticky top-0 z-10 cursor-pointer", "gap-1.5 bg-popover")}
                      >
                        <ProviderBrandIcon
                          type={group.providerType}
                          className="size-3.5 opacity-90"
                        />
                        <span className="min-w-0 flex-1 truncate">{group.name}</span>
                        <span
                          className={cn(
                            "inline-flex h-4 min-w-[1.1rem] shrink-0 items-center justify-center rounded-full bg-muted/70",
                            "px-1 text-tiny tabular-nums",
                          )}
                        >
                          {group.opts.length}
                        </span>
                        <ChevronDown
                          className={cn(
                            "size-3.5 shrink-0 transition-transform duration-200",
                            expanded && "rotate-180",
                          )}
                        />
                      </DropdownMenuItem>
                    ) : (
                      <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                        {group.name}
                      </div>
                    )}
                    {!collapsibleGroups || expanded
                      ? group.opts.map((option) => (
                          <ModelOptionItem
                            key={option.value}
                            selected={option.value === value}
                            onSelect={() => onChange(option.value)}
                            label={option.label}
                            description={option.description}
                          />
                        ))
                      : null}
                  </div>
                );
              })
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
