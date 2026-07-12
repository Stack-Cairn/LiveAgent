import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "../../i18n";
import { workspaceProjectPathKey } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import {
  composePublicUrl,
  type LocalTunnelClient,
  TUNNEL_TTL_OPTIONS,
  type TunnelCreateInput,
  type TunnelHealth,
  type TunnelStateSnapshot,
  type TunnelStatus,
  type TunnelTtlSeconds,
  type TunnelUpdateInput,
  validateLocalHttpTarget,
} from "../../lib/tunnels/constants";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Edit3,
  ExternalLink,
  Folder,
  Globe,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export type { LocalTunnelClient } from "../../lib/tunnels/constants";

type LocalTunnelPanelProps = {
  // Visibility contract from the right-dock registry: gates per-row TTL
  // countdown ticks while the panel is kept alive behind another tab.
  active?: boolean;
  client: LocalTunnelClient | null;
  enabled: boolean;
  disabledMessage?: string;
  projectPathKey?: string;
  publicBaseUrl: string;
  onOpenExternal?: (url: string) => void;
};

type TunnelScope = "project" | "global";

type TunnelRowAction = "save" | "close" | "check";

type HealthDisplayStatus = TunnelHealth["status"];

// "keep" leaves ttl_seconds out of tunnel.update so the current expiry is
// preserved instead of silently re-bucketing it.
type EditTtlValue = TunnelTtlSeconds | "keep";

const TUNNEL_SCOPE_OPTIONS: Array<{
  scope: TunnelScope;
  labelKey: string;
  titleKey: string;
}> = [
  {
    scope: "project",
    labelKey: "projectTools.tunnelScopeProject",
    titleKey: "projectTools.tunnelScopeProjectTitle",
  },
  {
    scope: "global",
    labelKey: "projectTools.tunnelScopeGlobal",
    titleKey: "projectTools.tunnelScopeGlobalTitle",
  },
];

const TUNNEL_INPUT_CLASS =
  "h-8 min-w-0 rounded-lg border-border/60 bg-background/80 text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-[calc(11px*var(--zone-font-scale,1))] transition-[border-color,box-shadow,background-color] focus-visible:border-muted-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground/15 focus-visible:ring-offset-0";

function ttlLabelKey(value: TunnelTtlSeconds) {
  if (value === 900) return "projectTools.tunnelTtl15m";
  if (value === 3600) return "projectTools.tunnelTtl1h";
  if (value === 14400) return "projectTools.tunnelTtl4h";
  return "projectTools.tunnelTtlInfinite";
}

function TtlSegmented({
  value,
  onChange,
  disabled,
}: {
  value: TunnelTtlSeconds | null;
  onChange: (value: TunnelTtlSeconds) => void;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div className="grid min-w-0 grid-cols-4 gap-0.5 rounded-lg bg-muted/70 p-0.5">
      {TUNNEL_TTL_OPTIONS.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            disabled={disabled}
            className={cn(
              "h-7 min-w-0 truncate rounded-[7px] px-1 text-xs text-muted-foreground transition-all duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              active && "bg-background font-medium text-foreground shadow-sm",
            )}
          >
            {t(ttlLabelKey(option))}
          </button>
        );
      })}
    </div>
  );
}

function healthStatusLabelKey(status: HealthDisplayStatus) {
  if (status === "ok") return "projectTools.tunnelHealthOk";
  if (status === "failed") return "projectTools.tunnelHealthFailed";
  return "projectTools.tunnelHealthUnknown";
}

function HealthBadge({
  label,
  status,
  title,
}: {
  label: string;
  status: HealthDisplayStatus;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium",
        status === "ok"
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : status === "failed"
            ? "border-destructive/20 bg-destructive/10 text-destructive"
            : "border-border/60 bg-muted/50 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          status === "ok"
            ? "bg-emerald-500"
            : status === "failed"
              ? "bg-destructive"
              : "bg-muted-foreground/45",
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatRemaining(seconds: number) {
  if (seconds <= 0) return "0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  if (minutes >= 60) return `${hours + 1}h`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatDateTime(seconds: number) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString();
}

function writeTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackWriteTextToClipboard(text),
    );
  }
  return Promise.resolve(fallbackWriteTextToClipboard(text));
}

function fallbackWriteTextToClipboard(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function displayTunnelName(tunnel: TunnelStatus) {
  return tunnel.name.trim() || tunnel.targetUrl;
}

function normalizeProjectPathKey(value: string | undefined) {
  return workspaceProjectPathKey(value ?? "");
}

function projectNameFromPathKey(pathKey: string) {
  const segments = pathKey.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function pruneByIds<T>(
  current: Record<string, T>,
  liveIds: ReadonlySet<string>,
): Record<string, T> {
  const next = Object.fromEntries(
    Object.entries(current).filter(([id]) => liveIds.has(id)),
  ) as Record<string, T>;
  return Object.keys(next).length === Object.keys(current).length ? current : next;
}

// Leaf that owns the 1s countdown tick so only the remaining-time text
// re-renders while the clock runs; it is only mounted for finite-TTL rows and
// pauses whenever the panel is not the active tab.
const TunnelRemainingTime = memo(function TunnelRemainingTime({
  active,
  expiresAt,
}: {
  active: boolean;
  expiresAt: number;
}) {
  const { t } = useLocale();
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    setNowSeconds(Math.floor(Date.now() / 1000));
    const timer = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const remaining = expiresAt - nowSeconds;
  if (remaining <= 0) {
    return <>{t("projectTools.tunnelExpired")}</>;
  }
  return <>{t("projectTools.tunnelExpiresIn").replace("{time}", formatRemaining(remaining))}</>;
});

type TunnelRowProps = {
  active: boolean;
  tunnel: TunnelStatus;
  scope: TunnelScope;
  offline: boolean;
  isEditing: boolean;
  editTargetUrl: string;
  editName: string;
  editTtlSeconds: EditTtlValue;
  editTargetValidationKey: string | null;
  pendingAction?: TunnelRowAction;
  rowError?: string;
  copied: boolean;
  enabled: boolean;
  mutationsEnabled: boolean;
  disabledMessage?: string;
  publicUrl: string;
  healthTitle: (health: TunnelHealth | null) => string;
  onEditTargetUrlChange: (value: string) => void;
  onEditNameChange: (value: string) => void;
  onEditTtlSecondsChange: (value: EditTtlValue) => void;
  onUpdate: (tunnel: TunnelStatus) => void;
  onCancelEdit: () => void;
  onBeginEdit: (tunnel: TunnelStatus) => void;
  onCopyLink: (tunnel: TunnelStatus) => void;
  onOpenLink: (tunnel: TunnelStatus) => void;
  onCheck: (id: string) => void;
  onClose: (id: string) => void;
};

const TunnelRow = memo(function TunnelRow(props: TunnelRowProps) {
  const {
    active,
    tunnel,
    scope,
    offline,
    isEditing,
    editTargetUrl,
    editName,
    editTtlSeconds,
    editTargetValidationKey,
    pendingAction,
    rowError,
    copied,
    enabled,
    mutationsEnabled,
    disabledMessage,
    publicUrl,
    healthTitle,
    onEditTargetUrlChange,
    onEditNameChange,
    onEditTtlSecondsChange,
    onUpdate,
    onCancelEdit,
    onBeginEdit,
    onCopyLink,
    onOpenLink,
    onCheck,
    onClose,
  } = props;
  const { t } = useLocale();
  const hasExpiry = tunnel.expiresAt > 0;
  // The 1s tick lives in TunnelRemainingTime; the row only needs a render-time
  // notion of "expired" (snapshot broadcasts re-render rows soon after expiry).
  const expired = hasExpiry && tunnel.expiresAt <= Math.floor(Date.now() / 1000);
  const updating = pendingAction === "save";
  const localHealth = tunnel.local;
  const localStatus: HealthDisplayStatus = localHealth?.status ?? "unknown";
  const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
  const handleEditKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onUpdate(tunnel);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancelEdit();
    }
  };
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background/70 shadow-[0_1px_2px_hsl(0_0%_0%_/_0.04)] backdrop-blur-xl transition-shadow duration-200 hover:shadow-[0_3px_10px_hsl(0_0%_0%_/_0.07)]">
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {displayTunnelName(tunnel)}
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium",
            offline
              ? "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : expired
                ? "border-border/60 bg-muted/70 text-muted-foreground"
                : "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              offline
                ? "bg-amber-500"
                : expired
                  ? "bg-muted-foreground/50"
                  : "animate-pulse bg-emerald-500 motion-reduce:animate-none",
            )}
          />
          {t(
            offline
              ? "projectTools.tunnelStatusOffline"
              : expired
                ? "projectTools.tunnelStatusExpired"
                : "projectTools.tunnelStatusActive",
          )}
        </span>
      </div>

      {isEditing ? (
        <>
          <div className="grid min-w-0 gap-2.5 px-3 pb-1 pt-2">
            <div className="grid gap-1.5">
              <Label
                htmlFor={`tunnel-edit-target-${tunnel.id}`}
                className="text-xs text-muted-foreground"
              >
                {t("projectTools.tunnelTargetUrl")}
              </Label>
              <Input
                id={`tunnel-edit-target-${tunnel.id}`}
                value={editTargetUrl}
                onChange={(event) => onEditTargetUrlChange(event.target.value)}
                onKeyDown={handleEditKeyDown}
                disabled={!mutationsEnabled || updating}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                className={cn(TUNNEL_INPUT_CLASS, "font-mono")}
              />
              {editTargetValidationKey ? (
                <div className="flex items-start gap-1 text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="min-w-0">{t(editTargetValidationKey)}</span>
                </div>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label
                htmlFor={`tunnel-edit-name-${tunnel.id}`}
                className="text-xs text-muted-foreground"
              >
                {t("projectTools.tunnelName")}
              </Label>
              <Input
                id={`tunnel-edit-name-${tunnel.id}`}
                value={editName}
                onChange={(event) => onEditNameChange(event.target.value)}
                onKeyDown={handleEditKeyDown}
                placeholder={t("projectTools.tunnelNamePlaceholder")}
                disabled={!mutationsEnabled || updating}
                autoComplete="off"
                className={TUNNEL_INPUT_CLASS}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("projectTools.tunnelTtl")}</Label>
              <button
                type="button"
                aria-pressed={editTtlSeconds === "keep"}
                onClick={() => onEditTtlSecondsChange("keep")}
                disabled={!mutationsEnabled || updating}
                className={cn(
                  "flex h-7 min-w-0 items-center justify-center truncate rounded-lg bg-muted/70 px-2 text-xs text-muted-foreground transition-all duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                  editTtlSeconds === "keep" &&
                    "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/60",
                )}
              >
                {t("projectTools.tunnelKeepCurrentTtl")}
              </button>
              <TtlSegmented
                value={editTtlSeconds === "keep" ? null : editTtlSeconds}
                onChange={onEditTtlSecondsChange}
                disabled={!mutationsEnabled || updating}
              />
            </div>
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-1.5 border-t border-border/40 px-3 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-lg px-2.5 text-xs text-muted-foreground hover:text-foreground"
              disabled={updating}
              onClick={onCancelEdit}
              title={t("projectTools.tunnelCancelEdit")}
            >
              <X className="h-3.5 w-3.5" />
              {t("settings.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1 rounded-lg px-2.5 text-xs"
              disabled={!mutationsEnabled || updating || Boolean(editTargetValidationKey)}
              onClick={() => onUpdate(tunnel)}
              title={updating ? t("projectTools.tunnelUpdating") : t("projectTools.tunnelSave")}
            >
              {updating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {t("settings.save")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onCopyLink(tunnel)}
            disabled={!publicUrl}
            title={copied ? t("projectTools.tunnelCopied") : t("projectTools.tunnelCopyLink")}
            aria-label={copied ? t("projectTools.tunnelCopied") : t("projectTools.tunnelCopyLink")}
            className="mx-3 mt-2 flex w-[calc(100%-1.5rem)] min-w-0 items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2 py-1.5 text-left transition-colors duration-150 hover:border-border hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] text-foreground/85">
              {publicUrl}
            </span>
            {copied ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            )}
          </button>
          <div
            className="mt-1.5 flex min-w-0 items-center gap-1 px-3 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground"
            title={tunnel.targetUrl}
          >
            <Link2 className="h-3 w-3 shrink-0" />
            <span className="shrink-0">{t("projectTools.tunnelTarget")}</span>
            <span className="min-w-0 truncate font-mono">{tunnel.targetUrl}</span>
          </div>
          <div className="mx-3 mt-2 flex min-w-0 items-center gap-1">
            <div
              title={`${t("projectTools.tunnelServiceLabel")} · ${healthTitle(localHealth)}`}
              className={cn(
                "flex h-6 min-w-0 items-center gap-1 rounded-md border px-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-medium",
                localStatus === "ok"
                  ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : localStatus === "failed"
                    ? "border-destructive/20 bg-destructive/10 text-destructive"
                    : "border-border/60 bg-muted/50 text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  localStatus === "ok"
                    ? "bg-emerald-500"
                    : localStatus === "failed"
                      ? "bg-destructive"
                      : "bg-muted-foreground/45",
                )}
              />
              <span className="truncate">{t("projectTools.tunnelServiceLabel")}</span>
              {localStatus === "ok" && localHealth && localHealth.httpStatus > 0 ? (
                <span className="shrink-0 tabular-nums">HTTP {localHealth.httpStatus}</span>
              ) : (
                <span className="truncate">{t(healthStatusLabelKey(localStatus))}</span>
              )}
            </div>
          </div>
          {rowError ? (
            <div className="mx-3 mt-2 rounded-lg border border-destructive/25 bg-destructive/10 px-2 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-destructive">
              {rowError}
            </div>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/40 py-1 pl-3 pr-1.5">
            <div className="flex min-w-0 items-center gap-2 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
              <span
                className="inline-flex min-w-0 items-center gap-1"
                title={hasExpiry ? formatDateTime(tunnel.expiresAt) : undefined}
              >
                <Clock3 className="h-3 w-3 shrink-0" />
                <span className="min-w-0 truncate tabular-nums">
                  {!hasExpiry ? (
                    t("projectTools.tunnelTtlInfinite")
                  ) : (
                    <TunnelRemainingTime active={active} expiresAt={tunnel.expiresAt} />
                  )}
                </span>
              </span>
              {scope === "global" ? (
                tunnelProjectPathKey ? (
                  <span
                    title={tunnelProjectPathKey}
                    className="min-w-0 max-w-[120px] truncate rounded-full bg-muted/80 px-1.5 py-px text-[calc(10px*var(--zone-font-scale,1))]"
                  >
                    {projectNameFromPathKey(tunnelProjectPathKey) ||
                      t("projectTools.tunnelScopeProjectBadge")}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-muted/80 px-1.5 py-px text-[calc(10px*var(--zone-font-scale,1))]">
                    {t("projectTools.tunnelScopeGlobalBadge")}
                  </span>
                )
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                disabled={!mutationsEnabled || expired || Boolean(pendingAction)}
                onClick={() => onCheck(tunnel.id)}
                title={!enabled ? disabledMessage : t("projectTools.tunnelCheckAction")}
                aria-label={t("projectTools.tunnelCheckAction")}
              >
                {pendingAction === "check" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                disabled={!mutationsEnabled || expired}
                onClick={() => onBeginEdit(tunnel)}
                title={!enabled ? disabledMessage : t("projectTools.tunnelEdit")}
                aria-label={t("projectTools.tunnelEdit")}
              >
                <Edit3 className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
                disabled={!publicUrl || expired}
                onClick={() => onOpenLink(tunnel)}
                title={t("projectTools.tunnelOpenLink")}
                aria-label={t("projectTools.tunnelOpenLink")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={!mutationsEnabled || Boolean(pendingAction)}
                onClick={() => onClose(tunnel.id)}
                title={!enabled ? disabledMessage : t("projectTools.tunnelClose")}
                aria-label={t("projectTools.tunnelClose")}
              >
                {pendingAction === "close" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
});

export function LocalTunnelPanel({
  active = false,
  client,
  enabled,
  disabledMessage,
  projectPathKey,
  publicBaseUrl,
  onOpenExternal,
}: LocalTunnelPanelProps) {
  const { t } = useLocale();
  const normalizedProjectPathKey = useMemo(
    () => normalizeProjectPathKey(projectPathKey),
    [projectPathKey],
  );
  const [scope, setScope] = useState<TunnelScope>(() =>
    normalizeProjectPathKey(projectPathKey) ? "project" : "global",
  );
  const [targetUrl, setTargetUrl] = useState("http://localhost:3000");
  const [name, setName] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState<TunnelTtlSeconds>(3600);
  const [createOpen, setCreateOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Errors scoped to the tunnel list ("check all" failures, an edited tunnel
  // vanishing) render near the list instead of polluting the create banner.
  const [listError, setListError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState("");
  const [editTargetUrl, setEditTargetUrl] = useState("");
  const [editName, setEditName] = useState("");
  const [editTtlSeconds, setEditTtlSeconds] = useState<EditTtlValue>("keep");
  const [snapshot, setSnapshot] = useState<TunnelStateSnapshot | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, TunnelRowAction>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const targetValidationKey = useMemo(() => validateLocalHttpTarget(targetUrl), [targetUrl]);
  const editTargetValidationKey = useMemo(
    () => (editingId ? validateLocalHttpTarget(editTargetUrl) : null),
    [editTargetUrl, editingId],
  );

  useEffect(() => {
    // A replaced client (e.g. a new gateway session) must not keep showing the
    // previous client's snapshot; clear before the new subscription seeds one.
    setSnapshot(null);
    if (!client) return;
    return client.subscribeTunnelState((next) => {
      setSnapshot((current) => (current && next.revision <= current.revision ? current : next));
    });
  }, [client]);

  useEffect(() => {
    if (!normalizedProjectPathKey && scope === "project") {
      setScope("global");
      setCreateError(null);
    }
  }, [normalizedProjectPathKey, scope]);

  const tunnels = useMemo(() => snapshot?.tunnels ?? [], [snapshot]);

  const cancelEdit = useCallback(() => {
    setEditingId("");
    setEditTargetUrl("");
    setEditName("");
    setEditTtlSeconds("keep");
  }, []);

  useEffect(() => {
    // Snapshot updates can remove tunnels that still have row-scoped UI state;
    // drop the orphans so stale spinners/errors don't reattach to reused ids.
    if (!snapshot) return;
    const liveIds = new Set(tunnels.map((tunnel) => tunnel.id));
    setPendingActions((current) => pruneByIds(current, liveIds));
    setRowErrors((current) => pruneByIds(current, liveIds));
  }, [snapshot, tunnels]);

  useEffect(() => {
    if (!snapshot || !editingId) return;
    if (tunnels.some((tunnel) => tunnel.id === editingId)) return;
    cancelEdit();
    setListError(t("projectTools.tunnelEditingClosed"));
  }, [cancelEdit, editingId, snapshot, t, tunnels]);

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(""), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const gatewayUnsupported = snapshot?.gatewayUnsupported === true;
  const mutationsEnabled = enabled && !gatewayUnsupported && Boolean(client);

  const beginRowAction = useCallback((id: string, action: TunnelRowAction) => {
    setPendingActions((current) => ({ ...current, [id]: action }));
    setRowErrors((current) => {
      if (!(id in current)) return current;
      const { [id]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const endRowAction = useCallback((id: string) => {
    setPendingActions((current) => {
      if (!(id in current)) return current;
      const { [id]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const setRowError = useCallback((id: string, message: string) => {
    setRowErrors((current) => ({ ...current, [id]: message }));
  }, []);

  const createTunnel = useCallback(() => {
    const validationKey = validateLocalHttpTarget(targetUrl);
    if (validationKey) {
      setCreateError(t(validationKey));
      return;
    }
    if (!client || !mutationsEnabled || creating) return;
    const input: TunnelCreateInput = {
      targetUrl: targetUrl.trim(),
      name: name.trim() || undefined,
      ttlSeconds,
    };
    if (scope === "project" && normalizedProjectPathKey) {
      input.projectPathKey = normalizedProjectPathKey;
    }
    setCreating(true);
    setCreateError(null);
    void client
      .createTunnel(input)
      .then(() => setName(""))
      .catch((err) => setCreateError(asErrorMessage(err)))
      .finally(() => setCreating(false));
  }, [
    client,
    creating,
    mutationsEnabled,
    name,
    normalizedProjectPathKey,
    scope,
    t,
    targetUrl,
    ttlSeconds,
  ]);

  const beginEdit = useCallback((tunnel: TunnelStatus) => {
    setEditingId(tunnel.id);
    setEditTargetUrl(tunnel.targetUrl);
    setEditName(tunnel.name);
    setEditTtlSeconds("keep");
    setRowErrors((current) => {
      if (!(tunnel.id in current)) return current;
      const { [tunnel.id]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const updateTunnel = useCallback(
    (tunnel: TunnelStatus) => {
      const validationKey = validateLocalHttpTarget(editTargetUrl);
      if (validationKey) {
        setRowError(tunnel.id, t(validationKey));
        return;
      }
      if (!client || !mutationsEnabled || pendingActions[tunnel.id]) return;
      const input: TunnelUpdateInput = {
        id: tunnel.id,
        targetUrl: editTargetUrl.trim(),
        name: editName.trim() || undefined,
      };
      // Only re-bucket the expiry when the user explicitly picked a TTL.
      if (editTtlSeconds !== "keep") {
        input.ttlSeconds = editTtlSeconds;
      }
      const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
      if (tunnelProjectPathKey) {
        input.projectPathKey = tunnelProjectPathKey;
      }
      beginRowAction(tunnel.id, "save");
      void client
        .updateTunnel(input)
        .then(() => cancelEdit())
        .catch((err) => setRowError(tunnel.id, asErrorMessage(err)))
        .finally(() => endRowAction(tunnel.id));
    },
    [
      beginRowAction,
      cancelEdit,
      client,
      editName,
      editTargetUrl,
      editTtlSeconds,
      endRowAction,
      mutationsEnabled,
      pendingActions,
      setRowError,
      t,
    ],
  );

  const closeTunnel = useCallback(
    (id: string) => {
      if (!client || !mutationsEnabled || pendingActions[id]) return;
      beginRowAction(id, "close");
      void client
        .closeTunnel(id)
        .catch((err) => setRowError(id, asErrorMessage(err)))
        .finally(() => endRowAction(id));
    },
    [beginRowAction, client, endRowAction, mutationsEnabled, pendingActions, setRowError],
  );

  const checkTunnel = useCallback(
    (id: string) => {
      if (!client || !mutationsEnabled || pendingActions[id]) return;
      beginRowAction(id, "check");
      void client
        .checkTunnel(id)
        .catch((err) => setRowError(id, asErrorMessage(err)))
        .finally(() => endRowAction(id));
    },
    [beginRowAction, client, endRowAction, mutationsEnabled, pendingActions, setRowError],
  );

  const checkAllTunnels = useCallback(() => {
    if (!client || !mutationsEnabled || checkingAll) return;
    setCheckingAll(true);
    setListError(null);
    void client
      .checkTunnel()
      .catch((err) => setListError(asErrorMessage(err)))
      .finally(() => setCheckingAll(false));
  }, [checkingAll, client, mutationsEnabled]);

  const publicUrlFor = useCallback(
    (tunnel: TunnelStatus) => composePublicUrl(publicBaseUrl, tunnel.publicPath),
    [publicBaseUrl],
  );

  const copyLink = useCallback(
    (tunnel: TunnelStatus) => {
      const url = publicUrlFor(tunnel);
      if (!url) return;
      void writeTextToClipboard(url)
        .then((copied) => {
          if (copied) {
            setCopiedId(tunnel.id);
          }
        })
        .catch(() => {});
    },
    [publicUrlFor],
  );

  const openLink = useCallback(
    (tunnel: TunnelStatus) => {
      const url = publicUrlFor(tunnel);
      if (!url) return;
      if (onOpenExternal) {
        onOpenExternal(url);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [onOpenExternal, publicUrlFor],
  );

  const healthTitle = useCallback(
    (health: TunnelHealth | null) => {
      if (!health) return t("projectTools.tunnelHealthUnknown");
      return [
        t(healthStatusLabelKey(health.status)),
        health.httpStatus > 0 ? `HTTP ${health.httpStatus}` : "",
        health.rttMs > 0 ? `${health.rttMs}ms` : "",
        health.error,
        health.checkedAt > 0 ? formatDateTime(health.checkedAt) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    },
    [t],
  );

  const scopedTunnels = useMemo(
    () =>
      tunnels.filter((tunnel) => {
        const tunnelProjectPathKey = normalizeProjectPathKey(tunnel.projectPathKey);
        if (scope === "project") {
          return (
            Boolean(normalizedProjectPathKey) && tunnelProjectPathKey === normalizedProjectPathKey
          );
        }
        return true;
      }),
    [normalizedProjectPathKey, scope, tunnels],
  );
  const sortedTunnels = useMemo(
    () => [...scopedTunnels].sort((a, b) => b.createdAt - a.createdAt),
    [scopedTunnels],
  );
  const loading = Boolean(client) && snapshot === null;
  const agentOnline = snapshot?.agentOnline === true;
  const offline = snapshot !== null && !agentOnline;
  const linkStatus: HealthDisplayStatus = snapshot ? (agentOnline ? "ok" : "failed") : "unknown";
  const relayStatus: HealthDisplayStatus = snapshot?.relay?.status ?? "unknown";
  const canCreate =
    mutationsEnabled &&
    !creating &&
    !targetValidationKey &&
    (scope !== "project" || Boolean(normalizedProjectPathKey));
  const showCreateForm = scope === "project" && Boolean(normalizedProjectPathKey);
  const createFieldsDisabled = !showCreateForm || !createOpen || !mutationsEnabled || creating;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gradient-to-b from-muted/40 via-muted/15 to-background">
      <div className="shrink-0 border-b border-border/60 bg-background/70 px-4 pb-3 pt-3.5 backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/80 text-foreground/70 shadow-[inset_0_1px_0_hsl(0_0%_100%_/_0.6),0_1px_2px_hsl(0_0%_0%_/_0.05)] dark:shadow-none">
            <Globe className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold tracking-tight text-foreground">
              {t("projectTools.tunnelTitle")}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {t("projectTools.tunnelDescription")}
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex min-w-0 items-center gap-1.5">
          <HealthBadge
            label={t("projectTools.tunnelLinkLabel")}
            status={linkStatus}
            title={`${t("projectTools.tunnelLinkLabel")} · ${t(healthStatusLabelKey(linkStatus))}`}
          />
          <HealthBadge
            label={t("projectTools.tunnelRelayLabel")}
            status={relayStatus}
            title={`${t("projectTools.tunnelRelayLabel")} · ${healthTitle(snapshot?.relay ?? null)}`}
          />
          <span className="min-w-0 flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 rounded-lg px-2 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground hover:text-foreground"
            disabled={!mutationsEnabled || checkingAll}
            onClick={checkAllTunnels}
            title={!enabled ? disabledMessage : t("projectTools.tunnelCheckAction")}
          >
            {checkingAll ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {t("projectTools.tunnelCheckAction")}
          </Button>
        </div>
        <div
          role="group"
          aria-label={t("projectTools.tunnelScopeGroup")}
          className="relative mt-3 grid grid-cols-2 gap-0.5 rounded-lg bg-muted/70 p-0.5"
        >
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 z-0 w-1/2 transform-gpu rounded-[7px] bg-background shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none",
              scope === "global" ? "translate-x-full" : "translate-x-0",
            )}
          />
          {TUNNEL_SCOPE_OPTIONS.map((option) => {
            const active = scope === option.scope;
            const disabled = option.scope === "project" && !normalizedProjectPathKey;
            const Icon = option.scope === "project" ? Folder : Globe;
            return (
              <button
                key={option.scope}
                type="button"
                aria-pressed={active}
                title={t(option.titleKey)}
                disabled={disabled}
                onClick={() => {
                  setScope(option.scope);
                  setCreateError(null);
                }}
                className={cn(
                  "relative z-10 flex h-7 min-w-0 transform-gpu items-center justify-center gap-1.5 rounded-[7px] px-2 text-xs text-muted-foreground transition-[color,transform] duration-200 ease-out hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100",
                  active && "font-medium text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{t(option.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {disabledMessage ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{disabledMessage}</span>
          </div>
        ) : null}

        {gatewayUnsupported ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{t("projectTools.tunnelGatewayUnsupported")}</span>
          </div>
        ) : null}

        {normalizedProjectPathKey ? (
          <div
            className={cn(
              "grid transform-gpu transition-[grid-template-rows,opacity,transform,margin] duration-200 ease-out motion-reduce:transition-none",
              showCreateForm
                ? "mb-3 grid-rows-[1fr] translate-y-0 opacity-100"
                : "mb-0 grid-rows-[0fr] -translate-y-1 opacity-0",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <section
                aria-hidden={!showCreateForm}
                className={cn(
                  "overflow-hidden rounded-xl border border-border/60 bg-background/70 shadow-[0_1px_2px_hsl(0_0%_0%_/_0.04)] backdrop-blur-xl transition-[border-color,background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
                  !showCreateForm && "pointer-events-none",
                )}
              >
                <button
                  type="button"
                  onClick={() => setCreateOpen((open) => !open)}
                  aria-controls="local-tunnel-create-form"
                  aria-expanded={showCreateForm && createOpen}
                  disabled={!showCreateForm}
                  className="flex h-10 w-full items-center gap-2 px-3 text-left transition-colors duration-150 ease-out hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none motion-reduce:transition-none"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted/80 text-muted-foreground">
                    <Plus className="h-3 w-3" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                    {t("projectTools.tunnelCreateSection")}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
                      showCreateForm && createOpen && "rotate-180",
                    )}
                  />
                </button>
                <div
                  className={cn(
                    "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                    showCreateForm && createOpen
                      ? "grid-rows-[1fr] opacity-100"
                      : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    <form
                      id="local-tunnel-create-form"
                      className={cn(
                        "grid min-w-0 gap-3 border-t border-border/50 px-3 pb-3 pt-3 transition-transform duration-200 ease-out motion-reduce:transition-none",
                        showCreateForm && createOpen ? "translate-y-0" : "-translate-y-1",
                      )}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!showCreateForm || !createOpen) return;
                        createTunnel();
                      }}
                    >
                      <div className="grid gap-1.5">
                        <Label
                          htmlFor="local-tunnel-target"
                          className="text-xs text-muted-foreground"
                        >
                          {t("projectTools.tunnelTargetUrl")}
                        </Label>
                        <Input
                          id="local-tunnel-target"
                          value={targetUrl}
                          onChange={(event) => setTargetUrl(event.target.value)}
                          placeholder={t("projectTools.tunnelTargetPlaceholder")}
                          disabled={createFieldsDisabled}
                          inputMode="url"
                          autoComplete="off"
                          spellCheck={false}
                          className={cn(TUNNEL_INPUT_CLASS, "font-mono")}
                        />
                        {targetValidationKey ? (
                          <div className="flex items-start gap-1 text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span className="min-w-0">{t(targetValidationKey)}</span>
                          </div>
                        ) : null}
                      </div>
                      <div className="grid gap-1.5">
                        <Label
                          htmlFor="local-tunnel-name"
                          className="text-xs text-muted-foreground"
                        >
                          {t("projectTools.tunnelName")}
                        </Label>
                        <Input
                          id="local-tunnel-name"
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          placeholder={t("projectTools.tunnelNamePlaceholder")}
                          disabled={createFieldsDisabled}
                          autoComplete="off"
                          className={TUNNEL_INPUT_CLASS}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label className="text-xs text-muted-foreground">
                          {t("projectTools.tunnelTtl")}
                        </Label>
                        <TtlSegmented
                          value={ttlSeconds}
                          onChange={setTtlSeconds}
                          disabled={createFieldsDisabled}
                        />
                      </div>
                      <Button
                        type="submit"
                        size="sm"
                        className="h-8 gap-1.5 rounded-lg text-xs"
                        disabled={!showCreateForm || !createOpen || !canCreate}
                        title={!enabled ? disabledMessage : undefined}
                      >
                        {creating ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        {creating
                          ? t("projectTools.tunnelCreating")
                          : t("projectTools.tunnelCreate")}
                      </Button>
                    </form>
                  </div>
                </div>
              </section>
            </div>
          </div>
        ) : null}

        {createError ? (
          <div className="mb-3 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
            {createError}
          </div>
        ) : null}

        <div>
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-[calc(11px*var(--zone-font-scale,1))] font-medium uppercase tracking-wider text-muted-foreground">
              {t("projectTools.tunnelListSection")}
            </span>
            {sortedTunnels.length > 0 ? (
              <span className="rounded-full bg-muted/80 px-1.5 py-px text-[calc(11px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground">
                {sortedTunnels.length}
              </span>
            ) : null}
          </div>
          {listError ? (
            <div className="mb-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {listError}
            </div>
          ) : null}
          {loading && sortedTunnels.length === 0 ? (
            <div className="grid gap-2">
              <span className="sr-only">{t("projectTools.tunnelLoading")}</span>
              <div className="hub-frost-skeleton h-24" aria-hidden />
              <div className="hub-frost-skeleton h-24 opacity-70" aria-hidden />
            </div>
          ) : sortedTunnels.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-background/40 px-4 py-10 text-center">
              <div className="mb-1.5 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/50 bg-background/80 text-muted-foreground/70 shadow-[inset_0_1px_0_hsl(0_0%_100%_/_0.6),0_1px_3px_hsl(0_0%_0%_/_0.05)] dark:shadow-none">
                <Globe className="h-5 w-5" />
              </div>
              <div className="text-xs font-medium text-foreground/80">
                {t("projectTools.tunnelEmpty")}
              </div>
              {showCreateForm ? (
                <div className="text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                  {t("projectTools.tunnelEmptyHintCreate")}
                </div>
              ) : normalizedProjectPathKey ? (
                <div className="text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                  {t("projectTools.tunnelEmptyHintProject")}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-2">
              {sortedTunnels.map((tunnel) => {
                const isEditing = editingId === tunnel.id;
                return (
                  <TunnelRow
                    key={tunnel.id}
                    active={active}
                    tunnel={tunnel}
                    scope={scope}
                    offline={offline}
                    isEditing={isEditing}
                    editTargetUrl={isEditing ? editTargetUrl : ""}
                    editName={isEditing ? editName : ""}
                    editTtlSeconds={isEditing ? editTtlSeconds : "keep"}
                    editTargetValidationKey={isEditing ? editTargetValidationKey : null}
                    pendingAction={pendingActions[tunnel.id]}
                    rowError={rowErrors[tunnel.id]}
                    copied={copiedId === tunnel.id}
                    enabled={enabled}
                    mutationsEnabled={mutationsEnabled}
                    disabledMessage={disabledMessage}
                    publicUrl={publicUrlFor(tunnel)}
                    healthTitle={healthTitle}
                    onEditTargetUrlChange={setEditTargetUrl}
                    onEditNameChange={setEditName}
                    onEditTtlSecondsChange={setEditTtlSeconds}
                    onUpdate={updateTunnel}
                    onCancelEdit={cancelEdit}
                    onBeginEdit={beginEdit}
                    onCopyLink={copyLink}
                    onOpenLink={openLink}
                    onCheck={checkTunnel}
                    onClose={closeTunnel}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
