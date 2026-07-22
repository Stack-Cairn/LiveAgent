import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, GitBranch, Loader2, X } from "../../../components/icons";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { useLocale } from "../../../i18n";
import { useModalMotion } from "../../../lib/shared/modalMotion";

type RemoteBranches = {
  defaultBranch: string;
  branches: string[];
};

type WorkspaceCloneModalProps = {
  initialParent: string;
  onClone: (remoteUrl: string, parent: string, name: string, branch: string) => Promise<void>;
  onLoadBranches: (remoteUrl: string) => Promise<RemoteBranches>;
  onOpenFolder: () => void;
  onClose: () => void;
};

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const message = String(error ?? "").trim();
  return message || "Failed to clone repository";
}

function workspaceNameFromRemoteUrl(remoteUrl: string) {
  const path = remoteUrl.trim().replace(/\/+$/, "");
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf(":"));
  return path.slice(separator + 1).replace(/\.git$/i, "");
}

export function WorkspaceCloneModal({
  initialParent,
  onClone,
  onLoadBranches,
  onOpenFolder,
  onClose,
}: WorkspaceCloneModalProps) {
  const { t } = useLocale();
  const [remoteUrl, setRemoteUrl] = useState("");
  const [parent, setParent] = useState(initialParent);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [cloning, setCloning] = useState(false);
  const { modalState, requestClose } = useModalMotion(onClose);

  const [nameIsAutomatic, setNameIsAutomatic] = useState(true);
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const branchRequestId = useRef(0);

  const canClone = Boolean(
    remoteUrl.trim() && parent.trim() && name.trim() && branch && !branchesLoading && !cloning,
  );

  async function chooseParent() {
    try {
      const selected = await invoke<string | null>("system_pick_folder", {
        initial_workdir: parent || undefined,
      });
      const path = selected?.trim();
      if (path) setParent(path);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const loadRemoteBranches = useCallback(
    async (url: string, requestId: number) => {
      try {
        const response = await onLoadBranches(url);
        if (requestId !== branchRequestId.current) return;
        const nextBranches = [
          ...new Set(response.branches.map((value) => value.trim()).filter(Boolean)),
        ];
        setBranches(nextBranches);
        setBranch((current) =>
          current && nextBranches.includes(current)
            ? current
            : response.defaultBranch || nextBranches[0] || "",
        );
      } catch (reason) {
        if (requestId === branchRequestId.current) setError(errorMessage(reason));
      } finally {
        if (requestId === branchRequestId.current) setBranchesLoading(false);
      }
    },
    [onLoadBranches],
  );

  useEffect(() => {
    const url = remoteUrl.trim();
    const requestId = ++branchRequestId.current;
    if (!url) {
      setBranches([]);
      setBranch("");
      setBranchesLoading(false);
      return;
    }

    setBranchesLoading(true);
    const timer = window.setTimeout(() => void loadRemoteBranches(url, requestId), 350);
    return () => {
      window.clearTimeout(timer);
      if (requestId === branchRequestId.current) branchRequestId.current += 1;
    };
  }, [loadRemoteBranches, remoteUrl]);

  async function cloneRepository() {
    if (!canClone) return;
    setCloning(true);
    setError("");
    try {
      await onClone(remoteUrl.trim(), parent.trim(), name.trim(), branch);
      requestClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCloning(false);
    }
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-create-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/25 backdrop-blur-md dark:bg-black/50"
        onClick={requestClose}
        aria-label={t("settings.cancel")}
      />
      <div className="settings-modal-panel relative z-10 w-full max-w-xl overflow-hidden rounded-[28px] border border-black/[0.07] bg-white/[0.93] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_32px_80px_-24px_rgba(0,0,0,0.35)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-background/[0.93] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_32px_80px_-24px_rgba(0,0,0,0.7)]">
        <div className="settings-modal-header flex items-center gap-3 border-b border-black/[0.06] px-6 py-5 dark:border-white/[0.08]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-black/[0.06] bg-white/80 text-foreground/70 shadow-sm dark:border-white/10 dark:bg-white/[0.07] dark:text-foreground/80">
            <GitBranch className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="workspace-create-title" className="text-base font-semibold">
              {t("chat.workspaceCreate")}
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t("chat.workspaceCreateDescription")}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={requestClose}
            aria-label={t("settings.cancel")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start gap-3 rounded-2xl p-4 text-left"
            onClick={() => {
              onOpenFolder();
              requestClose();
            }}
          >
            <FolderOpen className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span>
              <span className="block font-medium">{t("chat.workspaceOpenFolder")}</span>
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {t("chat.workspaceOpenFolderDescription")}
              </span>
            </span>
          </Button>

          <div className="relative py-1 text-center text-xs text-muted-foreground before:absolute before:inset-x-0 before:top-1/2 before:border-t before:border-border/60">
            <span className="relative bg-background px-3">{t("chat.workspaceOr")}</span>
          </div>

          <section className="rounded-2xl border border-border/60 bg-muted/20 p-4">
            <div className="mb-4 flex items-start gap-3">
              <GitBranch className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <h3 className="text-sm font-semibold">{t("chat.workspaceCloneRepository")}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t("chat.workspaceCloneDescription")}
                </p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="workspace-clone-url">{t("chat.workspaceCloneUrl")}</Label>
                <Input
                  id="workspace-clone-url"
                  value={remoteUrl}
                  onChange={(event) => {
                    const nextUrl = event.currentTarget.value;
                    setRemoteUrl(nextUrl);
                    setBranches([]);
                    setBranch("");
                    setBranchesLoading(Boolean(nextUrl.trim()));
                    setError("");
                    if (nameIsAutomatic) setName(workspaceNameFromRemoteUrl(nextUrl));
                  }}
                  placeholder={t("chat.workspaceCloneUrlPlaceholder")}
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor="workspace-clone-parent">{t("chat.workspaceCloneParent")}</Label>
                  <Input
                    id="workspace-clone-parent"
                    value={parent}
                    readOnly
                    placeholder={t("chat.workspaceCloneParentPlaceholder")}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="self-end"
                  onClick={() => void chooseParent()}
                >
                  {t("chat.workspaceCloneChooseParent")}
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="workspace-clone-name">{t("chat.workspaceCloneName")}</Label>
                  <Input
                    id="workspace-clone-name"
                    className="h-10"
                    value={name}
                    onChange={(event) => {
                      setName(event.currentTarget.value);
                      setNameIsAutomatic(false);
                    }}
                    placeholder={t("chat.workspaceCloneNamePlaceholder")}
                    autoComplete="off"
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void cloneRepository();
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="workspace-clone-branch">{t("chat.workspaceCloneBranch")}</Label>
                  <Select
                    value={branch || undefined}
                    onValueChange={setBranch}
                    disabled={!branches.length || branchesLoading}
                  >
                    <SelectTrigger id="workspace-clone-branch" className="h-10">
                      <SelectValue
                        placeholder={
                          branchesLoading
                            ? t("chat.workspaceCloneBranchesLoading")
                            : t("chat.workspaceCloneBranchPlaceholder")
                        }
                      />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {branches.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={requestClose} disabled={cloning}>
                {t("settings.cancel")}
              </Button>
              <Button onClick={() => void cloneRepository()} disabled={!canClone}>
                {cloning ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GitBranch className="h-4 w-4" />
                )}
                {cloning ? t("chat.workspaceCloning") : t("chat.workspaceCloneSubmit")}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
