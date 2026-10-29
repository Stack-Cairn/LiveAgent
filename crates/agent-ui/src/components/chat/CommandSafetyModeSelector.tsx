import { loadAIApprovalState } from "@liveagent/adapters/aiApprovalReadiness";
import { useSandboxCapability } from "@liveagent/adapters/sandboxCapability";
import type { CommandSafetyMode } from "@liveagent/app/lib/settings";
import {
  Check,
  Hand,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  SquarePen,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { COMPOSER_CONTROL_TRIGGER_CLASS } from "@liveagent/ui/lib/chat/composerControlStyles";
import { useAIApprovalReviewerConfigured } from "@liveagent/ui/lib/settings/aiApprovalReadiness";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";

const MODE_I18N_KEYS: Record<CommandSafetyMode, string> = {
  ask: "chat.safety.ask",
  auto: "chat.safety.auto",
  autoEdit: "chat.safety.autoEdit",
  always: "chat.safety.always",
  autoReview: "chat.safety.autoReview",
  sandbox: "chat.safety.sandbox",
  sandboxOffline: "chat.safety.sandboxOffline",
};

const MODE_DESC_I18N_KEYS: Record<CommandSafetyMode, string> = {
  ask: "chat.safety.askDesc",
  auto: "chat.safety.autoDesc",
  autoEdit: "chat.safety.autoEditDesc",
  always: "chat.safety.alwaysDesc",
  autoReview: "chat.safety.autoReviewDesc",
  sandbox: "chat.safety.sandboxDesc",
  sandboxOffline: "chat.safety.sandboxOfflineDesc",
};

// "Full access" (auto) is retired: auto review takes its place in the list and
// saved "auto" values are migrated to "always" by settings normalization.
const SAFETY_MODES = ["ask", "autoEdit", "autoReview", "always"] as const;

/**
 * 读掩蔽是平台/后端相关的能力,不能作为跨平台的肯定承诺(P2#7)。
 * macOS 用 `(deny file-read* (subpath …))`、Linux 用 `--tmpfs` 掩蔽,文案成立;
 * Windows 的联网后端是 WRITE_RESTRICTED 受限令牌 —— 限制性 SID 只参与"写"判定,
 * 读/执行跳过第二遍,且写 ACE 只授不撤,**没有任何读掩蔽**。若沿用同一句"敏感目录
 * 不可读",Windows 用户会据此认为凭据受保护而在沙箱模式下跑不可信代码,而这恰恰是
 * 可联网的后端(~/.ssh、%USERPROFILE%\.aws\credentials、config.sqlite 里的 provider
 * key 都可读并外传)。故该平台改用不含读掩蔽承诺的文案。
 * 断网后端(AppContainer)默认拒读,顺带获得掩蔽,sandboxOffline 文案不受影响。
 */
const MECHANISMS_WITHOUT_READ_MASKING: ReadonlySet<string> = new Set(["restricted-token"]);

function isCommandSafetyMode(value: unknown): value is CommandSafetyMode {
  return (
    value === "ask" ||
    value === "auto" ||
    value === "autoEdit" ||
    value === "always" ||
    value === "autoReview" ||
    value === "sandbox" ||
    value === "sandboxOffline"
  );
}

// One icon per mode, so neighbouring entries in the menu are distinguishable.
function modeIcon(mode: CommandSafetyMode, className: string) {
  if (mode === "ask") return <Hand className={className} />;
  if (mode === "autoEdit") return <SquarePen className={className} />;
  if (mode === "autoReview") return <ShieldCheck className={className} />;
  if (mode === "auto") return <Zap className={className} />;
  if (mode === "always") return <ShieldAlert className={className} />;
  if (mode === "sandboxOffline") return <ShieldOff className={className} />;
  return <Shield className={className} />;
}

function triggerIconClass(mode: CommandSafetyMode, reviewerMissing: boolean) {
  if (mode === "autoReview" && reviewerMissing) {
    return "size-4 shrink-0 text-amber-600 dark:text-amber-400";
  }
  if (mode === "sandbox" || mode === "sandboxOffline") {
    return "size-4 shrink-0 text-emerald-600 dark:text-emerald-400";
  }
  if (mode === "ask") return "size-4 shrink-0 text-sky-600 dark:text-sky-400";
  return "size-4 shrink-0 text-muted-foreground";
}

export function CommandSafetyModeSelector(props: {
  value: CommandSafetyMode;
  disabled?: boolean;
  onChange: (mode: CommandSafetyMode) => void;
  /** Opens the settings page that holds the AI approval reviewer model. */
  onConfigureAutoReview?: () => void;
}) {
  // Plan mode has its own switch in the composer's plus menu; this menu only
  // picks the permission mode, and choosing one leaves plan mode as it is.
  const { value, disabled, onChange, onConfigureAutoReview } = props;
  const { t } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  // Counts openings only, so the reviewer check re-reads on open and not on close.
  const [menuOpenings, setMenuOpenings] = useState(0);
  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (open) setMenuOpenings((count) => count + 1);
  };
  const capability = useSandboxCapability();
  // 写围栏(sandbox):平台不支持时禁用。桌面端探测返回前(null)乐观启用,由执行层
  // fail-closed 兜底;WebUI 执行端平台未知,同样交由 fail-closed。
  const sandboxUnavailable = capability !== null && !capability.supported;
  // 断网(sandboxOffline):额外要求平台可断网。探测判定 network_control=false 时
  // (如 Windows 派生不出 AppContainer SID)仅此项禁用,sandbox 仍可用。
  const offlineUnavailable =
    sandboxUnavailable || (capability !== null && !capability.network_control);
  // 禁用时的说明文案:整体不可用优先,否则为“仅断网不可用”。
  const disabledHint = sandboxUnavailable
    ? t("chat.safety.sandboxUnavailable")
    : t("chat.safety.sandboxOfflineUnavailable");
  // 联网写围栏后端是否缺失读掩蔽(Windows 受限令牌);缺失时 sandbox 项换用不承诺
  // “敏感目录不可读”的文案。探测返回前(null)以及 WebUI(永远拿不到桌面 mechanism)
  // 保守按缺失处理,避免先给出过强承诺。
  const sandboxLacksReadMasking =
    capability === null ? true : MECHANISMS_WITHOUT_READ_MASKING.has(capability.mechanism);
  const modeDescKey = (mode: CommandSafetyMode) =>
    mode === "sandbox" && sandboxLacksReadMasking
      ? "chat.safety.sandboxDescNoReadMask"
      : MODE_DESC_I18N_KEYS[mode];
  // 当前值本身不可用(如设置同步自 macOS,本机是 Windows)时仍显示,但标红提示
  // 由执行层报错兜底;这里不做静默改写,避免设置回写抖动。
  const selected = isCommandSafetyMode(value) && value !== "auto" ? value : "always";
  // Auto review needs a reviewer model; without one K-brain asks for every
  // action and withholds tool output. Only a confirmed missing reviewer warns.
  const reviewerConfigured = useAIApprovalReviewerConfigured(
    loadAIApprovalState,
    menuOpen || selected === "autoReview",
    menuOpenings,
  );
  const reviewerMissing = reviewerConfigured === false;
  const selectedLabel =
    t(MODE_I18N_KEYS[selected]) +
    (selected === "autoReview" && reviewerMissing
      ? ` · ${t("chat.safety.autoReviewNeedsModel")}`
      : "");
  const modes: readonly CommandSafetyMode[] =
    selected === "sandbox" || selected === "sandboxOffline"
      ? [...SAFETY_MODES, selected]
      : SAFETY_MODES;

  return (
    <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            disabled={disabled}
            className={cn(
              COMPOSER_CONTROL_TRIGGER_CLASS,
              "w-8 justify-center gap-0 px-0",
              "data-popup-open:bg-muted/60 web:max-480:flex-none web:max-480:w-8 web:max-480:min-w-8 web:max-480:justify-center web:max-480:gap-0 web:max-480:px-0",
            )}
          />
        }
        title={selectedLabel}
        aria-label={`${t("chat.safety.label")}: ${selectedLabel}`}
      >
        {modeIcon(selected, triggerIconClass(selected, reviewerMissing))}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        variant="soft"
        className="flex w-[324px] max-w-[calc(100vw-16px)] flex-col gap-0.5 overflow-hidden"
        side="top"
        align="start"
      >
        {modes.map((mode) => {
          const entryDisabled =
            mode === "sandbox"
              ? sandboxUnavailable
              : mode === "sandboxOffline"
                ? offlineUnavailable
                : false;
          const isSelected = mode === selected;
          const needsReviewer = mode === "autoReview" && reviewerMissing;
          const item = (
            <DropdownMenuItem
              key={mode}
              disabled={entryDisabled}
              onSelect={() => onChange(mode)}
              className={cn(
                "h-auto items-start gap-2.5 py-2 text-xs whitespace-normal",
                isSelected && "bg-accent text-accent-foreground",
              )}
            >
              {modeIcon(mode, "mt-0.5 size-3.5 shrink-0 text-muted-foreground")}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium leading-4">{t(MODE_I18N_KEYS[mode])}</span>
                <span
                  className={cn(
                    "text-tiny font-normal leading-4 text-muted-foreground",
                    needsReviewer && "text-amber-700 dark:text-amber-400",
                  )}
                >
                  {entryDisabled
                    ? disabledHint
                    : needsReviewer
                      ? t("chat.safety.autoReviewNeedsModel")
                      : t(modeDescKey(mode))}
                </span>
              </span>
              {isSelected ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
              ) : (
                <span className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              )}
            </DropdownMenuItem>
          );
          if (!needsReviewer || !onConfigureAutoReview) return item;
          return [
            item,
            <DropdownMenuItem
              key="configure-reviewer"
              onSelect={onConfigureAutoReview}
              className="h-auto items-center gap-2.5 py-1.5 pl-8 text-xs"
            >
              <Settings className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium">{t("chat.safety.configureReviewer")}</span>
            </DropdownMenuItem>,
          ];
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
