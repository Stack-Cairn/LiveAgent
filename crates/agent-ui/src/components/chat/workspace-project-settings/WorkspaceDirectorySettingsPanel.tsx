import type { WorkspaceProject } from "@liveagent/app/lib/settings";
import type {
  WorkspaceProjectRootAccess,
  WorkspaceProjectRootClient,
  WorkspaceProjectRootGrant,
} from "@liveagent/ui/contracts/workspaceProjectRoots";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { AlertCircle, Folder, FolderTree, Loader2, Plus, Trash2 } from "../../IconSet";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { rootStateTone } from "./workspaceProjectSettingsUtils";

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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{t("chat.workspaceSettingsDirectories")}</h3>
          <p className="mt-1 max-w-[560px] text-xs leading-5 text-muted-foreground">
            {t("chat.workspaceSettingsDirectoriesDescription")}
          </p>
        </div>
        {rootClient ? (
          <Button
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={onAdd}
            disabled={!loaded || loading}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("chat.workspaceSettingsAddDirectory")}
          </Button>
        ) : null}
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/[0.035] px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Folder className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {t("chat.workspaceSettingsPrimaryDirectory")}
              </span>
              <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {t("chat.workspaceSettingsPrimaryBadge")}
              </span>
            </div>
            <div
              className="mt-0.5 truncate font-mono text-[11px] leading-5 text-muted-foreground"
              title={project.path}
            >
              {project.path}
            </div>
          </div>
        </div>
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
      ) : loading ? (
        <div className="flex min-h-28 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("chat.workspaceSettingsDirectoriesLoading")}
        </div>
      ) : roots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-6 py-9 text-center">
          <FolderTree className="mx-auto h-6 w-6 text-muted-foreground/70" />
          <div className="mt-3 text-sm font-medium">
            {t("chat.workspaceSettingsDirectoriesEmpty")}
          </div>
          <p className="mx-auto mt-1 max-w-[420px] text-xs leading-5 text-muted-foreground">
            {t("chat.workspaceSettingsDirectoriesEmptyDescription")}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-background/60">
          {roots.map((root) => (
            <div
              key={root.id}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 py-2.5 transition-colors hover:bg-muted/30 max-[560px]:grid-cols-1"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    value={root.alias}
                    onChange={(event) => onAliasChange(root.id, event.currentTarget.value)}
                    aria-label={t("chat.workspaceSettingsDirectoryAlias")}
                    maxLength={32}
                    pattern="[a-z][a-z0-9_-]{0,31}"
                    disabled={!loaded}
                    className="h-7 min-w-0 max-w-[180px] border-transparent bg-transparent px-1.5 text-sm font-medium shadow-none hover:border-border/60 focus-visible:border-border/60 focus-visible:ring-2 focus-visible:ring-foreground/10"
                  />
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
                </div>
                <div
                  className="mt-0.5 truncate font-mono text-[11px] leading-4 text-muted-foreground"
                  title={root.displayPath}
                >
                  {root.displayPath}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1 max-[560px]:justify-between">
                <label className="sr-only" htmlFor={`workspace-root-access-${root.id}`}>
                  {t("chat.workspaceSettingsDirectoryAccess")}
                </label>
                <Select
                  value={root.access}
                  disabled={!loaded}
                  onValueChange={(value) =>
                    onAccessChange(root.id, value as WorkspaceProjectRootAccess)
                  }
                >
                  <SelectTrigger
                    id={`workspace-root-access-${root.id}`}
                    className="h-8 w-auto min-w-24 border-border/60 px-2.5 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="read">{t("chat.workspaceSettingsDirectoryRead")}</SelectItem>
                    <SelectItem value="write">
                      {t("chat.workspaceSettingsDirectoryWrite")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                  title={t("chat.workspaceSettingsRemoveDirectory")}
                  disabled={!loaded}
                  onClick={() => onRemove(root.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}
