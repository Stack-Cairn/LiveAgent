// 请求头编辑器：从旧对话框的"请求配置"面板抽出，供请求配置抽屉的供应商级
// 请求头（含导入与"模拟 CLI"）与端点请求头（精简模式）共用。编辑期间保留本地
// 行（含尚未填名的空行），只把合法的头写回设置；不合法的行留在界面上标红并计数，
// 让用户看得出哪些没生效。

import { ClipboardPaste, Fingerprint, List, Plus, Trash2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  applyCliIdentity,
  CLI_IDENTITY_USER_AGENTS,
  type CliIdentityProviderId,
  type CustomHeader,
  CustomHeaderImportError,
  type CustomHeaderImportErrorCode,
  type CustomHeaderImportIssue,
  isReservedCustomHeaderKey,
  isValidCustomHeaderKey,
  isValidCustomHeaderValue,
  listCliIdentityProviderIds,
  mergeImportedCustomHeaders,
  parseCustomHeadersImport,
} from "@liveagent/ui/lib/providers/customHeaders";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { customHeaderIssueMessage, getCustomHeaderIssue } from "../ProviderPresentation";

type HeaderImportErrorCode = CustomHeaderImportErrorCode | "no-valid" | "failed";

type HeaderImportSummary = {
  importedCount: number;
  overwrittenCount: number;
  removedCount?: number;
  issues: CustomHeaderImportIssue[];
};

function validHeaders(headers: readonly CustomHeader[]): CustomHeader[] {
  return headers.filter(
    (header) =>
      isValidCustomHeaderKey(header.key) &&
      isValidCustomHeaderValue(header.value) &&
      !isReservedCustomHeaderKey(header.key),
  );
}

/** 行级问题：填了值却没填键的行也算无效（它不会被写入），全空的新行不算。 */
function rowIssue(row: CustomHeader) {
  return getCustomHeaderIssue(row, row.value.trim().length > 0);
}

function headersKey(headers: readonly CustomHeader[]): string {
  return JSON.stringify(headers.map((header) => [header.key.trim(), header.value]));
}

export function CustomHeadersEditor(props: {
  headers: readonly CustomHeader[];
  onChange: (headers: CustomHeader[]) => void;
  presetKeys: readonly string[];
  /** 提供时显示"模拟 CLI"下拉，并把该身份档排在最前 */
  identity?: CliIdentityProviderId;
  /** 精简模式：无导入、无模拟 CLI、无空态大按钮（端点请求头） */
  compact?: boolean;
  title: string;
  idPrefix: string;
}) {
  const { headers, onChange, presetKeys, identity, compact, title, idPrefix } = props;
  const { t } = useLocale();
  const [rows, setRows] = useState<CustomHeader[]>(() => headers.map((header) => ({ ...header })));
  const committedRef = useRef(headersKey(validHeaders(headers)));
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<HeaderImportErrorCode | null>(null);
  const [importSummary, setImportSummary] = useState<HeaderImportSummary | null>(null);
  const [suggest, setSuggest] = useState<{
    index: number;
    rect: { left: number; top: number; width: number };
  } | null>(null);
  const [suggestActive, setSuggestActive] = useState(0);
  const keyRefs = useRef<Array<HTMLInputElement | null>>([]);
  const valueRefs = useRef<Array<HTMLInputElement | null>>([]);

  // 外部变化（切换供应商、探测写入）时重置本地行；自己提交的回声不重置。
  useEffect(() => {
    const incoming = headersKey(validHeaders(headers));
    if (incoming === committedRef.current) return;
    committedRef.current = incoming;
    setRows(headers.map((header) => ({ ...header })));
  }, [headers]);

  function commit(next: CustomHeader[]) {
    setRows(next);
    const valid = validHeaders(next);
    const key = headersKey(valid);
    if (key === committedRef.current) return;
    committedRef.current = key;
    onChange(valid);
  }

  function focusRow(index: number, field: "key" | "value") {
    requestAnimationFrame(() => {
      (field === "key" ? keyRefs.current[index] : valueRefs.current[index])?.focus();
    });
  }

  function updateRow(index: number, field: "key" | "value", value: string) {
    commit(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)));
  }

  function addRow(key = "") {
    const index = rows.length;
    commit([...rows, { key, value: "" }]);
    focusRow(index, key ? "value" : "key");
  }

  function removeRow(index: number) {
    commit(rows.filter((_, rowIndex) => rowIndex !== index));
  }

  function openSuggest(index: number) {
    const input = keyRefs.current[index];
    if (!input) return;
    const rect = input.getBoundingClientRect();
    setSuggest({ index, rect: { left: rect.left, top: rect.bottom + 4, width: rect.width } });
    setSuggestActive(0);
  }

  function applySuggestion(preset: string) {
    if (!suggest) return;
    updateRow(suggest.index, "key", preset);
    setSuggest(null);
    focusRow(suggest.index, "value");
  }

  function applyIdentity(target: CliIdentityProviderId) {
    const result = applyCliIdentity(rows, target);
    commit(result.headers);
    setSuggest(null);
    setImportOpen(false);
    setImportError(null);
    setImportSummary({
      importedCount: result.importedCount,
      overwrittenCount: result.overwrittenCount,
      removedCount: result.removedCount,
      issues: [],
    });
  }

  function importHeaders() {
    setImportError(null);
    setImportSummary(null);
    try {
      const parsed = parseCustomHeadersImport(importText);
      if (parsed.headers.length === 0) {
        setImportError("no-valid");
        setImportSummary({ importedCount: 0, overwrittenCount: 0, issues: parsed.issues });
        return;
      }
      const merged = mergeImportedCustomHeaders(rows, parsed.headers);
      commit(merged.headers);
      setSuggest(null);
      setImportSummary({
        importedCount: merged.importedCount,
        overwrittenCount: merged.overwrittenCount,
        issues: parsed.issues,
      });
      setImportText("");
      setImportOpen(false);
    } catch (error) {
      setImportError(error instanceof CustomHeaderImportError ? error.code : "failed");
    }
  }

  const suggestQuery = suggest ? (rows[suggest.index]?.key ?? "").trim().toLowerCase() : "";
  const usedKeys = new Set(
    suggest
      ? rows
          .filter((_, index) => index !== suggest.index)
          .map((row) => row.key.trim().toLowerCase())
          .filter(Boolean)
      : [],
  );
  const suggestItems =
    suggest && suggestQuery
      ? presetKeys.filter((preset) => {
          const lower = preset.toLowerCase();
          return !usedKeys.has(lower) && lower.includes(suggestQuery) && lower !== suggestQuery;
        })
      : [];
  const suggestActiveIndex = Math.min(suggestActive, Math.max(0, suggestItems.length - 1));
  const importErrorMessage = importError
    ? t(`settings.customHeaderImportError.${importError}`)
    : null;
  const importSummaryMessage = importSummary
    ? [
        `${t("settings.customHeaderImportSummary.imported")} ${importSummary.importedCount}`,
        `${t("settings.customHeaderImportSummary.overwritten")} ${importSummary.overwrittenCount}`,
        (importSummary.removedCount ?? 0) > 0
          ? `${t("settings.customHeaderImportSummary.removed")} ${importSummary.removedCount}`
          : null,
        importSummary.issues.length > 0
          ? `${t("settings.customHeaderImportSummary.skipped")} ${importSummary.issues
              .map(
                (issue) =>
                  `${issue.key ?? t("settings.customHeaderImportUnknownItem")} (${t(
                    `settings.customHeaderImportIssue.${issue.reason}`,
                  )})`,
              )
              .join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("; ")
    : null;
  const issues = rows.map(rowIssue);
  const firstIssue = issues.find((issue) => issue !== null) ?? null;
  const ignoredCount = issues.filter((issue) => issue !== null).length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground/85">{title}</span>
        {rows.length > 0 ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        ) : null}
        <span className="flex-1" />
        {identity && !compact ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" />
              }
            >
              <Fingerprint className="h-3.5 w-3.5" />
              {t("settings.cliIdentityHeaders")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                {t("settings.cliIdentityHeadersHint")}
              </DropdownMenuLabel>
              {listCliIdentityProviderIds(identity).map((item) => (
                <DropdownMenuItem
                  key={item}
                  className="items-center gap-2 rounded-md py-1.5 text-xs"
                  onSelect={() => applyIdentity(item)}
                >
                  <span className="shrink-0 whitespace-nowrap font-medium leading-5">
                    {t(`settings.cliIdentity.${item}`)}
                  </span>
                  {item === identity ? (
                    <span className="shrink-0 whitespace-nowrap rounded bg-primary/10 px-1 py-px text-[10px] font-medium text-primary">
                      {t("settings.cliIdentityRecommended")}
                    </span>
                  ) : null}
                  <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                    {CLI_IDENTITY_USER_AGENTS[item].split(" ")[0]}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {!compact ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-7 gap-1.5 text-xs",
              importOpen && "border-primary/50 bg-primary/10 text-primary",
            )}
            aria-expanded={importOpen}
            onClick={() => {
              setImportOpen((open) => !open);
              setImportError(null);
              setImportSummary(null);
              setSuggest(null);
            }}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            {t("settings.importCustomHeaders")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={importOpen}
          onClick={() => addRow()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("settings.addCustomHeader")}
        </Button>
      </div>

      {importOpen ? (
        <div className="rounded-xl border bg-card p-3">
          <Label htmlFor={`${idPrefix}-import`} className="mb-2 block text-xs font-medium">
            {t("settings.customHeaderImportLabel")}
          </Label>
          <Textarea
            id={`${idPrefix}-import`}
            value={importText}
            className="min-h-[100px] w-full resize-y font-mono text-xs leading-relaxed"
            placeholder={t("settings.customHeaderImportPlaceholder")}
            aria-invalid={importErrorMessage ? true : undefined}
            spellCheck={false}
            autoFocus
            onChange={(event) => {
              setImportText(event.currentTarget.value);
              setImportError(null);
              setImportSummary(null);
            }}
          />
          {importErrorMessage ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {importErrorMessage}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => {
                setImportOpen(false);
                setImportText("");
                setImportError(null);
              }}
            >
              {t("settings.cancelCustomHeaderImport")}
            </Button>
            <Button type="button" size="sm" className="h-7" onClick={importHeaders}>
              {t("settings.parseAndImportCustomHeaders")}
            </Button>
          </div>
        </div>
      ) : null}

      {importSummaryMessage ? (
        <p
          className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {importSummaryMessage}
        </p>
      ) : null}

      {importOpen ? null : rows.length === 0 ? (
        compact ? (
          <p className="text-[11px] text-muted-foreground/70">{t("settings.noCustomHeaders")}</p>
        ) : (
          <button
            type="button"
            className="flex w-full flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-accent/20"
            onClick={() => addRow()}
          >
            <List className="h-5 w-5 text-muted-foreground/60" />
            <span className="mt-1 text-xs font-medium text-muted-foreground">
              {t("settings.noCustomHeaders")}
            </span>
            <span className="text-[11px] text-muted-foreground/75">
              {t("settings.noCustomHeadersHint")}
            </span>
          </button>
        )
      ) : (
        <div className="space-y-1.5" onScroll={() => setSuggest(null)}>
          {rows.map((row, index) => {
            const issue = issues[index];
            const issueTitle = issue ? customHeaderIssueMessage(issue, t) : undefined;
            const valueIssue = issue === "invalid-value";
            const keyIssue = issue !== null && !valueIssue;
            const suggestOpen = suggest?.index === index && suggestItems.length > 0;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 行是有序受控编辑器，按索引变更；内容派生 key 会在每次按键时重挂输入框。
                key={index}
                className={cn(
                  "group relative flex items-stretch overflow-hidden rounded-lg border bg-card transition-colors focus-within:border-primary/45 hover:border-muted-foreground/30 max-[720px]:flex-wrap",
                  issue && "border-destructive/60 focus-within:border-destructive",
                )}
              >
                <Input
                  ref={(element) => {
                    keyRefs.current[index] = element;
                  }}
                  value={row.key}
                  className={cn(
                    "h-8 w-[180px] shrink-0 rounded-none border-0 border-r bg-muted/30 px-3 font-mono text-xs shadow-none focus-visible:ring-0 max-[720px]:w-full max-[720px]:border-b max-[720px]:border-r-0",
                    keyIssue && "text-destructive",
                  )}
                  placeholder={t("settings.customHeaderKeyPlaceholder")}
                  aria-label={t("settings.customHeaderName")}
                  aria-invalid={keyIssue ? true : undefined}
                  role="combobox"
                  aria-expanded={suggestOpen}
                  aria-controls={suggestOpen ? `${idPrefix}-suggest` : undefined}
                  aria-autocomplete="list"
                  title={issueTitle}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    updateRow(index, "key", event.currentTarget.value);
                    openSuggest(index);
                  }}
                  onFocus={() => openSuggest(index)}
                  onBlur={() => setSuggest(null)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      if (suggestOpen)
                        setSuggestActive((suggestActiveIndex + 1) % suggestItems.length);
                      else openSuggest(index);
                      return;
                    }
                    if (event.key === "ArrowUp" && suggestOpen) {
                      event.preventDefault();
                      setSuggestActive(
                        (suggestActiveIndex - 1 + suggestItems.length) % suggestItems.length,
                      );
                      return;
                    }
                    if (event.key === "Escape" && suggest) {
                      event.preventDefault();
                      setSuggest(null);
                      return;
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (suggestOpen) {
                      applySuggestion(suggestItems[suggestActiveIndex]);
                      return;
                    }
                    focusRow(index, "value");
                  }}
                />
                <div className="relative min-w-0 flex-1 max-[720px]:basis-full">
                  <Input
                    ref={(element) => {
                      valueRefs.current[index] = element;
                    }}
                    type="text"
                    value={row.value}
                    className={cn(
                      "h-8 w-full rounded-none border-0 bg-transparent pl-3 pr-10 font-mono text-xs shadow-none focus-visible:ring-0",
                      valueIssue && "text-destructive",
                    )}
                    placeholder={t("settings.customHeaderValue")}
                    aria-label={t("settings.customHeaderValue")}
                    aria-invalid={valueIssue ? true : undefined}
                    title={valueIssue ? issueTitle : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => updateRow(index, "value", event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      if (index === rows.length - 1) addRow();
                      else focusRow(index + 1, "key");
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 max-[720px]:opacity-100"
                    onClick={() => removeRow(index)}
                    title={t("settings.removeCustomHeader")}
                    aria-label={t("settings.removeCustomHeader")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {firstIssue && !importOpen ? (
        <p className="text-xs leading-relaxed text-destructive" role="alert">
          {t("settings.customHeaderRowsIgnored").replace("{count}", String(ignoredCount))}
          {" · "}
          {customHeaderIssueMessage(firstIssue, t)}
        </p>
      ) : null}

      {suggest && suggestItems.length > 0
        ? createPortal(
            <div
              id={`${idPrefix}-suggest`}
              role="listbox"
              className="layer-popover fixed overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
              style={{ left: suggest.rect.left, top: suggest.rect.top, width: suggest.rect.width }}
            >
              {suggestItems.map((preset, itemIndex) => (
                <button
                  key={preset}
                  type="button"
                  role="option"
                  aria-selected={itemIndex === suggestActiveIndex}
                  className={cn(
                    "flex w-full items-center rounded-md px-2.5 py-2 text-left font-mono text-xs text-muted-foreground transition-colors",
                    itemIndex === suggestActiveIndex && "bg-accent text-foreground",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSuggestActive(itemIndex)}
                  onClick={() => applySuggestion(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
