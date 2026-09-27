import { useState } from "react";
import { RotateCcw, Trash2 } from "../../components/IconSet";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import { useConfirmDialog } from "../../components/ui/confirm-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { localizePlanningError, planningDateLocale, translate } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import type { PlanningSnapshot } from "../../lib/planning/types";

export function PlanningTrash({
  snapshot,
  onClose,
}: {
  snapshot: PlanningSnapshot;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [limit, setLimit] = useState(20);
  const { confirm, dialog } = useConfirmDialog();
  const entries = [
    ...snapshot.todos.filter((t) => t.deletedAt).map((t) => ({ ...t, kind: "todo" as const })),
    ...(snapshot.eventMasters ?? snapshot.events)
      .filter((e) => e.deletedAt)
      .map((e) => ({ ...e, kind: "event" as const })),
  ].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  const apply = async (item: (typeof entries)[number], permanent: boolean) => {
    if (
      permanent &&
      !(await confirm({
        title: translate("planner.trash.purgeTitle", { title: item.title }),
        description:
          item.kind === "todo"
            ? translate("planner.trash.purgeTask")
            : translate("planner.trash.purgeEvent"),
        confirmLabel: translate("planner.trash.purge"),
        cancelLabel: translate("planner.common.keep"),
        preferCancel: true,
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await planningStore.mutate({
        action: `${item.kind}.${permanent ? "purge" : "restore"}`,
        id: item.id,
        expectedRevision: item.revision,
        data: {},
      });
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-85dvh max-w-xl flex-col"
        showCloseButton
        closeLabel={translate("planner.common.close")}
        closeDisabled={busy}
      >
        <DialogHeader>
          <DialogTitle>{translate("planner.trash")}</DialogTitle>
          <DialogDescription>{translate("planner.trash.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error && (
            <SettingsNotice variant="action-error" role="alert">
              {error}
            </SettingsNotice>
          )}
          {entries.length ? (
            <ul className="divide-y divide-border">
              {entries.slice(0, limit).map((item) => (
                <li key={`${item.kind}-${item.id}`} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.kind === "todo"
                        ? translate("planner.kind.task")
                        : translate("planner.kind.event")}{" "}
                      ·{" "}
                      {new Date(item.deletedAt ?? 0).toLocaleDateString(planningDateLocale(), {
                        timeZone: snapshot.timeZone,
                      })}
                    </p>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={translate("planner.trash.restoreLabel", { title: item.title })}
                    onClick={() => void apply(item, false)}
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={busy}
                    aria-label={translate("planner.trash.purgeLabel", { title: item.title })}
                    onClick={() => void apply(item, true)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState className="h-auto py-12">{translate("planner.trash.empty")}</EmptyState>
          )}
          {entries.length > limit && (
            <Button variant="ghost" className="w-full" onClick={() => setLimit(limit + 20)}>
              {translate("planner.common.loadMore", { count: entries.length - limit })}
            </Button>
          )}
        </DialogBody>
      </DialogContent>
      {dialog}
    </Dialog>
  );
}
