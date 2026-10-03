import { useSidebar } from "@liveagent/ui/components/ui/sidebar";
import { useState } from "react";
import iconSimpleUrl from "../../src-tauri/icons/icon-simple.png";
import { AppUpdateButton } from "../components/AppUpdateButton";
import { isMacOsTauri } from "../components/MacOsTitleBarSpacer";
import type { AppUpdateController } from "../lib/appUpdates";

// 宽布局的侧栏在应用标题栏下方，不需要额外留白；窄布局（<768px）侧栏改为
// 从窗口顶边开始的浮层，原生红绿灯会压在品牌行上，需要让出一个标题栏高度。
export function DesktopSidebarTitleBar() {
  const { isMobile } = useSidebar();
  const [isMacOs] = useState(isMacOsTauri);
  if (!isMacOs || !isMobile) return null;
  return (
    <div
      data-tauri-drag-region
      aria-hidden="true"
      className="shrink-0"
      style={{ height: "var(--app-header-height, 48px)" }}
    />
  );
}

export function DesktopSidebarBrand() {
  return (
    <div className="flex min-w-0 -translate-y-0.5 items-center gap-2">
      <img
        src={iconSimpleUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="size-8 shrink-0 select-none rounded-xl object-contain"
      />
      <div className="min-w-0">
        <div className="truncate font-semibold tracking-tight">Live Agent</div>
      </div>
    </div>
  );
}

export function DesktopSidebarUpdate({ appUpdate }: { appUpdate?: AppUpdateController }) {
  return appUpdate?.showUpdateButton ? <AppUpdateButton appUpdate={appUpdate} iconOnly /> : null;
}

export function hideDesktopSidebarCloseButton() {
  return isMacOsTauri();
}
