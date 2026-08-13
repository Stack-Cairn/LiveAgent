import { sshLocalForwardClient } from "@liveagent/adapters/sshLocalForwardClient";
import type { SshHostConfig } from "@liveagent/app/lib/settings";
import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import {
  AlertTriangle,
  ArrowLeft,
  Cable,
  Check,
  ChevronDown,
  Clock3,
  ConnectionIcon,
  Copy,
  FolderTree,
  Globe,
  Key,
  Loader2,
  RefreshCw,
  Server,
  Settings,
  Shield,
  Terminal,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "@liveagent/ui/components/IconSet";
import { SshPortForwardDialog } from "@liveagent/ui/components/project-tools/SshPortForwardDialog";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { SshLocalForwardState } from "@liveagent/ui/lib/terminal/sshLocalForwardTypes";
import { reduceSshLocalForwardState } from "@liveagent/ui/lib/terminal/sshLocalForwardTypes";
import type {
  TerminalClient,
  TerminalSession,
  TerminalSnapshot,
  TerminalSshPrompt,
} from "@liveagent/ui/lib/terminal/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SshTunnelScope = "project" | "all";
type SshTunnelView = "list" | "settings" | "create";

type SshLatencyState = {
  latencyMs?: number;
  loading: boolean;
  failed: boolean;
};

type PendingSshCreate = {
  hostId: string;
  // Set once the create RPC returns a prompt: later prompt answers are tied to
  // this create flow by the prompt id instead of guessing by host.
  promptId: string | null;
};

type SshTunnelPanelProps = {
  active: boolean;
  cwd: string;
  projectPathKey: string;
  hosts: SshHostConfig[];
  associatedHostIds: string[];
  client: TerminalClient;
  sessions: TerminalSession[];
  onSessionSnapshot: (snapshot: TerminalSnapshot) => void;
  onSessionClosed: (sessionId: string) => void;
  onSshSessionsReconcile: (sessions: TerminalSession[]) => void;
  onOpenSession: (session: TerminalSession, kind?: "bash" | "sftp") => void;
  onAssociatedHostIdsChange: (hostIds: string[]) => void;
};

function endpointLabel(host: SshHostConfig) {
  const userPrefix = host.username.trim() ? `${host.username.trim()}@` : "";
  return `${userPrefix}${host.host}:${host.port}`;
}

function authLabel(host: Pick<SshHostConfig, "authType">, t: (key: string) => string) {
  if (host.authType === "privateKey") return t("settings.sshAuthPrivateKey");
  if (host.authType === "keyboardInteractive") return t("settings.sshAuthKeyboardInteractive");
  return t("settings.sshAuthPassword");
}

function hostHasProxy(host: SshHostConfig) {
  return (
    host.proxy.url.trim().length > 0 ||
    host.proxy.port > 0 ||
    host.proxy.username.trim().length > 0 ||
    host.proxy.passwordConfigured === true
  );
}

export function hostSecretReady(host: SshHostConfig) {
  if (host.authType === "keyboardInteractive") return true;
  if (host.authType === "privateKey") {
    return (
      host.privateKey.trim().length > 0 ||
      host.privateKeyPath.trim().length > 0 ||
      host.privateKeyConfigured === true
    );
  }
  return host.password.trim().length > 0 || host.passwordConfigured === true;
}

export function hostStatusMessage(host: SshHostConfig, t: (key: string) => string) {
  if (!hostSecretReady(host)) return t("projectTools.sshTunnelMissingSecret");
  return "";
}

function sessionBelongsToProject(session: TerminalSession, projectPathKey: string) {
  const wantedProjectKey = workspaceProjectPathKey(projectPathKey);
  if (!wantedProjectKey) return false;
  const sessionProjectKey = workspaceProjectPathKey(session.projectPathKey || session.cwd);
  return sessionProjectKey === wantedProjectKey;
}

function sessionTitle(session: TerminalSession, fallback: string) {
  return session.title || session.ssh?.hostName || fallback;
}

function sessionEndpointLabel(session: TerminalSession) {
  const ssh = session.ssh;
  if (!ssh) return session.cwd || session.projectPathKey;
  const userPrefix = ssh.username.trim() ? `${ssh.username.trim()}@` : "";
  return `${userPrefix}${ssh.host}:${ssh.port}`;
}

function sessionProjectLabel(session: TerminalSession) {
  return session.projectPathKey || session.cwd || "";
}

function sshSessionStatus(session: TerminalSession) {
  const status = session.ssh?.status ?? (session.running ? "connected" : "disconnected");
  if (status === "connected" && !session.running) return "disconnected";
  return status;
}

function sshSessionConnected(session: TerminalSession) {
  return sshSessionStatus(session) === "connected" && session.running;
}

function sshStatusLabel(session: TerminalSession, t: (key: string) => string) {
  const status = sshSessionStatus(session);
  if (status === "reconnecting") {
    const attempt = Math.max(1, Number(session.ssh?.reconnectAttempt ?? 1));
    const max = Math.max(attempt, Number(session.ssh?.reconnectMaxAttempts ?? 3));
    return t("projectTools.sshTunnelReconnecting")
      .replace("{attempt}", String(attempt))
      .replace("{max}", String(max));
  }
  if (status === "disconnected") return t("projectTools.sshTunnelDisconnected");
  return t("projectTools.sshTunnelConnected");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTerminalSessionNotFoundError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("terminal session not found") || message.includes("session not found");
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

let workspaceSshTerminalOverlayPreload: Promise<unknown> | null = null;

function preloadWorkspaceSshTerminalOverlay() {
  workspaceSshTerminalOverlayPreload ??= import(
    "@liveagent/ui/components/workspace-editor/WorkspaceSshTerminalOverlay"
  ).catch((error) => {
    workspaceSshTerminalOverlayPreload = null;
    throw error;
  });
  return workspaceSshTerminalOverlayPreload;
}

function HostMetaTags(props: { host: SshHostConfig }) {
  const { host } = props;
  const { t } = useLocale();
  const tags: string[] = [];
  if (host.authType === "privateKey" && host.privateKeyPath.trim()) {
    tags.push(host.privateKeyPath.trim());
  } else if (host.authType === "privateKey" && host.privateKeyConfigured) {
    tags.push(t("settings.sshPrivateKeyConfigured"));
  }
  if (host.privateKeyPassphraseConfigured) {
    tags.push(t("settings.sshPrivateKeyPassphraseConfigured"));
  }
  if (tags.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="max-w-full truncate rounded-md bg-muted/70 px-1.5 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground"
          title={tag}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

export function SshTunnelPanel(props: SshTunnelPanelProps) {
  const {
    active,
    cwd,
    projectPathKey,
    hosts,
    associatedHostIds,
    client,
    sessions,
    onSessionSnapshot,
    onSessionClosed,
    onSshSessionsReconcile,
    onOpenSession,
    onAssociatedHostIdsChange,
  } = props;
  const { t } = useLocale();
  const { confirm: requestCloseSessionConfirm, dialog: closeSessionConfirmDialog } =
    useConfirmDialog();
  const [scope, setScope] = useState<SshTunnelScope>("project");
  const [view, setView] = useState<SshTunnelView>("list");
  const [createHostId, setCreateHostId] = useState("");
  const [createHostMenuOpen, setCreateHostMenuOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createSftpEnabled, setCreateSftpEnabled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [closingSessionIds, setClosingSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [reconnectingSessionIds, setReconnectingSessionIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Create-page failures and list-page failures surface in their own views;
  // a close error must not appear under the create form and vice versa.
  const [createError, setCreateError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<TerminalSshPrompt | null>(null);
  const [promptAnswer, setPromptAnswer] = useState("");
  const [answeringPrompt, setAnsweringPrompt] = useState(false);
  const [latencyBySessionId, setLatencyBySessionId] = useState<Record<string, SshLatencyState>>({});
  const [localForwards, setLocalForwards] = useState<SshLocalForwardState>({
    forwards: [],
    revision: 0,
  });
  // 新建映射的表单挪进了 SshPortForwardDialog；这里只记住哪个会话开着模态。
  const [forwardModalSessionId, setForwardModalSessionId] = useState<string | null>(null);
  const [stoppingForwardIds, setStoppingForwardIds] = useState<ReadonlySet<string>>(new Set());
  const [forwardErrorsBySessionId, setForwardErrorsBySessionId] = useState<Record<string, string>>(
    {},
  );
  const [copiedForwardId, setCopiedForwardId] = useState("");
  const latencyRequestsRef = useRef<Set<string>>(new Set());
  const pendingCreateRef = useRef<PendingSshCreate | null>(null);
  const onSshSessionsReconcileRef = useRef(onSshSessionsReconcile);
  onSshSessionsReconcileRef.current = onSshSessionsReconcile;
  const associatedSet = useMemo(() => new Set(associatedHostIds), [associatedHostIds]);
  const associatedHosts = useMemo(
    () => hosts.filter((host) => associatedSet.has(host.id)),
    [associatedSet, hosts],
  );
  const sshSessions = useMemo(
    () => sessions.filter((session) => session.kind === "ssh" && session.ssh),
    [sessions],
  );
  // 会话被关闭/回收时模态随之消失：挂载与否直接跟着会话是否还在走。
  const forwardModalSession = forwardModalSessionId
    ? (sshSessions.find((session) => session.id === forwardModalSessionId) ?? null)
    : null;
  const projectSshSessions = useMemo(
    () => sshSessions.filter((session) => sessionBelongsToProject(session, projectPathKey)),
    [projectPathKey, sshSessions],
  );
  const visibleSessions = scope === "project" ? projectSshSessions : sshSessions;
  const visibleSessionsRef = useRef(visibleSessions);
  visibleSessionsRef.current = visibleSessions;
  const visibleSessionsKey = useMemo(
    () => visibleSessions.map((session) => session.id).join("\n"),
    [visibleSessions],
  );
  const canCreateInScope = scope === "project";
  const createHosts = canCreateInScope ? associatedHosts : [];
  const hasCreateHosts = createHosts.length > 0;
  const canShowCreateButton = canCreateInScope && hasCreateHosts;
  const selectedCreateHostId = createHosts.some((host) => host.id === createHostId)
    ? createHostId
    : (createHosts[0]?.id ?? "");
  const selectedCreateHost = createHosts.find((host) => host.id === selectedCreateHostId) ?? null;
  const selectedHostMessage = selectedCreateHost ? hostStatusMessage(selectedCreateHost, t) : "";
  const canCreate = Boolean(
    canShowCreateButton && selectedCreateHost && !selectedHostMessage && !creating,
  );

  useEffect(() => {
    if (canShowCreateButton || view !== "create") return;
    setView("list");
  }, [canShowCreateButton, view]);

  // Create/list errors are transient feedback for the visible panel. Clearing
  // on deactivation (not activation) keeps them from greeting the user on a
  // later reopen while still surfacing failures that land while the tab is
  // put away (e.g. an in-flight create that fails after switching tabs).
  useEffect(() => {
    if (active) return;
    setCreateError(null);
    setListError(null);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    const reconcileSshSessions = () => {
      if (inFlight) return;
      inFlight = true;
      void client
        .list()
        .then((nextSessions) => {
          if (cancelled) return;
          onSshSessionsReconcileRef.current(
            nextSessions.filter((session) => session.kind === "ssh" && session.ssh),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    reconcileSshSessions();
    const timer = window.setInterval(reconcileSshSessions, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, client]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void sshLocalForwardClient
      .subscribe((event) => {
        if (cancelled) return;
        setLocalForwards((current) => reduceSshLocalForwardState(current, event));
        if (event.kind === "failed" && event.forward.error) {
          setForwardErrorsBySessionId((current) => ({
            ...current,
            [event.forward.sessionId]: event.forward.error ?? "",
          }));
        }
      })
      .then((nextUnsubscribe) => {
        if (cancelled) nextUnsubscribe();
        else unsubscribe = nextUnsubscribe;
        if (cancelled) return;
        return sshLocalForwardClient.list().then((snapshot) => {
          if (!cancelled) {
            setLocalForwards((current) => reduceSshLocalForwardState(current, snapshot));
          }
        });
      })
      .catch((error) => {
        if (!cancelled) setListError(errorMessage(error));
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [active]);

  const refreshSessionLatency = useCallback(
    (session: TerminalSession) => {
      if (!sshSessionConnected(session) || session.kind !== "ssh") return;
      if (latencyRequestsRef.current.has(session.id)) return;
      latencyRequestsRef.current.add(session.id);
      setLatencyBySessionId((current) => ({
        ...current,
        [session.id]: {
          latencyMs: current[session.id]?.latencyMs,
          loading: true,
          failed: false,
        },
      }));
      void client
        .sshLatency(session.id, session.projectPathKey)
        .then((latency) => {
          setLatencyBySessionId((current) => ({
            ...current,
            [session.id]: {
              latencyMs: latency.latencyMs,
              loading: false,
              failed: false,
            },
          }));
        })
        .catch(() => {
          setLatencyBySessionId((current) => ({
            ...current,
            [session.id]: {
              loading: false,
              failed: true,
            },
          }));
        })
        .finally(() => {
          latencyRequestsRef.current.delete(session.id);
        });
    },
    [client],
  );

  useEffect(() => {
    const visibleIds = new Set(visibleSessions.map((session) => session.id));
    setLatencyBySessionId((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([sessionId]) => visibleIds.has(sessionId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [visibleSessions]);

  const clearForwardError = useCallback((sessionId: string) => {
    setForwardErrorsBySessionId((current) => {
      if (!current[sessionId]) return current;
      return { ...current, [sessionId]: "" };
    });
  }, []);

  const handleOpenForwardModal = useCallback(
    (session: TerminalSession) => {
      clearForwardError(session.id);
      setForwardModalSessionId(session.id);
    },
    [clearForwardError],
  );

  const handleStopForward = useCallback((forwardId: string, sessionId: string) => {
    setStoppingForwardIds((current) => new Set(current).add(forwardId));
    setForwardErrorsBySessionId((current) => ({ ...current, [sessionId]: "" }));
    void sshLocalForwardClient
      .stop({ forwardId, sessionId })
      .then((response) => {
        setLocalForwards((current) => reduceSshLocalForwardState(current, response));
      })
      .catch((error) => {
        setForwardErrorsBySessionId((current) => ({
          ...current,
          [sessionId]: errorMessage(error),
        }));
      })
      .finally(() => {
        setStoppingForwardIds((current) => {
          const next = new Set(current);
          next.delete(forwardId);
          return next;
        });
      });
  }, []);

  const handleCopyForward = useCallback((forwardId: string, address: string) => {
    void writeTextToClipboard(address).then((copied) => {
      if (!copied) return;
      setCopiedForwardId(forwardId);
      window.setTimeout(
        () => setCopiedForwardId((current) => (current === forwardId ? "" : current)),
        1500,
      );
    });
  }, []);

  useEffect(() => {
    // Latency probes only run while the tab is visible. The interval callback
    // reads the latest session list from a ref so reconcile-produced array
    // identities don't rebuild the timer; the id join key only retriggers an
    // immediate refresh when membership actually changes.
    if (!active) return;
    const refreshConnectedLatencies = () => {
      for (const session of visibleSessionsRef.current) {
        if (session.kind === "ssh" && sshSessionConnected(session)) {
          refreshSessionLatency(session);
        }
      }
    };
    refreshConnectedLatencies();
    const timer = window.setInterval(refreshConnectedLatencies, 10_000);
    return () => window.clearInterval(timer);
  }, [active, refreshSessionLatency, visibleSessionsKey]);

  // Ends the create flow's form/pending state only. It deliberately never
  // touches the prompt: while a prompt is open its lifecycle belongs to the
  // prompt handlers (submit/cancel), so a concurrent flow finish can't yank an
  // auth dialog out from under the user.
  const finishCreateFlow = useCallback(() => {
    if (!pendingCreateRef.current) return;
    pendingCreateRef.current = null;
    setCreateTitle("");
    setCreateSftpEnabled(false);
    setCreating(false);
    setCreateError(null);
    setView("list");
  }, []);

  const finishCreatedSnapshot = useCallback(
    (snapshot: TerminalSnapshot) => {
      onSessionSnapshot(snapshot);
      finishCreateFlow();
    },
    [finishCreateFlow, onSessionSnapshot],
  );

  // A failure from a previous create attempt is stale once the form is
  // reopened or retargeted at another host.
  const openCreateView = useCallback(() => {
    setCreateError(null);
    setView("create");
  }, []);

  const selectCreateHost = useCallback((hostId: string) => {
    setCreateHostId(hostId);
    setCreateError(null);
  }, []);

  const toggleHost = (hostId: string) => {
    const current = associatedHostIds.filter((id) => hosts.some((host) => host.id === id));
    const next = associatedSet.has(hostId)
      ? current.filter((id) => id !== hostId)
      : [...current, hostId];
    onAssociatedHostIdsChange(next);
  };

  const handleCreate = useCallback(() => {
    if (!selectedCreateHost || !canCreate) return;
    pendingCreateRef.current = {
      hostId: selectedCreateHost.id,
      promptId: null,
    };
    setCreating(true);
    setCreateError(null);
    void client
      .createSsh({
        cwd,
        projectPathKey,
        hostId: selectedCreateHost.id,
        title: createTitle.trim() || undefined,
        sftpEnabled: createSftpEnabled,
      })
      .then((result) => {
        if (result.prompt) {
          const pending = pendingCreateRef.current;
          if (pending && pending.hostId === selectedCreateHost.id) {
            pendingCreateRef.current = { ...pending, promptId: result.prompt.id };
            setPrompt(result.prompt);
            setPromptAnswer("");
            setView("list");
          } else {
            // The flow this prompt belongs to is gone; don't surface an
            // ownerless auth dialog — release it server-side instead.
            void client.cancelSshPrompt(result.prompt.id).catch(() => undefined);
          }
          return;
        }
        // The create RPC identifies our session directly via the returned
        // snapshot — never by matching "some new session on this host".
        if (result.snapshot) {
          finishCreatedSnapshot(result.snapshot);
        }
      })
      .catch((err) => {
        pendingCreateRef.current = null;
        setCreateError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setCreating(false));
  }, [
    canCreate,
    client,
    createSftpEnabled,
    createTitle,
    cwd,
    finishCreatedSnapshot,
    projectPathKey,
    selectedCreateHost,
  ]);

  const handleSubmitPrompt = useCallback(() => {
    if (!prompt || answeringPrompt) return;
    const hostKeyPrompt = prompt.kind === "hostKey";
    if (!hostKeyPrompt && !promptAnswer.trim()) return;
    setAnsweringPrompt(true);
    setListError(null);
    void client
      .answerSshPrompt({
        promptId: prompt.id,
        answer: hostKeyPrompt ? undefined : promptAnswer,
        trustHostKey: hostKeyPrompt,
      })
      .then((result) => {
        if (result.prompt) {
          const pending = pendingCreateRef.current;
          if (pending) {
            pendingCreateRef.current = { ...pending, promptId: result.prompt.id };
          }
          setPrompt(result.prompt);
          setPromptAnswer("");
          return;
        }
        setPrompt(null);
        setPromptAnswer("");
        if (result.snapshot) {
          finishCreatedSnapshot(result.snapshot);
        }
      })
      .catch((err) => setListError(err instanceof Error ? err.message : String(err)))
      .finally(() => setAnsweringPrompt(false));
  }, [answeringPrompt, client, finishCreatedSnapshot, prompt, promptAnswer]);

  const handleCancelPrompt = useCallback(() => {
    const promptId = prompt?.id;
    pendingCreateRef.current = null;
    setPrompt(null);
    setPromptAnswer("");
    if (!promptId) return;
    void client.cancelSshPrompt(promptId).catch(() => undefined);
  }, [client, prompt]);

  const handleCloseSession = useCallback(
    async (session: TerminalSession) => {
      if (closingSessionIds.has(session.id)) return;
      const title = sessionTitle(session, t("projectTools.sshTunnelTitle"));
      const confirmed = await requestCloseSessionConfirm({
        title: t("projectTools.confirmCloseSshSession"),
        subtitle: t("projectTools.closeSshSessionConfirm").replace("{title}", title),
        detail: sessionEndpointLabel(session),
        confirmLabel: t("projectTools.closeSshSessionContinue"),
        cancelLabel: t("projectTools.closeSshSessionCancel"),
        closeLabel: t("projectTools.closeSshSessionClose"),
        tone: "destructive",
      });
      if (!confirmed) return;
      setClosingSessionIds((current) => new Set(current).add(session.id));
      setListError(null);
      void client
        .close(session.id, session.projectPathKey)
        .then(() => onSessionClosed(session.id))
        .catch((err) => {
          if (isTerminalSessionNotFoundError(err)) {
            onSessionClosed(session.id);
            return;
          }
          setListError(errorMessage(err));
        })
        .finally(() =>
          setClosingSessionIds((current) => {
            if (!current.has(session.id)) return current;
            const next = new Set(current);
            next.delete(session.id);
            return next;
          }),
        );
    },
    [client, closingSessionIds, onSessionClosed, requestCloseSessionConfirm, t],
  );

  // keyboard-interactive hosts cannot re-authenticate inside the reconnect
  // path (it has no prompt channel) — the fallback is a fresh create, which
  // owns the full host-key/auth prompt flow.
  const recreateSessionForKbi = useCallback(
    async (session: TerminalSession) => {
      const hostId = session.ssh?.hostId ?? "";
      if (!hostId) return;
      try {
        await client.close(session.id, session.projectPathKey);
        onSessionClosed(session.id);
      } catch (err) {
        if (isTerminalSessionNotFoundError(err)) {
          onSessionClosed(session.id);
        } else {
          setListError(errorMessage(err));
          return;
        }
      }
      pendingCreateRef.current = { hostId, promptId: null };
      try {
        const result = await client.createSsh({
          cwd: session.cwd || cwd,
          projectPathKey: session.projectPathKey || projectPathKey,
          hostId,
          title: session.title.trim() || undefined,
          sftpEnabled: session.ssh?.sftpEnabled ?? false,
        });
        if (result.prompt) {
          const pending = pendingCreateRef.current;
          if (pending && pending.hostId === hostId) {
            pendingCreateRef.current = { ...pending, promptId: result.prompt.id };
            setPrompt(result.prompt);
            setPromptAnswer("");
            setView("list");
          } else {
            void client.cancelSshPrompt(result.prompt.id).catch(() => undefined);
          }
          return;
        }
        if (result.snapshot) {
          onSessionSnapshot(result.snapshot);
        }
      } catch (err) {
        pendingCreateRef.current = null;
        setListError(errorMessage(err));
      }
    },
    [client, cwd, onSessionClosed, onSessionSnapshot, projectPathKey],
  );

  const handleReconnectSession = useCallback(
    async (session: TerminalSession) => {
      if (reconnectingSessionIds.has(session.id) || closingSessionIds.has(session.id)) return;
      setReconnectingSessionIds((current) => new Set(current).add(session.id));
      setListError(null);
      try {
        await client.sshReconnect(session.id, session.projectPathKey);
      } catch (err) {
        const message = errorMessage(err);
        if (message.includes("already in progress")) {
          // The automatic reconnect loop owns the session right now; every
          // attempt re-reads the saved settings, so nothing else to do.
        } else if (message.includes("keyboard-interactive")) {
          const recreate = await requestCloseSessionConfirm({
            title: t("projectTools.sshTunnelReconnectKbiTitle"),
            subtitle: t("projectTools.sshTunnelReconnectKbiDesc"),
            detail: sessionEndpointLabel(session),
            confirmLabel: t("projectTools.sshTunnelReconnectKbiConfirm"),
            cancelLabel: t("projectTools.closeSshSessionCancel"),
            tone: "warning",
          });
          if (recreate) {
            await recreateSessionForKbi(session);
          }
        } else {
          setListError(message);
        }
      } finally {
        setReconnectingSessionIds((current) => {
          if (!current.has(session.id)) return current;
          const next = new Set(current);
          next.delete(session.id);
          return next;
        });
      }
    },
    [
      client,
      closingSessionIds,
      reconnectingSessionIds,
      recreateSessionForKbi,
      requestCloseSessionConfirm,
      t,
    ],
  );

  const listActive = view === "list";
  const settingsActive = view === "settings";
  const createActive = view === "create";
  const listPageClassName = cn(
    "absolute inset-0 flex min-h-0 flex-col bg-background transition-[opacity,transform] duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none",
    listActive
      ? "z-10 translate-x-0 opacity-100"
      : "pointer-events-none z-0 -translate-x-4 opacity-0",
  );
  const settingsPageClassName = cn(
    "absolute inset-0 flex min-h-0 flex-col bg-background transition-[opacity,transform] duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none",
    settingsActive
      ? "z-10 translate-x-0 opacity-100"
      : "pointer-events-none z-0 translate-x-4 opacity-0",
  );
  const createPageClassName = cn(
    "absolute inset-0 flex min-h-0 flex-col bg-background transition-[opacity,transform] duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none",
    createActive
      ? "z-10 translate-x-0 opacity-100"
      : "pointer-events-none z-0 translate-x-4 opacity-0",
  );
  const emptyTitle =
    scope === "project"
      ? t("projectTools.sshTunnelProjectEmpty")
      : t("projectTools.sshTunnelAllEmpty");
  const emptyHint =
    scope === "project"
      ? t("projectTools.sshTunnelProjectEmptyHint")
      : t("projectTools.sshTunnelAllEmptyHint");
  const visibleSessionCount = visibleSessions.length;
  const connectedSessionCount = visibleSessions.filter(sshSessionConnected).length;
  const statusText =
    visibleSessionCount > 0
      ? t("projectTools.sshTunnelConnectionCount")
          .replace("{count}", String(visibleSessionCount))
          .replace("{connected}", String(connectedSessionCount))
      : scope === "all"
        ? t("projectTools.sshTunnelAllEmpty")
        : projectPathKey
          ? t("projectTools.sshTunnelProjectEmpty")
          : t("projectTools.sshTunnelNoProject");
  const hostKeyPrompt = prompt?.kind === "hostKey";
  const promptSubmitDisabled =
    answeringPrompt || Boolean(prompt && !hostKeyPrompt && !promptAnswer.trim());
  const latencyText = (session: TerminalSession) => {
    const state = latencyBySessionId[session.id];
    if (state?.failed) return t("projectTools.sshTunnelLatencyUnknown");
    if (state?.latencyMs) {
      return t("projectTools.sshTunnelLatencyValue").replace("{ms}", String(state.latencyMs));
    }
    if (state?.loading) return t("projectTools.sshTunnelLatencyChecking");
    return t("projectTools.sshTunnelLatencyUnknown");
  };

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      <div className={settingsPageClassName} aria-hidden={!settingsActive} inert={!settingsActive}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
            title={t("projectTools.sshTunnelBack")}
            onClick={() => setView("list")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {t("projectTools.sshTunnelAssociateHosts")}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {t("projectTools.sshTunnelAssociateHostsHint")}
            </div>
          </div>
          <div className="rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
            <span className="tabular-nums text-foreground">{associatedHosts.length}</span>{" "}
            {t("projectTools.sshTunnelAssociatedCount")}
          </div>
        </div>

        {hosts.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
              <Key className="h-6 w-6" />
            </div>
            <div className="max-w-xs space-y-1">
              <div className="text-sm font-medium text-foreground">
                {t("projectTools.sshTunnelNoConfiguredHosts")}
              </div>
              <div className="text-xs leading-relaxed text-muted-foreground">
                {t("projectTools.sshTunnelNoConfiguredHostsHint")}
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div className="space-y-2">
              {hosts.map((host) => {
                const selected = associatedSet.has(host.id);
                return (
                  <button
                    key={host.id}
                    type="button"
                    className={cn(
                      "group flex w-full items-start gap-3 rounded-lg border border-border/60 bg-card px-3 py-3 text-left transition-all hover:border-emerald-500/40 hover:bg-muted/40",
                      selected && "border-emerald-500/50 bg-emerald-500/5",
                    )}
                    aria-pressed={selected}
                    onClick={() => toggleHost(host.id)}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                      <Server className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {host.name}
                        </span>
                        <span className="shrink-0 rounded-md bg-muted/70 px-1.5 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
                          {authLabel(host, t)}
                        </span>
                        {hostHasProxy(host) ? (
                          <span className="shrink-0 rounded-md bg-muted/70 px-1.5 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
                            {t("settings.sshAdvancedProxy")}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {endpointLabel(host)}
                      </div>
                      <HostMetaTags host={host} />
                    </div>
                    <span
                      className={cn(
                        "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                        selected
                          ? "border-emerald-500 bg-emerald-500 text-white"
                          : "border-border bg-background text-transparent",
                      )}
                      aria-hidden="true"
                    >
                      <Check className="h-3 w-3" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className={createPageClassName} aria-hidden={!createActive} inert={!createActive}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
            title={t("projectTools.sshTunnelBack")}
            onClick={() => setView("list")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {t("projectTools.sshTunnelCreateTitle")}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {t("projectTools.sshTunnelCreateHint")}
            </div>
          </div>
        </div>

        {createHosts.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
              <Key className="h-6 w-6" />
            </div>
            <div className="max-w-xs space-y-1">
              <div className="text-sm font-medium text-foreground">
                {hosts.length === 0
                  ? t("projectTools.sshTunnelNoConfiguredHosts")
                  : t("projectTools.sshTunnelCreateNoAssociatedHosts")}
              </div>
              <div className="text-xs leading-relaxed text-muted-foreground">
                {hosts.length === 0
                  ? t("projectTools.sshTunnelNoConfiguredHostsHint")
                  : t("projectTools.sshTunnelCreateNoAssociatedHostsHint")}
              </div>
            </div>
          </div>
        ) : (
          <form
            className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleCreate();
            }}
          >
            <div className="space-y-3">
              <div className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t("projectTools.sshTunnelHost")}
                </span>
                <DropdownMenu open={createHostMenuOpen} onOpenChange={setCreateHostMenuOpen}>
                  <DropdownMenuTrigger
                    type="button"
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 rounded-lg border border-border/70 bg-card/80 px-3 py-2 text-left shadow-[0_1px_2px_hsl(0_0%_0%_/_0.04)] outline-none transition-all hover:border-emerald-500/40 hover:bg-card focus-visible:border-emerald-500/50 focus-visible:ring-1 focus-visible:ring-emerald-500/20",
                      createHostMenuOpen && "border-emerald-500/50 ring-1 ring-emerald-500/20",
                    )}
                    aria-label={t("projectTools.sshTunnelHost")}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                      <Server className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-foreground">
                        {selectedCreateHost?.name}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                        {selectedCreateHost ? endpointLabel(selectedCreateHost) : ""}
                      </span>
                    </span>
                    {selectedCreateHost ? (
                      <span className="hidden shrink-0 rounded-md bg-muted/70 px-1.5 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground min-[360px]:inline-flex">
                        {authLabel(selectedCreateHost, t)}
                      </span>
                    ) : null}
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                        createHostMenuOpen && "rotate-180 text-emerald-500",
                      )}
                      aria-hidden="true"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    collisionPadding={12}
                    className="z-[80] w-max max-w-[calc(100vw-2rem)] min-w-[var(--anchor-width)] rounded-xl border-border/70 bg-popover/95 p-1 shadow-[0_18px_46px_-24px_hsl(160_84%_25%_/_0.42),0_8px_24px_-18px_hsl(0_0%_0%_/_0.32)] backdrop-blur-xl"
                  >
                    <div className="max-h-72 overflow-y-auto p-0.5">
                      {createHosts.map((host) => {
                        const selected = host.id === selectedCreateHostId;
                        return (
                          <DropdownMenuItem
                            key={host.id}
                            onSelect={() => selectCreateHost(host.id)}
                            className={cn(
                              "group/item flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-all focus:translate-x-0.5 focus:bg-emerald-500/10 focus:text-foreground",
                              selected && "bg-emerald-500/10 text-foreground",
                            )}
                          >
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 transition-colors group-focus/item:bg-emerald-500/15">
                              <Server className="h-3.5 w-3.5" />
                            </span>
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                                {host.name}
                              </span>
                              <span className="shrink-0 whitespace-nowrap font-mono text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                                {endpointLabel(host)}
                              </span>
                              <span className="shrink-0 rounded-md bg-background/80 px-1.5 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground">
                                {authLabel(host, t)}
                              </span>
                            </span>
                            <span
                              className={cn(
                                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                                selected
                                  ? "border-emerald-500 bg-emerald-500 text-white"
                                  : "border-border bg-background text-transparent",
                              )}
                              aria-hidden="true"
                            >
                              <Check className="h-3 w-3" />
                            </span>
                          </DropdownMenuItem>
                        );
                      })}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t("projectTools.sshTunnelTabTitle")}
                </span>
                <input
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.currentTarget.value)}
                  className="h-10 w-full rounded-lg border border-border/70 bg-background/80 px-3 text-[calc(11px*var(--zone-font-scale,1))] text-foreground outline-none transition-colors placeholder:text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-muted-foreground/70 focus-visible:border-emerald-500/50 focus-visible:ring-1 focus-visible:ring-emerald-500/20"
                  placeholder={
                    selectedCreateHost?.name || t("projectTools.sshTunnelTabTitlePlaceholder")
                  }
                />
              </label>

              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/70 bg-background/80 px-3 py-2.5 text-sm text-foreground transition-colors hover:border-emerald-500/40">
                <input
                  type="checkbox"
                  checked={createSftpEnabled}
                  onChange={(event) => setCreateSftpEnabled(event.currentTarget.checked)}
                  className="h-4 w-4 rounded border-border text-emerald-500 accent-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/20"
                />
                <span className="min-w-0 flex-1 text-xs font-medium">
                  {t("projectTools.sshTunnelSftpEnabled")}
                </span>
              </label>

              {selectedCreateHost ? (
                <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Server className="h-4 w-4 shrink-0 text-emerald-500" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">
                        {selectedCreateHost.name}
                      </div>
                      <div className="truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                        {endpointLabel(selectedCreateHost)}
                      </div>
                    </div>
                    <span className="shrink-0 rounded-md bg-background/70 px-1.5 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] text-muted-foreground">
                      {authLabel(selectedCreateHost, t)}
                    </span>
                  </div>
                  {selectedHostMessage ? (
                    <div className="mt-2 flex gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-destructive">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{selectedHostMessage}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {createError ? (
                <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {createError}
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2 border-t border-border/60 pt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-lg px-3 text-xs"
                onClick={() => setView("list")}
              >
                {t("projectTools.sshTunnelCreateCancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                className="h-8 rounded-lg px-3 text-xs"
                disabled={!canCreate}
              >
                {creating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {creating
                  ? t("projectTools.sshTunnelConnecting")
                  : t("projectTools.sshTunnelConnect")}
              </Button>
            </div>
          </form>
        )}
      </div>

      <div className={listPageClassName} aria-hidden={!listActive} inert={!listActive}>
        <div className="shrink-0 border-b border-border/60 bg-background/80 px-4 pb-3 pt-3.5 backdrop-blur-xl">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-foreground/70 shadow-[inset_0_1px_0_hsl(0_0%_100%_/_0.6),0_1px_2px_hsl(0_0%_0%_/_0.05)] dark:shadow-none">
              <Key className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold tracking-tight text-foreground">
                {t("projectTools.sshTunnelTitle")}
              </div>
              <div className="truncate text-xs text-muted-foreground">{statusText}</div>
            </div>
            {canShowCreateButton ? (
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border/60 hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={t("projectTools.newSshTunnel")}
                aria-label={t("projectTools.newSshTunnel")}
                onClick={openCreateView}
              >
                <ConnectionIcon height="1em" />
              </button>
            ) : null}
            {scope === "project" ? (
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border/60 hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={t("projectTools.sshTunnelSettings")}
                aria-label={t("projectTools.sshTunnelSettings")}
                onClick={() => setView("settings")}
              >
                <Settings className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          <div
            role="group"
            aria-label={t("projectTools.sshTunnelScopeGroup")}
            className="relative mt-3 grid grid-cols-2 gap-0.5 rounded-lg bg-muted/70 p-0.5"
          >
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-y-0 left-0 z-0 w-1/2 transform-gpu rounded-[7px] bg-background shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none",
                scope === "all" ? "translate-x-full" : "translate-x-0",
              )}
            />
            {(["project", "all"] as const).map((option) => {
              const selected = scope === option;
              const Icon = option === "project" ? Server : Globe;
              const label =
                option === "project"
                  ? t("projectTools.sshTunnelScopeProject")
                  : t("projectTools.sshTunnelScopeAll");
              return (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    "relative z-10 flex h-7 min-w-0 transform-gpu items-center justify-center gap-1.5 rounded-[7px] px-2 text-xs text-muted-foreground transition-[color,transform] duration-200 ease-out hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:active:scale-100",
                    selected && "font-medium text-foreground",
                  )}
                  title={label}
                  aria-label={label}
                  aria-pressed={selected}
                  onClick={() => setScope(option)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {listError ? (
            <div className="mb-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {listError}
            </div>
          ) : null}

          {visibleSessionCount === 0 ? (
            <div className="flex min-h-full items-center justify-center">
              <div className="flex flex-col items-center justify-center gap-1.5 rounded-lg bg-background/40 px-4 py-8 text-center">
                <div className="mb-1.5 flex h-12 w-12 items-center justify-center rounded-xl border border-border/50 bg-background/80 text-muted-foreground/70 shadow-[inset_0_1px_0_hsl(0_0%_100%_/_0.6),0_1px_3px_hsl(0_0%_0%_/_0.05)] dark:shadow-none">
                  <Key className="h-5 w-5" />
                </div>
                <div className="text-xs font-medium text-foreground/80">{emptyTitle}</div>
                <div className="max-w-[16rem] text-[calc(11px*var(--zone-font-scale,1))] leading-relaxed text-muted-foreground">
                  {emptyHint}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  {canShowCreateButton ? (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      className="h-7 rounded-lg px-2.5 text-xs"
                      onClick={openCreateView}
                    >
                      {t("projectTools.newSshTunnel")}
                    </Button>
                  ) : null}
                  {scope === "project" && associatedHosts.length === 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-lg bg-background/70 px-2.5 text-xs"
                      onClick={() => setView("settings")}
                    >
                      {t("projectTools.sshTunnelAssociateHosts")}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {visibleSessions.map((session) => {
                const title = sessionTitle(session, t("projectTools.sshTunnelTitle"));
                const endpoint = sessionEndpointLabel(session);
                const projectLabel = sessionProjectLabel(session);
                const closing = closingSessionIds.has(session.id);
                const reconnecting =
                  reconnectingSessionIds.has(session.id) ||
                  sshSessionStatus(session) === "reconnecting";
                const sshStatus = sshSessionStatus(session);
                const connected = sshSessionConnected(session);
                const sessionForwards = localForwards.forwards.filter(
                  (forward) => forward.sessionId === session.id,
                );
                const forwardError = forwardErrorsBySessionId[session.id] ?? "";
                return (
                  <article
                    key={session.id}
                    className="rounded-lg border border-border/60 bg-card px-3 py-3 shadow-[0_1px_2px_hsl(0_0%_0%_/_0.04)]"
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                          sshStatus === "disconnected"
                            ? "bg-destructive/10 text-destructive"
                            : sshStatus === "reconnecting"
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                              : "bg-emerald-500/10 text-emerald-500",
                        )}
                      >
                        <Server className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {title}
                          </span>
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium",
                              sshStatus === "disconnected"
                                ? "bg-destructive/10 text-destructive"
                                : sshStatus === "reconnecting"
                                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                            )}
                          >
                            {sshStatus === "disconnected" ? (
                              <WifiOff className="h-3 w-3" />
                            ) : sshStatus === "reconnecting" ? (
                              <RefreshCw className="h-3 w-3 animate-spin" />
                            ) : (
                              <Wifi className="h-3 w-3" />
                            )}
                            {sshStatusLabel(session, t)}
                          </span>
                        </div>
                        <div className="mt-1 truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                          {endpoint}
                        </div>
                        {scope === "all" && projectLabel ? (
                          <div className="mt-1 truncate text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                            {projectLabel}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] text-muted-foreground">
                          {latencyBySessionId[session.id]?.loading &&
                          !latencyBySessionId[session.id]?.latencyMs ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Clock3 className="h-3 w-3" />
                          )}
                          {latencyText(session)}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:hover:text-amber-400"
                          title={t("projectTools.sshTunnelReconnect")}
                          aria-label={t("projectTools.sshTunnelReconnect")}
                          disabled={reconnecting || closing}
                          onClick={() => void handleReconnectSession(session)}
                        >
                          <RefreshCw className={cn("h-4 w-4", reconnecting && "animate-spin")} />
                        </button>
                        <button
                          type="button"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:hover:text-emerald-400"
                          title={t("projectTools.sshTunnelOpenBash")}
                          aria-label={t("projectTools.sshTunnelOpenBash")}
                          disabled={!connected}
                          onFocus={() => {
                            void preloadWorkspaceSshTerminalOverlay();
                          }}
                          onPointerEnter={() => {
                            void preloadWorkspaceSshTerminalOverlay();
                          }}
                          onClick={() => {
                            void preloadWorkspaceSshTerminalOverlay();
                            onOpenSession(session, "bash");
                          }}
                        >
                          <Terminal className="h-4 w-4" />
                        </button>
                        {session.ssh?.sftpEnabled ? (
                          <button
                            type="button"
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-sky-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:hover:text-sky-400"
                            title={t("projectTools.sshTunnelOpenSftp")}
                            aria-label={t("projectTools.sshTunnelOpenSftp")}
                            disabled={!connected}
                            onFocus={() => {
                              void preloadWorkspaceSshTerminalOverlay();
                            }}
                            onPointerEnter={() => {
                              void preloadWorkspaceSshTerminalOverlay();
                            }}
                            onClick={() => {
                              void preloadWorkspaceSshTerminalOverlay();
                              onOpenSession(session, "sftp");
                            }}
                          >
                            <FolderTree className="h-4 w-4" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/10 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:hover:text-indigo-400"
                          title={t("projectTools.sshLocalForwardOpen")}
                          aria-label={t("projectTools.sshLocalForwardOpen")}
                          disabled={!connected || closing}
                          onClick={() => handleOpenForwardModal(session)}
                        >
                          <Cable className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                          title={t("projectTools.sshTunnelCloseSession")}
                          aria-label={t("projectTools.sshTunnelCloseSession")}
                          disabled={closing}
                          onClick={() => handleCloseSession(session)}
                        >
                          {closing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <X className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    {sessionForwards.length > 0 || forwardError ? (
                      <div className="mt-3 border-t border-border/60 pt-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-foreground">
                            {t("projectTools.sshLocalForwardTitle")}
                          </span>
                          {sessionForwards.length > 0 ? (
                            <span className="rounded-full bg-muted/80 px-1.5 py-px text-[calc(10.5px*var(--zone-font-scale,1))] tabular-nums text-muted-foreground">
                              {sessionForwards.length}
                            </span>
                          ) : null}
                        </div>
                        {forwardError ? (
                          <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/10 px-2.5 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] text-destructive">
                            {forwardError}
                          </div>
                        ) : null}
                        {sessionForwards.length > 0 ? (
                          <div className="mt-2 space-y-1.5">
                            {sessionForwards.map((forward) => {
                              const stopping = stoppingForwardIds.has(forward.id);
                              const waitingForSsh = sshStatus !== "connected";
                              const copied = copiedForwardId === forward.id;
                              return (
                                <div
                                  key={forward.id}
                                  className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-background/70 px-2.5 py-2"
                                >
                                  <span
                                    className={cn(
                                      "h-1.5 w-1.5 shrink-0 rounded-full",
                                      waitingForSsh
                                        ? "animate-pulse bg-amber-500"
                                        : "bg-emerald-500",
                                    )}
                                    aria-hidden="true"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex min-w-0 items-baseline gap-1.5 font-mono text-[calc(11px*var(--zone-font-scale,1))]">
                                      <span className="shrink-0 font-medium tabular-nums text-foreground">
                                        {forward.address}
                                      </span>
                                      <span className="shrink-0 text-muted-foreground/60">→</span>
                                      <span className="truncate tabular-nums text-muted-foreground">
                                        {forward.remoteHost}:{forward.remotePort}
                                      </span>
                                    </div>
                                    <div className="mt-0.5 truncate text-[calc(10px*var(--zone-font-scale,1))] text-muted-foreground">
                                      {waitingForSsh
                                        ? t("projectTools.sshLocalForwardWaiting")
                                        : t("projectTools.sshLocalForwardListening")}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    className={cn(
                                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
                                      copied
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                                    )}
                                    aria-label={
                                      copied
                                        ? t("projectTools.sshLocalForwardCopied")
                                        : t("projectTools.sshLocalForwardCopy")
                                    }
                                    title={
                                      copied
                                        ? t("projectTools.sshLocalForwardCopied")
                                        : t("projectTools.sshLocalForwardCopy")
                                    }
                                    onClick={() => handleCopyForward(forward.id, forward.address)}
                                  >
                                    {copied ? (
                                      <Check className="h-3.5 w-3.5" />
                                    ) : (
                                      <Copy className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                                    aria-label={t("projectTools.sshLocalForwardStop")}
                                    title={t("projectTools.sshLocalForwardStop")}
                                    disabled={stopping}
                                    onClick={() => handleStopForward(forward.id, session.id)}
                                  >
                                    {stopping ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Trash2 className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={prompt !== null}
        onOpenChange={(open) => {
          if (!open) handleCancelPrompt();
        }}
      >
        <DialogContent className="max-w-md rounded-lg p-4">
          {prompt ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmitPrompt();
              }}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Shield className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="text-sm">
                    {hostKeyPrompt
                      ? t("projectTools.sshTunnelPromptTitle")
                      : t("projectTools.sshTunnelAuthPromptTitle")}
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-xs leading-relaxed">
                    {prompt.message}
                  </DialogDescription>
                </div>
              </div>
              <div className="mt-3 space-y-2 rounded-lg bg-muted/40 px-3 py-2 text-xs">
                <div className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">
                    {t("projectTools.sshTunnelHost")}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                    {prompt.host}:{prompt.port}
                  </span>
                </div>
                {prompt.keyType ? (
                  <div className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">
                      {t("projectTools.sshTunnelKeyType")}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                      {prompt.keyType}
                    </span>
                  </div>
                ) : null}
                {prompt.fingerprintSha256 ? (
                  <div className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">
                      {t("projectTools.sshTunnelFingerprint")}
                    </span>
                    <span className="min-w-0 flex-1 break-all font-mono text-foreground">
                      {prompt.fingerprintSha256}
                    </span>
                  </div>
                ) : null}
              </div>
              {!hostKeyPrompt ? (
                <input
                  value={promptAnswer}
                  onChange={(event) => setPromptAnswer(event.currentTarget.value)}
                  className="mt-3 h-10 w-full rounded-lg border border-border/70 bg-background/80 px-3 text-[calc(11px*var(--zone-font-scale,1))] text-foreground outline-none transition-colors placeholder:text-[calc(11px*var(--zone-font-scale,1))] placeholder:text-muted-foreground/70 focus-visible:border-emerald-500/50 focus-visible:ring-1 focus-visible:ring-emerald-500/20"
                  type={prompt.answerEcho ? "text" : "password"}
                  aria-label={t("projectTools.sshTunnelAuthPromptTitle")}
                  autoFocus
                />
              ) : null}
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-lg px-3 text-xs"
                  onClick={handleCancelPrompt}
                  disabled={answeringPrompt}
                >
                  {hostKeyPrompt
                    ? t("projectTools.sshTunnelRejectHost")
                    : t("projectTools.sshTunnelPromptCancel")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  className="h-8 rounded-lg px-3 text-xs"
                  disabled={promptSubmitDisabled}
                >
                  {answeringPrompt ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  {hostKeyPrompt
                    ? t("projectTools.sshTunnelTrustHost")
                    : t("projectTools.sshTunnelPromptSubmit")}
                </Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      {closeSessionConfirmDialog}
      {forwardModalSession ? (
        <SshPortForwardDialog
          sessionId={forwardModalSession.id}
          projectPathKey={forwardModalSession.projectPathKey}
          subtitle={`${sessionTitle(forwardModalSession, t("projectTools.sshTunnelTitle"))} · ${sessionEndpointLabel(forwardModalSession)}`}
          client={sshLocalForwardClient}
          onClose={() => setForwardModalSessionId(null)}
          onStarted={(action) => {
            setLocalForwards((current) => reduceSshLocalForwardState(current, action));
            clearForwardError(action.forward.sessionId);
            setForwardModalSessionId(null);
          }}
        />
      ) : null}
    </div>
  );
}
