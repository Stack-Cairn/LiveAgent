import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";
import type { TerminalShellOption } from "../../lib/terminal/types";
import { ChevronDown, ChevronRight, Cpu, Plus, Terminal } from "../icons";
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
  onCreateTerminal: (shell?: string) => void;
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
  shellOptions: TerminalShellOption[];
  terminalReady: boolean;
  terminalDisabledMessage?: string;
  disabledMessage?: string;
  projectReady: boolean;
  tunnelAvailable: boolean;
  creating: boolean;
  loading: boolean;
  error: string | null;
};

export function RightDockCreateMenu(props: RightDockCreateMenuProps) {
  const {
    open,
    onOpenChange,
    shellOptions,
    terminalReady,
    terminalDisabledMessage,
    projectReady,
    tunnelAvailable,
    creating,
    onCreateTerminal,
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
      {/* Native trigger button styled via buttonVariants: the Base UI (GUI) and
          Radix (web) triggers both render a plain <button>, so this markup can
          stay byte-identical on both ends without asChild/render adapters. */}
      <DropdownMenuTrigger
        disabled={!(projectReady || tunnelAvailable) || creating}
        title={t("projectTools.newProjectTool")}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "h-7 w-7 rounded-md text-muted-foreground/80 hover:text-foreground",
        )}
      >
        <Plus className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-40">
        {terminalItem}
        {RIGHT_DOCK_TOOL_DEFINITIONS.map((definition) => (
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
    shellOptions,
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
  } = props;
  const { t } = useLocale();
  const tools = [
    {
      key: "terminal",
      title: t("projectTools.newTerminal"),
      description: t("projectTools.terminalDescription"),
      icon: <Terminal className="h-4.5 w-4.5" />,
      disabled: !terminalReady || creating,
      titleAttr: terminalDisabledMessage,
      onClick: () => onCreateTerminal(),
    },
    ...RIGHT_DOCK_TOOL_DEFINITIONS.map((definition) => ({
      key: definition.kind,
      title: t(definition.createTitleKey),
      description: t(definition.descriptionKey),
      icon: definition.icon("h-4.5 w-4.5"),
      disabled: definition.projectRequired ? !projectReady : !tunnelAvailable,
      titleAttr: definition.projectRequired ? disabledMessage : undefined,
      onClick: () => onStartTool(definition.kind),
    })),
    {
      key: "backgroundTasks",
      title: t("projectTools.backgroundTasksTitle"),
      description: t("projectTools.backgroundTasksDescription"),
      icon: <Cpu className="h-4.5 w-4.5" />,
      disabled: false,
      titleAttr: undefined,
      onClick: onOpenBackgroundTasks,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-5 py-6">
      <div className="flex flex-col items-center gap-1">
        <h3 className="text-sm font-medium text-foreground">{t("projectTools.getStarted")}</h3>
        <p className="text-xs text-muted-foreground">{t("projectTools.getStartedHint")}</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        {tools.map((tool) => {
          // 终端卡片在有多个 shell 时是分裂按钮：主区开默认 shell，右缘
          // 箭头展开 shell 选择菜单（能力与原「+」菜单的子菜单一致）。
          const splitShellMenu = tool.key === "terminal" && shellOptions.length > 1;
          const card = (
            <button
              type="button"
              onClick={tool.onClick}
              disabled={tool.disabled}
              title={tool.titleAttr}
              className={cn(
                "group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-background px-3.5 py-3 text-left text-sm text-foreground transition-all hover:border-border hover:bg-muted/60 hover:shadow-sm disabled:pointer-events-none disabled:opacity-50",
                splitShellMenu && "pr-12",
              )}
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
          );
          if (!splitShellMenu) {
            return <div key={tool.key}>{card}</div>;
          }
          return (
            <div key={tool.key} className="relative">
              {card}
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={tool.disabled}
                  title={t("projectTools.newTerminal")}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "icon" }),
                    "absolute right-2 top-1/2 h-8 w-8 -translate-y-1/2 rounded-md text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ChevronDown className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="min-w-36">
                  {shellOptions.map((option) => (
                    <DropdownMenuItem
                      key={option.id}
                      onSelect={() => onCreateTerminal(option.id)}
                      disabled={tool.disabled}
                      className="gap-2 text-xs"
                      title={option.command || option.label}
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      {option.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
      {loading ? (
        <div className="text-center text-xs text-muted-foreground">{t("projectTools.loading")}</div>
      ) : null}
      {error ? <div className="text-center text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
