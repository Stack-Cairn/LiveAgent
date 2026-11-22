import type { AppSettings } from "@liveagent/app/lib/settings";
import {
  type CSSProperties,
  type HTMLAttributes,
  lazy,
  type ReactNode,
  type Ref,
  Suspense,
} from "react";
import { useLocale } from "../i18n";
import type { ResourceHostCapabilities } from "../lib/resourceHost";
import type { SidebarShortcutId } from "../lib/settings/sidebarShortcuts";
import { cn } from "../lib/shared/utils";
import type { SkillSummary } from "../lib/skills/index";
import type { KBrainSettingsAdapter } from "../pages/settings/kbrainSettingsAdapter";
import type { ImageStudioHost } from "./imageStudioHost";

// Hub pages are separate routes; loading them on first visit keeps their code
// (planner, calendar import, resource stores, image studio) out of the chat
// startup path. The chat view itself stays mounted while a hub is shown.
const ImageStudioPage = lazy(() =>
  import("../features/image-studio/ImageStudioPage").then((m) => ({ default: m.ImageStudioPage })),
);
const PlanningPage = lazy(() =>
  import("../pages/planning/PlanningPage").then((m) => ({ default: m.PlanningPage })),
);
const SkillsHubPage = lazy(() =>
  import("../pages/skills-hub/SkillsHubPage").then((m) => ({ default: m.SkillsHubPage })),
);
const McpHubPage = lazy(() =>
  import("../pages/mcp-hub/McpHubPage").then((m) => ({ default: m.McpHubPage })),
);
const ResourceManagementPage = lazy(() =>
  import("../pages/resources/ResourceManagementPage").then((m) => ({
    default: m.ResourceManagementPage,
  })),
);

export type ApplicationViewId = "chat" | `${SidebarShortcutId}-hub`;

type ApplicationChatViewProps = {
  containerRef?: Ref<HTMLDivElement>;
  containerProps?: Omit<HTMLAttributes<HTMLDivElement>, "children">;
  content: ReactNode;
};

type ApplicationViewProps = {
  activeView: ApplicationViewId;
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  isAgentMode: boolean;
  resourceHost?: ResourceHostCapabilities;
  /** K-brain settings for the memory hub's master switch; omitted hosts hide it. */
  kbrainSettings?: KBrainSettingsAdapter;
  imageStudioHost?: ImageStudioHost;
  initialSkills?: SkillSummary[];
  initialSkillsRootDir?: string;
  className?: string;
  chatClassName?: string;
  chatStyle?: CSSProperties;
  chat: ApplicationChatViewProps;
  workspaceOverlays?: ReactNode;
  /** Lets hub pages jump to another view (e.g. schedule → scheduled tasks). */
  onOpenView?: (view: ApplicationViewId) => void;
};

export function ApplicationView(props: ApplicationViewProps) {
  const {
    activeView,
    settings,
    setSettings,
    isAgentMode,
    resourceHost,
    kbrainSettings,
    imageStudioHost,
    initialSkills,
    initialSkillsRootDir,
    className,
    chatClassName,
    chatStyle,
    chat,
    workspaceOverlays,
    onOpenView,
  } = props;

  const { t } = useLocale();
  const { containerProps, containerRef, content: chatContent } = chat;
  let content: ReactNode;
  if (activeView === "image-studio-hub") {
    content = imageStudioHost ? (
      <ImageStudioPage key={imageStudioHost.scopeKey} {...imageStudioHost} />
    ) : (
      <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-lg font-semibold">{t("settings.navImageStudio")}</h1>
        <p role="status" className="text-sm text-muted-foreground">
          {t("settings.imageStudioUnsupported")}
        </p>
      </section>
    );
  } else if (activeView === "planning-hub") {
    content = <PlanningPage onOpenCron={onOpenView ? () => onOpenView("cron-hub") : undefined} />;
  } else if (activeView === "skills-hub") {
    content = (
      <SkillsHubPage
        settings={settings}
        setSettings={setSettings}
        resourceHost={resourceHost}
        initialSkills={initialSkills}
        initialRootDir={initialSkillsRootDir}
        isAgentMode={isAgentMode}
      />
    );
  } else if (activeView === "mcp-hub") {
    content = (
      <McpHubPage settings={settings} setSettings={setSettings} isAgentMode={isAgentMode} />
    );
  } else if (activeView === "memory-hub" || activeView === "cron-hub") {
    content = (
      <ResourceManagementPage
        resource={activeView === "memory-hub" ? "memory" : "cron"}
        settings={settings}
        setSettings={setSettings}
        resourceHost={resourceHost}
        kbrainSettings={kbrainSettings}
      />
    );
  }

  return (
    <div
      className={cn(className, activeView === "chat" && chatClassName)}
      style={activeView === "chat" ? chatStyle : undefined}
    >
      {/* Keep chat panes and running tasks mounted while a hub is visible. */}
      <div
        {...containerProps}
        ref={containerRef}
        hidden={activeView !== "chat"}
        inert={activeView !== "chat"}
        style={{ ...containerProps?.style, ...(activeView !== "chat" ? { display: "none" } : {}) }}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          containerProps?.className,
        )}
      >
        {chatContent}
      </div>
      {content ? (
        <Suspense fallback={<div className="min-h-0 min-w-0 flex-1" />}>{content}</Suspense>
      ) : null}
      {workspaceOverlays}
    </div>
  );
}
