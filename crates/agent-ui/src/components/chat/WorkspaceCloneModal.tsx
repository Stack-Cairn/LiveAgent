import { useDirectoryPicker } from "@liveagent/adapters/directoryPicker";
import { ArrowLeft, FolderOpen, GitBranch, Loader2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useRef, useState } from "react";

type RemoteBranches = {
  defaultBranch: string;
  branches: string[];
};

type WorkspaceCloneModalProps = {
  initialParent: string;
  canClone?: boolean;
  cloneDisabledMessage?: string;
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
  canClone: cloningEnabled = true,
  cloneDisabledMessage,
  onClone,
  onLoadBranches,
  onOpenFolder,
  onClose,
}: WorkspaceCloneModalProps) {
  const { t } = useLocale();
  const { pickDirectory, directoryPickerElement } = useDirectoryPicker();
  const [step, setStep] = useState<"choose" | "clone">("choose");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [parent, setParent] = useState(initialParent);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [cloning, setCloning] = useState(false);

  const [nameIsAutomatic, setNameIsAutomatic] = useState(true);
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const branchRequestId = useRef(0);

  const canSubmit = Boolean(
    cloningEnabled &&
      remoteUrl.trim() &&
      parent.trim() &&
      name.trim() &&
      branch &&
      !branchesLoading &&
      !cloning,
  );

  async function chooseParent() {
    try {
      const selected = await pickDirectory(parent);
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
    if (!canSubmit) return;
    setCloning(true);
    setError("");
    try {
      await onClone(remoteUrl.trim(), parent.trim(), name.trim(), branch);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCloning(false);
    }
  }

  const modal = (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cloning) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-90dvh max-w-xl flex-col p-0"
        closeDisabled={cloning}
        closeLabel={t("settings.cancel")}
        showCloseButton
      >
        <DialogHeader className="flex-row items-start gap-3">
          {step === "clone" ? (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={cloning}
              aria-label={t("chat.workspaceCreate")}
              onClick={() => setStep("choose")}
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0">
            <DialogTitle>
              {t(step === "choose" ? "chat.workspaceCreate" : "chat.workspaceCloneRepository")}
            </DialogTitle>
            <DialogDescription>
              {t(
                step === "choose"
                  ? "chat.workspaceCreateDescription"
                  : "chat.workspaceCloneDescription",
              )}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {step === "choose" ? (
            <div className="space-y-2">
              <Button
                variant="ghost"
                className={cn(
                  "h-auto w-full justify-start gap-3 rounded-xl p-4 text-left whitespace-normal",
                  "bg-settings-tile hover:bg-settings-tile-hover",
                )}
                onClick={() => {
                  onOpenFolder();
                  onClose();
                }}
              >
                <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">{t("chat.workspaceOpenFolder")}</span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    {t("chat.workspaceOpenFolderDescription")}
                  </span>
                </span>
              </Button>
              <Button
                variant="ghost"
                disabled={!cloningEnabled}
                className={cn(
                  "h-auto w-full justify-start gap-3 rounded-xl p-4 text-left whitespace-normal",
                  "bg-settings-tile hover:bg-settings-tile-hover",
                )}
                onClick={() => setStep("clone")}
              >
                <GitBranch className="size-5 shrink-0 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">
                    {t("chat.workspaceCloneRepository")}
                  </span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    {!cloningEnabled && cloneDisabledMessage
                      ? cloneDisabledMessage
                      : t("chat.workspaceCloneDescription")}
                  </span>
                </span>
              </Button>
            </div>
          ) : (
            <fieldset disabled={cloning} className="min-w-0 space-y-4">
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="workspace-clone-url">{t("chat.workspaceCloneUrl")}</Label>
                  <Input
                    variant="plain"
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
                    autoFocus
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-clone-parent">{t("chat.workspaceCloneParent")}</Label>
                    <Input
                      variant="plain"
                      id="workspace-clone-parent"
                      value={parent}
                      readOnly
                      placeholder={t("chat.workspaceCloneParentPlaceholder")}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-end"
                    onClick={() => void chooseParent()}
                  >
                    {t("chat.workspaceCloneChooseParent")}
                  </Button>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-clone-name">{t("chat.workspaceCloneName")}</Label>
                    <Input
                      variant="plain"
                      id="workspace-clone-name"
                      className="h-9"
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
                      value={branch || null}
                      onValueChange={setBranch}
                      disabled={!branches.length || branchesLoading}
                    >
                      <SelectTrigger
                        id="workspace-clone-branch"
                        className="h-9 w-full border-0 bg-settings-tile-hover shadow-none"
                      >
                        <SelectValue
                          placeholder={
                            branchesLoading
                              ? t("chat.workspaceCloneBranchesLoading")
                              : t("chat.workspaceCloneBranchPlaceholder")
                          }
                        />
                      </SelectTrigger>
                      <SelectContent className="max-h-60 w-72 max-w-viewport-inset-2rem">
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
              {!cloningEnabled && cloneDisabledMessage ? (
                <p className="mt-3 text-xs text-muted-foreground">{cloneDisabledMessage}</p>
              ) : null}
              {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
            </fieldset>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button size="sm" variant="outline" onClick={onClose} disabled={cloning}>
              {t("settings.cancel")}
            </Button>
            {step === "clone" ? (
              <Button size="sm" onClick={() => void cloneRepository()} disabled={!canSubmit}>
                {cloning ? <Loader2 className="size-4 animate-spin" /> : null}
                {cloning ? t("chat.workspaceCloning") : t("chat.workspaceCloneSubmit")}
              </Button>
            ) : null}
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      {modal}
      {directoryPickerElement}
    </>
  );
}
