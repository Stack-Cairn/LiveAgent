import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { KbdShortcut } from "../../components/ui/kbd";
import { usePlanningT } from "./usePlanningT";

// Each entry lists alternative chords in the shared Kbd syntax; the planner
// matches letters on `event.key`, so they are written as plain labels.
const SHORTCUTS: [chords: string[], label: string][] = [
  [["D"], "planner.shortcuts.day"],
  [["W"], "planner.shortcuts.week"],
  [["M"], "planner.shortcuts.month"],
  [["A"], "planner.shortcuts.agenda"],
  [["T"], "planner.shortcuts.today"],
  [["J", "N"], "planner.shortcuts.next"],
  [["K", "P"], "planner.shortcuts.previous"],
  [["C"], "planner.shortcuts.create"],
  [["/"], "planner.shortcuts.search"],
  [["Alt+ArrowUp", "Alt+ArrowDown"], "planner.shortcuts.moveTime"],
  [["Alt+ArrowLeft", "Alt+ArrowRight"], "planner.shortcuts.moveDay"],
  [["Escape"], "planner.shortcuts.cancel"],
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
            {SHORTCUTS.map(([chords, label]) => (
              <div key={label} className="flex items-center justify-between gap-4 py-2">
                <dt>{t(label)}</dt>
                <dd className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {chords.map((chord, index) => (
                    <span key={chord} className="flex items-center gap-1">
                      {index > 0 && t("planner.shortcuts.or")}
                      <KbdShortcut shortcut={chord} keyClassName="px-1.5" />
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
