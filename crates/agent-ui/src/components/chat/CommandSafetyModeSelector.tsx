import { useSandboxCapability } from "@liveagent/adapters/sandboxCapability";
import type { CommandSafetyMode } from "@liveagent/app/lib/settings";
import { Hand, Shield, ShieldOff, Zap } from "@liveagent/ui/components/IconSet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";

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

export function CommandSafetyModeSelector(props: {
  surface: "desktop" | "web";
  value: CommandSafetyMode;
  disabled?: boolean;
  onChange: (mode: CommandSafetyMode) => void;
}) {
  const { surface, value, disabled, onChange } = props;
  const { t } = useLocale();
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
  const sandboxSelected = selected === "sandbox" || selected === "sandboxOffline";

  const modeIcon = (mode: CommandSafetyMode, className: string) => {
    if (mode === "ask") return <Hand className={className} />;
    if (mode === "auto") return <Zap className={className} />;
    if (mode === "sandboxOffline") return <ShieldOff className={className} />;
    return <Shield className={className} />;
  };

  return (
    <Select
      value={selected}
      onValueChange={(next) => {
        if (isCommandSafetyMode(next)) onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        className={cn(
          "composer-safety-trigger group/safety h-8 w-auto shrink-0 gap-0.5 rounded-full border-0 pl-2 pr-1.5 text-xs font-medium shadow-none outline-hidden transition-all duration-200 ease-out disabled:opacity-45",
          sandboxSelected
            ? "bg-emerald-50/70 text-foreground hover:bg-emerald-50 dark:bg-emerald-400/[0.09] dark:hover:bg-emerald-400/[0.15]"
            : selected === "ask"
              ? "bg-sky-50/70 text-foreground hover:bg-sky-50 dark:bg-sky-400/[0.09] dark:hover:bg-sky-400/[0.15]"
              : "bg-muted/45 text-foreground hover:bg-muted/70 dark:bg-white/[0.06] dark:hover:bg-white/[0.11]",
          surface === "desktop"
            ? "[&_svg:last-child]:h-3 [&_svg:last-child]:w-3 [&_svg:last-child]:opacity-50 [&_svg:last-child]:transition-transform [&_svg:last-child]:duration-200 [&[data-popup-open]_svg:last-child]:rotate-180"
            : "[&>svg:last-child]:h-3 [&>svg:last-child]:w-3 [&>svg:last-child]:opacity-50 [&>svg:last-child]:transition-transform [&>svg:last-child]:duration-200 [&[data-state=open]>svg:last-child]:rotate-180",
        )}
        aria-label={t("chat.safety.label")}
      >
        <span className="flex min-w-0 items-center gap-1">
          {modeIcon(
            selected,
            cn(
              "h-3.5 w-3.5 shrink-0 transition-colors",
              sandboxSelected
                ? "text-emerald-600 dark:text-emerald-400"
                : selected === "ask"
                  ? "text-sky-600 dark:text-sky-400"
                  : "text-muted-foreground",
            ),
          )}
          <SelectValue>
            {(current) => t(MODE_I18N_KEYS[isCommandSafetyMode(current) ? current : selected])}
          </SelectValue>
        </span>
      </SelectTrigger>
      <SelectContent className="sidebar-context-menu min-w-64 rounded-xl border-0">
        {(["ask", "auto", "sandbox", "sandboxOffline"] as const).map((mode) => {
          const entryDisabled =
            mode === "sandbox"
              ? sandboxUnavailable
              : mode === "sandboxOffline"
                ? offlineUnavailable
                : false;
          return (
            <SelectItem
              key={mode}
              value={mode}
              disabled={entryDisabled}
              className={cn(
                "mb-0.5 rounded-md py-1.5 text-[calc(13px*var(--zone-font-scale,1))] font-normal leading-5 transition-none last:mb-0",
                surface === "desktop"
                  ? "data-[highlighted]:bg-foreground/[0.05] data-[highlighted]:text-foreground"
                  : "focus:bg-foreground/[0.05] focus:text-foreground",
                mode === selected &&
                  (surface === "desktop"
                    ? "bg-foreground/[0.07] data-[highlighted]:bg-foreground/[0.09]"
                    : "bg-foreground/[0.07] focus:bg-foreground/[0.09]"),
                entryDisabled && "opacity-45",
              )}
            >
              <span className="flex items-start gap-2">
                {modeIcon(mode, "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground")}
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{t(MODE_I18N_KEYS[mode])}</span>
                  <span className="text-[11px] leading-4 text-muted-foreground">
                    {entryDisabled ? disabledHint : t(modeDescKey(mode))}
                  </span>
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
