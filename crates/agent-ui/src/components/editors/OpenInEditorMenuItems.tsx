// "Open in <Editor>" menu entries shared by the file tree context menu, the
// workspace project menu and the chat file link menu. Renders nothing when no
// editor is detected (always the case outside the desktop app).

import { Braces, ChevronRight } from "@liveagent/ui/components/IconSet";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { openInEditorLabel, otherEditors, useEditors } from "@liveagent/ui/lib/editors/editors";
import { cn } from "@liveagent/ui/lib/shared/utils";

type OpenInEditorMenuItemsProps = {
  onOpen: (editorId: string) => void;
  disabled?: boolean;
  /** `context` matches ContextMenuItem styling; `dropdown` the soft menus. */
  variant?: "context" | "dropdown";
  iconClassName?: string;
};

const CONTEXT_ITEM_CLASS = "cursor-pointer gap-2 rounded-lg px-2.5 text-left";

export function OpenInEditorMenuItems({
  onOpen,
  disabled = false,
  variant = "context",
  iconClassName,
}: OpenInEditorMenuItemsProps) {
  const { t } = useLocale();
  const { editors, preferred } = useEditors();
  if (!preferred) return null;
  const others = otherEditors(editors, preferred);
  const itemClassName = variant === "context" ? CONTEXT_ITEM_CLASS : "gap-2";
  const iconClass = cn("size-3.5 shrink-0", iconClassName);

  return (
    <>
      <DropdownMenuItem
        data-open-in-editor={preferred.id}
        disabled={disabled}
        className={itemClassName}
        onClick={() => onOpen(preferred.id)}
      >
        <Braces className={iconClass} />
        <span className="min-w-0 flex-1 truncate">
          {openInEditorLabel(t("editors.openIn"), preferred.name)}
        </span>
      </DropdownMenuItem>
      {others.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={disabled} className={itemClassName}>
            <Braces className={cn(iconClass, "opacity-0")} aria-hidden />
            <span className="min-w-0 flex-1">{t("editors.openInOther")}</span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            variant={variant === "dropdown" ? "soft" : "default"}
            className={cn("min-w-40", variant === "context" && "text-xs")}
          >
            {others.map((editor) => (
              <DropdownMenuItem
                key={editor.id}
                data-open-in-editor={editor.id}
                className={itemClassName}
                onClick={() => onOpen(editor.id)}
              >
                <span className="min-w-0 flex-1 truncate">{editor.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
    </>
  );
}
