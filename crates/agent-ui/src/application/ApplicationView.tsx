import type { AppSettings } from "@liveagent/app/lib/settings";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/shared/utils";
import type { SkillSummary } from "../lib/skills/index";
import { McpHubPage } from "../pages/mcp-hub/McpHubPage";
import { SkillsHubPage } from "../pages/skills-hub/SkillsHubPage";

export type ApplicationViewId = "chat" | "skills-hub" | "mcp-hub";

type ApplicationChatViewProps = {
  containerProps?: Omit<HTMLAttributes<HTMLDivElement>, "children">;
  content: ReactNode;
};

type ApplicationViewProps = {
  activeView: ApplicationViewId;
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  isAgentMode: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  initialSkills?: SkillSummary[];
  initialSkillsRootDir?: string;
  className?: string;
  chatClassName?: string;
  chatStyle?: CSSProperties;
  chat: ApplicationChatViewProps;
  workspaceOverlays?: ReactNode;
};

export function ApplicationView(props: ApplicationViewProps) {
  const {
    activeView,
    settings,
    setSettings,
    isAgentMode,
    sidebarOpen,
    onOpenSidebar,
    initialSkills,
    initialSkillsRootDir,
    className,
    chatClassName,
    chatStyle,
    chat,
    workspaceOverlays,
  } = props;

  let content: ReactNode;
  if (activeView === "skills-hub") {
    content = (
      <SkillsHubPage
        settings={settings}
        setSettings={setSettings}
        initialSkills={initialSkills}
        initialRootDir={initialSkillsRootDir}
        isAgentMode={isAgentMode}
        sidebarOpen={sidebarOpen}
        onOpenSidebar={onOpenSidebar}
      />
    );
  } else if (activeView === "mcp-hub") {
    content = (
      <McpHubPage
        settings={settings}
        setSettings={setSettings}
        isAgentMode={isAgentMode}
        sidebarOpen={sidebarOpen}
        onOpenSidebar={onOpenSidebar}
      />
    );
  } else {
    const { containerProps, content: chatContent } = chat;
    content = (
      <div
        {...containerProps}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          containerProps?.className,
        )}
      >
        {chatContent}
      </div>
    );
  }

  return (
    <div
      className={cn(className, activeView === "chat" && chatClassName)}
      style={activeView === "chat" ? chatStyle : undefined}
    >
      {content}
      {workspaceOverlays}
    </div>
  );
}
