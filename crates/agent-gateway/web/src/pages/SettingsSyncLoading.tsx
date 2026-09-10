import { type Locale, t as translate } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";

type SettingsSyncLoadingProps = {
  locale: Locale;
};

export function SettingsSyncLoading({ locale }: SettingsSyncLoadingProps) {
  return (
    <div
      className={cn(
        "relative z-1 flex flex-col items-center gap-18px overflow-hidden",
        "rounded-24px border border-solid border-hsl-0-0-100-0p7 bg-hsl-0-0-100-0p55",
        "px-46px pt-38px pb-32px",
        "shadow-login-container backdrop-blur-40px backdrop-saturate-160",
        "dark:border-hsl-0-0-100-0p08 dark:bg-hsl-224-20-12-0p6 dark:shadow-login-container-2",
      )}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          "pointer-events-none absolute top-minus-80px left-minus-64px -z-1 size-200px",
          "rounded-full bg-hsl-210-100-86-0p55 opacity-(--ui-opacity-0p55) blur-60px dark:bg-hsl-210-80-32-0p25",
        )}
        aria-hidden="true"
      />
      <div
        className={cn(
          "pointer-events-none absolute right-minus-54px bottom-minus-72px -z-1 size-170px",
          "rounded-full bg-hsl-250-70-86-0p45 opacity-(--ui-opacity-0p55) blur-60px dark:bg-hsl-250-60-32-0p2",
        )}
        aria-hidden="true"
      />

      <div className="relative flex items-center justify-center size-60px mt-2px">
        <div className="relative flex size-60px items-center justify-center">
          <img
            src="/icon-simple.png"
            alt=""
            width={60}
            height={60}
            className="block size-60px drop-shadow-sync-loading-logo select-none"
            draggable={false}
          />
        </div>
      </div>

      <strong className="text-14px font-semibold tracking-minus-0p01em text-foreground">
        {translate("chat.runtime.settingsSyncTitle", locale)}
      </strong>

      <span
        className={cn(
          "inline-flex h-8px items-center gap-6px",
          "[&>i]:size-7px [&>i]:animate-[syncDotBounce_var(--ui-duration-1200ms)_ease-in-out_infinite] [&>i]:rounded-full [&>i]:bg-primary [&>i]:will-change-[transform,opacity] motion-reduce:[&>i]:animate-none [&>i:nth-child(2)]:[animation-delay:var(--ui-duration-160ms)] [&>i:nth-child(3)]:[animation-delay:var(--ui-duration-320ms)]",
        )}
        aria-hidden="true"
      >
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
