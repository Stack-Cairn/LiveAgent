import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import type {
  DangerousToolAssessment,
  ToolApprovalRequest,
} from "../../lib/chat/runner/toolApprovalPolicy";
import { ShieldAlert } from "../icons";
import { Button } from "../ui/button";

type ToolApprovalModalProps = {
  request: ToolApprovalRequest;
  onDecision: (approved: boolean) => void;
};

function kindLabelKey(kind: DangerousToolAssessment["kind"]) {
  switch (kind) {
    case "delete":
      return "chat.toolApproval.kindDelete";
    case "ssh-mutation":
      return "chat.toolApproval.kindSsh";
    case "external-cwd":
      return "chat.toolApproval.kindExternalCwd";
    default:
      return "chat.toolApproval.kindGeneric";
  }
}

/**
 * 危险工具调用的模态确认卡片：模型的运行会在 beforeToolCall 处等待，
 * 直到用户允许 / 拒绝，或运行被取消（signal 撤下卡片并按拒绝处理）。
 */
export function ToolApprovalModal({ request, onDecision }: ToolApprovalModalProps) {
  const { t } = useLocale();
  const { toolCall, assessment } = request;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label={t("chat.toolApproval.title")}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />

      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-amber-500/25 bg-amber-500/10 text-amber-500">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {t("chat.toolApproval.title")}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t(kindLabelKey(assessment.kind))}
            </div>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="text-xs font-medium text-muted-foreground">{toolCall.name}</div>
          {assessment.detail ? (
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
              {assessment.detail}
            </div>
          ) : null}
          <div className="text-xs text-muted-foreground">{t("chat.toolApproval.hint")}</div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3.5">
          <Button type="button" variant="outline" size="sm" onClick={() => onDecision(false)}>
            {t("chat.toolApproval.deny")}
          </Button>
          <Button type="button" size="sm" onClick={() => onDecision(true)}>
            {t("chat.toolApproval.allow")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
