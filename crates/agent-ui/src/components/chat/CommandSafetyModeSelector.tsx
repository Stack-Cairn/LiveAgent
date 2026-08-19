import { useSandboxCapability } from "@liveagent/adapters/sandboxCapability";
import type { CommandSafetyMode } from "@liveagent/app/lib/settings";
import {
  Check,
  ChevronDown,
  Hand,
  Shield,
  ShieldOff,
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
import {
  COMPOSER_CONTROL_CHEVRON_CLASS,
  COMPOSER_CONTROL_LABEL_CLASS,
  COMPOSER_CONTROL_TRIGGER_CLASS,
} from "@liveagent/ui/lib/chat/composerControlStyles";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";

const MODE_I18N_KEYS: Record<CommandSafetyMode, string> = {
  ask: "chat.safety.ask",
  auto: "chat.safety.auto",
  sandbox: "chat.safety.sandbox",
  sandboxOffline: "chat.safety.sandboxOffline",
};

const MODE_DESC_I18N_KEYS: Record<CommandSafetyMode, string> = {
  ask: "chat.safety.askDesc",
  auto: "chat.safety.autoDesc",
  sandbox: "chat.safety.sandboxDesc",
  sandboxOffline: "chat.safety.sandboxOfflineDesc",
};

const SAFETY_MODES = ["ask", "auto", "sandbox", "sandboxOffline"] as const;

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
  return value === "ask" || value === "auto" || value === "sandbox" || value === "sandboxOffline";
}

function modeIcon(mode: CommandSafetyMode, className: string) {
  if (mode === "ask") return <Hand className={className} />;
  if (mode === "auto") return <Zap className={className} />;
  if (mode === "sandboxOffline") return <ShieldOff className={className} />;
  return <Shield className={className} />;
}

function triggerIconClass(mode: CommandSafetyMode) {
  if (mode === "sandbox" || mode === "sandboxOffline") {
    return "h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400";
  }
  if (mode === "ask") return "h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400";
  return "h-4 w-4 shrink-0 text-muted-foreground";
}

export function CommandSafetyModeSelector(props: {
  value: CommandSafetyMode;
  disabled?: boolean;
  onChange: (mode: CommandSafetyMode) => void;
}) {
  const { value, disabled, onChange } = props;
  const { t } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
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
  const selected = isCommandSafetyMode(value) ? value : "auto";
  const selectedLabel = t(MODE_I18N_KEYS[selected]);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            disabled={disabled}
            className={cn(COMPOSER_CONTROL_TRIGGER_CLASS, "data-[popup-open]:bg-muted/60")}
          />
        }
        title={selectedLabel}
        aria-label={`${t("chat.safety.label")}: ${selectedLabel}`}
      >
        {modeIcon(selected, triggerIconClass(selected))}
        <span className={COMPOSER_CONTROL_LABEL_CLASS}>{selectedLabel}</span>
        <ChevronDown className={cn(COMPOSER_CONTROL_CHEVRON_CLASS, menuOpen && "rotate-180")} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="composer-safety-dropdown flex w-72 flex-col overflow-hidden p-1"
        side="top"
        align="start"
      >
        {SAFETY_MODES.map((mode) => {
          const entryDisabled =
            mode === "sandbox"
              ? sandboxUnavailable
              : mode === "sandboxOffline"
                ? offlineUnavailable
                : false;
          const isSelected = mode === selected;
          return (
            <DropdownMenuItem
              key={mode}
              disabled={entryDisabled}
              onSelect={() => onChange(mode)}
              className={cn(
                "composer-safety-item items-start gap-2 whitespace-normal rounded-md py-1.5 text-xs",
                isSelected &&
                  "bg-foreground/[0.07] font-medium data-[highlighted]:bg-foreground/[0.09]",
              )}
            >
              {modeIcon(mode, "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground")}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium leading-5">{t(MODE_I18N_KEYS[mode])}</span>
                <span className="text-[11px] font-normal leading-4 text-muted-foreground">
                  {entryDisabled ? disabledHint : t(modeDescKey(mode))}
                </span>
              </span>
              {isSelected ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <span className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
