import { useId, useState } from "react";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { localizePlanningError, translate } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import type { PlanningCategory } from "../../lib/planning/types";

export type TaskListAction =
  | { kind: "create" }
  | { kind: "rename" | "delete"; list: PlanningCategory };

export function TaskListDialog({
  action,
  onClose,
  onSelect,
}: {
  action: TaskListAction;
  onClose(): void;
  onSelect(id: string): void;
}) {
  const [name, setName] = useState(action.kind === "create" ? "" : action.list.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formId = useId();
  const deleting = action.kind === "delete";
  const title = deleting
    ? translate("planner.list.deleteTitle")
    : action.kind === "rename"
      ? translate("planner.list.renameTitle")
      : translate("planner.list.new");
  const save = async () => {
    if (busy || (!deleting && !name.trim())) return;
    setBusy(true);
    setError("");
    try {
      const list = await planningStore.mutate<PlanningCategory>(
        action.kind === "create"
          ? { action: "group.create", data: { name: name.trim() } }
          : {
              action: deleting ? "group.delete" : "group.update",
              id: action.list.id,
              expectedRevision: action.list.revision,
              data: deleting ? {} : { name: name.trim() },
            },
      );
      if (deleting) onSelect("");
      else if (list) onSelect(list.id);
      onClose();
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-xs" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="py-1">
          <form
            id={formId}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {action.kind === "delete" ? (
              <DialogDescription className="break-words leading-relaxed">
                {translate("planner.list.deleteHint", { name: action.list.name })}
              </DialogDescription>
            ) : (
              <Input
                variant="plain"
                aria-label={translate("planner.list.nameLabel")}
                placeholder={translate("planner.list.namePlaceholder")}
                maxLength={100}
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            {error && (
              <SettingsNotice variant="inline-error" role="alert">
                {error}
              </SettingsNotice>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
              {translate("planner.common.cancel")}
            </Button>
            <Button
              size="sm"
              variant={deleting ? "destructive" : "default"}
              type="submit"
              form={formId}
              disabled={busy || (!deleting && !name.trim())}
            >
              {busy
                ? translate("planner.common.saving")
                : deleting
                  ? translate("planner.list.delete")
                  : translate("planner.common.done")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
