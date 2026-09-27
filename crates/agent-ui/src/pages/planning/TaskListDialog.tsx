import { useId, useState } from "react";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
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
import { Label } from "../../components/ui/label";
import { localizePlanningError, translate } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import type { PlanningCategory } from "../../lib/planning/types";
import { PlanningField, PlanningSelect } from "./PlanningControls";

export type TaskListAction =
  | { kind: "create" }
  | { kind: "rename"; list: PlanningCategory }
  /** `fallback` names the list that receives the deleted list's tasks. */
  | { kind: "delete"; list: PlanningCategory; fallback: string }
  /** Delete the built-in My Tasks: its tasks move to (or are recycled in) a new default list. */
  | { kind: "deleteMyTasks"; lists: PlanningCategory[]; taskCount: number };

export function TaskListDialog({
  action,
  onClose,
  onSelect,
}: {
  action: TaskListAction;
  onClose(): void;
  onSelect(id: string): void;
}) {
  const [name, setName] = useState(
    action.kind === "rename" || action.kind === "delete" ? action.list.name : "",
  );
  const [target, setTarget] = useState(
    action.kind === "deleteMyTasks" ? (action.lists[0]?.id ?? "") : "",
  );
  const [trashTasks, setTrashTasks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formId = useId();
  const deleting = action.kind === "delete" || action.kind === "deleteMyTasks";
  // With no other list yet, the new default list is created in the same step.
  const needsName = action.kind === "deleteMyTasks" ? !action.lists.length && !target : !deleting;
  const title = deleting
    ? translate("planner.list.deleteTitle")
    : action.kind === "rename"
      ? translate("planner.list.renameTitle")
      : translate("planner.list.new");
  const save = async () => {
    if (busy || (needsName && !name.trim())) return;
    setBusy(true);
    setError("");
    try {
      if (action.kind === "deleteMyTasks") {
        const home =
          target ||
          (
            await planningStore.mutate<PlanningCategory>({
              action: "group.create",
              data: { name: name.trim() },
            })
          )?.id;
        if (!home) return;
        // A retry after a failed second step reuses the list created here.
        setTarget(home);
        await planningStore.mutate({
          action: "mytasks.delete",
          data: { defaultGroupId: home, deleteTasks: trashTasks },
        });
        onSelect(home);
        onClose();
        return;
      }
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
      <DialogContent
        className={action.kind === "deleteMyTasks" ? "max-w-sm" : "max-w-xs"}
        showCloseButton={false}
      >
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
            {action.kind === "deleteMyTasks" ? (
              <div className="space-y-4">
                <DialogDescription className="break-words leading-relaxed">
                  {translate("planner.list.deleteMyTasksHint")}
                </DialogDescription>
                {action.lists.length ? (
                  <PlanningField label={translate("planner.list.newDefault")}>
                    <PlanningSelect
                      value={target}
                      disabled={busy}
                      onValueChange={setTarget}
                      options={action.lists.map((list) => ({ value: list.id, label: list.name }))}
                    />
                  </PlanningField>
                ) : (
                  <PlanningField label={translate("planner.list.newDefault")}>
                    <Input
                      variant="plain"
                      placeholder={translate("planner.list.namePlaceholder")}
                      maxLength={100}
                      value={name}
                      disabled={busy || !!target}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </PlanningField>
                )}
                {action.taskCount > 0 && (
                  <Label className="flex items-start gap-2 text-sm font-normal leading-relaxed">
                    <Checkbox
                      className="mt-0.5"
                      disabled={busy}
                      checked={trashTasks}
                      onCheckedChange={(checked) => setTrashTasks(checked)}
                    />
                    {translate("planner.list.trashMyTasks", { count: action.taskCount })}
                  </Label>
                )}
              </div>
            ) : action.kind === "delete" ? (
              <DialogDescription className="break-words leading-relaxed">
                {translate("planner.list.deleteHint", {
                  name: action.list.name,
                  target: action.fallback,
                })}
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
              disabled={busy || (needsName && !name.trim())}
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
