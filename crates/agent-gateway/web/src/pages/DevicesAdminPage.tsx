import { ArrowLeft } from "@liveagent/ui/components/IconSet";
import { LocaleContext, useLocale, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";
import { loadWebLocale } from "../lib/webLocale";
import { DevicesSection } from "./settings/DevicesSection";

// 保留可直接访问的管理路由；WebUI 日常入口位于设置页内，并与此处复用同一内容组件。
export function DevicesAdminPage() {
  // This route renders outside the app shell, so it supplies the saved WebUI locale itself.
  const [locale] = useState(loadWebLocale);
  const localeContextValue = useLocaleContextValue(locale);
  return (
    <LocaleContext.Provider value={localeContextValue}>
      <DevicesAdminContent />
    </LocaleContext.Provider>
  );
}

function DevicesAdminContent() {
  const { t } = useLocale();
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-6 sm:px-6">
      <a
        href="/"
        className={cn(
          "mb-5 flex w-fit items-center gap-2 rounded-md px-2 py-1",
          "text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        )}
      >
        <ArrowLeft className="size-4" />
        {t("gatewayWeb.backToChat")}
      </a>
      <DevicesSection />
    </div>
  );
}
