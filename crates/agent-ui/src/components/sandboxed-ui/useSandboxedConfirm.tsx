// In-app confirmations for actions a sandboxed page asks the host to take: tool calls
// (once / for the rest of this app session / deny) and opening a link.

import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { SandboxedUiConfirmChoice } from "@liveagent/ui/lib/sandboxed-ui/pluginPanelHost";
import { useCallback } from "react";

/** Arguments as shown to the user: pretty JSON, cut so the dialog stays readable. */
export function formatToolArgsForConfirm(args: Record<string, unknown>, maxChars = 2000) {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    text = "{}";
  }
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export type SandboxedToolConfirmRequest = {
  /** Plugin or MCP server name, shown as the requester. */
  source: string;
  toolName: string;
  args: Record<string, unknown>;
  kind: "plugin" | "mcpApp";
};

export function useSandboxedConfirm() {
  const { t } = useLocale();
  const { choose, confirm, dialog } = useConfirmDialog();

  const confirmTool = useCallback(
    async (request: SandboxedToolConfirmRequest): Promise<SandboxedUiConfirmChoice> => {
      const choice = await choose({
        title: t("sandboxedUi.confirmTool.title"),
        subtitle: t(
          request.kind === "plugin"
            ? "sandboxedUi.confirmTool.pluginSubtitle"
            : "sandboxedUi.confirmTool.mcpSubtitle",
        )
          .replace("{source}", request.source)
          .replace("{tool}", request.toolName),
        description: t("sandboxedUi.confirmTool.description"),
        detail: <pre className="whitespace-pre-wrap">{formatToolArgsForConfirm(request.args)}</pre>,
        confirmLabel: t("sandboxedUi.confirmTool.allowOnce"),
        secondaryConfirmLabel: t("sandboxedUi.confirmTool.allowSession"),
        cancelLabel: t("sandboxedUi.confirmTool.deny"),
        tone: "default",
      });
      return choice === "confirm" ? "once" : choice === "secondary" ? "always" : "deny";
    },
    [choose, t],
  );

  const confirmLink = useCallback(
    (url: string) =>
      confirm({
        title: t("sandboxedUi.confirmLink.title"),
        description: t("sandboxedUi.confirmLink.description"),
        detail: url,
        confirmLabel: t("sandboxedUi.confirmLink.open"),
        cancelLabel: t("sandboxedUi.cancel"),
        tone: "default",
      }),
    [confirm, t],
  );

  return { confirmTool, confirmLink, dialog };
}
