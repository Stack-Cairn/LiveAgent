import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  AlertTriangle,
  Check,
  Copy,
  Key,
  Loader2,
  MonitorSmartphone,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useLocale } from "../../i18n";
import {
  type AdminAgentEntry,
  type AdminAgentStatus,
  type AdminAgentsPage,
  deleteAdminAgent,
  isGeneratedAgentID,
  issueAdminToken,
  listAdminAgents,
  updateAdminAgentName,
} from "../../lib/adminApi";
import { normalizeGatewayAccessToken } from "../../lib/gatewayAuth";
import { loadToken, saveToken } from "../../lib/storage";
import { ConfirmActionPopover } from "./shared";

const PAGE_SIZE = 50;
const MAX_AGENT_NAME_LENGTH = 64;
const STATUS_FILTERS = [
  { value: "all", labelKey: "settings.devicesFilterAll" },
  { value: "online", labelKey: "settings.devicesFilterOnline" },
  { value: "offline", labelKey: "settings.devicesFilterOffline" },
] as const satisfies ReadonlyArray<{ value: AdminAgentStatus; labelKey: string }>;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function formatCreatedAt(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function DevicesSection({
  onDirectoryChanged,
}: {
  onDirectoryChanged?: () => void | Promise<void>;
}) {
  const { t } = useLocale();
  const [token, setToken] = useState(() => loadToken());
  const [tokenInput, setTokenInput] = useState(() => loadToken());
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState<AdminAgentsPage | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<AdminAgentStatus>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [deletingAgentId, setDeletingAgentId] = useState("");
  const [rotatingAgentId, setRotatingAgentId] = useState("");
  const [updatingNameAgentId, setUpdatingNameAgentId] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [newName, setNewName] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ agentId: string; token: string } | null>(null);

  const load = useCallback(
    async (
      targetPage: number,
      accessToken = token,
      targetStatus: AdminAgentStatus = statusFilter,
    ) => {
      const normalizedToken = normalizeGatewayAccessToken(accessToken);
      if (!normalizedToken) {
        setAuthed(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        let result = await listAdminAgents(normalizedToken, targetPage, PAGE_SIZE, targetStatus);
        if (result.total > 0 && result.agents.length === 0 && result.page > 1) {
          const lastPage = Math.max(1, Math.ceil(result.total / result.page_size));
          result = await listAdminAgents(normalizedToken, lastPage, PAGE_SIZE, targetStatus);
        }
        setData(result);
        setPage(result.page);
        setAuthed(true);
      } catch (loadError) {
        setError(errorMessage(loadError, t("settings.devicesLoadFailed")));
      } finally {
        setLoading(false);
      }
    },
    [statusFilter, t, token],
  );

  useEffect(() => {
    if (token) void load(1, token);
  }, [load, token]);

  async function handleLogin() {
    const normalized = normalizeGatewayAccessToken(tokenInput);
    if (!normalized) {
      setError(t("settings.devicesTokenRequired"));
      return;
    }
    saveToken(normalized);
    if (normalized === token) {
      await load(1, normalized);
    } else {
      setToken(normalized);
    }
  }

  async function handleIssue() {
    const agentId = newAgentId.trim();
    if (!agentId) {
      setError(t("settings.devicesAgentRequired"));
      return;
    }
    if (!isGeneratedAgentID(agentId)) {
      setError(t("settings.devicesAgentInvalid"));
      return;
    }
    setIssuing(true);
    setError(null);
    try {
      const plaintext = await issueAdminToken(token, agentId, newName);
      setIssuedToken({ agentId, token: plaintext });
      setNewAgentId("");
      setNewName("");
      setAddDialogOpen(false);
      await load(page);
      await onDirectoryChanged?.();
    } catch (issueError) {
      setError(errorMessage(issueError, t("settings.devicesIssueFailed")));
    } finally {
      setIssuing(false);
    }
  }

  function openAddDialog() {
    setError(null);
    setNewAgentId("");
    setNewName("");
    setAddDialogOpen(true);
  }

  function closeAddDialog() {
    setAddDialogOpen(false);
    setError(null);
  }

  async function handleRotate(agent: AdminAgentEntry) {
    setRotatingAgentId(agent.agent_id);
    setError(null);
    try {
      const plaintext = await issueAdminToken(token, agent.agent_id, agent.name);
      setIssuedToken({ agentId: agent.agent_id, token: plaintext });
      await load(page);
      await onDirectoryChanged?.();
    } catch (rotateError) {
      setError(errorMessage(rotateError, t("settings.devicesIssueFailed")));
    } finally {
      setRotatingAgentId("");
    }
  }

  async function handleUpdateName(agentId: string, name: string) {
    setUpdatingNameAgentId(agentId);
    setError(null);
    try {
      await updateAdminAgentName(token, agentId, name);
      await load(page);
      await onDirectoryChanged?.();
    } catch (updateError) {
      setError(errorMessage(updateError, t("settings.devicesNameUpdateFailed")));
      throw updateError;
    } finally {
      setUpdatingNameAgentId("");
    }
  }

  async function handleDelete(agentId: string) {
    setDeletingAgentId(agentId);
    setError(null);
    try {
      await deleteAdminAgent(token, agentId);
      await load(page);
      await onDirectoryChanged?.();
    } catch (deleteError) {
      setError(errorMessage(deleteError, t("settings.devicesDeleteFailed")));
    } finally {
      setDeletingAgentId("");
    }
  }

  function handleStatusFilter(nextStatus: AdminAgentStatus) {
    if (nextStatus === statusFilter) return;
    setPage(1);
    setStatusFilter(nextStatus);
  }

  return (
    <div className="space-y-5">
      <div className="settings-section-heading-row flex items-center justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/10">
            <MonitorSmartphone className="h-[18px] w-[18px] text-sky-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.devicesTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.devicesDesc")}</p>
          </div>
        </div>
        {authed ? (
          <Button
            variant="outline"
            size="sm"
            className="settings-section-action gap-1.5"
            onClick={openAddDialog}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("settings.devicesAdd")}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {!authed ? (
        <div className="max-w-xl rounded-2xl border border-border/60 bg-card p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
              <Key className="h-4 w-4 text-amber-500" />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-medium">{t("settings.devicesLoginTitle")}</h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t("settings.devicesLoginDesc")}
              </p>
              <div className="mt-4 flex gap-2">
                <Input
                  type="password"
                  className="font-mono text-xs"
                  placeholder={t("settings.devicesGatewayToken")}
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleLogin();
                  }}
                />
                <Button disabled={loading} onClick={() => void handleLogin()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("settings.devicesLogin")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          {addDialogOpen ? (
            <AddClientDialog
              agentId={newAgentId}
              name={newName}
              error={error}
              loading={issuing}
              onAgentIdChange={setNewAgentId}
              onNameChange={setNewName}
              onSubmit={() => void handleIssue()}
              onClose={closeAddDialog}
            />
          ) : null}
          {issuedToken ? (
            <IssuedTokenDialog issuedToken={issuedToken} onClose={() => setIssuedToken(null)} />
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
              {STATUS_FILTERS.map(({ value, labelKey }) => (
                <button
                  key={value}
                  type="button"
                  disabled={loading}
                  onClick={() => handleStatusFilter(value)}
                  className={`inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md px-3 text-xs font-medium transition-all disabled:pointer-events-none disabled:opacity-50 ${
                    statusFilter === value
                      ? "bg-background text-foreground shadow"
                      : "hover:text-foreground/80"
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={loading}
              onClick={() => void load(page)}
            >
              <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {t("settings.devicesRefresh")}
            </Button>
          </div>

          <DeviceDirectory
            data={data}
            statusFilter={statusFilter}
            loading={loading}
            deletingAgentId={deletingAgentId}
            rotatingAgentId={rotatingAgentId}
            updatingNameAgentId={updatingNameAgentId}
            onDelete={handleDelete}
            onRotate={handleRotate}
            onUpdateName={handleUpdateName}
          />

          {data && data.total > 0 ? (
            <div className="flex items-center justify-end text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1 || loading}
                  onClick={() => void load(page - 1)}
                >
                  {t("settings.devicesPrevious")}
                </Button>
                <span>
                  {t("settings.devicesPage")} {page}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!data.has_more || loading}
                  onClick={() => void load(page + 1)}
                >
                  {t("settings.devicesNext")}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function AddClientDialog({
  agentId,
  name,
  error,
  loading,
  onAgentIdChange,
  onNameChange,
  onSubmit,
  onClose,
}: {
  agentId: string;
  name: string;
  error: string | null;
  loading: boolean;
  onAgentIdChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !loading) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loading, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.devicesAddTitle")}
    >
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-sm"
        onClick={() => {
          if (!loading) onClose();
        }}
        aria-hidden="true"
      />
      <form
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading) onSubmit();
        }}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400">
              <Plus className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold text-foreground">
                {t("settings.devicesAddTitle")}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("settings.devicesAddDesc")}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={loading}
            className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
            title={t("settings.close")}
            aria-label={t("settings.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {error ? (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="admin-agent-name-dialog" className="text-xs text-muted-foreground">
              {t("settings.devicesName")}
            </Label>
            <Input
              id="admin-agent-name-dialog"
              autoFocus
              placeholder={t("settings.devicesNamePlaceholder")}
              value={name}
              maxLength={MAX_AGENT_NAME_LENGTH}
              onChange={(event) => onNameChange(event.currentTarget.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-agent-id-dialog" className="text-xs text-muted-foreground">
              {t("settings.devicesAgentId")}
              <span className="ml-0.5 text-red-500">*</span>
            </Label>
            <Input
              id="admin-agent-id-dialog"
              className="font-mono"
              placeholder={t("settings.devicesAgentIdPlaceholder")}
              value={agentId}
              onChange={(event) => onAgentIdChange(event.currentTarget.value)}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
            {t("settings.close")}
          </Button>
          <Button type="submit" className="gap-1.5" disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Key className="h-3.5 w-3.5" />
            )}
            {t("settings.devicesIssueShort")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function IssuedTokenDialog({
  issuedToken,
  onClose,
}: {
  issuedToken: { agentId: string; token: string };
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleCopy() {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(issuedToken.token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.devicesIssuedTitle")}
    >
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Key className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold text-foreground">
                {t("settings.devicesIssuedTitle")}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {issuedToken.agentId}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
            title={t("settings.close")}
            aria-label={t("settings.close")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3 px-5 py-5">
          <p className="text-xs leading-5 text-muted-foreground">
            {t("settings.devicesTokenOnce")}
          </p>
          <div className="relative">
            <Input
              readOnly
              value={issuedToken.token}
              className="pr-11 font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              title={copied ? t("chat.markdown.copied") : t("chat.copy")}
              aria-label={copied ? t("chat.markdown.copied") : t("chat.copy")}
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        <div className="flex justify-end border-t border-border/60 bg-muted/20 px-5 py-4">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("settings.close")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DeviceDirectory(props: {
  data: AdminAgentsPage | null;
  statusFilter: AdminAgentStatus;
  loading: boolean;
  deletingAgentId: string;
  rotatingAgentId: string;
  updatingNameAgentId: string;
  onDelete: (agentId: string) => Promise<void>;
  onRotate: (agent: AdminAgentEntry) => Promise<void>;
  onUpdateName: (agentId: string, name: string) => Promise<void>;
}) {
  const {
    data,
    statusFilter,
    loading,
    deletingAgentId,
    rotatingAgentId,
    updatingNameAgentId,
    onDelete,
    onRotate,
    onUpdateName,
  } = props;
  const { t } = useLocale();

  if (!data) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/20 py-12 text-sm text-muted-foreground">
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        {loading ? t("settings.devicesLoading") : t("settings.devicesEmpty")}
      </div>
    );
  }

  if (data.agents.length === 0) {
    const filtered = statusFilter !== "all";
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/60 bg-muted/20 py-12 text-center">
        <MonitorSmartphone className="h-8 w-8 text-muted-foreground/30" />
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {t(filtered ? "settings.devicesFilterEmpty" : "settings.devicesEmpty")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t(filtered ? "settings.devicesFilterEmptyDesc" : "settings.devicesEmptyDesc")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {data.agents.map((agent) => (
        <DeviceRow
          key={agent.agent_id}
          agent={agent}
          deleting={deletingAgentId === agent.agent_id}
          rotating={rotatingAgentId === agent.agent_id}
          updatingName={updatingNameAgentId === agent.agent_id}
          onDelete={() => void onDelete(agent.agent_id)}
          onRotate={() => void onRotate(agent)}
          onUpdateName={(name) => onUpdateName(agent.agent_id, name)}
        />
      ))}
    </div>
  );
}

function DeviceRow(props: {
  agent: AdminAgentEntry;
  deleting: boolean;
  rotating: boolean;
  updatingName: boolean;
  onDelete: () => void;
  onRotate: () => void;
  onUpdateName: (name: string) => Promise<void>;
}) {
  const { agent, deleting, rotating, updatingName, onDelete, onRotate, onUpdateName } = props;
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(agent.name);
  const displayName = agent.name.trim();

  async function saveName() {
    try {
      await onUpdateName(nameDraft);
      setEditing(false);
    } catch {
      // 父组件保留页面级错误；编辑区继续打开，便于用户修正后重试。
    }
  }

  function beginEditing() {
    setNameDraft(agent.name);
    setEditing(true);
  }

  return (
    <div className="group rounded-xl border border-border/60 bg-card transition-colors hover:border-border hover:bg-accent/20">
      <div className="settings-card-row flex items-center gap-3 px-4 py-3">
        <div
          className={
            agent.online
              ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10"
              : "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60"
          }
        >
          {agent.online ? (
            <Wifi className="h-4 w-4 text-emerald-500" />
          ) : (
            <WifiOff className="h-4 w-4 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`truncate text-sm font-medium ${displayName ? "" : "font-mono"}`}
              title={displayName || agent.agent_id}
            >
              {displayName || agent.agent_id}
            </span>
            <span
              className={
                agent.online
                  ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                  : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              }
            >
              {agent.online
                ? t("settings.devicesOnlineStatus")
                : t("settings.devicesOfflineStatus")}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {displayName ? <span className="font-mono">{agent.agent_id}</span> : null}
            {agent.agent_version ? <span>{agent.agent_version}</span> : null}
            <span>
              {t(
                agent.has_token
                  ? "settings.devicesIndependentTokenIssued"
                  : "settings.devicesIndependentTokenMissing",
              )}
            </span>
            <span>{formatCreatedAt(agent.token_created_at ?? agent.registered_at)}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {agent.has_token ? (
            <ConfirmActionPopover
              title={t("settings.devicesRotateTitle")}
              description={t("settings.devicesRotateDesc")}
              confirmLabel={t("settings.devicesRotate")}
              tone="default"
              onConfirm={onRotate}
            >
              {(open) => (
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  disabled={rotating || deleting}
                  onClick={open}
                >
                  {rotating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Key className="h-3.5 w-3.5" />
                  )}
                  {t("settings.devicesRotate")}
                </Button>
              )}
            </ConfirmActionPopover>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              disabled={rotating || deleting}
              onClick={onRotate}
            >
              {rotating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Key className="h-3.5 w-3.5" />
              )}
              {t("settings.devicesIssueShort")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            disabled={deleting || updatingName}
            onClick={beginEditing}
          >
            <Pencil className="h-3.5 w-3.5" />
            {t("settings.devicesEditName")}
          </Button>
          <ConfirmActionPopover
            title={t("settings.devicesDeleteTitle")}
            description={
              <>
                {t("settings.devicesDeleteDesc")}{" "}
                <span className="font-mono font-medium text-foreground">{agent.agent_id}</span>
              </>
            }
            confirmLabel={t("settings.devicesDelete")}
            onConfirm={onDelete}
          >
            {(open) => (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-destructive"
                disabled={deleting || rotating}
                onClick={open}
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {t("settings.devicesDelete")}
              </Button>
            )}
          </ConfirmActionPopover>
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2 border-t border-border/50 px-4 py-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label
              htmlFor={`agent-name-${agent.agent_id}`}
              className="text-xs text-muted-foreground"
            >
              {t("settings.devicesName")}
            </Label>
            <Input
              id={`agent-name-${agent.agent_id}`}
              value={nameDraft}
              maxLength={MAX_AGENT_NAME_LENGTH}
              placeholder={t("settings.devicesNamePlaceholder")}
              disabled={updatingName}
              autoFocus
              onChange={(event) => setNameDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveName();
                if (event.key === "Escape") setEditing(false);
              }}
            />
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={updatingName}
              onClick={() => setEditing(false)}
            >
              <X className="h-3.5 w-3.5" />
              {t("settings.cancel")}
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={updatingName}
              onClick={() => void saveName()}
            >
              {updatingName ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {t("settings.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
