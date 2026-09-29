import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogActions,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { usePlanningT } from "./usePlanningT";

export type SeriesScope = "this" | "all";
interface ScopeRequest {
  title: string;
  /** Changes that only the series can hold (rule, calendar, notification) hide "此日程". */
  allowThis: boolean;
  resolve(scope: SeriesScope | null): void;
}

/** Google's "修改重复活动" prompt: apply a change to one occurrence or the whole series. */
export function useSeriesScope() {
  const { t } = usePlanningT();
  const [request, setRequest] = useState<ScopeRequest | null>(null);
  const pending = useRef<ScopeRequest | null>(null);
  const finish = useCallback((scope: SeriesScope | null) => {
    pending.current?.resolve(scope);
    pending.current = null;
    setRequest(null);
  }, []);
  const askScope = useCallback(
    (title: string, allowThis = true) =>
      new Promise<SeriesScope | null>((resolve) => {
        pending.current?.resolve(null);
        pending.current = { title, allowThis, resolve };
        setRequest(pending.current);
      }),
    [],
  );
  useEffect(() => () => pending.current?.resolve(null), []);
  const scopeDialog = request && (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
        </AlertDialogHeader>
        {!request.allowThis && (
          <AlertDialogBody>
            <AlertDialogDescription>{t("planner.series.allOnlyHint")}</AlertDialogDescription>
          </AlertDialogBody>
        )}
        <AlertDialogFooter>
          <AlertDialogActions>
            <AlertDialogClose render={<Button type="button" variant="ghost" className="h-8" />}>
              {t("planner.common.cancel")}
            </AlertDialogClose>
            {request.allowThis && (
              <Button
                type="button"
                variant="outline"
                className="h-8"
                autoFocus
                onClick={() => finish("this")}
              >
                {t("planner.series.this")}
              </Button>
            )}
            <Button type="button" className="h-8" onClick={() => finish("all")}>
              {t("planner.series.all")}
            </Button>
          </AlertDialogActions>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { askScope, scopeDialog };
}
