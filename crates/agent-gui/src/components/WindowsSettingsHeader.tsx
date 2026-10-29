import { AppHeaderFrame } from "@liveagent/ui/application/AppWorkbenchChrome";
import { useLocale } from "@liveagent/ui/i18n/index";
import { isWindowsTauriRuntime, WindowsTitleBar } from "./WindowsTitleBar";

// Back to chat stays in the settings sidebar ("返回对话", Esc); the header only
// carries the title, the drag surface and the native window controls.
export function WindowsSettingsHeader() {
  const { t } = useLocale();
  if (!isWindowsTauriRuntime()) return null;

  return (
    <AppHeaderFrame>
      <header
        data-windows-settings-header=""
        data-tauri-drag-region
        className="relative flex h-full items-center gap-4 pl-4"
      >
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center">
          <span className="pointer-events-none truncate text-sm font-medium">
            {t("settings.title")}
          </span>
        </div>
        <WindowsTitleBar controlsOnly />
      </header>
    </AppHeaderFrame>
  );
}
