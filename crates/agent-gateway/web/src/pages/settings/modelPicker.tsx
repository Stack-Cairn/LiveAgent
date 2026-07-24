import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ClaudeIcon,
  GeminiIcon,
  GrokIcon,
  OpenaiChatgptIcon,
  Search,
  Sparkles,
} from "../../components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useLocale } from "../../i18n";
import type { ProviderId } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";

// Shared provider-grouped model picker used by the cron prompt-task form and
// the memory settings drawer. Manually kept in sync with the GUI twin (Base UI
// flavor); grouped-collapse behavior mirrors the main page model menu in
// pages/chat/ChatHeader.tsx.

export type ModelPickerOption = {
  value: string;
  label: string;
  providerName: string;
  providerId?: string;
  providerType?: ProviderId;
};

function ProviderBrandIcon({ type, className }: { type?: ProviderId; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  if (type === "claude_code") return <ClaudeIcon className={cls} />;
  if (type === "gemini") return <GeminiIcon className={cls} />;
  if (type === "xai") return <GrokIcon className={cls} />;
  return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-white")} />;
}

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

export function ModelPicker({
  options,
  value,
  onChange,
  disabled,
  placeholder,
  noneLabel,
  ariaLabel,
  triggerClassName,
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
  triggerClassName?: string;
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
      setTimeout(() => searchInputRef.current?.focus(), 0);
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
              option.providerName.toLowerCase().includes(normalizedSearch),
          ),
        }))
        .filter((group) => group.opts.length > 0)
    : groups;

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          triggerClassName,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
              selectedOption
                ? "bg-violet-500/10 text-violet-500"
                : "bg-muted/60 text-muted-foreground",
            )}
          >
            {selectedOption ? (
              <ProviderBrandIcon type={selectedOption.providerType} className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
          </span>
          <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground opacity-50 transition-transform duration-200 ease-out",
            isOpen && "rotate-180",
          )}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="z-[80] w-(--anchor-width) overflow-hidden rounded-xl p-0 text-xs"
      >
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            <input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("chat.searchModel")}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>
        <div className="max-h-[min(14rem,var(--available-height,14rem))] overflow-y-auto overscroll-contain px-1 pb-1 [scrollbar-gutter:stable]">
          {noneLabel && !normalizedSearch ? (
            <DropdownMenuItem
              onSelect={() => onChange("")}
              className={cn(
                "h-[30px] max-w-full shrink-0 justify-between gap-3 overflow-hidden rounded-md py-0 text-xs font-normal leading-5 text-foreground transition-none data-[highlighted]:bg-foreground/[0.05]",
                value === "" &&
                  "bg-foreground/[0.07] font-medium data-[highlighted]:bg-foreground/[0.09]",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Sparkles
                  className={cn("h-4 w-4 shrink-0 opacity-70", value === "" && "opacity-100")}
                />
                <span className="min-w-0 truncate">{noneLabel}</span>
              </span>
              {value === "" ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
            </DropdownMenuItem>
          ) : null}
          {filteredGroups.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t("chat.noModelFound")}
            </div>
          ) : (
            filteredGroups.map((group, groupIndex) => {
              const expanded = isGroupExpanded(group.id);
              return (
                <div key={group.id} className="flex flex-col gap-0.5">
                  {groupIndex > 0 || (noneLabel && !normalizedSearch) ? (
                    <DropdownMenuSeparator className="bg-border/30" />
                  ) : null}
                  <DropdownMenuItem
                    closeOnClick={false}
                    onSelect={() => toggleGroup(group.id)}
                    aria-expanded={expanded}
                    title={expanded ? t("chat.collapseProvider") : t("chat.expandProvider")}
                    className="sticky top-0 z-10 flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-popover/60 px-2 py-0 text-xs font-medium text-muted-foreground/80 backdrop-blur-xl transition-colors data-[highlighted]:bg-muted/40 supports-[backdrop-filter]:bg-popover/40"
                  >
                    <ProviderBrandIcon
                      type={group.providerType}
                      className="h-3.5 w-3.5 opacity-90"
                    />
                    <span className="min-w-0 flex-1 truncate">{group.name}</span>
                    <span className="inline-flex h-4 min-w-[1.1rem] shrink-0 items-center justify-center rounded-full bg-muted/70 px-1 text-[10px] tabular-nums">
                      {group.opts.length}
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                        expanded && "rotate-180",
                      )}
                    />
                  </DropdownMenuItem>
                  {expanded
                    ? group.opts.map((option) => {
                        const isSelected = option.value === value;
                        return (
                          <DropdownMenuItem
                            key={option.value}
                            onSelect={() => onChange(option.value)}
                            className={cn(
                              "h-[30px] max-w-full shrink-0 justify-between gap-3 overflow-hidden rounded-md py-0 text-xs font-normal leading-5 text-foreground transition-none data-[highlighted]:bg-foreground/[0.05]",
                              isSelected &&
                                "bg-foreground/[0.07] font-medium data-[highlighted]:bg-foreground/[0.09]",
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <ProviderBrandIcon
                                type={option.providerType}
                                className={cn("opacity-70", isSelected && "opacity-100")}
                              />
                              <span className="min-w-0 truncate">{option.label}</span>
                            </span>
                            {isSelected ? (
                              <Check className="h-4 w-4 shrink-0 text-primary" />
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })
                    : null}
                </div>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
