import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { usePlanningT } from "./usePlanningT";

const SHORTCUTS: [keys: string[], label: string][] = [
  [["D"], "planner.shortcuts.day"],
  [["W"], "planner.shortcuts.week"],
  [["M"], "planner.shortcuts.month"],
  [["A"], "planner.shortcuts.agenda"],
  [["T"], "planner.shortcuts.today"],
  [["J", "N"], "planner.shortcuts.next"],
  [["K", "P"], "planner.shortcuts.previous"],
  [["C"], "planner.shortcuts.create"],
  [["/"], "planner.shortcuts.search"],
  [["Alt", "↑ ↓"], "planner.shortcuts.moveTime"],
  [["Alt", "← →"], "planner.shortcuts.moveDay"],
  [["Esc"], "planner.shortcuts.cancel"],
  [["?"], "planner.shortcuts.help"],
];

/** Keyboard shortcut reference, opened with "?" like Google Calendar. */
export function ShortcutHelp({ onClose }: { onClose(): void }) {
  const { t } = usePlanningT();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton closeLabel={t("planner.common.close")}>
        <DialogHeader>
          <DialogTitle>{t("planner.shortcuts.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <dl className="divide-y divide-border text-sm">
            {SHORTCUTS.map(([keys, label]) => (
              <div key={label} className="flex items-center justify-between gap-4 py-2">
                <dt>{t(label)}</dt>
                <dd className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {keys.map((key, index) => (
                    <span key={key} className="flex items-center gap-1">
                      {index > 0 && (keys[0] === "Alt" ? "+" : t("planner.shortcuts.or"))}
                      <kbd className="rounded border border-foreground/10 px-1.5">{key}</kbd>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
