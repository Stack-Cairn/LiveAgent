import { Download, Loader2, RefreshCw } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type AppUpdateController, getAppUpdateDisplayVersion } from "../lib/appUpdates";

type AppUpdateButtonProps = {
  appUpdate: AppUpdateController;
  className?: string;
  iconOnly?: boolean;
  iconClassName?: string;
};

function interpolate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

export function AppUpdateButton({
  appUpdate,
  className,
  iconOnly = false,
  iconClassName,
}: AppUpdateButtonProps) {
  const { t } = useLocale();
  if (!appUpdate.showUpdateButton) {
    return null;
  }

  const version = getAppUpdateDisplayVersion(appUpdate.result);
  const busy = appUpdate.installing || appUpdate.restarting;
  const installed = appUpdate.installed;
  const actionLabel = installed ? t("appUpdate.restart") : t("appUpdate.update");
  const title =
    appUpdate.status === "error" && appUpdate.message
      ? interpolate(t("appUpdate.failedRetry"), { message: appUpdate.message })
      : installed
        ? t("appUpdate.restartToComplete")
        : version
          ? interpolate(t("appUpdate.updateTo"), { version })
          : t("appUpdate.update");

  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      className={cn(
        iconOnly
          ? cn(
              "group/update relative size-6 shrink-0 gap-0 overflow-hidden rounded-full bg-ui-4096ff",
              "px-0 text-xs font-medium leading-none text-white shadow-none transition-[width,background-color] duration-150",
              "hover:w-10 hover:bg-ui-1677ff hover:text-white active:bg-ui-0958d9",
            )
          : cn(
              "h-22px shrink-0 gap-3px rounded-full bg-ui-4096ff px-2",
              "text-xs font-medium leading-none text-white shadow-none",
              "hover:bg-ui-1677ff hover:text-white active:bg-ui-0958d9",
            ),
        className,
      )}
      disabled={busy}
      title={title}
      aria-label={title}
      onClick={() =>
        void (installed ? appUpdate.restart() : appUpdate.installAndRestart()).catch(
          () => undefined,
        )
      }
    >
      {busy ? (
        <Loader2 className={cn(iconOnly ? "size-3" : "size-13px", iconClassName, "animate-spin")} />
      ) : installed ? (
        <RefreshCw
          className={cn(
            iconOnly
              ? "size-3 transition-opacity duration-150 group-hover/update:opacity-0"
              : "size-13px",
            iconClassName,
          )}
        />
      ) : (
        <Download
          className={cn(
            iconOnly
              ? "size-3 transition-opacity duration-150 group-hover/update:opacity-0"
              : "size-13px",
            iconClassName,
          )}
        />
      )}
      {iconOnly ? (
        busy ? null : (
          <span className="pointer-events-none absolute whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover/update:opacity-100">
            {actionLabel}
          </span>
        )
      ) : (
        actionLabel
      )}
    </Button>
  );
}
