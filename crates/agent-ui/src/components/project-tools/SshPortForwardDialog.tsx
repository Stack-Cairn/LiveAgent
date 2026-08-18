import { Cable, Loader2 } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useRef, useState } from "react";
import type {
  SshLocalForwardAction,
  SshLocalForwardClient,
} from "../../lib/terminal/sshLocalForwardTypes";
import {
  isSshLocalForwardPortDraft,
  validateSshLocalForwardTarget,
} from "../../lib/terminal/sshLocalForwardTypes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export type SshPortForwardDialogProps = {
  sessionId: string;
  projectPathKey?: string;
  /** 会话标识（标题 · user@host:port），由面板算好传入。 */
  subtitle: string;
  /** 平台传输客户端（Tauri IPC / 网关 WS），由面板注入以保持本文件可镜像。 */
  client: SshLocalForwardClient;
  onClose: () => void;
  /** 转发建立成功；面板收下 action 快照并关闭本对话框。 */
  onStarted: (action: SshLocalForwardAction) => void;
};

// 模态 portal 到 body，逃出了 dock 的 --zone-font-scale 作用域，
// 所以这里与 confirm-dialog 一样使用固定字号。
const FIELD_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-border/70 bg-background/80 px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-indigo-500/50 focus-visible:ring-1 focus-visible:ring-indigo-500/20 disabled:opacity-50";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 「添加端口映射」模态框：本地端口（留空自动）、远端主机（留空 127.0.0.1）、
 * 远端端口。提交前先经 `checkLocalPort` 检测本地端口占用，占用即报错中止；
 * `start` 里权威的 bind 失败会以后端原始错误兜底显示。
 */
export function SshPortForwardDialog(props: SshPortForwardDialogProps) {
  const { sessionId, projectPathKey, subtitle, client, onClose, onStarted } = props;
  const { t } = useLocale();
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submittingRef = useRef(false);
  // blur 检测是异步的：结果回来时草稿可能已被改掉，靠 ref 丢弃过期结果。
  const localPortRef = useRef("");
  localPortRef.current = localPort;

  const portInUseMessage = (port: number) =>
    t("projectTools.sshLocalForwardPortInUse").replace("{port}", String(port));

  const handleLocalPortBlur = () => {
    const port = Number(localPort);
    if (!localPort || !Number.isInteger(port) || port < 1 || port > 65535) return;
    void client
      .checkLocalPort(port)
      .then((available) => {
        if (available || localPortRef.current !== String(port)) return;
        setError(portInUseMessage(port));
      })
      .catch(() => {
        // 提前提示失败无所谓，提交时还会再查一次。
      });
  };

  const handleSubmit = () => {
    if (submittingRef.current) return;
    const target = validateSshLocalForwardTarget(remoteHost, remotePort, localPort);
    if (!target) {
      setError(t("projectTools.sshLocalForwardInvalidTarget"));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    void (async () => {
      try {
        if (target.localPort > 0) {
          // 检测失败（命令报错）不拦截：start 的 bind 才是权威裁决。
          const available = await client.checkLocalPort(target.localPort).catch(() => true);
          if (!available) {
            setError(portInUseMessage(target.localPort));
            return;
          }
        }
        const action = await client.start({
          sessionId,
          projectPathKey,
          remoteHost: target.remoteHost,
          remotePort: target.remotePort,
          localPort: target.localPort,
        });
        onStarted(action);
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    })();
  };

  const previewLocal = localPort || t("projectTools.sshLocalForwardAutoPort");
  const previewHost = remoteHost.trim() || "127.0.0.1";
  const previewPort = remotePort || "?";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-w-md p-0"
        closeDisabled={submitting}
        closeLabel={t("projectTools.sshLocalForwardCancel")}
        showCloseButton
      >
        <DialogHeader className="flex-row items-start gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
              <Cable className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="break-words">
                {t("projectTools.sshLocalForwardModalTitle")}
              </DialogTitle>
              <DialogDescription className="mt-1 break-words font-mono text-xs leading-5">
                {subtitle}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <DialogBody className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="ssh-forward-local-port"
                  className="text-xs font-medium text-foreground"
                >
                  {t("projectTools.sshLocalForwardLocalPortLabel")}
                </label>
                <input
                  id="ssh-forward-local-port"
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  value={localPort}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (!isSshLocalForwardPortDraft(value)) return;
                    setLocalPort(value);
                    setError("");
                  }}
                  onBlur={handleLocalPortBlur}
                  className={cn(FIELD_CLASS, "font-mono")}
                  placeholder={t("projectTools.sshLocalForwardAutoPort")}
                  disabled={submitting}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="ssh-forward-remote-port"
                  className="text-xs font-medium text-foreground"
                >
                  {t("projectTools.sshLocalForwardRemotePortLabel")}
                </label>
                <input
                  id="ssh-forward-remote-port"
                  type="text"
                  inputMode="numeric"
                  value={remotePort}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (!isSshLocalForwardPortDraft(value)) return;
                    setRemotePort(value);
                    setError("");
                  }}
                  className={cn(FIELD_CLASS, "font-mono")}
                  placeholder={t("projectTools.sshLocalForwardRemotePortLabel")}
                  disabled={submitting}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="ssh-forward-remote-host"
                className="text-xs font-medium text-foreground"
              >
                {t("projectTools.sshLocalForwardRemoteHostLabel")}
              </label>
              <input
                id="ssh-forward-remote-host"
                type="text"
                value={remoteHost}
                onChange={(event) => {
                  setRemoteHost(event.currentTarget.value);
                  setError("");
                }}
                className={FIELD_CLASS}
                placeholder={t("projectTools.sshLocalForwardHostPlaceholder")}
                disabled={submitting}
              />
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 font-mono text-xs text-muted-foreground">
              127.0.0.1:{previewLocal}
              <span className="mx-1.5 text-muted-foreground/60">→</span>
              {previewHost}:{previewPort}
            </div>

            <div className="text-xs leading-5 text-muted-foreground">
              {t("projectTools.sshLocalForwardHelp")}
            </div>

            {error ? (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </DialogBody>

          <DialogFooter className="bg-muted/20">
            <DialogActions>
              <DialogClose render={<Button type="button" variant="outline" />}>
                {t("projectTools.sshLocalForwardCancel")}
              </DialogClose>
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t("projectTools.sshLocalForwardSubmit")}
              </Button>
            </DialogActions>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
