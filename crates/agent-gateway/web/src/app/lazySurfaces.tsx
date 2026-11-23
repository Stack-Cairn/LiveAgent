// On-demand surfaces of the WebUI app. Each one is a separate chunk that loads
// the first time it opens, so the chat startup bundle does not carry settings,
// the resource hubs it links to, or the share/project/workspace dialogs.
// The exports keep the original component names, so call sites read the same.
import type { HistoryShareModal as HistoryShareModalComponent } from "@liveagent/ui/components/chat/HistoryShareModal";
import type {
  SharedHistoryManagerModal as SharedHistoryManagerModalComponent,
  SharedHistorySummary,
} from "@liveagent/ui/components/chat/SharedHistoryManagerModal";
import type { WorkspaceCloneModal as WorkspaceCloneModalComponent } from "@liveagent/ui/components/chat/WorkspaceCloneModal";
import type { WorkspaceProjectSettingsModal as WorkspaceProjectSettingsModalComponent } from "@liveagent/ui/components/chat/WorkspaceProjectSettingsModal";
import { onDemand } from "@liveagent/ui/components/OnDemand";
import { t } from "@liveagent/ui/i18n/index";
import type { SettingsPage as SettingsPageComponent } from "@liveagent/ui/pages/settings/SettingsPage";
import { type ComponentProps, lazy, Suspense } from "react";
import type { SharedHistoryPage as SharedHistoryPageComponent } from "@/pages/SharedHistoryPage";
import type { WorkdirPickerModal as WorkdirPickerModalComponent } from "@/pages/settings/WorkdirPickerModal";

const LoadedSettingsPage = lazy(async () => ({
  default: (await import("@liveagent/ui/pages/settings/SettingsPage")).SettingsPage,
}));

export function SettingsPage(props: ComponentProps<typeof SettingsPageComponent>) {
  return (
    <Suspense
      fallback={
        <div className="flex size-full items-center justify-center bg-background text-sm text-muted-foreground">
          {t("app.loading", props.settings.locale)}
        </div>
      }
    >
      <LoadedSettingsPage {...props} />
    </Suspense>
  );
}

export const HistoryShareModal = onDemand<ComponentProps<typeof HistoryShareModalComponent>>(
  async () => (await import("@liveagent/ui/components/chat/HistoryShareModal")).HistoryShareModal,
);

// lazy() drops the component's generic parameter; keep its own signature.
const LoadedSharedHistoryManagerModal = lazy(async () => ({
  default: (await import("@liveagent/ui/components/chat/SharedHistoryManagerModal"))
    .SharedHistoryManagerModal,
})) as unknown as typeof SharedHistoryManagerModalComponent;

export function SharedHistoryManagerModal<Conversation extends SharedHistorySummary>(
  props: ComponentProps<typeof SharedHistoryManagerModalComponent<Conversation>>,
) {
  return (
    <Suspense fallback={null}>
      <LoadedSharedHistoryManagerModal {...props} />
    </Suspense>
  );
}

export const WorkspaceCloneModal = onDemand<ComponentProps<typeof WorkspaceCloneModalComponent>>(
  async () =>
    (await import("@liveagent/ui/components/chat/WorkspaceCloneModal")).WorkspaceCloneModal,
);

export const WorkspaceProjectSettingsModal = onDemand<
  ComponentProps<typeof WorkspaceProjectSettingsModalComponent>
>(
  async () =>
    (await import("@liveagent/ui/components/chat/WorkspaceProjectSettingsModal"))
      .WorkspaceProjectSettingsModal,
);

export const WorkdirPickerModal = onDemand<ComponentProps<typeof WorkdirPickerModalComponent>>(
  async () => (await import("@/pages/settings/WorkdirPickerModal")).WorkdirPickerModal,
);

/** The read-only page behind a history share link; it shows its own loading state. */
export const SharedHistoryPage = onDemand<ComponentProps<typeof SharedHistoryPageComponent>>(
  async () => (await import("@/pages/SharedHistoryPage")).SharedHistoryPage,
);
