import {
  type ComponentType,
  type CSSProperties,
  type RefObject,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocale } from "../../../i18n/index";
import type { ChatFileLink } from "../../../lib/chat/chatFileLinks";
import { cn } from "../../../lib/shared/utils";
import { trajectoryKindLabelKey } from "../../../lib/trajectory/presentation";
import type {
  LedgerHeader,
  TrajectoryRecord,
  TrajectorySection,
} from "../../../lib/trajectory/types";
import { X } from "../../IconSet";
import { DetailsResizeHandle } from "./DetailsResizeHandle";
import { DiffTab } from "./tabs/DiffTab";
import { InputTab } from "./tabs/InputTab";
import { OptionsTab } from "./tabs/OptionsTab";
import { OutputTab } from "./tabs/OutputTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { RawTab } from "./tabs/RawTab";
import { RenderedTab } from "./tabs/RenderedTab";
import { SchemaTab } from "./tabs/SchemaTab";
import { SourceTab } from "./tabs/SourceTab";
import { SystemPromptTab } from "./tabs/SystemPromptTab";
import { TimingTab } from "./tabs/TimingTab";
import { ToolsTab } from "./tabs/ToolsTab";
import { UsageTab } from "./tabs/UsageTab";
import type { DetailTabId, DetailTabProps, SectionState } from "./types";

const SECTION_TABS = new Set<DetailTabId>(["systemPrompt", "tools", "schema", "diff"]);

function tabsFor(record: TrajectoryRecord): readonly DetailTabId[] {
  switch (record.kind) {
    case "system":
      return record.headerChange === "initial"
        ? ["systemPrompt", "tools", "raw"]
        : ["diff", "systemPrompt", "tools", "raw"];
    case "message":
      return ["overview", "rendered", "raw", "source", "output", "options", "usage", "timing"];
    case "tool":
    case "subtool":
      return [
        "overview",
        "rendered",
        "raw",
        "source",
        "input",
        "output",
        "schema",
        "options",
        "timing",
      ];
    case "compacted":
      return ["overview", "raw", "timing"];
    default:
      return ["rendered", "raw", "source", "input"];
  }
}

const TAB_COMPONENTS: Record<DetailTabId, ComponentType<DetailTabProps>> = {
  overview: OverviewTab,
  rendered: RenderedTab,
  raw: RawTab,
  source: SourceTab,
  input: InputTab,
  output: OutputTab,
  schema: SchemaTab,
  options: OptionsTab,
  usage: UsageTab,
  timing: TimingTab,
  systemPrompt: SystemPromptTab,
  tools: ToolsTab,
  diff: DiffTab,
};

export function DetailsPanel(props: {
  record: TrajectoryRecord | null;
  header: LedgerHeader | undefined;
  previousHeader: LedgerHeader | undefined;
  loadSections: (sectionIds: readonly string[]) => Promise<readonly TrajectorySection[]>;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onClose: () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const { t, locale } = useLocale();
  const { record } = props;
  const tabs = useMemo(() => (record === null ? [] : tabsFor(record)), [record]);
  const [activeTab, setActiveTab] = useState<DetailTabId | null>(null);
  const [sectionState, setSectionState] = useState<SectionState>({ status: "idle" });
  const [reloadToken, setReloadToken] = useState(0);
  const currentTab = activeTab !== null && tabs.includes(activeTab) ? activeTab : (tabs[0] ?? null);

  const selectedRecordId = record?.recordId;
  useEffect(() => {
    // Reading the stable identity is intentional: selecting a different record must reset
    // tabs even when both records expose the same tab set.
    if (selectedRecordId === undefined) {
      setActiveTab(null);
      setSectionState({ status: "idle" });
      return;
    }
    setActiveTab(null);
    setSectionState({ status: "idle" });
  }, [selectedRecordId]);

  const shouldLoadSections = currentTab !== null && SECTION_TABS.has(currentTab);
  const neededSectionKey = JSON.stringify(
    shouldLoadSections
      ? [...(props.header?.sections ?? []), ...(props.previousHeader?.sections ?? [])]
      : [],
  );
  // Parse our own serialized refs so object identity churn cannot issue duplicate requests.
  const neededSectionIds = useMemo(() => {
    const refs = JSON.parse(neededSectionKey) as (string | null)[];
    return [...new Set(refs.filter((ref): ref is string => typeof ref === "string"))];
  }, [neededSectionKey]);

  useEffect(() => {
    // A retry intentionally re-runs the same request even though its ids did not change.
    void reloadToken;
    if (neededSectionIds.length === 0) {
      setSectionState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setSectionState({ status: "loading" });
    props
      .loadSections(neededSectionIds)
      .then((sections) => {
        if (!cancelled) setSectionState({ status: "ready", sections });
      })
      .catch(() => {
        if (!cancelled) setSectionState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [neededSectionIds, props.loadSections, reloadToken]);

  if (record === null) {
    // 窄容器为上下排布：空态占位直接隐藏，把整块高度让给列表。
    return (
      <aside
        className="relative flex min-w-[160px] max-w-[calc(100%-140px)] w-[var(--trajectory-details-width)] shrink-0 items-center justify-center border-l border-border/60 p-6 text-center text-[12px] text-muted-foreground @max-[520px]:p-3 @max-[640px]:hidden"
        style={{ "--trajectory-details-width": `${props.width}px` } as CSSProperties}
      >
        <DetailsResizeHandle
          containerRef={props.containerRef}
          width={props.width}
          onWidthChange={props.onWidthChange}
        />
        {t("trajectory.details.empty")}
      </aside>
    );
  }

  const sectionById = new Map(
    sectionState.status === "ready"
      ? sectionState.sections.map((section) => [section.sectionId, section] as const)
      : [],
  );
  const ActiveTab = currentTab === null ? null : TAB_COMPONENTS[currentTab];
  const tabProps: DetailTabProps = {
    record,
    header: props.header,
    previousHeader: props.previousHeader,
    sectionState,
    sectionById,
    onRetrySections: () => setReloadToken((token) => token + 1),
    locale,
    t,
    workdir: props.workdir,
    onOpenFileLink: props.onOpenFileLink,
  };

  return (
    <aside
      className="relative flex min-w-[160px] max-w-[calc(100%-140px)] w-[var(--trajectory-details-width)] shrink-0 flex-col border-l border-border/60 bg-background @max-[640px]:h-[55%] @max-[640px]:w-full @max-[640px]:min-w-0 @max-[640px]:max-w-none @max-[640px]:border-l-0 @max-[640px]:border-t"
      style={{ "--trajectory-details-width": `${props.width}px` } as CSSProperties}
    >
      <DetailsResizeHandle
        containerRef={props.containerRef}
        width={props.width}
        onWidthChange={props.onWidthChange}
      />
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="truncate text-[12px] font-medium">
          {t(trajectoryKindLabelKey(record.kind))}
          <span className="ml-2 font-normal text-muted-foreground">#{record.index}</span>
        </span>
        <button
          type="button"
          aria-label={t("trajectory.details.close")}
          onClick={props.onClose}
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </header>

      <div
        role="tablist"
        className="flex shrink-0 flex-wrap gap-1 border-b border-border/60 px-2 py-1 @max-[520px]:flex-nowrap @max-[520px]:overflow-x-auto"
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={currentTab === tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "shrink-0 rounded px-2 py-0.5 text-[11px] transition-colors",
              currentTab === tab
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`trajectory.details.tab.${tab}`)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px] @max-[520px]:p-2.5">
        {ActiveTab === null ? null : <ActiveTab {...tabProps} />}
      </div>
    </aside>
  );
}
