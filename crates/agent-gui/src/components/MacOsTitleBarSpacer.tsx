import { PanelLeft, PanelLeftClose, Settings } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AppUpdateController } from "../lib/appUpdates";
import { AppUpdateButton } from "./AppUpdateButton";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

type MacOsTrafficLightMetrics = {
  top: number;
  left: number;
  width: number;
  height: number;
};

// Fallback values match tauri.conf.json; runtime AppKit metrics replace them on macOS.
const MAC_OS_TRAFFIC_LIGHT_TOP = 26;
const MAC_OS_TRAFFIC_LIGHT_LEFT = 18;
const MAC_OS_TRAFFIC_LIGHT_GROUP_WIDTH = 52;
const MAC_OS_TRAFFIC_LIGHT_GROUP_HEIGHT = 12;
const MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE = 28;
const MAC_OS_TITLEBAR_TOGGLE_GAP = 22;

function isValidMetrics(
  metrics: MacOsTrafficLightMetrics | null,
): metrics is MacOsTrafficLightMetrics {
  return Boolean(
    metrics &&
      Number.isFinite(metrics.top) &&
      Number.isFinite(metrics.left) &&
      Number.isFinite(metrics.width) &&
      Number.isFinite(metrics.height) &&
      metrics.width > 0 &&
      metrics.height > 0,
  );
}

function useMacOsTrafficLightMetrics(enabled: boolean) {
  const [metrics, setMetrics] = useState<MacOsTrafficLightMetrics | null>(null);

  useEffect(() => {
    if (!enabled) {
      setMetrics(null);
      return undefined;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await invoke<MacOsTrafficLightMetrics | null>(
          "app_macos_traffic_light_metrics",
        );
        if (!cancelled && isValidMetrics(next)) {
          setMetrics(next);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("failed to read macOS traffic light metrics", error);
          setMetrics(null);
        }
      }
    };

    void refresh();
    window.addEventListener("resize", refresh);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", refresh);
    };
  }, [enabled]);

  return metrics;
}

export function isMacOsTauri(): boolean {
  if (typeof window === "undefined") return false;
  const hasTauri = !!(window as TauriWindow).__TAURI_INTERNALS__;
  return hasTauri && /Mac/i.test(navigator.platform);
}

/** Vertical spacer at the top of a sidebar column — clears the macOS traffic lights. */
export function MacOsTitleBarSpacer({ className }: { className?: string }) {
  const [show] = useState(isMacOsTauri);
  if (!show) return null;
  return <div data-tauri-drag-region className={cn("h-38px shrink-0", className)} />;
}

/**
 * Inline sidebar controls in the shared application titlebar.
 * Stays beside the traffic lights in both states so repeated clicks hit the same target.
 */
export function MacOsTitleBarToggle({
  sidebarOpen,
  onToggle,
  onOpenSettings,
  appUpdate,
}: {
  sidebarOpen: boolean;
  onToggle: () => void;
  onOpenSettings?: () => void;
  appUpdate?: AppUpdateController;
}) {
  const { t } = useLocale();
  const [show] = useState(isMacOsTauri);
  const trafficLightMetrics = useMacOsTrafficLightMetrics(show);
  useEffect(() => {
    if (!show) return;
    const center =
      (trafficLightMetrics?.top ?? MAC_OS_TRAFFIC_LIGHT_TOP) +
      (trafficLightMetrics?.height ?? MAC_OS_TRAFFIC_LIGHT_GROUP_HEIGHT) / 2;
    document.documentElement.style.setProperty("--app-header-height", `${center * 2}px`);
    return () => {
      document.documentElement.style.removeProperty("--app-header-height");
    };
  }, [show, trafficLightMetrics]);
  if (!show) return null;
  const trafficLightLeft = trafficLightMetrics?.left ?? MAC_OS_TRAFFIC_LIGHT_LEFT;
  const trafficLightWidth = trafficLightMetrics?.width ?? MAC_OS_TRAFFIC_LIGHT_GROUP_WIDTH;
  const toggleLeft = trafficLightLeft + trafficLightWidth + MAC_OS_TITLEBAR_TOGGLE_GAP;
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
      style={{
        paddingLeft: Math.max(0, toggleLeft - 16),
        height: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={sidebarOpen}
        aria-label={t(sidebarOpen ? "sidebar.closeSidebar" : "tooltip.openSidebar")}
        className={cn(
          "flex cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors",
          "hover:bg-accent/60 hover:text-foreground [-webkit-app-region:no-drag]",
        )}
        style={{
          height: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
          width: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
        }}
      >
        {sidebarOpen ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
      </button>
      {!sidebarOpen && onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          // 自动化脚本按 testid 定位；可读名走 i18n——屏幕阅读器念给用户
          // 听的东西不该为了脚本方便固定成英文。
          data-testid="open-settings"
          aria-label={t("tooltip.settings")}
          title={t("tooltip.settings")}
          className={cn(
            "flex cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-accent/60 hover:text-foreground [-webkit-app-region:no-drag]",
          )}
          style={{
            height: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
            width: MAC_OS_TITLEBAR_TOGGLE_BUTTON_SIZE,
          }}
        >
          <Settings className="size-4" />
        </button>
      )}
      {!sidebarOpen && onOpenSettings && appUpdate ? (
        <AppUpdateButton appUpdate={appUpdate} className="ml-1" />
      ) : null}
    </div>
  );
}

/**
 * Horizontal spacer on the left of a header row — used in ChatHeader when sidebar is
 * closed on macOS to clear the traffic lights + fixed toggle button zone.
 */
export function MacOsTitleBarLeadingInset({ className }: { className?: string }) {
  const [show] = useState(isMacOsTauri);
  if (!show) return null;
  return <div data-tauri-drag-region className={cn("w-88px shrink-0", className)} />;
}
