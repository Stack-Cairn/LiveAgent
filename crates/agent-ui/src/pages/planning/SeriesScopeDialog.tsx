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

export type SeriesScope = "this" | "following" | "all";
interface ScopeRequest {
  title: string;
  /** Changes that only the series can hold (rule, calendar, notification) hide "此日程". */
  allowThis: boolean;
  /** Hidden on the first occurrence, where it equals "所有日程". */
  allowFollowing: boolean;
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
    (title: string, { allowThis = true, allowFollowing = true } = {}) =>
      new Promise<SeriesScope | null>((resolve) => {
        pending.current?.resolve(null);
        pending.current = { title, allowThis, allowFollowing, resolve };
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
        <AlertDialogBody className="space-y-3">
          {!request.allowThis && (
            <AlertDialogDescription>{t("planner.series.allOnlyHint")}</AlertDialogDescription>
          )}
          <div className="flex flex-col gap-2">
            {(
              [
                ["this", request.allowThis],
                ["following", request.allowFollowing],
                ["all", true],
              ] as const
            )
              .filter(([, shown]) => shown)
              .map(([scope], index) => (
                <Button
                  key={scope}
                  type="button"
                  variant="outline"
                  className="justify-start"
                  autoFocus={index === 0}
                  onClick={() => finish(scope)}
                >
                  {t(`planner.series.${scope}`)}
                </Button>
              ))}
          </div>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogActions>
            <AlertDialogClose render={<Button type="button" variant="ghost" className="h-8" />}>
              {t("planner.common.cancel")}
            </AlertDialogClose>
          </AlertDialogActions>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { askScope, scopeDialog };
}
