import { useLocale } from "../i18n";
import { type AppUpdateController, getAppUpdateDisplayVersion } from "../lib/appUpdates";
import { cn } from "../lib/shared/utils";
import { Download, Loader2 } from "./icons";
import { Button } from "./ui/button";

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
  const title =
    appUpdate.status === "error" && appUpdate.message
      ? interpolate(t("appUpdate.failedRetry"), { message: appUpdate.message })
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
          ? "group/update relative h-6 w-6 shrink-0 gap-0 overflow-hidden rounded-full bg-[#4096ff] px-0 text-[11px] font-medium leading-none text-white shadow-none transition-[width,background-color] duration-150 hover:w-10 hover:bg-[#1677ff] hover:text-white active:bg-[#0958d9]"
          : "h-[22px] shrink-0 gap-[3px] rounded-full bg-[#4096ff] px-2 text-[11px] font-medium leading-none text-white shadow-none hover:bg-[#1677ff] hover:text-white active:bg-[#0958d9]",
        className,
      )}
      disabled={busy}
      title={title}
      aria-label={title}
      onClick={() => void appUpdate.installAndRestart().catch(() => undefined)}
    >
      {busy ? (
        <Loader2
          className={cn(iconOnly ? "h-3 w-3" : "h-[13px] w-[13px]", iconClassName, "animate-spin")}
        />
      ) : (
        <Download
          className={cn(
            iconOnly
              ? "h-3 w-3 transition-opacity duration-150 group-hover/update:opacity-0"
              : "h-[13px] w-[13px]",
            iconClassName,
          )}
        />
      )}
      {iconOnly ? (
        busy ? null : (
          <span className="pointer-events-none absolute whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover/update:opacity-100">
            {t("appUpdate.update")}
          </span>
        )
      ) : (
        t("appUpdate.update")
      )}
    </Button>
  );
}
