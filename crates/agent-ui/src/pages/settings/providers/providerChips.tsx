// 供应商设置页共用的小件：状态芯片、三态能力芯片、来源标签、可点击芯片、渠道头像与
// "失焦提交"的输入框。视觉沿用设置页现有的 shadcn 风格。
//
// 语义色只有一套：default = 中性（信息 / 继承 / 自动），on = 主色（当前选中 / 默认项），
// ok = 绿（可用 / 支持 / 已验证），warn = 琥珀（待处理：未知 / 未拉取 / 缺 Key），
// bad = 红（鉴权失败 / 不支持 / 错误）。同一行只用一种强调色。

import {
  PROVIDER_CHAT_PROTOCOL_LABELS,
  type ProviderChatProtocol,
  type ProviderEndpointProbe,
  type ProviderId,
  type ProviderWireDialect,
} from "@liveagent/app/lib/settings";
import { CircleHelp, Eye, EyeOff, Server } from "@liveagent/ui/components/IconSet";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import { providerPresetLogo } from "@liveagent/ui/components/ProviderLogos";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ProviderPreset } from "@liveagent/ui/lib/providers/registry";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type ChipTone = "default" | "on" | "ok" | "warn" | "bad";

const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  default: "border-border/70 bg-muted/50 text-muted-foreground",
  on: "border-primary/30 bg-primary/10 text-primary",
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
};

/** 所有芯片统一尺寸：22px 高、11px 字、rounded-md、左右 8px。 */
const CHIP_BASE_CLASS =
  "inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-[11px] font-medium leading-none";

const CHIP_BUTTON_CLASS =
  "transition-colors hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50";

export function Chip(props: {
  tone?: ChipTone;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const { tone = "default", className, title, children } = props;
  return (
    <span title={title} className={cn(CHIP_BASE_CLASS, CHIP_TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

export function ChipButton(props: {
  tone?: ChipTone;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const { tone = "default", active, disabled, className, title, ariaLabel, onClick } = props;
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(CHIP_BASE_CLASS, CHIP_BUTTON_CLASS, CHIP_TONE_CLASS[tone], className)}
    >
      {props.children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 三态芯片：支持 / 不支持 / 未知 用形状区分，不用删除线或文字问号
// ---------------------------------------------------------------------------

export type ChipState = "supported" | "unsupported" | "unknown";

const STATE_CHIP_CLASS: Record<ChipState, string> = {
  supported: "border-border/70 bg-muted/40 text-foreground/85",
  unsupported: "border-dashed border-border/80 bg-transparent text-muted-foreground",
  unknown: "border-border/70 bg-muted/40 text-muted-foreground",
};

function StateMark({ state }: { state: ChipState }) {
  if (state === "supported") {
    return <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />;
  }
  if (state === "unsupported") {
    return (
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground/60"
      />
    );
  }
  return <CircleHelp aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground/80" />;
}

function stateChipClass(state: ChipState, overridden: boolean | undefined, className?: string) {
  // 用户覆盖只加一圈细主色描边，不改底色。
  return cn(
    CHIP_BASE_CLASS,
    STATE_CHIP_CLASS[state],
    overridden && "ring-1 ring-primary/50",
    className,
  );
}

export function StateChip(props: {
  state: ChipState;
  overridden?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const { state, overridden, className, title, children } = props;
  return (
    <span title={title} className={stateChipClass(state, overridden, className)}>
      <StateMark state={state} />
      {children}
    </span>
  );
}

export function StateChipButton(props: {
  state: ChipState;
  overridden?: boolean;
  className?: string;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const { state, overridden, className, title, onClick, children } = props;
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(stateChipClass(state, overridden, className), CHIP_BUTTON_CLASS)}
    >
      <StateMark state={state} />
      {children}
    </button>
  );
}

export type ValueSource = "auto" | "user" | "preset" | "catalog" | "heuristic";

/** 来源标签：一律中性灰小字，只有"用户"用主色；不按字段各配一种颜色。 */
export function SourceTag(props: { source: ValueSource; onReset?: () => void }) {
  const { source, onReset } = props;
  const { t } = useLocale();
  const label = t(`settings.providerSource.${source}`);
  return (
    <span className="inline-flex items-center gap-1.5 text-[10.5px] leading-none">
      <span
        className={cn(
          "font-medium",
          source === "user" ? "text-primary" : "text-muted-foreground/80",
        )}
      >
        {label}
      </span>
      {source === "user" && onReset ? (
        <button
          type="button"
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={onReset}
        >
          {t("settings.providerSourceReset")}
        </button>
      ) : null}
    </span>
  );
}

export function ProbeStatusChip(props: {
  probe: ProviderEndpointProbe | undefined;
  pending?: boolean;
}) {
  const { probe, pending } = props;
  const { t } = useLocale();
  if (pending) {
    return <Chip tone="default">{t("settings.providerProbeStatus.pending")}</Chip>;
  }
  if (!probe) return <Chip tone="default">{t("settings.providerProbeStatus.none")}</Chip>;
  if (probe.status === "ok") {
    return (
      <Chip tone="ok" title={probe.error}>
        {t("settings.providerProbeStatus.ok")}
        {probe.latencyMs !== undefined ? ` · ${probe.latencyMs}ms` : ""}
      </Chip>
    );
  }
  if (probe.status === "missing") {
    return (
      <Chip tone="default" title={probe.error}>
        {t("settings.providerProbeStatus.missing")}
      </Chip>
    );
  }
  if (probe.status === "unauthorized") {
    return (
      <Chip tone="bad" title={probe.error}>
        {t("settings.providerProbeStatus.unauthorized")}
      </Chip>
    );
  }
  // 未知：琥珀，原因由 ProbeReason 展示在下一行。
  return (
    <Chip tone="warn" title={probe.error}>
      {t("settings.providerProbeStatus.unknown")}
    </Chip>
  );
}

const PROBE_REASON_LIMIT = 120;

/** "未知"结果的简短原因（截断到 120 字）；其它状态含义自明，原因只留在 title。 */
export function probeReason(probe: ProviderEndpointProbe | undefined): string | undefined {
  if (!probe || probe.status !== "unknown" || !probe.error) return undefined;
  const text = probe.error.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > PROBE_REASON_LIMIT ? `${text.slice(0, PROBE_REASON_LIMIT)}…` : text;
}

export function ProbeReason(props: { probe: ProviderEndpointProbe | undefined }) {
  const reason = probeReason(props.probe);
  if (!reason) return null;
  return (
    <p className="break-all text-[10.5px] leading-relaxed text-amber-700/90 dark:text-amber-300/90">
      {reason}
    </p>
  );
}

/** 方言的界面文案（中英各一套）；"generic" 显示为"通用"。 */
export function dialectLabel(t: (key: string) => string, dialect: ProviderWireDialect): string {
  return t(`settings.providerDialectLabel.${dialect}`);
}

const PROTOCOL_SHORT_LABELS: Record<ProviderChatProtocol, string> = {
  "anthropic-messages": "Messages",
  "openai-completions": "Completions",
  "openai-responses": "Responses",
  "google-generative-ai": "Gemini",
};

export function protocolShortLabel(protocol: ProviderChatProtocol): string {
  return PROTOCOL_SHORT_LABELS[protocol];
}

export function protocolLabel(protocol: ProviderChatProtocol): string {
  return PROVIDER_CHAT_PROTOCOL_LABELS[protocol];
}

const NATIVE_BRAND_BY_PRESET: Record<string, ProviderId> = {
  anthropic: "claude_code",
  openai: "codex",
  gemini: "gemini",
  xai: "xai",
  deepseek: "deepseek",
};

/**
 * 渠道头像：原生渠道用 IconSet 品牌图标，收录的第三方渠道用 ProviderLogos，
 * 自定义 / 未知预设用中性的 Server 图标（不再用名称首字）。容器统一浅底圆角，
 * 尺寸由 className 给（列表行 h-7、详情头 h-10、对话框 h-14），图标按容器比例缩放。
 */
export function ProviderAvatar(props: { preset: ProviderPreset | undefined; className?: string }) {
  const { preset, className } = props;
  const nativeType = preset?.native ? NATIVE_BRAND_BY_PRESET[preset.id] : undefined;
  const Logo = nativeType ? undefined : providerPresetLogo(preset?.id);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground",
        className,
      )}
    >
      {nativeType ? (
        <ProviderBrandIcon type={nativeType} className="h-[56%] w-[56%]" />
      ) : Logo ? (
        <Logo className="h-[56%] w-[56%]" />
      ) : (
        <Server className="h-[50%] w-[50%] text-muted-foreground" />
      )}
    </span>
  );
}

/**
 * 失焦 / 回车提交的文本输入：编辑期间保留本地草稿，提交时才写入设置，避免
 * 每次按键都触发归一化（去尾斜杠、trim）改写用户正在输入的内容。
 */
export function CommittedInput(
  props: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur"> & {
    value: string;
    onCommit: (value: string) => void;
    /** 每次按键即写入（少数场景，例如名称） */
    commitOnChange?: boolean;
  },
) {
  const { value, onCommit, commitOnChange, onKeyDown, ...rest } = props;
  const [draft, setDraft] = useState(value);
  const editingRef = useRef(false);
  useLayoutEffect(() => {
    if (!editingRef.current) setDraft(value);
  }, [value]);

  function commit() {
    editingRef.current = false;
    if (draft === value) return;
    onCommit(draft);
    // 调用方可能拒绝写入（例如清空地址）：草稿回到当前值，被接受时上面的效果会
    // 再同步到归一化后的新值。
    setDraft(value);
  }

  return (
    <Input
      {...rest}
      value={draft}
      onChange={(event) => {
        editingRef.current = true;
        setDraft(event.currentTarget.value);
        if (commitOnChange) onCommit(event.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(event);
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          editingRef.current = false;
          setDraft(value);
        }
      }}
    />
  );
}

/**
 * 秘密输入：WebUI 只知道"已配置"，输入框留空并以占位符表示；桌面端可切换明文。
 * 提交空串且 configured 时表示"保留已存密钥"，由调用方处理。
 */
export function SecretInput(props: {
  id?: string;
  value: string;
  configured: boolean;
  redacted: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
}) {
  const { id, value, configured, redacted, placeholder, className, ariaLabel, onCommit } = props;
  const { t } = useLocale();
  const [show, setShow] = useState(false);
  return (
    <div className={cn("relative min-w-0 flex-1", className)}>
      <CommittedInput
        id={id}
        type={show ? "text" : "password"}
        value={redacted ? "" : value}
        placeholder={
          redacted && configured ? t("settings.providerSecretConfigured") : (placeholder ?? "sk-…")
        }
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        className="h-8 pr-9 font-mono text-xs shadow-none"
        onCommit={(next) => {
          if (redacted && configured && next.trim() === "") return;
          onCommit(next);
        }}
      />
      {!redacted ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0 h-8 w-8 text-muted-foreground hover:bg-transparent hover:text-foreground"
          onClick={() => setShow((previous) => !previous)}
          title={show ? t("settings.hideApiKey") : t("settings.showApiKey")}
          aria-label={show ? t("settings.hideApiKey") : t("settings.showApiKey")}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      ) : null}
    </div>
  );
}

export function SectionTitle(props: {
  title: string;
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const { title, badge, actions, className } = props;
  return (
    <div className={cn("flex min-h-7 flex-wrap items-center gap-2", className)}>
      <span className="text-[13px] font-semibold tracking-tight text-foreground/90">{title}</span>
      {badge}
      {actions ? (
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">{actions}</span>
      ) : null}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}
