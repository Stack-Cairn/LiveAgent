import { ChevronRight, Columns2, Cpu, Plus, Terminal } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../../lib/shared/utils";
import type { TerminalShellOption } from "../../lib/terminal/types";
import { buttonVariants } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { RIGHT_DOCK_TOOL_DEFINITIONS, type RightDockSingletonTabKind } from "./rightDockRegistry";

type RightDockLauncherActions = {
  fileTreeLeased?: boolean;
  onCreateTerminal: (shell?: string) => void;
  onOpenNewTerminalInWorkbench?: () => void;
  onStartTool: (kind: RightDockSingletonTabKind) => void;
  // Opens the derived background-tasks tab via ephemeral session state; it
  // is not a registry tool and never writes persisted right-dock settings.
  onOpenBackgroundTasks: () => void;
};

type RightDockCreateMenuProps = RightDockLauncherActions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shellOptions: TerminalShellOption[];
  terminalReady: boolean;
  terminalDisabledMessage?: string;
  projectReady: boolean;
  tunnelAvailable: boolean;
  creating: boolean;
};

type RightDockChooserProps = RightDockLauncherActions & {
  terminalReady: boolean;
  terminalDisabledMessage?: string;
  disabledMessage?: string;
  projectReady: boolean;
  tunnelAvailable: boolean;
  creating: boolean;
  loading: boolean;
  error: string | null;
  /**
   * 存在时"新建终端"入口可拖出到工作台画板(拖到落点新建终端 Pane);
   * 点击行为不变(新建并进 dock)。拖拽阈值与点击抑制由工作台拖拽会话处理。
   */
  onNewTerminalDragStart?: (event: {
    pointerId: number;
    clientX: number;
    clientY: number;
    currentTarget?: EventTarget | null;
  }) => void;
};

export function RightDockCreateMenu(props: RightDockCreateMenuProps) {
  const {
    fileTreeLeased,
    open,
    onOpenChange,
    shellOptions,
    terminalReady,
    terminalDisabledMessage,
    projectReady,
    tunnelAvailable,
    creating,
    onCreateTerminal,
    onOpenNewTerminalInWorkbench,
    onStartTool,
    onOpenBackgroundTasks,
  } = props;
  const { t } = useLocale();

  const terminalItem =
    shellOptions.length > 1 ? (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!terminalReady || creating} className="gap-2 text-xs">
          <Terminal className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1">{t("projectTools.newTerminal")}</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-36">
          {shellOptions.map((option) => (
            <DropdownMenuItem
              key={option.id}
              onSelect={() => onCreateTerminal(option.id)}
              disabled={!terminalReady || creating}
              className="gap-2 text-xs"
              title={option.command || option.label}
            >
              <Terminal className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    ) : (
      <DropdownMenuItem
        onSelect={() => onCreateTerminal()}
        disabled={!terminalReady || creating}
        className="gap-2 text-xs"
        title={terminalDisabledMessage}
      >
        <Terminal className="h-3.5 w-3.5" />
        {t("projectTools.newTerminal")}
      </DropdownMenuItem>
    );

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {/* Native trigger button styled via buttonVariants: Base UI Trigger
          renders a plain <button>, so this stays identical on GUI and web. */}
      <DropdownMenuTrigger
        disabled={!(projectReady || tunnelAvailable) || creating}
        title={t("projectTools.newProjectTool")}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground",
        )}
      >
        <Plus className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-40">
        {terminalItem}
        {onOpenNewTerminalInWorkbench ? (
          <DropdownMenuItem
            onSelect={onOpenNewTerminalInWorkbench}
            disabled={!terminalReady || creating}
            className="gap-2 text-xs"
            title={terminalDisabledMessage}
          >
            <Columns2 className="h-3.5 w-3.5" />
            {t("workbench.openNewTerminalInSplit")}
          </DropdownMenuItem>
        ) : null}
        {RIGHT_DOCK_TOOL_DEFINITIONS.filter(
          (definition) => definition.kind !== "fileTree" || !fileTreeLeased,
        ).map((definition) => (
          <DropdownMenuItem
            key={definition.kind}
            onSelect={() => onStartTool(definition.kind)}
            disabled={definition.projectRequired ? !projectReady : !tunnelAvailable}
            className="gap-2 text-xs"
          >
            {definition.icon("h-3.5 w-3.5")}
            {t(definition.createTitleKey)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={onOpenBackgroundTasks} className="gap-2 text-xs">
          <Cpu className="h-3.5 w-3.5" />
          {t("projectTools.backgroundTasksTitle")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RightDockChooser(props: RightDockChooserProps) {
  const {
    fileTreeLeased,
    terminalReady,
    terminalDisabledMessage,
    disabledMessage,
    projectReady,
    tunnelAvailable,
    creating,
    loading,
    error,
    onCreateTerminal,
    onStartTool,
    onOpenBackgroundTasks,
    onNewTerminalDragStart,
  } = props;
  const { t } = useLocale();
  const terminalTileDisabled = !terminalReady || creating;
  const tools = [
    {
      key: "terminal",
      title: t("projectTools.newTerminal"),
      description: t("projectTools.terminalDescription"),
      icon: <Terminal className="h-4.5 w-4.5" />,
      disabled: terminalTileDisabled,
      titleAttr: terminalDisabledMessage,
      onClick: () => onCreateTerminal(),
      onPointerDown:
        onNewTerminalDragStart && !terminalTileDisabled
          ? (event: ReactPointerEvent<HTMLButtonElement>) => {
              if (event.button !== 0 || event.pointerType === "touch") return;
              onNewTerminalDragStart({
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                currentTarget: event.currentTarget,
              });
            }
          : undefined,
    },
    ...RIGHT_DOCK_TOOL_DEFINITIONS.filter(
      (definition) => definition.kind !== "fileTree" || !fileTreeLeased,
    ).map((definition) => ({
      key: definition.kind,
      title: t(definition.createTitleKey),
      description: t(definition.descriptionKey),
      icon: definition.icon("h-4.5 w-4.5"),
      disabled: definition.projectRequired ? !projectReady : !tunnelAvailable,
      titleAttr: definition.projectRequired ? disabledMessage : undefined,
      onClick: () => onStartTool(definition.kind),
      onPointerDown: undefined,
    })),
    {
      key: "backgroundTasks",
      title: t("projectTools.backgroundTasksTitle"),
      description: t("projectTools.backgroundTasksDescription"),
      icon: <Cpu className="h-4.5 w-4.5" />,
      disabled: false,
      titleAttr: undefined,
      onClick: onOpenBackgroundTasks,
      onPointerDown: undefined,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-5 py-6">
      <div className="flex flex-col items-center gap-1">
        <h3 className="text-sm font-medium text-foreground">{t("projectTools.getStarted")}</h3>
        <p className="text-xs text-muted-foreground">{t("projectTools.getStartedHint")}</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        {tools.map((tool) => (
          <button
            key={tool.key}
            type="button"
            onClick={tool.onClick}
            onPointerDown={tool.onPointerDown}
            disabled={tool.disabled}
            title={tool.titleAttr}
            className="group flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3.5 py-3 text-left text-sm text-foreground transition-all hover:border-border hover:bg-muted/60 hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/80 text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
              {tool.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium leading-tight">{tool.title}</div>
              <div className="mt-0.5 text-xs leading-tight text-muted-foreground">
                {tool.description}
              </div>
            </div>
          </button>
        ))}
      </div>
      {loading ? (
        <div className="text-center text-xs text-muted-foreground">{t("projectTools.loading")}</div>
      ) : null}
      {error ? <div className="text-center text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
