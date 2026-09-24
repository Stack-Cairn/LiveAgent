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
/** Keep in sync with the `--app-header-height` declaration in agent-ui tokens.css. */
const APP_HEADER_HEIGHT_FALLBACK = "48px";

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

/**
 * `undefined` = not read yet (or the read failed): callers use the fallback geometry.
 * `null` = AppKit reports no traffic lights in the main window — native fullscreen
 * moves them into a separate auto-hiding titlebar, so there is nothing to clear.
 */
type TrafficLightState = MacOsTrafficLightMetrics | null | undefined;

// Fullscreen enter/exit animates for ~0.5s and the last `resize` can fire before
// AppKit has moved the buttons back, so re-read once the window settles.
const TRAFFIC_LIGHT_SETTLE_DELAY_MS = 800;

function useMacOsTrafficLightMetrics(enabled: boolean) {
  const [metrics, setMetrics] = useState<TrafficLightState>(undefined);

  useEffect(() => {
    if (!enabled) {
      setMetrics(undefined);
      return undefined;
    }

    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      try {
        const next = await invoke<MacOsTrafficLightMetrics | null>(
          "app_macos_traffic_light_metrics",
        );
        if (cancelled) return;
        setMetrics(next === null ? null : isValidMetrics(next) ? next : undefined);
      } catch (error) {
        if (!cancelled) {
          console.warn("failed to read macOS traffic light metrics", error);
          setMetrics(undefined);
        }
      }
    };

    const onResize = () => {
      void refresh();
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        void refresh();
      }, TRAFFIC_LIGHT_SETTLE_DELAY_MS);
    };

    void refresh();
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      window.removeEventListener("resize", onResize);
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
 * Publishes `--app-header-height` from the live traffic-light geometry.
 *
 * Mount this at the application root, not inside a view subtree: the workbench
 * chrome reads the variable on every surface, so tearing it down when one view
 * unmounts would snap the header back to its 48px fallback mid-transition.
 * On unmount it restores the default instead of removing the property.
 */
export function useMacOsAppHeaderHeight() {
  const enabled = isMacOsTauri();
  const trafficLightMetrics = useMacOsTrafficLightMetrics(enabled);
  useEffect(() => {
    if (!enabled) return;
    if (trafficLightMetrics === null) {
      document.documentElement.style.setProperty("--app-header-height", APP_HEADER_HEIGHT_FALLBACK);
      return;
    }
    const center =
      (trafficLightMetrics?.top ?? MAC_OS_TRAFFIC_LIGHT_TOP) +
      (trafficLightMetrics?.height ?? MAC_OS_TRAFFIC_LIGHT_GROUP_HEIGHT) / 2;
    document.documentElement.style.setProperty("--app-header-height", `${center * 2}px`);
    return () => {
      document.documentElement.style.setProperty("--app-header-height", APP_HEADER_HEIGHT_FALLBACK);
    };
  }, [enabled, trafficLightMetrics]);
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
  if (!show) return null;
  const trafficLightLeft = trafficLightMetrics?.left ?? MAC_OS_TRAFFIC_LIGHT_LEFT;
  const trafficLightWidth = trafficLightMetrics?.width ?? MAC_OS_TRAFFIC_LIGHT_GROUP_WIDTH;
  // No traffic lights to clear (native fullscreen): sit where the group would start.
  const toggleLeft =
    trafficLightMetrics === null
      ? MAC_OS_TRAFFIC_LIGHT_LEFT
      : trafficLightLeft + trafficLightWidth + MAC_OS_TITLEBAR_TOGGLE_GAP;
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
