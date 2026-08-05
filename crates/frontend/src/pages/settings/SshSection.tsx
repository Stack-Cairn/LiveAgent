import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Key,
  LayoutGrid,
  List,
  Lock,
  Pencil,
  Plus,
  Server,
  Shield,
  Terminal,
  Trash2,
  Upload,
} from "../../components/icons";

import { Button } from "../../components/ui/button";
import { useConfirmDialog } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import {
  removeSshHostFromProjectAssociations,
  type SshAuthType,
  type SshHostConfig,
  type SshProxyType,
  updateSsh,
} from "../../lib/settings";
import { createUuid } from "../../lib/shared/id";
import { useModalMotion } from "../../lib/shared/modalMotion";
import {
  type SshImportCandidate,
  type SshScanResult,
  scanSshImportCandidates,
} from "../../lib/ssh/scan";
import type { TerminalSession } from "../../lib/terminal/types";
import { ConfirmActionPopover, PromptTag } from "./shared";
import type { SettingsSectionProps } from "./types";

type SshViewMode = "list" | "grid";
type SshHostDraft = Omit<SshHostConfig, "id">;
type SshKnownHostResetStatus = {
  hostId: string;
  kind: "success" | "info" | "error";
  message: string;
};

type SshKnownHostResetResponse = {
  deleted: number;
};

type RawTerminalListResponse = {
  sessions?: TerminalSession[];
};

type SshReconnectTarget = {
  id: string;
  projectPathKey: string;
};

/** Non-empty secret input replaces the stored secret; empty input keeps it. */
function sshSecretInputChanged(draftValue: string, storedValue: string) {
  const next = draftValue.trim();
  if (!next) return false;
  return next !== storedValue.trim();
}

/**
 * Whether the edited draft changes anything an established connection depends
 * on. Cosmetic fields (name, description, sort order, `*Configured` flags)
 * never count.
 */
export function sshHostConnectionFieldsChanged(
  before: SshHostConfig,
  draft: Omit<SshHostConfig, "id">,
): boolean {
  if (
    before.host.trim() !== draft.host.trim() ||
    before.port !== draft.port ||
    before.username.trim() !== draft.username.trim() ||
    before.authType !== draft.authType
  ) {
    return true;
  }
  if (
    before.proxy.type !== draft.proxy.type ||
    before.proxy.url.trim() !== draft.proxy.url.trim() ||
    before.proxy.port !== draft.proxy.port ||
    before.proxy.username.trim() !== draft.proxy.username.trim() ||
    sshSecretInputChanged(draft.proxy.password, before.proxy.password)
  ) {
    return true;
  }
  if (draft.authType === "password") {
    return sshSecretInputChanged(draft.password, before.password);
  }
  if (draft.authType === "privateKey") {
    return (
      sshSecretInputChanged(draft.privateKey, before.privateKey) ||
      draft.privateKeyPath.trim() !== before.privateKeyPath.trim() ||
      sshSecretInputChanged(draft.privateKeyPassphrase, before.privateKeyPassphrase)
    );
  }
  return false;
}

async function listActiveSshSessions(hostId: string): Promise<TerminalSession[]> {
  const response = await invoke<RawTerminalListResponse>("terminal_list", {});
  return (response.sessions ?? []).filter(
    (session) =>
      session.kind === "ssh" &&
      session.ssh?.hostId === hostId &&
      session.ssh.status !== "disconnected",
  );
}

function normalizePortInput(value: string) {
  const port = Number(value);
  if (!Number.isFinite(port)) return 22;
  const normalized = Math.floor(port);
  return normalized >= 1 && normalized <= 65535 ? normalized : 22;
}

function normalizeOptionalPortInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const port = Number(trimmed);
  if (!Number.isFinite(port)) return 0;
  const normalized = Math.floor(port);
  return normalized >= 1 && normalized <= 65535 ? normalized : 0;
}

function endpointLabel(host: SshHostConfig) {
  const userPrefix = host.username.trim() ? `${host.username.trim()}@` : "";
  return `${userPrefix}${host.host}:${host.port}`;
}

function authLabel(host: Pick<SshHostConfig, "authType">, t: (key: string) => string) {
  if (host.authType === "privateKey") return t("settings.sshAuthPrivateKey");
  if (host.authType === "keyboardInteractive") return t("settings.sshAuthKeyboardInteractive");
  return t("settings.sshAuthPassword");
}

function SshPasswordInput(props: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { id, value, disabled = false, onChange } = props;
  const { t } = useLocale();
  const [visible, setVisible] = useState(false);
  const toggleLabel = visible ? t("settings.sshHidePassword") : t("settings.sshShowPassword");

  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        disabled={disabled}
        className="pr-10"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        disabled={disabled}
        onClick={() => setVisible((current) => !current)}
        title={toggleLabel}
        aria-label={toggleLabel}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  );
}

function SshHostModal(props: {
  initialData?: SshHostConfig;
  onSave: (data: SshHostDraft) => void;
  onClose: () => void;
}) {
  const { initialData, onSave, onClose } = props;
  const { t } = useLocale();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(initialData?.name ?? "");
  const [host, setHost] = useState(initialData?.host ?? "");
  const [port, setPort] = useState(String(initialData?.port ?? 22));
  const [username, setUsername] = useState(initialData?.username ?? "");
  const [authType, setAuthType] = useState<SshAuthType>(initialData?.authType ?? "password");
  const [password, setPassword] = useState(initialData?.password ?? "");
  const [privateKey, setPrivateKey] = useState(initialData?.privateKey ?? "");
  const [privateKeyPath, setPrivateKeyPath] = useState(initialData?.privateKeyPath ?? "");
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState(
    initialData?.privateKeyPassphrase ?? "",
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [proxyType, setProxyType] = useState<SshProxyType>(initialData?.proxy.type ?? "socks5");
  const [proxyUrl, setProxyUrl] = useState(initialData?.proxy.url ?? "");
  const [proxyPort, setProxyPort] = useState(
    initialData?.proxy.port ? String(initialData.proxy.port) : "",
  );
  const [proxyUsername, setProxyUsername] = useState(initialData?.proxy.username ?? "");
  const [proxyPassword, setProxyPassword] = useState(initialData?.proxy.password ?? "");
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);
  const isEditing = Boolean(initialData);
  const isPasswordAuth = authType === "password";
  const isPrivateKeyAuth = authType === "privateKey";
  const isKeyboardInteractiveAuth = authType === "keyboardInteractive";
  const passwordAuthPanelStyle: CSSProperties = {
    maxHeight: isPasswordAuth ? "7rem" : "0rem",
    opacity: isPasswordAuth ? 1 : 0,
    pointerEvents: isPasswordAuth ? "auto" : "none",
    transform: isPasswordAuth ? "translateY(0)" : "translateY(-4px)",
  };
  const privateKeyAuthPanelStyle: CSSProperties = {
    maxHeight: isPrivateKeyAuth ? "29rem" : "0rem",
    opacity: isPrivateKeyAuth ? 1 : 0,
    pointerEvents: isPrivateKeyAuth ? "auto" : "none",
    transform: isPrivateKeyAuth ? "translateY(0)" : "translateY(4px)",
  };

  function handleFileSelected(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      setPrivateKey(content.trim());
      setPrivateKeyPath(file.name);
      setAuthType("privateKey");
    };
    reader.readAsText(file);
  }

  function handleSave() {
    if (isClosing) return;
    const trimmedName = name.trim();
    const trimmedHost = host.trim();
    if (!trimmedName || !trimmedHost) return;
    const trimmedPassword = password.trim();
    const trimmedPrivateKey = privateKey.trim();
    const trimmedPrivateKeyPath = privateKeyPath.trim();
    const trimmedPrivateKeyPassphrase = privateKeyPassphrase.trim();
    const trimmedProxyPassword = proxyPassword.trim();
    const nextPassword = isPasswordAuth ? trimmedPassword : "";
    const nextPrivateKey = isPrivateKeyAuth ? trimmedPrivateKey : "";
    const nextPrivateKeyPath = isPrivateKeyAuth ? trimmedPrivateKeyPath : "";
    const nextPrivateKeyPassphrase = isPrivateKeyAuth ? trimmedPrivateKeyPassphrase : "";
    onSave({
      name: trimmedName,
      description: initialData?.description ?? "",
      host: trimmedHost,
      port: normalizePortInput(port),
      username: username.trim(),
      authType,
      password: nextPassword,
      passwordConfigured:
        isPasswordAuth &&
        (nextPassword.length > 0 ||
          (initialData?.authType === "password" && initialData?.passwordConfigured === true)),
      privateKey: nextPrivateKey,
      privateKeyPath: nextPrivateKeyPath,
      privateKeyConfigured:
        isPrivateKeyAuth &&
        (nextPrivateKey.length > 0 ||
          nextPrivateKeyPath.length > 0 ||
          (initialData?.authType === "privateKey" && initialData?.privateKeyConfigured === true)),
      privateKeyPassphrase: nextPrivateKeyPassphrase,
      privateKeyPassphraseConfigured:
        isPrivateKeyAuth &&
        (nextPrivateKeyPassphrase.length > 0 ||
          (initialData?.authType === "privateKey" &&
            initialData?.privateKeyPassphraseConfigured === true)),
      proxy: {
        type: proxyType,
        url: proxyUrl.trim(),
        port: normalizeOptionalPortInput(proxyPort),
        username: proxyUsername.trim(),
        password: trimmedProxyPassword,
        passwordConfigured:
          trimmedProxyPassword.length > 0 || initialData?.proxy.passwordConfigured === true,
      },
    });
    requestClose();
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />
      <div className="settings-modal-panel relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
            <Key className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold">
              {isEditing ? t("settings.sshEdit") : t("settings.sshAdd")}
            </div>
            <div className="text-xs text-muted-foreground">{t("settings.sshDesc")}</div>
          </div>
        </div>

        <div className="settings-modal-body flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ssh-name" className="text-xs font-medium text-muted-foreground">
                {t("settings.sshName")}
                <span className="ml-0.5 text-red-500">*</span>
              </Label>
              <Input
                id="ssh-name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ssh-host" className="text-xs font-medium text-muted-foreground">
                {t("settings.sshHost")}
                <span className="ml-0.5 text-red-500">*</span>
              </Label>
              <Input
                id="ssh-host"
                value={host}
                onChange={(event) => setHost(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ssh-username" className="text-xs font-medium text-muted-foreground">
                {t("settings.sshUsername")}
              </Label>
              <Input
                id="ssh-username"
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ssh-port" className="text-xs font-medium text-muted-foreground">
                {t("settings.sshPort")}
              </Label>
              <Input
                id="ssh-port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.currentTarget.value)}
              />
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              {t("settings.sshAuthMethod")}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => setAuthType("password")}
                className={`group relative flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-all duration-200 ease-out hover:-translate-y-0.5 ${
                  isPasswordAuth
                    ? "border-emerald-500/40 bg-emerald-500/[0.06] shadow-sm"
                    : "border-border/60 bg-card hover:border-border hover:bg-muted/20"
                }`}
              >
                <Lock
                  className={`h-4 w-4 shrink-0 text-emerald-500 transition-transform duration-200 ${
                    isPasswordAuth ? "scale-110" : "group-hover:scale-105"
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t("settings.sshAuthPassword")}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("settings.sshAuthPasswordHint")}
                  </div>
                </div>
                <Check
                  aria-hidden="true"
                  className={`ml-auto h-4 w-4 shrink-0 text-emerald-500 transition-all duration-200 ${
                    isPasswordAuth ? "scale-100 opacity-100" : "scale-75 opacity-0"
                  }`}
                />
              </button>
              <button
                type="button"
                onClick={() => setAuthType("privateKey")}
                className={`group relative flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-all duration-200 ease-out hover:-translate-y-0.5 ${
                  isPrivateKeyAuth
                    ? "border-emerald-500/40 bg-emerald-500/[0.06] shadow-sm"
                    : "border-border/60 bg-card hover:border-border hover:bg-muted/20"
                }`}
              >
                <Key
                  className={`h-4 w-4 shrink-0 text-emerald-500 transition-transform duration-200 ${
                    isPrivateKeyAuth ? "scale-110" : "group-hover:scale-105"
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t("settings.sshAuthPrivateKey")}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("settings.sshAuthPrivateKeyHint")}
                  </div>
                </div>
                <Check
                  aria-hidden="true"
                  className={`ml-auto h-4 w-4 shrink-0 text-emerald-500 transition-all duration-200 ${
                    isPrivateKeyAuth ? "scale-100 opacity-100" : "scale-75 opacity-0"
                  }`}
                />
              </button>
              <button
                type="button"
                onClick={() => setAuthType("keyboardInteractive")}
                className={`group relative flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-all duration-200 ease-out hover:-translate-y-0.5 ${
                  isKeyboardInteractiveAuth
                    ? "border-emerald-500/40 bg-emerald-500/[0.06] shadow-sm"
                    : "border-border/60 bg-card hover:border-border hover:bg-muted/20"
                }`}
              >
                <Terminal
                  className={`h-4 w-4 shrink-0 text-emerald-500 transition-transform duration-200 ${
                    isKeyboardInteractiveAuth ? "scale-110" : "group-hover:scale-105"
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {t("settings.sshAuthKeyboardInteractive")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("settings.sshAuthKeyboardInteractiveHint")}
                  </div>
                </div>
                <Check
                  aria-hidden="true"
                  className={`ml-auto h-4 w-4 shrink-0 text-emerald-500 transition-all duration-200 ${
                    isKeyboardInteractiveAuth ? "scale-100 opacity-100" : "scale-75 opacity-0"
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="mt-4">
            <div
              aria-hidden={!isPasswordAuth}
              className="ssh-auth-panel ssh-auth-panel--password"
              data-state={isPasswordAuth ? "open" : "closed-up"}
              style={passwordAuthPanelStyle}
            >
              <div className="space-y-1.5">
                <Label htmlFor="ssh-password" className="text-xs font-medium text-muted-foreground">
                  {t("settings.sshPassword")}
                </Label>
                <SshPasswordInput
                  id="ssh-password"
                  value={password}
                  disabled={!isPasswordAuth}
                  onChange={setPassword}
                />
                {initialData?.passwordConfigured && !password.trim() ? (
                  <div className="text-[11px] text-muted-foreground">
                    {t("settings.sshPasswordConfigured")}
                  </div>
                ) : null}
              </div>
            </div>

            <div
              aria-hidden={!isPrivateKeyAuth}
              className="ssh-auth-panel ssh-auth-panel--private-key"
              data-state={isPrivateKeyAuth ? "open" : "closed-down"}
              style={privateKeyAuthPanelStyle}
            >
              <div className="space-y-3">
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-2 top-2 z-10 h-7 w-7 rounded-md border border-transparent bg-background/80 p-0 text-muted-foreground shadow-none hover:border-border/70 hover:bg-muted/70 hover:text-foreground"
                    aria-label={t("settings.sshPrivateKeyImport")}
                    disabled={!isPrivateKeyAuth}
                    onClick={() => fileInputRef.current?.click()}
                    title={t("settings.sshPrivateKeyImport")}
                  >
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    disabled={!isPrivateKeyAuth}
                    onChange={(event) => handleFileSelected(event.currentTarget.files?.[0])}
                  />
                  <Textarea
                    id="ssh-private-key"
                    aria-label={t("settings.sshPrivateKey")}
                    value={privateKey}
                    disabled={!isPrivateKeyAuth}
                    className="min-h-[180px] resize-y pr-12 font-mono text-xs leading-relaxed"
                    onChange={(event) => setPrivateKey(event.currentTarget.value)}
                  />
                </div>
                {initialData?.privateKeyConfigured && !privateKey.trim() ? (
                  <div className="text-[11px] text-muted-foreground">
                    {t("settings.sshPrivateKeyConfigured")}
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label
                    htmlFor="ssh-private-key-passphrase"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("settings.sshPrivateKeyPassphrase")}
                  </Label>
                  <SshPasswordInput
                    id="ssh-private-key-passphrase"
                    value={privateKeyPassphrase}
                    disabled={!isPrivateKeyAuth}
                    onChange={setPrivateKeyPassphrase}
                  />
                  {initialData?.privateKeyPassphraseConfigured && !privateKeyPassphrase.trim() ? (
                    <div className="text-[11px] text-muted-foreground">
                      {t("settings.sshPrivateKeyPassphraseConfigured")}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 overflow-hidden rounded-xl border border-border/60 bg-muted/10">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-muted/30"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span>{t("settings.sshAdvancedSettings")}</span>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${
                  advancedOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            <div className="ssh-collapsible" data-open={advancedOpen}>
              <div
                aria-hidden={!advancedOpen}
                className={`ssh-collapsible-inner border-border/60 px-4 transition-[border-width,padding] duration-200 ease-out ${
                  advancedOpen ? "border-t py-4" : "border-t-0 py-0"
                }`}
                inert={!advancedOpen}
              >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-xs font-medium text-muted-foreground">
                      {t("settings.sshProxyType")}
                    </Label>
                    <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-background p-1">
                      {(["socks5", "http"] as SshProxyType[]).map((type) => (
                        <button
                          key={type}
                          type="button"
                          className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                            proxyType === type
                              ? "bg-muted text-foreground shadow-sm"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          }`}
                          onClick={() => setProxyType(type)}
                        >
                          {type === "socks5"
                            ? t("settings.sshProxyTypeSocks5")
                            : t("settings.sshProxyTypeHttp")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="ssh-proxy-url"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {t("settings.sshProxyUrl")}
                    </Label>
                    <Input
                      id="ssh-proxy-url"
                      value={proxyUrl}
                      placeholder={t(
                        proxyType === "socks5"
                          ? "settings.sshProxyUrlSocks5Placeholder"
                          : "settings.sshProxyUrlHttpPlaceholder",
                      )}
                      onChange={(event) => setProxyUrl(event.currentTarget.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="ssh-proxy-port"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {t("settings.sshProxyPort")}
                    </Label>
                    <Input
                      id="ssh-proxy-port"
                      type="number"
                      min={1}
                      max={65535}
                      value={proxyPort}
                      onChange={(event) => setProxyPort(event.currentTarget.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="ssh-proxy-username"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {t("settings.sshProxyUsername")}
                    </Label>
                    <Input
                      id="ssh-proxy-username"
                      value={proxyUsername}
                      onChange={(event) => setProxyUsername(event.currentTarget.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="ssh-proxy-password"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {t("settings.sshProxyPassword")}
                    </Label>
                    <SshPasswordInput
                      id="ssh-proxy-password"
                      value={proxyPassword}
                      onChange={setProxyPassword}
                    />
                    {initialData?.proxy.passwordConfigured && !proxyPassword.trim() ? (
                      <div className="text-[11px] text-muted-foreground">
                        {t("settings.sshProxyPasswordConfigured")}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="settings-modal-footer flex items-center justify-end border-t px-6 py-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={requestClose}>
              {t("settings.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={!name.trim() || !host.trim() || isClosing}>
              {t("settings.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SshImportModal(props: {
  existingHosts: SshHostConfig[];
  onImport: (hosts: SshImportCandidate[]) => void;
  onClose: () => void;
}) {
  const { existingHosts, onImport, onClose } = props;
  const { t } = useLocale();
  const [result, setResult] = useState<SshScanResult | null>(null);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const { isClosing, modalState, requestClose } = useModalMotion(onClose);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError("");
    scanSshImportCandidates(existingHosts)
      .then((scanResult) => {
        if (cancelled) return;
        setResult(scanResult);
        setSelectedIds(
          new Set(scanResult.candidates.filter((item) => !item.duplicate).map((item) => item.id)),
        );
      })
      .catch((scanError) => {
        if (cancelled) return;
        setError(scanError instanceof Error ? scanError.message : String(scanError));
      });
    return () => {
      cancelled = true;
    };
  }, [existingHosts]);

  const candidates = result?.candidates ?? [];
  const selected = candidates.filter((candidate) => selectedIds.has(candidate.id));

  function toggle(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />
      <div className="settings-modal-panel relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
            <Upload className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold">{t("settings.sshImport")}</div>
            <div className="text-xs text-muted-foreground">{t("settings.sshImportDesc")}</div>
          </div>
        </div>

        <div className="settings-modal-body flex-1 overflow-y-auto px-6 py-5">
          {!result && !error ? (
            <div className="flex h-48 items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/20 text-sm text-muted-foreground">
              {t("settings.sshImportScanning")}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {t("settings.sshImportFailed")}: {error}
            </div>
          ) : null}

          {result ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">{result.sshDirPath}</div>
                <div className="mt-1">
                  {t("settings.sshImportFound")
                    .replace("{count}", String(candidates.length))
                    .replace("{keys}", String(result.keyFiles.length))}
                </div>
              </div>

              {candidates.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/60 bg-muted/20 py-12 text-center">
                  <Key className="h-8 w-8 text-muted-foreground/50" />
                  <div>
                    <div className="text-sm font-medium">{t("settings.sshImportEmpty")}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t("settings.sshImportEmptyHint")}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      disabled={candidate.duplicate}
                      onClick={() => toggle(candidate.id)}
                      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                        selectedIds.has(candidate.id)
                          ? "border-emerald-500/40 bg-emerald-500/[0.06]"
                          : "border-border/60 bg-card hover:border-border"
                      } ${candidate.duplicate ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors duration-150 ${
                          selectedIds.has(candidate.id)
                            ? "border-emerald-500 bg-emerald-500 text-white"
                            : "border-border bg-background"
                        }`}
                      >
                        <Check
                          className={`h-3.5 w-3.5 transition-transform duration-150 ${
                            selectedIds.has(candidate.id) ? "scale-100" : "scale-0"
                          }`}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{candidate.name}</span>
                          <PromptTag label={authLabel(candidate, t)} />
                          {candidate.duplicate ? (
                            <PromptTag label={t("settings.sshImportDuplicate")} muted />
                          ) : null}
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {candidate.username ? `${candidate.username}@` : ""}
                          {candidate.host}:{candidate.port}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="settings-modal-footer flex items-center justify-between border-t px-6 py-4">
          <div className="text-xs text-muted-foreground">
            {t("settings.sshImportSelected").replace("{count}", String(selected.length))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={requestClose}>
              {t("settings.cancel")}
            </Button>
            <Button
              disabled={selected.length === 0 || isClosing}
              onClick={() => {
                onImport(selected);
                requestClose();
              }}
            >
              {t("settings.sshImport")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SshHostCard(props: {
  host: SshHostConfig;
  viewMode: SshViewMode;
  resetStatus?: SshKnownHostResetStatus;
  resettingKnownHost: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onResetKnownHost: () => void;
}) {
  const { host, viewMode, resetStatus, resettingKnownHost, onEdit, onDelete, onResetKnownHost } =
    props;
  const { t } = useLocale();
  const showKeyPath = host.authType === "privateKey" && host.privateKeyPath.trim().length > 0;
  const showKeyConfigured = host.authType === "privateKey" && host.privateKeyConfigured;
  const showProxy =
    host.proxy.url.trim().length > 0 || host.proxy.port > 0 || host.proxy.passwordConfigured;
  const hasMeta = showKeyPath || showKeyConfigured;
  const hasFooter = hasMeta || resetStatus;

  const actions = (
    <div className="settings-hover-actions flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      <ConfirmActionPopover
        title={t("settings.sshKnownHostResetTitle")}
        description={t("settings.sshKnownHostResetDesc")}
        confirmLabel={t("settings.sshKnownHostResetConfirm")}
        onConfirm={onResetKnownHost}
      >
        {(open) => (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={open}
            title={t("settings.sshKnownHostReset")}
            aria-label={t("settings.sshKnownHostReset")}
            disabled={resettingKnownHost}
          >
            <Shield className="h-3.5 w-3.5" />
          </Button>
        )}
      </ConfirmActionPopover>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={onEdit}
        title={t("settings.edit")}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
        title={t("settings.delete")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  const metaTags = (
    <div className="flex flex-wrap items-center gap-1.5">
      {showKeyPath ? <PromptTag label={host.privateKeyPath} muted /> : null}
      {showKeyConfigured ? <PromptTag label={t("settings.sshPrivateKeyConfigured")} muted /> : null}
    </div>
  );

  const resetStatusNode = resetStatus ? (
    <div
      className={`text-xs leading-relaxed ${
        resetStatus.kind === "error" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {resetStatus.message}
    </div>
  ) : null;

  if (viewMode === "grid") {
    return (
      <div className="group relative z-0 flex flex-col rounded-xl border border-border/60 bg-card p-4 transition-all duration-200 hover:z-10 hover:border-emerald-500/40 hover:shadow-md hover:shadow-emerald-500/10">
        <div className="absolute right-3 top-3">{actions}</div>
        <div className="flex items-start gap-3 pr-12">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 transition-transform duration-200 group-hover:scale-105">
            <Server className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{host.name}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <PromptTag label={authLabel(host, t)} />
              {showProxy ? <PromptTag label={t("settings.sshAdvancedProxy")} muted /> : null}
            </div>
          </div>
        </div>
        <div className="mt-3 truncate font-mono text-xs text-muted-foreground">
          {endpointLabel(host)}
        </div>
        {hasFooter ? (
          <div className="mt-auto space-y-2 pt-3">
            {hasMeta ? metaTags : null}
            {resetStatusNode}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="group relative z-0 rounded-xl border border-border/60 bg-card transition-all duration-200 hover:z-10 hover:border-emerald-500/40 hover:shadow-md hover:shadow-emerald-500/10">
      <div className="settings-card-row flex items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 transition-transform duration-200 group-hover:scale-105">
          <Server className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{host.name}</span>
            <PromptTag label={authLabel(host, t)} />
            {showProxy ? <PromptTag label={t("settings.sshAdvancedProxy")} muted /> : null}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {endpointLabel(host)}
          </div>
        </div>
        {actions}
      </div>
      {hasFooter ? (
        <div className="space-y-2 border-t border-border/40 px-4 py-2.5">
          {hasMeta ? metaTags : null}
          {resetStatusNode}
        </div>
      ) : null}
    </div>
  );
}

function SshViewModeToggle(props: { value: SshViewMode; onChange: (value: SshViewMode) => void }) {
  const { value, onChange } = props;
  const { t } = useLocale();
  const groupLabel = `${t("settings.sshViewList")} / ${t("settings.sshViewGrid")}`;
  const options = [
    { value: "list" as const, label: t("settings.sshViewList"), icon: List },
    { value: "grid" as const, label: t("settings.sshViewGrid"), icon: LayoutGrid },
  ];

  return (
    <fieldset className="relative isolate grid min-w-0 grid-cols-2 rounded-lg border border-border/60 bg-muted/30 p-0.5 shadow-inner shadow-black/5">
      <legend className="sr-only">{groupLabel}</legend>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-[calc(50%-0.125rem)] rounded-md bg-emerald-500/10 shadow-sm shadow-emerald-500/10 ring-1 ring-emerald-500/30 transition-transform duration-200 ease-out motion-reduce:transition-none ${
          value === "grid" ? "translate-x-full" : "translate-x-0"
        }`}
      />
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-200 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-reduce:transition-none ${
              active ? "text-emerald-500" : "text-muted-foreground"
            }`}
            title={option.label}
            aria-label={option.label}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </fieldset>
  );
}

export function SshSection(props: SettingsSectionProps) {
  const { settings, setSettings, saveState } = props;
  const { t } = useLocale();
  const [viewMode, setViewMode] = useState<SshViewMode>("list");
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<SshHostConfig | null>(null);
  const [knownHostResettingId, setKnownHostResettingId] = useState<string | null>(null);
  const [knownHostResetStatus, setKnownHostResetStatus] = useState<SshKnownHostResetStatus | null>(
    null,
  );
  const knownHostResetTimerRef = useRef<number | null>(null);
  const { confirm: requestSshConfirm, dialog: sshConfirmDialog } = useConfirmDialog();
  const saveStatusRef = useRef(saveState?.status ?? "idle");
  saveStatusRef.current = saveState?.status ?? "idle";
  const hosts = settings.ssh.hosts;

  useEffect(() => {
    return () => {
      if (knownHostResetTimerRef.current !== null) {
        window.clearTimeout(knownHostResetTimerRef.current);
      }
    };
  }, []);

  function showKnownHostResetStatus(status: SshKnownHostResetStatus, durationMs = 5000) {
    if (knownHostResetTimerRef.current !== null) {
      window.clearTimeout(knownHostResetTimerRef.current);
    }
    setKnownHostResetStatus(status);
    knownHostResetTimerRef.current = window.setTimeout(() => {
      setKnownHostResetStatus((current) => (current?.hostId === status.hostId ? null : current));
      knownHostResetTimerRef.current = null;
    }, durationMs);
  }

  // The settings save pipeline is asynchronous on both ends (Tauri patch
  // command / gateway SettingsUpdate round-trip). Reconnects re-read the host
  // config from the store, so they must not start before the save landed.
  async function waitForSettingsSaved(timeoutMs = 15000): Promise<"saved" | "error" | "timeout"> {
    const startedAt = Date.now();
    for (;;) {
      const status = saveStatusRef.current;
      if (status === "saved" || status === "idle") return "saved";
      if (status === "error") return "error";
      if (Date.now() - startedAt >= timeoutMs) return "timeout";
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
  }

  async function runSshReconnectBatch(hostId: string, targets: SshReconnectTarget[]) {
    let reconnected = 0;
    let kbiFailures = 0;
    let hostKeyFailures = 0;
    const otherFailures: string[] = [];
    for (const target of targets) {
      try {
        await invoke("terminal_ssh_reconnect", {
          session_id: target.id,
          project_path_key: target.projectPathKey,
        });
        reconnected += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already in progress")) {
          // An automatic reconnect is running; every attempt re-reads the
          // saved settings, so the update still lands.
          reconnected += 1;
        } else if (message.includes("keyboard-interactive")) {
          kbiFailures += 1;
        } else if (message.includes("host key")) {
          hostKeyFailures += 1;
        } else {
          otherFailures.push(message);
        }
      }
    }
    if (reconnected === targets.length) {
      showKnownHostResetStatus(
        {
          hostId,
          kind: "success",
          message: t("settings.sshReconnectResultSuccess").replace("{count}", String(reconnected)),
        },
        8000,
      );
      return;
    }
    const details: string[] = [];
    if (kbiFailures > 0) {
      details.push(t("settings.sshReconnectResultKbi").replace("{count}", String(kbiFailures)));
    }
    if (hostKeyFailures > 0) {
      details.push(
        t("settings.sshReconnectResultHostKey").replace("{count}", String(hostKeyFailures)),
      );
    }
    if (otherFailures.length > 0) {
      details.push(otherFailures[0]);
    }
    const summary = t("settings.sshReconnectResultPartial")
      .replace("{reconnected}", String(reconnected))
      .replace("{total}", String(targets.length));
    showKnownHostResetStatus(
      {
        hostId,
        kind: "error",
        message: [summary, ...details].join(" "),
      },
      10000,
    );
  }

  async function promptSshReconnectAfterSave(host: SshHostConfig, nextAuthType: SshAuthType) {
    let sessions: TerminalSession[];
    try {
      sessions = await listActiveSshSessions(host.id);
    } catch {
      // Session listing unavailable (e.g. web terminal disabled) — the update
      // still applies on the next connect, so stay silent.
      return;
    }
    if (sessions.length === 0) return;
    const count = String(sessions.length);
    if (nextAuthType === "keyboardInteractive") {
      await requestSshConfirm({
        title: t("settings.sshReconnectKbiTitle"),
        subtitle: host.name,
        description: t("settings.sshReconnectKbiNotice").replace("{count}", count),
        confirmLabel: t("settings.sshReconnectKbiGotIt"),
        cancelLabel: t("settings.cancel"),
        closeLabel: t("settings.sshReconnectKbiGotIt"),
        tone: "warning",
        hideCancel: true,
      });
      return;
    }
    const proceed = await requestSshConfirm({
      title: t("settings.sshReconnectPromptTitle"),
      subtitle: host.name,
      description: t("settings.sshReconnectPromptDesc").replace("{count}", count),
      detail: t("settings.sshReconnectPromptDetail"),
      confirmLabel: t("settings.sshReconnectPromptConfirm").replace("{count}", count),
      cancelLabel: t("settings.sshReconnectPromptKeep"),
      tone: "warning",
    });
    if (!proceed) return;
    const saveOutcome = await waitForSettingsSaved();
    if (saveOutcome !== "saved") {
      showKnownHostResetStatus({
        hostId: host.id,
        kind: "error",
        message: t("settings.sshReconnectSaveFailed"),
      });
      return;
    }
    await runSshReconnectBatch(
      host.id,
      sessions.map((session) => ({ id: session.id, projectPathKey: session.projectPathKey })),
    );
  }

  function openAdd() {
    setEditingHost(null);
    setModalOpen(true);
  }

  function openEdit(host: SshHostConfig) {
    setEditingHost(host);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingHost(null);
  }

  function handleSave(data: SshHostDraft) {
    const target = editingHost;
    if (target && sshHostConnectionFieldsChanged(target, data)) {
      void promptSshReconnectAfterSave(target, data.authType);
    }
    setSettings((prev) => {
      if (editingHost) {
        return updateSsh(prev, {
          hosts: prev.ssh.hosts.map((host) => {
            if (host.id !== editingHost.id) return host;
            const keepPasswordSecret = data.authType === "password" && host.authType === "password";
            const keepPrivateKeySecret =
              data.authType === "privateKey" && host.authType === "privateKey";
            const nextPassword =
              data.authType === "password"
                ? data.password || (keepPasswordSecret ? host.password : "")
                : "";
            const nextPrivateKey =
              data.authType === "privateKey"
                ? data.privateKey || (keepPrivateKeySecret ? host.privateKey : "")
                : "";
            const nextPrivateKeyPassphrase =
              data.authType === "privateKey"
                ? data.privateKeyPassphrase ||
                  (keepPrivateKeySecret ? host.privateKeyPassphrase : "")
                : "";
            return {
              ...host,
              ...data,
              password: nextPassword,
              privateKey: nextPrivateKey,
              privateKeyPassphrase: nextPrivateKeyPassphrase,
              passwordConfigured:
                data.authType === "password" &&
                (data.password.trim().length > 0 ||
                  (keepPasswordSecret && host.passwordConfigured === true)),
              privateKeyConfigured:
                data.authType === "privateKey" &&
                (data.privateKey.trim().length > 0 ||
                  data.privateKeyPath.trim().length > 0 ||
                  (keepPrivateKeySecret && host.privateKeyConfigured === true)),
              privateKeyPassphraseConfigured:
                data.authType === "privateKey" &&
                (data.privateKeyPassphrase.trim().length > 0 ||
                  (keepPrivateKeySecret && host.privateKeyPassphraseConfigured === true)),
              proxy: {
                ...data.proxy,
                password: data.proxy.password || host.proxy.password,
                passwordConfigured:
                  data.proxy.password.trim().length > 0 || host.proxy.passwordConfigured === true,
              },
            };
          }),
        });
      }
      return updateSsh(prev, {
        hosts: [
          ...prev.ssh.hosts,
          {
            id: createUuid(),
            ...data,
          },
        ],
      });
    });
  }

  function handleDelete(id: string) {
    setSettings((prev) =>
      removeSshHostFromProjectAssociations(
        updateSsh(prev, {
          hosts: prev.ssh.hosts.filter((host) => host.id !== id),
        }),
        id,
      ),
    );
  }

  async function handleDeleteRequest(host: SshHostConfig) {
    let sessions: TerminalSession[] = [];
    try {
      sessions = await listActiveSshSessions(host.id);
    } catch {
      sessions = [];
    }
    const proceed = await requestSshConfirm({
      title: t("settings.deleteConfirm"),
      subtitle: host.name,
      description:
        sessions.length > 0
          ? t("settings.sshDeleteActiveWarning").replace("{count}", String(sessions.length))
          : t("settings.deleteConfirmDesc"),
      confirmLabel: t("settings.delete"),
      cancelLabel: t("settings.cancel"),
      tone: "destructive",
    });
    if (!proceed) return;
    // Close before deleting so the sessions never outlive their host config;
    // best-effort — a session that already ended is fine to ignore.
    for (const session of sessions) {
      try {
        await invoke("terminal_close", {
          session_id: session.id,
          project_path_key: session.projectPathKey,
        });
      } catch {
        // ignore
      }
    }
    handleDelete(host.id);
  }

  async function handleResetKnownHost(host: SshHostConfig) {
    const targetHost = host.host.trim();
    if (!targetHost || host.port <= 0) {
      showKnownHostResetStatus({
        hostId: host.id,
        kind: "error",
        message: t("settings.sshKnownHostResetFailed").replace(
          "{error}",
          t("settings.sshRequired"),
        ),
      });
      return;
    }

    setKnownHostResettingId(host.id);
    try {
      const response = await invoke<SshKnownHostResetResponse>("settings_reset_ssh_known_host", {
        host: targetHost,
        port: host.port,
      });
      showKnownHostResetStatus({
        hostId: host.id,
        kind: response.deleted > 0 ? "success" : "info",
        message:
          response.deleted > 0
            ? t("settings.sshKnownHostResetSuccess")
            : t("settings.sshKnownHostResetEmpty"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showKnownHostResetStatus({
        hostId: host.id,
        kind: "error",
        message: t("settings.sshKnownHostResetFailed").replace("{error}", message),
      });
    } finally {
      setKnownHostResettingId((current) => (current === host.id ? null : current));
    }
  }

  function handleImport(candidates: SshImportCandidate[]) {
    setSettings((prev) =>
      updateSsh(prev, {
        hosts: [
          ...prev.ssh.hosts,
          ...candidates.map((candidate) => {
            const { id: _id, source: _source, duplicate: _duplicate, ...host } = candidate;
            return {
              id: createUuid(),
              ...host,
            };
          }),
        ],
      }),
    );
  }

  return (
    <>
      <div className="settings-ssh-section space-y-5">
        <div className="settings-section-heading-row flex items-center justify-between gap-4">
          <div className="settings-section-title-group flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10">
              <Key className="h-[18px] w-[18px] text-emerald-500" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">{t("settings.sshTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("settings.sshDesc")}</p>
            </div>
          </div>

          <div className="settings-section-actions flex items-center gap-2">
            {hosts.length > 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                <span className="tabular-nums font-medium text-foreground">{hosts.length}</span>
                {t("settings.sshCount")}
              </div>
            ) : null}
            <SshViewModeToggle value={viewMode} onChange={setViewMode} />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setImportOpen(true)}
            >
              <Upload className="h-3.5 w-3.5" />
              {t("settings.sshImport")}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5" />
              {t("settings.sshAdd")}
            </Button>
          </div>
        </div>

        {hosts.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 bg-muted/20 py-14 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10">
              <Key className="h-6 w-6 text-emerald-400" />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">{t("settings.sshNoHosts")}</p>
              <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
                {t("settings.sshNoHostsHint")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setImportOpen(true)}
              >
                <Upload className="h-3.5 w-3.5" />
                {t("settings.sshImport")}
              </Button>
              <Button size="sm" className="gap-1.5" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5" />
                {t("settings.sshAdd")}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className={viewMode === "grid" ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "space-y-2"}
          >
            {hosts.map((host) => (
              <SshHostCard
                key={host.id}
                host={host}
                viewMode={viewMode}
                resetStatus={
                  knownHostResetStatus?.hostId === host.id ? knownHostResetStatus : undefined
                }
                resettingKnownHost={knownHostResettingId === host.id}
                onEdit={() => openEdit(host)}
                onDelete={() => void handleDeleteRequest(host)}
                onResetKnownHost={() => void handleResetKnownHost(host)}
              />
            ))}
          </div>
        )}
      </div>

      {modalOpen ? (
        <SshHostModal
          initialData={editingHost ?? undefined}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}
      {importOpen ? (
        <SshImportModal
          existingHosts={hosts}
          onImport={handleImport}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
      {sshConfirmDialog}
    </>
  );
}
