import type { McpServerConfig } from "@liveagent/app/lib/settings/index";
import { AlertTriangle, McpLogo, Plus, Save } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useLocale } from "@liveagent/ui/i18n/index";
import { type FormEvent, useEffect, useMemo, useState } from "react";

type ServerDraft = {
  id: string;
  description: string;
  docsUrl: string;
  transport: McpServerConfig["transport"];
  timeoutMs: string;
  command: string;
  cwd: string;
  argsText: string;
  envText: string;
  url: string;
  messageUrl: string;
  headersText: string;
};

function formatKeyValueRecord(input: Record<string, string> | undefined) {
  return input
    ? Object.entries(input)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")
    : "";
}

function parseLineList(input: string) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseKeyValueDraft(input: string, errorPrefix: string) {
  const out: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`${errorPrefix}${trimmed}`);
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || !value) {
      throw new Error(`${errorPrefix}${trimmed}`);
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function suggestServerName(existing: string[]): string {
  const taken = new Set(existing.map((id) => id.trim()).filter(Boolean));
  let idx = existing.length + 1;
  let name = `MCP Server ${idx}`;
  while (taken.has(name)) {
    idx += 1;
    name = `MCP Server ${idx}`;
  }
  return name;
}

function blankDraft(existingIds: string[]): ServerDraft {
  return {
    id: suggestServerName(existingIds),
    description: "",
    docsUrl: "",
    transport: "stdio",
    timeoutMs: "60000",
    command: "",
    cwd: "",
    argsText: "",
    envText: "",
    url: "",
    messageUrl: "",
    headersText: "",
  };
}

function draftFromServer(server: McpServerConfig): ServerDraft {
  const transport: McpServerConfig["transport"] = server.transport ?? "stdio";
  return {
    id: server.id,
    description: server.description ?? "",
    docsUrl: server.docsUrl ?? "",
    transport,
    timeoutMs: String(server.timeoutMs ?? 60_000),
    command: server.command ?? "",
    cwd: server.cwd ?? "",
    argsText: (server.args ?? []).join("\n"),
    envText: formatKeyValueRecord(server.env),
    url: server.url ?? "",
    messageUrl: server.messageUrl ?? "",
    headersText: formatKeyValueRecord(server.headers),
  };
}

function buildServerFromDraft(
  draft: ServerDraft,
  base: McpServerConfig | null,
  existingIds: string[],
  t: (key: string) => string,
): McpServerConfig {
  const id = draft.id.trim();
  if (!id) {
    throw new Error(t("mcpHub.invalidName"));
  }
  if (existingIds.includes(id)) {
    throw new Error(t("mcpHub.duplicateName"));
  }

  const parsedTimeout = Number(draft.timeoutMs);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? Math.floor(parsedTimeout) : 60_000;

  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (!command) {
      throw new Error(t("mcpHub.invalidCommand"));
    }
    return {
      ...(base ?? {}),
      id,
      description: draft.description.trim() || undefined,
      docsUrl: draft.docsUrl.trim() || undefined,
      enabled: base?.enabled ?? true,
      transport: "stdio",
      command,
      args: parseLineList(draft.argsText),
      cwd: draft.cwd.trim() || undefined,
      env: parseKeyValueDraft(draft.envText, `${t("mcpHub.invalidKeyValue")} `),
      url: "",
      messageUrl: undefined,
      headers: undefined,
      timeoutMs,
    };
  }

  const url = draft.url.trim();
  if (!url) {
    throw new Error(t("mcpHub.invalidUrl"));
  }
  return {
    ...(base ?? {}),
    id,
    description: draft.description.trim() || undefined,
    docsUrl: draft.docsUrl.trim() || undefined,
    enabled: base?.enabled ?? true,
    transport: draft.transport,
    command: "",
    args: [],
    url,
    messageUrl: draft.transport === "sse" ? draft.messageUrl.trim() || undefined : undefined,
    headers: parseKeyValueDraft(draft.headersText, `${t("mcpHub.invalidKeyValue")} `),
    cwd: undefined,
    env: undefined,
    timeoutMs,
  };
}
export function McpServerEditModal(props: {
  mode: "add" | "edit";
  initialServer: McpServerConfig | null;
  existingServers: McpServerConfig[];
  onClose: () => void;
  onSave: (server: McpServerConfig) => void;
}) {
  const { mode, initialServer, existingServers, onClose, onSave } = props;
  const { t } = useLocale();

  const existingIdsExcludingCurrent = useMemo(() => {
    return existingServers
      .filter((server) => mode !== "edit" || server.id !== initialServer?.id)
      .map((server) => server.id);
  }, [existingServers, initialServer, mode]);

  const [draft, setDraft] = useState<ServerDraft>(() =>
    initialServer ? draftFromServer(initialServer) : blankDraft(existingIdsExcludingCurrent),
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      initialServer ? draftFromServer(initialServer) : blankDraft(existingIdsExcludingCurrent),
    );
    setFormError(null);
  }, [existingIdsExcludingCurrent, initialServer]);

  function updateDraft(patch: Partial<ServerDraft>) {
    setFormError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const server = buildServerFromDraft(draft, initialServer, existingIdsExcludingCurrent, t);
      onSave(server);
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  }

  const isStdio = draft.transport === "stdio";
  const isSse = draft.transport === "sse";
  const title = mode === "add" ? t("mcpHub.addTitle") : t("mcpHub.editTitle");
  const subtitleRaw =
    mode === "add"
      ? t("mcpHub.addSubtitle")
      : t("mcpHub.editSubtitle").replace("{name}", initialServer?.id ?? "");
  const submitLabel = mode === "add" ? t("mcpHub.modalAdd") : t("mcpHub.modalSave");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[92dvh] max-w-3xl flex-col p-0"
        closeLabel={t("settings.cancel")}
        layout="fullscreen-mobile"
        showCloseButton
      >
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="flex-row items-center gap-3 px-6 py-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <McpLogo className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-xs" title={subtitleRaw}>
                {subtitleRaw}
              </DialogDescription>
            </div>
          </DialogHeader>

          <DialogBody className="px-6 py-5">
            <div className="space-y-6">
              <section aria-labelledby="mcp-edit-basics-heading" className="space-y-3">
                <h3
                  id="mcp-edit-basics-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t("mcpHub.basicSettings")}
                </h3>
                <div className="grid gap-x-3 gap-y-4 sm:grid-cols-4">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="mcp-edit-id" className="text-xs text-muted-foreground">
                      {t("mcpHub.serverName")}
                    </Label>
                    <Input
                      id="mcp-edit-id"
                      value={draft.id}
                      placeholder={t("mcpHub.serverNamePlaceholder")}
                      aria-describedby="mcp-edit-id-hint"
                      onChange={(event) => updateDraft({ id: event.currentTarget.value })}
                    />
                    <p id="mcp-edit-id-hint" className="text-xs leading-5 text-muted-foreground">
                      {t("mcpHub.serverNameHint")}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-edit-transport" className="text-xs text-muted-foreground">
                      {t("mcpHub.transport")}
                    </Label>
                    <Select
                      value={draft.transport}
                      onValueChange={(value) => {
                        const transport =
                          value === "http" ? "http" : value === "sse" ? "sse" : "stdio";
                        updateDraft({ transport });
                      }}
                    >
                      <SelectTrigger id="mcp-edit-transport">
                        <SelectValue placeholder={t("mcpHub.selectTransport")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stdio">{t("mcpHub.stdio")}</SelectItem>
                        <SelectItem value="http">{t("mcpHub.http")}</SelectItem>
                        <SelectItem value="sse">{t("mcpHub.sse")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-edit-timeout" className="text-xs text-muted-foreground">
                      {t("mcpHub.timeout")}
                    </Label>
                    <Input
                      id="mcp-edit-timeout"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={draft.timeoutMs}
                      placeholder="60000"
                      onChange={(event) => updateDraft({ timeoutMs: event.currentTarget.value })}
                    />
                  </div>
                </div>
              </section>

              <section
                aria-labelledby="mcp-edit-connection-heading"
                className="space-y-3 border-t border-border/60 pt-5"
              >
                <h3
                  id="mcp-edit-connection-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t("mcpHub.connectionSettings")}
                </h3>
                {isStdio ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="mcp-edit-command" className="text-xs text-muted-foreground">
                          {t("mcpHub.command")}
                        </Label>
                        <Input
                          id="mcp-edit-command"
                          value={draft.command}
                          placeholder="npx"
                          className="font-mono text-[12.5px]"
                          onChange={(event) => updateDraft({ command: event.currentTarget.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="mcp-edit-cwd" className="text-xs text-muted-foreground">
                          {t("mcpHub.cwd")}
                        </Label>
                        <Input
                          id="mcp-edit-cwd"
                          value={draft.cwd}
                          placeholder={t("mcpHub.cwdDefault")}
                          className="font-mono text-[12.5px]"
                          onChange={(event) => updateDraft({ cwd: event.currentTarget.value })}
                        />
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="mcp-edit-args" className="text-xs text-muted-foreground">
                          {t("mcpHub.args")}
                        </Label>
                        <Textarea
                          id="mcp-edit-args"
                          rows={4}
                          value={draft.argsText}
                          placeholder={"-y\n@modelcontextprotocol/server-time"}
                          className="resize-y font-mono text-xs"
                          onChange={(event) => updateDraft({ argsText: event.currentTarget.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="mcp-edit-env" className="text-xs text-muted-foreground">
                          {t("mcpHub.env")}
                        </Label>
                        <Textarea
                          id="mcp-edit-env"
                          rows={4}
                          value={draft.envText}
                          placeholder={"BRAVE_API_KEY=...\nHTTP_PROXY=..."}
                          className="resize-y font-mono text-xs"
                          onChange={(event) => updateDraft({ envText: event.currentTarget.value })}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="mcp-edit-url" className="text-xs text-muted-foreground">
                        {draft.transport === "http" ? t("mcpHub.urlHttp") : t("mcpHub.urlSse")}
                      </Label>
                      <Input
                        id="mcp-edit-url"
                        value={draft.url}
                        placeholder={
                          draft.transport === "http"
                            ? "http://127.0.0.1:3000/mcp"
                            : "http://127.0.0.1:3000/sse"
                        }
                        className="font-mono text-[12.5px]"
                        onChange={(event) => updateDraft({ url: event.currentTarget.value })}
                      />
                    </div>
                    {isSse ? (
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="mcp-edit-message-url"
                          className="text-xs text-muted-foreground"
                        >
                          {t("mcpHub.messageUrl")}
                        </Label>
                        <Input
                          id="mcp-edit-message-url"
                          value={draft.messageUrl}
                          placeholder="http://127.0.0.1:3000/message"
                          className="font-mono text-[12.5px]"
                          onChange={(event) =>
                            updateDraft({
                              messageUrl: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                    ) : null}
                    <div className="space-y-1.5">
                      <Label htmlFor="mcp-edit-headers" className="text-xs text-muted-foreground">
                        {t("mcpHub.headers")}
                      </Label>
                      <Textarea
                        id="mcp-edit-headers"
                        rows={4}
                        value={draft.headersText}
                        placeholder={"Authorization=Bearer ...\nX-API-Key=..."}
                        className="resize-y font-mono text-xs"
                        onChange={(event) =>
                          updateDraft({
                            headersText: event.currentTarget.value,
                          })
                        }
                      />
                    </div>
                  </div>
                )}
              </section>

              <section
                aria-labelledby="mcp-edit-details-heading"
                className="space-y-3 border-t border-border/60 pt-5"
              >
                <h3
                  id="mcp-edit-details-heading"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t("mcpHub.optionalDetails")}
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-edit-description" className="text-xs text-muted-foreground">
                      {t("mcpHub.description")}
                    </Label>
                    <Textarea
                      id="mcp-edit-description"
                      rows={3}
                      value={draft.description}
                      placeholder={t("mcpHub.descriptionPlaceholder")}
                      className="resize-y text-sm"
                      onChange={(event) => updateDraft({ description: event.currentTarget.value })}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-edit-docs-url" className="text-xs text-muted-foreground">
                      {t("mcpHub.docsUrl")}
                    </Label>
                    <Input
                      id="mcp-edit-docs-url"
                      value={draft.docsUrl}
                      placeholder={t("mcpHub.docsUrlPlaceholder")}
                      className="font-mono text-xs"
                      onChange={(event) => updateDraft({ docsUrl: event.currentTarget.value })}
                    />
                  </div>
                </div>
              </section>

              {formError ? (
                <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3 py-2.5 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              ) : null}
            </div>
          </DialogBody>

          <DialogFooter className="flex-row flex-wrap px-6 py-3.5">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button type="submit" className="gap-1.5">
              {mode === "add" ? <Plus className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
