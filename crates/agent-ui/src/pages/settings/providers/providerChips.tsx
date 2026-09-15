// 供应商设置页共用的小件：状态芯片、来源标签、可点击芯片、预设头像与
// "失焦提交"的输入框。视觉沿用设置页现有的 shadcn 风格。

import {
  PROVIDER_CHAT_PROTOCOL_LABELS,
  type ProviderChatProtocol,
  type ProviderEndpointProbe,
  type ProviderWireDialect,
} from "@liveagent/app/lib/settings";
import { Eye, EyeOff } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { PresetCategory, ProviderPreset } from "@liveagent/ui/lib/providers/registry";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ProviderBrandIcon } from "../ProviderPresentation";

export type ChipTone = "default" | "on" | "ok" | "warn" | "bad" | "purple";

const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  default: "border-border/70 bg-muted/60 text-muted-foreground",
  on: "border-primary/30 bg-primary/10 text-primary",
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
  purple: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};

export function Chip(props: {
  tone?: ChipTone;
  strike?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const { tone = "default", strike, className, title, children } = props;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[10.5px] font-medium leading-none",
        CHIP_TONE_CLASS[tone],
        strike && "line-through opacity-60",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ChipButton(props: {
  tone?: ChipTone;
  strike?: boolean;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const {
    tone = "default",
    strike,
    active,
    disabled,
    className,
    title,
    ariaLabel,
    onClick,
  } = props;
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[11px] font-medium leading-none transition-colors hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50",
        CHIP_TONE_CLASS[tone],
        strike && "line-through opacity-60",
        className,
      )}
    >
      {props.children}
    </button>
  );
}

export type ValueSource = "auto" | "user" | "preset" | "catalog" | "heuristic";

export function SourceTag(props: { source: ValueSource; onReset?: () => void }) {
  const { source, onReset } = props;
  const { t } = useLocale();
  const label = t(`settings.providerSource.${source}`);
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          "inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium leading-none",
          source === "user"
            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : source === "auto" || source === "preset" || source === "catalog"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
        )}
      >
        {label}
      </span>
      {source === "user" && onReset ? (
        <button
          type="button"
          className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
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

export function CategoryChip({ category }: { category: PresetCategory | undefined }) {
  const { t } = useLocale();
  if (!category) return null;
  return <Chip>{t(`settings.providerCategory.${category}`)}</Chip>;
}

/** 预设头像：原生渠道用品牌图标，其余用名称首字。 */
export function ProviderAvatar(props: {
  preset: ProviderPreset | undefined;
  name: string;
  className?: string;
}) {
  const { preset, name, className } = props;
  const nativeType = preset?.native
    ? preset.id === "anthropic"
      ? "claude_code"
      : preset.id === "openai"
        ? "codex"
        : preset.id === "gemini"
          ? "gemini"
          : preset.id === "xai"
            ? "xai"
            : preset.id === "deepseek"
              ? "deepseek"
              : undefined
    : undefined;
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border border-foreground/[0.06] bg-foreground/[0.04] text-foreground",
        className,
      )}
    >
      {nativeType ? (
        <ProviderBrandIcon type={nativeType} />
      ) : (
        <span className="text-[0.85em] font-semibold text-foreground/80">{initial}</span>
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
