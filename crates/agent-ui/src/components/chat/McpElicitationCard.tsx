// MCP form elicitation cards: the pending form an MCP server asks the user to fill in while
// its tool runs, and the collapsed summary once it is resolved. Pure presentation shared by
// the desktop app and the WebUI; answering is injected by the caller (desktop pending store
// or gateway RPC). Everything the server supplies (server name, message, titles,
// descriptions, labels, error text) is rendered as plain text, never markdown or HTML.
// Typed values live only in this component's state: nothing here persists them.

import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  McpLogo,
  ShieldAlert,
} from "@liveagent/ui/components/IconSet";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useId, useState } from "react";
import {
  buildMcpElicitationContent,
  formatMcpElicitationValue,
  initialMcpElicitationDraft,
  isMcpElicitationChoice,
  type McpElicitationAction,
  type McpElicitationContent,
  type McpElicitationDraft,
  type McpElicitationDraftValue,
  type McpElicitationField,
  type McpElicitationIssue,
  type McpElicitationRecord,
  type McpElicitationRequest,
  type McpElicitationSubmitOutcome,
  mcpElicitationFieldLabel,
  mcpElicitationOutcome,
} from "../../lib/chat/mcpElicitation";
import { cn } from "../../lib/shared/utils";

type Translate = (key: string) => string;

function fill(template: string, values?: Record<string, string | number>) {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

function issueText(t: Translate, issue: McpElicitationIssue) {
  return fill(t(issue.key), issue.values);
}

function formatCountdown(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Longest answer window a deadline may claim before it is treated as clock skew. */
const MAX_TRUSTED_WINDOW_MS = 60 * 60 * 1000;

/**
 * Countdown to the backend's deadline. The deadline is stamped with the backend's clock; a
 * remote browser's clock can be off, so a deadline already past (or absurdly far away) when
 * the card mounts is not trusted: no countdown is shown and the form is not locked. The
 * backend rejects a late answer either way.
 */
function useDeadline(active: boolean, deadlineAt?: number) {
  const [trusted] = useState(() => {
    if (deadlineAt === undefined) return false;
    const remaining = deadlineAt - Date.now();
    return remaining > 0 && remaining <= MAX_TRUSTED_WINDOW_MS;
  });
  const [remainingMs, setRemainingMs] = useState(() =>
    deadlineAt === undefined ? 0 : deadlineAt - Date.now(),
  );
  useEffect(() => {
    if (!active || !trusted || deadlineAt === undefined) return;
    const tick = () => setRemainingMs(deadlineAt - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, trusted, deadlineAt]);
  return { trusted, remainingMs };
}

/** Constraint hints shown under a field label, e.g. "3–20 characters · Email address". */
function fieldHints(t: Translate, field: McpElicitationField): string[] {
  const hints: string[] = [];
  if (field.type === "string" && !isMcpElicitationChoice(field)) {
    if (field.minLength !== undefined && field.maxLength !== undefined) {
      hints.push(
        fill(t("chat.mcpElicitation.hint.lengthRange"), {
          min: field.minLength,
          max: field.maxLength,
        }),
      );
    } else if (field.minLength !== undefined) {
      hints.push(fill(t("chat.mcpElicitation.hint.minLength"), { count: field.minLength }));
    } else if (field.maxLength !== undefined) {
      hints.push(fill(t("chat.mcpElicitation.hint.maxLength"), { count: field.maxLength }));
    }
    if (field.format === "email") hints.push(t("chat.mcpElicitation.hint.email"));
    if (field.format === "uri") hints.push(t("chat.mcpElicitation.hint.uri"));
    if (field.format === "date") hints.push(t("chat.mcpElicitation.hint.date"));
    if (field.format === "date-time") hints.push(t("chat.mcpElicitation.hint.dateTime"));
    if (field.pattern) {
      hints.push(fill(t("chat.mcpElicitation.hint.pattern"), { pattern: field.pattern }));
    }
  }
  if (field.type === "number" || field.type === "integer") {
    if (field.type === "integer") hints.push(t("chat.mcpElicitation.hint.integer"));
    if (field.minimum !== undefined && field.maximum !== undefined) {
      hints.push(
        fill(t("chat.mcpElicitation.hint.range"), { min: field.minimum, max: field.maximum }),
      );
    } else if (field.minimum !== undefined) {
      hints.push(fill(t("chat.mcpElicitation.hint.minimum"), { value: field.minimum }));
    } else if (field.maximum !== undefined) {
      hints.push(fill(t("chat.mcpElicitation.hint.maximum"), { value: field.maximum }));
    }
  }
  if (field.type === "array") {
    if (field.minItems !== undefined && field.maxItems !== undefined) {
      hints.push(
        fill(t("chat.mcpElicitation.hint.itemsRange"), {
          min: field.minItems,
          max: field.maxItems,
        }),
      );
    } else if (field.minItems !== undefined) {
      hints.push(fill(t("chat.mcpElicitation.hint.minItems"), { count: field.minItems }));
    } else if (field.maxItems !== undefined) {
      hints.push(fill(t("chat.mcpElicitation.hint.maxItems"), { count: field.maxItems }));
    } else {
      hints.push(t("chat.mcpElicitation.hint.multiple"));
    }
  }
  return hints;
}

function ChoiceMark({ multiple, selected }: { multiple: boolean; selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center border",
        multiple ? "rounded-sm" : "rounded-full",
        selected
          ? "border-foreground bg-foreground text-background"
          : "border-muted-foreground/40 group-hover/option:border-muted-foreground/70",
      )}
    >
      {multiple ? (
        selected ? (
          <Check className="size-3" />
        ) : null
      ) : selected ? (
        <span className="size-1.5 rounded-full bg-background" />
      ) : null}
    </span>
  );
}

function OptionButton({
  role,
  selected,
  disabled,
  label,
  onClick,
}: {
  role: "radio" | "checkbox";
  selected: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is radio or checkbox, both support aria-checked.
    <button
      type="button"
      role={role}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group/option flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
        "transition-colors duration-150 enabled:hover:bg-foreground/[0.04] disabled:cursor-not-allowed",
        selected ? "text-foreground" : "text-foreground/85",
      )}
    >
      <ChoiceMark multiple={role === "checkbox"} selected={selected} />
      <span className="min-w-0 break-words">{label}</span>
    </button>
  );
}

function FieldInput({
  field,
  value,
  disabled,
  invalid,
  inputId,
  describedBy,
  onChange,
}: {
  field: McpElicitationField;
  value: McpElicitationDraftValue;
  disabled: boolean;
  invalid: boolean;
  inputId: string;
  describedBy?: string;
  onChange: (value: McpElicitationDraftValue) => void;
}) {
  const { t } = useLocale();
  const [revealed, setRevealed] = useState(false);
  const label = mcpElicitationFieldLabel(field);

  if (field.type === "boolean") {
    const choices: Array<{ value: boolean; label: string }> = [
      { value: true, label: t("chat.mcpElicitation.yes") },
      { value: false, label: t("chat.mcpElicitation.no") },
    ];
    return (
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
        {choices.map((choice) => (
          <OptionButton
            key={String(choice.value)}
            role="radio"
            selected={value === choice.value}
            disabled={disabled}
            label={choice.label}
            onClick={() =>
              // Clicking the chosen answer again clears an optional field.
              onChange(value === choice.value && !field.required ? undefined : choice.value)
            }
          />
        ))}
      </div>
    );
  }

  if (field.type === "array") {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset aria-label={label} className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
        {(field.options ?? []).map((option) => {
          const selected = chosen.includes(option.value);
          return (
            <OptionButton
              key={option.value}
              role="checkbox"
              selected={selected}
              disabled={disabled}
              label={option.label}
              onClick={() =>
                onChange(
                  selected
                    ? chosen.filter((item) => item !== option.value)
                    : [...chosen, option.value],
                )
              }
            />
          );
        })}
      </fieldset>
    );
  }

  if (isMcpElicitationChoice(field)) {
    return (
      <div role="radiogroup" aria-label={label} className="flex flex-col gap-0.5">
        {(field.options ?? []).map((option) => (
          <OptionButton
            key={option.value}
            role="radio"
            selected={value === option.value}
            disabled={disabled}
            label={option.label}
            onClick={() => onChange(value === option.value && !field.required ? "" : option.value)}
          />
        ))}
      </div>
    );
  }

  const text = typeof value === "string" ? value : "";
  const numeric = field.type === "number" || field.type === "integer";
  const inputType = field.sensitive
    ? revealed
      ? "text"
      : "password"
    : field.format === "date"
      ? "date"
      : field.format === "email"
        ? "email"
        : field.format === "uri"
          ? "url"
          : "text";
  return (
    <div className="flex items-center gap-1">
      <Input
        id={inputId}
        type={inputType}
        value={text}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-required={field.required || undefined}
        inputMode={numeric ? (field.type === "integer" ? "numeric" : "decimal") : undefined}
        placeholder={field.format === "date-time" ? "2026-01-02T15:04:05Z" : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-mcp-elicitation-sensitive={field.sensitive ? "true" : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn("h-8 text-sm", invalid && "border-destructive/60")}
      />
      {field.sensitive ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-pressed={revealed}
          aria-label={
            revealed ? t("chat.mcpElicitation.hideValue") : t("chat.mcpElicitation.showValue")
          }
          title={revealed ? t("chat.mcpElicitation.hideValue") : t("chat.mcpElicitation.showValue")}
          onClick={() => setRevealed((current) => !current)}
          className="size-8 shrink-0 text-muted-foreground"
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      ) : null}
    </div>
  );
}

function ServerHeading({ server, tool }: { server: string; tool?: string }) {
  const { t } = useLocale();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <McpLogo className="size-3.5 shrink-0" />
      <span>{t("chat.mcpElicitation.serverLabel")}</span>
      <span
        data-mcp-elicitation-server
        className="max-w-full truncate rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground"
      >
        {server || t("chat.mcpElicitation.unknownServer")}
      </span>
      {tool ? <span className="truncate font-mono text-muted-foreground/70">· {tool}</span> : null}
    </div>
  );
}

export type McpElicitationSubmit = (
  action: McpElicitationAction,
  content?: McpElicitationContent,
) => Promise<McpElicitationSubmitOutcome>;

/** The pending form for one elicitation request. */
export function McpElicitationForm({
  request,
  interactive,
  onSubmit,
}: {
  request: McpElicitationRequest;
  /** True when this side can answer (desktop pending store, or WebUI with a live relay). */
  interactive: boolean;
  onSubmit?: McpElicitationSubmit;
}) {
  const { t } = useLocale();
  const formId = useId();
  const [draft, setDraft] = useState<McpElicitationDraft>(() =>
    initialMcpElicitationDraft(request.fields),
  );
  const [showIssues, setShowIssues] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState<McpElicitationAction | null>(null);
  const [sent, setSent] = useState(false);
  const { trusted, remainingMs } = useDeadline(interactive && !sent, request.deadlineAt);
  const expired = trusted && remainingMs <= 0;
  const canInteract = interactive && Boolean(onSubmit) && !busy && !sent && !expired;

  const validation = buildMcpElicitationContent(request.fields, draft);
  const clientIssues = validation.ok ? {} : validation.issues;
  const hasSensitive = request.fields.some((field) => field.sensitive);

  const updateField = (name: string, value: McpElicitationDraftValue) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setServerErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
    setFormError("");
  };

  const send = async (action: McpElicitationAction) => {
    if (!onSubmit || !canInteract) return;
    let content: McpElicitationContent | undefined;
    if (action === "accept") {
      if (!validation.ok) {
        setShowIssues(true);
        return;
      }
      content = validation.content;
    }
    setBusy(action);
    setFormError("");
    try {
      const outcome = await onSubmit(action, content);
      if (outcome.ok) {
        setSent(true);
        // Drop typed secrets as soon as they are delivered.
        setDraft((current) => {
          const next = { ...current };
          for (const field of request.fields) if (field.sensitive) next[field.name] = "";
          return next;
        });
        return;
      }
      const fieldErrors = outcome.fieldErrors ?? {};
      setServerErrors(fieldErrors);
      setShowIssues(true);
      const knownFieldError = Object.keys(fieldErrors).some((name) =>
        request.fields.some((field) => field.name === name),
      );
      if (!knownFieldError || outcome.message) {
        setFormError(outcome.message || t("chat.mcpElicitation.submitFailed"));
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t("chat.mcpElicitation.submitFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full max-w-panel-36rem" data-mcp-elicitation={request.elicitationId}>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send("accept");
        }}
        className="overflow-hidden rounded-xl border border-border/60 bg-muted/20"
      >
        <div className="flex flex-col gap-3 px-4 pb-3 pt-3.5">
          <ServerHeading server={request.server} tool={request.tool} />
          {request.message ? (
            <div className="whitespace-pre-wrap break-words text-sm font-medium leading-1p5 text-foreground">
              {request.message}
            </div>
          ) : null}
          {hasSensitive ? (
            <div
              role="note"
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2 text-xs leading-1p5 text-amber-700 dark:text-amber-300"
            >
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {fill(t("chat.mcpElicitation.sensitiveWarning"), {
                  server: request.server || t("chat.mcpElicitation.unknownServer"),
                })}
              </span>
            </div>
          ) : null}
          {request.fields.length > 0 ? (
            <div className="flex flex-col gap-3">
              {request.fields.map((field) => {
                const inputId = `${formId}-${field.name}`;
                const hintId = `${inputId}-hint`;
                const errorId = `${inputId}-error`;
                const serverError = serverErrors[field.name];
                const clientIssue = showIssues ? clientIssues[field.name] : undefined;
                const errorMessage =
                  serverError ?? (clientIssue ? issueText(t, clientIssue) : undefined);
                const hints = fieldHints(t, field);
                const describedBy =
                  [field.description || hints.length > 0 ? hintId : "", errorMessage ? errorId : ""]
                    .filter(Boolean)
                    .join(" ") || undefined;
                return (
                  <div key={field.name} className="flex min-w-0 flex-col gap-1">
                    <label
                      htmlFor={inputId}
                      className="flex min-w-0 items-baseline gap-1 text-sm font-medium text-foreground"
                    >
                      <span className="min-w-0 break-words">{mcpElicitationFieldLabel(field)}</span>
                      {field.required ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="text-destructive"
                            title={t("chat.mcpElicitation.required")}
                          >
                            *
                          </span>
                          <span className="sr-only">{t("chat.mcpElicitation.required")}</span>
                        </>
                      ) : null}
                      {field.sensitive ? (
                        <Badge variant="muted" size="compact" className="self-center">
                          {t("chat.mcpElicitation.sensitiveBadge")}
                        </Badge>
                      ) : null}
                    </label>
                    {field.description || hints.length > 0 ? (
                      <div id={hintId} className="text-xs leading-1p5 text-muted-foreground">
                        {field.description ? (
                          <div className="whitespace-pre-wrap break-words">{field.description}</div>
                        ) : null}
                        {hints.length > 0 ? (
                          <div className="break-words text-muted-foreground/80">
                            {hints.join(" · ")}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <FieldInput
                      field={field}
                      value={draft[field.name]}
                      disabled={!canInteract}
                      invalid={Boolean(errorMessage)}
                      inputId={inputId}
                      describedBy={describedBy}
                      onChange={(value) => updateField(field.name, value)}
                    />
                    {errorMessage ? (
                      <div
                        id={errorId}
                        role="alert"
                        data-mcp-elicitation-error={field.name}
                        className="break-words text-xs text-destructive"
                      >
                        {errorMessage}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {formError ? (
            <div role="alert" className="break-words text-xs text-destructive">
              {formError}
            </div>
          ) : null}
        </div>

        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
          <div className="min-w-0 text-xs tabular-nums text-muted-foreground/70">
            {sent ? (
              <span>{t("chat.mcpElicitation.sent")}</span>
            ) : expired ? (
              <span className="text-amber-600 dark:text-amber-400">
                {t("chat.mcpElicitation.expired")}
              </span>
            ) : interactive && trusted ? (
              <span role="timer">
                {fill(t("chat.mcpElicitation.countdown"), { time: formatCountdown(remainingMs) })}
              </span>
            ) : !interactive ? (
              <span>{t("chat.mcpElicitation.waiting")}</span>
            ) : null}
          </div>
          {interactive && !sent ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canInteract}
                onClick={() => void send("cancel")}
                className="h-7 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground"
              >
                {busy === "cancel"
                  ? t("chat.mcpElicitation.sending")
                  : t("chat.mcpElicitation.cancel")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canInteract}
                onClick={() => void send("decline")}
                className="h-7 rounded-full px-3 text-xs"
              >
                {busy === "decline"
                  ? t("chat.mcpElicitation.sending")
                  : t("chat.mcpElicitation.decline")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!canInteract}
                className="h-7 rounded-full px-3.5 text-xs"
              >
                {busy === "accept"
                  ? t("chat.mcpElicitation.sending")
                  : t("chat.mcpElicitation.submit")}
              </Button>
            </div>
          ) : null}
        </div>
      </form>
    </div>
  );
}

const OUTCOME_KEYS: Record<ReturnType<typeof mcpElicitationOutcome>, string> = {
  accepted: "chat.mcpElicitation.outcome.accepted",
  declined: "chat.mcpElicitation.outcome.declined",
  cancelled: "chat.mcpElicitation.outcome.cancelled",
  timedOut: "chat.mcpElicitation.outcome.timedOut",
  runCancelled: "chat.mcpElicitation.outcome.runCancelled",
  user: "chat.mcpElicitation.outcome.accepted",
  timeout: "chat.mcpElicitation.outcome.timedOut",
  no_client: "chat.mcpElicitation.auto.no_client",
  unattended: "chat.mcpElicitation.auto.unattended",
  limit: "chat.mcpElicitation.auto.limit",
};

/** The collapsed summary of a resolved (or automatically declined) elicitation. */
export function McpElicitationSummary({ record }: { record: McpElicitationRecord }) {
  const { t } = useLocale();
  const outcome = mcpElicitationOutcome(record);
  const server = record.server || t("chat.mcpElicitation.unknownServer");

  if (outcome === "no_client" || outcome === "unattended" || outcome === "limit") {
    // Nobody was asked: a small note, not a card.
    return (
      <div
        data-mcp-elicitation-note={outcome}
        className="flex min-w-0 items-start gap-1.5 text-xs leading-1p5 text-muted-foreground"
      >
        <McpLogo className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{fill(t(OUTCOME_KEYS[outcome]), { server })}</span>
      </div>
    );
  }

  const labels = { yes: t("chat.mcpElicitation.yes"), no: t("chat.mcpElicitation.no") };
  const content = record.content ?? {};
  const redacted = new Set(record.redacted ?? []);
  const rows: Array<{ key: string; label: string; value: string; redacted: boolean }> = [];
  if (record.action === "accept") {
    const seen = new Set<string>();
    for (const field of record.fields) {
      seen.add(field.name);
      if (redacted.has(field.name)) {
        rows.push({
          key: field.name,
          label: mcpElicitationFieldLabel(field),
          value: "",
          redacted: true,
        });
      } else if (field.name in content) {
        rows.push({
          key: field.name,
          label: mcpElicitationFieldLabel(field),
          value: formatMcpElicitationValue(field, content[field.name], labels),
          redacted: false,
        });
      }
    }
    for (const name of Object.keys(content)) {
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        key: name,
        label: name,
        value: formatMcpElicitationValue(undefined, content[name], labels),
        redacted: false,
      });
    }
    for (const name of redacted) {
      if (seen.has(name)) continue;
      rows.push({ key: name, label: name, value: "", redacted: true });
    }
  }
  const tone = outcome === "accepted" ? "success" : outcome === "timedOut" ? "warning" : "muted";

  return (
    <div
      className="w-full max-w-panel-36rem rounded-xl border border-border/60 bg-muted/10 px-3.5 py-2.5"
      data-mcp-elicitation-summary={outcome}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <ServerHeading server={record.server} tool={record.tool} />
        {tone === "success" ? (
          <Badge variant="success" className="text-xs">
            <Check className="size-3" />
            {t(OUTCOME_KEYS[outcome])}
          </Badge>
        ) : tone === "warning" ? (
          <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-3" />
            {t(OUTCOME_KEYS[outcome])}
          </span>
        ) : (
          <Badge variant="muted" className="text-xs">
            {t(OUTCOME_KEYS[outcome])}
          </Badge>
        )}
      </div>
      {record.message ? (
        <div className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-1p5 text-muted-foreground">
          {record.message}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <dt className="truncate text-muted-foreground">{row.label}</dt>
              <dd
                className={cn(
                  "min-w-0 whitespace-pre-wrap break-words",
                  row.redacted ? "italic text-muted-foreground/70" : "text-foreground",
                )}
              >
                {row.redacted ? t("chat.mcpElicitation.redacted") : row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
