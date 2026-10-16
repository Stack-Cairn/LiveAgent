import { useEffect, useRef, useState } from "react";
import { AppErrorBoundary } from "../../components/AppErrorBoundary";
import { Button } from "../../components/ui/button";
import type { ExportDestination, ImageStudioClient } from "../../lib/imaging/types";
import type { DraftStorage } from "./drafts";
import { ImageCompareView } from "./ImageCompareView";
import { ImageComposer } from "./ImageComposer";
import { ImageDetailPane } from "./ImageDetailPane";
import { ResultGallery } from "./ResultGallery";
import { useImageStudio } from "./useImageStudio";

export interface ImageStudioPageProps {
  client: ImageStudioClient;
  ownerId: string;
  backendId: string;
  exportDestinations?: readonly ExportDestination[];
  storage?: DraftStorage;
  onOpenSettings?: () => void;
}

export function ImageStudioPage(props: ImageStudioPageProps) {
  return (
    <AppErrorBoundary key={`${props.ownerId}:${props.backendId}`}>
      <ImageStudioWorkbench {...props} />
    </AppErrorBoundary>
  );
}

function ImageStudioWorkbench({
  client,
  ownerId,
  backendId,
  exportDestinations = [],
  storage,
  onOpenSettings,
}: ImageStudioPageProps) {
  const { controller, view } = useImageStudio(client, ownerId, backendId, storage);
  useEffect(
    () =>
      client.subscribeSettingsSaved?.(() => {
        void controller.refreshTargets();
      }),
    [client, controller],
  );
  const [panel, setPanel] = useState<"gallery" | "details">("gallery");
  const [compare, setCompare] = useState<{ left: string; right: string }>();
  const composer = useRef<HTMLDivElement>(null);
  if (view.supported === false) {
    return (
      <section className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-lg font-semibold">图像工作台暂不可用</h1>
        <p className="max-w-lg text-sm text-muted-foreground">
          当前后端尚未提供图像模块，请升级后端后重试。聊天功能可以继续使用。
        </p>
        <Button variant="outline" onClick={() => void controller.start()}>
          重新检查
        </Button>
      </section>
    );
  }
  if (view.supported === null) {
    return (
      <section
        className="flex h-full flex-col items-center justify-center gap-3 p-6"
        aria-busy={view.loading}
      >
        <p role="status">{view.loading ? "正在连接图像工作台…" : view.notice || "连接失败"}</p>
        {!view.loading && (
          <Button variant="outline" onClick={() => void controller.start()}>
            重试连接
          </Button>
        )}
      </section>
    );
  }
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      aria-label="图像工作台"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <h1 className="mr-auto font-semibold">图像工作台</h1>
        <nav className="flex gap-1 lg:hidden" aria-label="工作台面板">
          {(
            [
              { id: "gallery", label: "画廊" },
              { id: "details", label: "详情" },
            ] as const
          ).map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={panel === item.id ? "secondary" : "ghost"}
              aria-pressed={panel === item.id}
              onClick={() => setPanel(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </nav>
      </header>
      {view.notice && (
        <p role="status" className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-sm">
          {view.notice}
        </p>
      )}
      {compare ? (
        <ImageCompareView
          client={client}
          left={compare.left}
          right={compare.right}
          onClose={() => setCompare(undefined)}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <main
            className={`${panel === "gallery" ? "flex" : "hidden"} min-w-0 flex-1 flex-col overflow-y-auto lg:flex`}
            aria-busy={view.loading}
          >
            <ResultGallery
              controller={controller}
              view={view}
              onSelect={(id) => {
                controller.selectAsset(id);
                setPanel("details");
              }}
            />
          </main>
          <aside
            className={`${panel === "details" ? "block w-full" : "hidden"} shrink-0 overflow-y-auto border-l border-border lg:block lg:w-72`}
          >
            <ImageDetailPane
              controller={controller}
              view={view}
              exportDestinations={exportDestinations}
              onCompare={(left, right) => setCompare({ left, right })}
              onEdit={() => {
                setPanel("gallery");
                composer.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
              }}
            />
          </aside>
        </div>
      )}
      <div ref={composer} className="max-h-[55%] shrink-0 overflow-y-auto">
        <ImageComposer controller={controller} view={view} onOpenSettings={onOpenSettings} />
      </div>
    </section>
  );
}
