import type { ReactNode } from "react";
import { ChatHeader, type ChatHeaderProps } from "../components/chat/ChatHeader";
import { cn } from "../lib/shared/utils";

type AppWorkbenchChromeProps = ChatHeaderProps & {
  overlay?: ReactNode;
  className?: string;
};

export function AppWorkbenchChrome(props: AppWorkbenchChromeProps) {
  const { overlay, className, sidebarOpen, ...headerProps } = props;

  return (
    <div
      data-app-workbench-chrome=""
      style={{ height: "var(--app-header-height, 48px)" }}
      className={cn("app-workbench-chrome relative z-20 h-12 shrink-0 bg-background", className)}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 bg-settings-rail transition-[width] duration-200 ease-out motion-reduce:transition-none desktop:max-[767px]:hidden web:max-820:hidden"
        style={{ width: sidebarOpen ? "var(--sidebar-width)" : 0 }}
      />
      <ChatHeader {...headerProps} sidebarOpen={sidebarOpen} className="relative h-full" />
      {overlay}
    </div>
  );
}
