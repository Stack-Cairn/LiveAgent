import type { WorkspaceProject } from "@liveagent/app/lib/settings";
import type {
  WorkspaceProjectRootAccess,
  WorkspaceProjectRootClient,
  WorkspaceProjectRootGrant,
} from "@liveagent/ui/contracts/workspaceProjectRoots";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { AlertCircle, Folder, FolderTree, Info, Lock, Plus, Trash2 } from "../../IconSet";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { rootStateTone } from "./workspaceProjectSettingsUtils";

const ROOT_ACCESS_OPTIONS = ["read", "write"] as const;

function RootAccessToggle(props: {
  value: WorkspaceProjectRootAccess;
  disabled: boolean;
  ariaLabel: string;
  readLabel: string;
  writeLabel: string;
  onChange: (access: WorkspaceProjectRootAccess) => void;
}) {
  const { value, disabled, ariaLabel, readLabel, writeLabel, onChange } = props;
  return (
    <fieldset className="flex h-7 shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
      <legend className="sr-only">{ariaLabel}</legend>
      {ROOT_ACCESS_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          disabled={disabled}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            value === option && "bg-background text-foreground shadow-sm",
          )}
          onClick={() => onChange(option)}
        >
          {option === "read" ? readLabel : writeLabel}
        </button>
      ))}
    </fieldset>
  );
}

export function WorkspaceDirectorySettingsPanel(props: {
  project: WorkspaceProject;
  rootClient?: WorkspaceProjectRootClient;
  unavailableDescription?: string;
  roots: readonly WorkspaceProjectRootGrant[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  onAdd: () => void;
  onAliasChange: (id: string, alias: string) => void;
  onAccessChange: (id: string, access: WorkspaceProjectRootAccess) => void;
  onRemove: (id: string) => void;
}) {
  const {
    project,
    rootClient,
    unavailableDescription,
    roots,
    loading,
    loaded,
    error,
    onAdd,
    onAliasChange,
    onAccessChange,
    onRemove,
  } = props;
  const { t } = useLocale();

  return (
    <section className="mx-auto max-w-[720px] space-y-4 p-6 max-[720px]:p-4">
      <h3 className="text-base font-semibold">{t("chat.workspaceSettingsDirectories")}</h3>

      {/* 主目录与附加目录合并为同一张列表卡片，形成统一的目录清单。 */}
      <div className="overflow-hidden rounded-xl border border-border/60">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FolderTree className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t("chat.workspaceSettingsPrimaryDirectory")}</div>
            <div
              className="truncate font-mono text-[11px] leading-4 text-muted-foreground"
              title={project.path}
            >
              {project.path}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <Lock className="h-3 w-3" />
            {t("chat.workspaceSettingsDirectoryWrite")}
          </div>
        </div>

        {loading ? (
          <div className="space-y-2 border-t border-border/50 px-4 py-3">
            <span className="sr-only" role="status">
              {t("chat.workspaceSettingsDirectoriesLoading")}
            </span>
            {[0, 1].map((row) => (
              <div key={row} className="flex animate-pulse items-center gap-3 py-1">
                <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/70" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-24 rounded bg-muted/70" />
                  <div className="h-2.5 w-48 max-w-full rounded bg-muted/50" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          roots.map((root) => (
            <div
              key={root.id}
              className="flex items-center gap-3 border-t border-border/50 px-4 py-2.5 transition-colors hover:bg-muted/25 max-[560px]:flex-wrap"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                <Folder className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Input
                    value={root.alias}
                    onChange={(event) => onAliasChange(root.id, event.currentTarget.value)}
                    aria-label={t("chat.workspaceSettingsDirectoryAlias")}
                    maxLength={32}
                    pattern="[a-z][a-z0-9_-]{0,31}"
                    disabled={!loaded}
                    className="h-6 min-w-0 max-w-[180px] border-transparent bg-transparent px-1 text-sm font-medium shadow-none hover:border-border/60 focus-visible:border-border/60 focus-visible:ring-2 focus-visible:ring-foreground/10"
                  />
                  {/* 正常状态不显示徽标，只有异常/待批准时提醒。 */}
                  {root.state !== "active" ? (
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                        rootStateTone(root.state),
                      )}
                    >
                      {t(
                        `chat.workspaceSettingsDirectoryState${root.state
                          .split("-")
                          .map((part) => part[0].toUpperCase() + part.slice(1))
                          .join("")}`,
                      )}
                    </span>
                  ) : null}
                </div>
                <div
                  className="truncate font-mono text-[11px] leading-4 text-muted-foreground"
                  title={root.displayPath}
                >
                  {root.displayPath}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1 max-[560px]:w-full max-[560px]:justify-end">
                <RootAccessToggle
                  value={root.access}
                  disabled={!loaded}
                  ariaLabel={t("chat.workspaceSettingsDirectoryAccess")}
                  readLabel={t("chat.workspaceSettingsDirectoryRead")}
                  writeLabel={t("chat.workspaceSettingsDirectoryWrite")}
                  onChange={(access) => onAccessChange(root.id, access)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  title={t("chat.workspaceSettingsRemoveDirectory")}
                  disabled={!loaded}
                  onClick={() => onRemove(root.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}

        {rootClient ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={!loaded || loading}
            className="flex w-full items-center justify-center gap-1.5 border-t border-dashed border-border/60 px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("chat.workspaceSettingsAddDirectory")}
          </button>
        ) : null}
      </div>

      {!rootClient ? (
        <div className="flex gap-3 rounded-xl border border-border/60 bg-muted/20 p-4">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">
              {t("chat.workspaceSettingsDirectoriesUnavailable")}
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {unavailableDescription ?? t("chat.workspaceSettingsDirectoriesDesktopOnly")}
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <p className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("chat.workspaceSettingsDirectoriesDescription")}
      </p>
    </section>
  );
}
