import {
  ChevronDown,
  ChevronRight,
  EyeOff,
  Loader2,
  Package,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { ResourceActivationSwitch } from "@liveagent/ui/components/resources/ResourceActivationSwitch";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { ConfirmActionPopover } from "@liveagent/ui/components/ui/confirm-action-popover";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { SkillSummary } from "@liveagent/ui/lib/skills/index";
import type { SkillPackToggleState } from "@liveagent/ui/lib/skills/packs";
import { type ReactNode, useState } from "react";
import { SKILL_LIST_GRID_CLASS } from "./skillCardLayout";

type SkillPackGroupProps = {
  pack: string;
  /** Active skills of the pack (all of them, not only the filtered ones). */
  skillCount: number;
  enabledCount: number;
  toggleState: SkillPackToggleState;
  skillsEnabled: boolean;
  deleting: boolean;
  deleteDisabled: boolean;
  /** Filtering is on: the group opens to show the matches. */
  forceExpanded: boolean;
  /** Shadowed copies inside the pack, listed after the active skills. */
  shadowed: readonly SkillSummary[];
  /** Cards of the pack's active skills that pass the current filters. */
  children: ReactNode;
  onToggle: (pack: string, on: boolean) => void;
  onDelete: (pack: string) => void;
};

/** Collapsible group of the skills of one skill pack. */
export function SkillPackGroup({
  pack,
  skillCount,
  enabledCount,
  toggleState,
  skillsEnabled,
  deleting,
  deleteDisabled,
  forceExpanded,
  shadowed,
  children,
  onToggle,
  onDelete,
}: SkillPackGroupProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const open = expanded || forceExpanded;
  const Chevron = open ? ChevronDown : ChevronRight;
  const on = skillsEnabled && toggleState !== "off";

  return (
    <section
      data-skill-pack={pack}
      aria-label={`${t("settings.skillPackLabel")}: ${pack}`}
      className="rounded-xl border border-border/50 bg-settings-tile/40"
    >
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-label={t(open ? "settings.skillPackCollapse" : "settings.skillPackExpand").replace(
            "{pack}",
            pack,
          )}
          className="h-auto min-w-0 flex-1 justify-start gap-2 px-1 py-1 text-left"
          onClick={() => setExpanded(!open)}
        >
          <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
            <Package className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-foreground">{pack}</span>
              <Badge variant="muted" className="h-5 shrink-0 px-1.5 text-tiny">
                {t("settings.skillPackLabel")}
              </Badge>
            </span>
            <span className="block truncate text-tiny text-muted-foreground">
              {t("settings.skillPackCount").replace("{count}", String(skillCount))}
              {" · "}
              {toggleState === "mixed"
                ? t("settings.skillPackMixed")
                : t("settings.skillPackEnabledCount")
                    .replace("{enabled}", String(enabledCount))
                    .replace("{count}", String(skillCount))}
            </span>
          </span>
        </Button>
        <div className="flex shrink-0 items-center gap-1">
          <ConfirmActionPopover
            title={t("settings.skillPackDelete")}
            description={t("settings.skillPackDeleteConfirm")
              .replace("{pack}", pack)
              .replace("{count}", String(skillCount))}
            confirmLabel={t("settings.delete")}
            onConfirm={() => onDelete(pack)}
          >
            {(openConfirm) => (
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={deleteDisabled}
                aria-label={`${t("settings.skillPackDelete")}: ${pack}`}
                title={t("settings.skillPackDelete")}
                onClick={openConfirm}
              >
                {deleting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
              </Button>
            )}
          </ConfirmActionPopover>
          <ResourceActivationSwitch
            checked={on}
            disabled={!skillsEnabled}
            compact
            label={`${t("settings.skillPackToggle")}: ${pack}`}
            onCheckedChange={(next) => onToggle(pack, next)}
          />
        </div>
      </div>
      {open ? (
        <div className={cn(SKILL_LIST_GRID_CLASS, "border-t border-border/40 p-1.5")}>
          {children}
          {shadowed.map((skill) => (
            <div
              key={skill.baseDir}
              data-shadowed-skill={skill.baseDir}
              className="flex min-w-0 items-start gap-3 rounded-xl px-3.5 py-2 opacity-70"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground">
                <EyeOff className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {skill.name}
                  </span>
                  <Badge variant="muted" className="h-5 shrink-0 px-1.5 text-tiny">
                    {t("settings.skillPackShadowed")}
                  </Badge>
                </span>
                <span className="block truncate text-tiny text-muted-foreground">
                  {skill.baseDir}
                </span>
                {skill.shadowedBy ? (
                  <span className="block truncate text-tiny text-muted-foreground">
                    {t("settings.skillPackShadowedBy").replace("{by}", skill.shadowedBy)}
                  </span>
                ) : null}
              </span>
              <ResourceActivationSwitch
                checked={false}
                disabled
                compact
                label={`${t("settings.skillPackShadowed")}: ${skill.name}`}
                onCheckedChange={() => {}}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
