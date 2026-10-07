import { copyImagePreviewData, saveImagePreviewData } from "@liveagent/adapters/imagePreview";
import { Check, Copy, Download, Loader2, Share2 } from "@liveagent/ui/components/IconSet";
import { domToBlob } from "modern-screenshot";
import { useMemo, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import {
  buildReplyShareFileName,
  buildReplyShareText,
  bytesToBase64,
  type ReplyShareFormat,
  type ReplyShareScope,
  type ReplyShareSource,
  resolveReplyShareScope,
  textToBase64,
} from "../../lib/chat/replyShare";
import { copyTextToClipboard } from "../../lib/shared/clipboard";
import { Markdown } from "../Markdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { toast } from "../ui/toast-manager";

type AssistantReplyShareDialogProps = {
  source: ReplyShareSource;
  onClose: () => void;
};

// 截图节点的像素比：2x 在高分屏和聊天软件里都清晰，又不会让长回答超过画布上限。
const SHARE_IMAGE_SCALE = 2;

async function captureShareImage(node: HTMLElement) {
  const background = getComputedStyle(node).backgroundColor;
  const blob = await domToBlob(node, {
    scale: SHARE_IMAGE_SCALE,
    backgroundColor: background,
    type: "image/png",
  });
  if (!blob) throw new Error("Could not render the reply as an image");
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function AssistantReplyShareDialog({ source, onClose }: AssistantReplyShareDialogProps) {
  const { t } = useLocale();
  const hasPrompt = Boolean(source.prompt?.trim());
  const [scope, setScope] = useState<ReplyShareScope>(hasPrompt ? "conversation" : "answer");
  const [format, setFormat] = useState<ReplyShareFormat>("image");
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [copied, setCopied] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);

  const effectiveScope = resolveReplyShareScope(scope, source);
  const shareText = useMemo(
    () =>
      buildReplyShareText(source, effectiveScope, {
        prompt: t("chat.replyShare.promptLabel"),
        answer: t("chat.replyShare.answerLabel"),
      }),
    [source, effectiveScope, t],
  );

  async function run(kind: "copy" | "save", action: () => Promise<boolean | undefined>) {
    setBusy(kind);
    try {
      const done = await action();
      if (kind === "copy" && done !== false) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    } catch (error) {
      console.error("[reply-share]", error);
      toast.error(
        kind === "copy" ? t("chat.replyShare.copyFailed") : t("chat.replyShare.saveFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  function handleCopy() {
    void run("copy", async () => {
      if (format === "text") {
        const ok = await copyTextToClipboard(shareText);
        if (!ok) throw new Error("Clipboard write failed");
        return true;
      }
      const node = captureRef.current;
      if (!node) throw new Error("Share preview is not mounted");
      // 传 Promise 而不是先 await：WebUI 的 ClipboardItem 需要在用户点击的同一调用栈里创建。
      await copyImagePreviewData(
        captureShareImage(node).then((dataBase64) => ({ dataBase64, mimeType: "image/png" })),
      );
      return true;
    });
  }

  function handleSave() {
    void run("save", async () => {
      const fileName = buildReplyShareFileName(format, source.timestamp);
      if (format === "text") {
        return saveImagePreviewData({
          dataBase64: textToBase64(shareText),
          fileName,
          mimeType: "text/markdown",
        });
      }
      const node = captureRef.current;
      if (!node) throw new Error("Share preview is not mounted");
      return saveImagePreviewData({
        dataBase64: await captureShareImage(node),
        fileName,
        mimeType: "image/png",
      });
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-2xl p-0"
        closeLabel={t("chat.replyShare.close")}
        showCloseButton
      >
        <DialogHeader className="flex-row items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/10 text-sky-500">
            <Share2 className="size-4" />
          </div>
          <DialogTitle className="text-sm leading-normal">{t("chat.replyShare.title")}</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              value={effectiveScope}
              onValueChange={(value) => {
                if (value === "answer" || value === "conversation") setScope(value);
              }}
            >
              <TabsList variant="segmented" aria-label={t("chat.replyShare.scope")}>
                <TabsTrigger value="answer" variant="segmented">
                  {t("chat.replyShare.scopeAnswer")}
                </TabsTrigger>
                <TabsTrigger
                  value="conversation"
                  variant="segmented"
                  disabled={!hasPrompt}
                  title={hasPrompt ? undefined : t("chat.replyShare.scopeConversationUnavailable")}
                >
                  {t("chat.replyShare.scopeConversation")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Tabs
              className="ml-auto"
              value={format}
              onValueChange={(value) => {
                if (value === "text" || value === "image") setFormat(value);
              }}
            >
              <TabsList variant="segmented" aria-label={t("chat.replyShare.format")}>
                <TabsTrigger value="image" variant="segmented">
                  {t("chat.replyShare.formatImage")}
                </TabsTrigger>
                <TabsTrigger value="text" variant="segmented">
                  {t("chat.replyShare.formatText")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="max-h-[60vh] overflow-auto rounded-2xl border border-border/60 bg-muted/25">
            {format === "text" ? (
              <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-foreground">
                {shareText}
              </pre>
            ) : (
              <div
                ref={captureRef}
                data-reply-share-capture=""
                className="space-y-4 bg-background px-6 py-5 text-foreground"
              >
                {effectiveScope === "conversation" ? (
                  <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-sm leading-6">
                    {source.prompt?.trim()}
                  </div>
                ) : null}
                <Markdown content={source.reply.trim()} readOnly />
                <div className="flex justify-end pt-1 text-[11px] text-muted-foreground/70">
                  LiveAgent
                </div>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <DialogActions>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={handleSave}>
              {busy === "save" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {t("chat.replyShare.save")}
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={handleCopy}>
              {busy === "copy" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? t("chat.replyShare.copied") : t("chat.replyShare.copy")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
