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
      className={cn(
        "app-workbench-chrome layer-panel pointer-events-none relative h-12 shrink-0",
        className,
      )}
    >
      <ChatHeader
        {...headerProps}
        sidebarOpen={sidebarOpen}
        className="pointer-events-auto h-full"
      />
      {overlay}
    </div>
  );
}
