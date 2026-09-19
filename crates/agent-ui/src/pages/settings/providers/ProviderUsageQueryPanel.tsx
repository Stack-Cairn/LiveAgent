// 用量查询分区：从旧对话框的"用量查询"面板迁入详情底部。编辑器持有草稿，
// 变更后短延迟写回设置（秘密占位符经 serializeUsageQueryDraft 还原）；测试查询
// 始终按草稿执行，不落库。

import {
  getUsagePlanDisplay,
  testProviderUsage,
  type UsageData,
} from "@liveagent/app/lib/providers/usageQuery";
import type { CustomProvider, UsageQueryMode } from "@liveagent/app/lib/settings";
import { ExternalLink, Eye, EyeOff, RefreshCw } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  applyUsageQueryModePreset,
  clampUsageQueryTimeoutSecs,
  createUsageQueryDraft,
  detectCodingPlanProvider,
  matchBalanceProviders,
  requiresCustomUsageQueryConfirmation,
  serializeUsageQueryDraft,
  setUsageQueryScript,
  USAGE_QUERY_CODING_PLAN_PROVIDERS,
} from "@liveagent/ui/pages/settings/providerUtils";
import { useEffect, useRef, useState } from "react";
import { USAGE_QUERY_SCRIPT_HELP_EXAMPLE, UsagePlanLine } from "../ProviderPresentation";

const COMMIT_DELAY_MS = 400;

type UsageQueryDraft = ReturnType<typeof createUsageQueryDraft>;

export function ProviderUsageQueryPanel(props: {
  provider: CustomProvider;
  onChange: (updater: (provider: CustomProvider) => CustomProvider) => void;
  isGatewayWebui: boolean;
}) {
  const { provider, onChange, isGatewayWebui } = props;
  const { t } = useLocale();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [draft, setDraft] = useState<UsageQueryDraft>(() =>
    applyUsageQueryModePreset(
      createUsageQueryDraft(provider.usageQuery, isGatewayWebui),
      provider.usageQuery.mode,
    ),
  );
  const [customConfirmed, setCustomConfirmed] = useState(
    () => provider.usageQuery.enabled && provider.usageQuery.mode === "custom",
  );
  const [timeoutInput, setTimeoutInput] = useState(() => String(draft.timeoutSecs));
  const [showVariableApiKey, setShowVariableApiKey] = useState(false);
  const [test, setTest] = useState<{
    status: "idle" | "running" | "success" | "error";
    data: UsageData[];
    error: string | null;
  }>({ status: "idle", data: [], error: null });
  const testSeqRef = useRef(0);
  const providerIdRef = useRef(provider.id);
  const dirtyRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // 切换到另一个供应商时重建草稿；自己的写回不会触发（id 不变）。
  useEffect(() => {
    if (providerIdRef.current === provider.id) return;
    providerIdRef.current = provider.id;
    dirtyRef.current = false;
    const next = applyUsageQueryModePreset(
      createUsageQueryDraft(provider.usageQuery, isGatewayWebui),
      provider.usageQuery.mode,
    );
    setDraft(next);
    setTimeoutInput(String(next.timeoutSecs));
    setCustomConfirmed(provider.usageQuery.enabled && provider.usageQuery.mode === "custom");
    setTest({ status: "idle", data: [], error: null });
  }, [provider.id, provider.usageQuery, isGatewayWebui]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: draft 的每次变化都要重排延迟提交，值本身经 draftRef 读取。
  useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = setTimeout(() => {
      dirtyRef.current = false;
      const serialized = serializeUsageQueryDraft(draftRef.current, isGatewayWebui);
      onChange((current) => ({ ...current, usageQuery: serialized }));
    }, COMMIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, isGatewayWebui, onChange]);

  function update(updater: (previous: UsageQueryDraft) => UsageQueryDraft) {
    dirtyRef.current = true;
    setDraft(updater);
  }

  async function confirmCustomIfNeeded(next: UsageQueryDraft): Promise<boolean> {
    if (!requiresCustomUsageQueryConfirmation(next, customConfirmed)) return true;
    const confirmed = await confirm({
      title: t("settings.providerUsageCustomConfirmTitle"),
      description: t("settings.providerUsageCustomConfirmDescription"),
      detail: t("settings.providerUsageCustomConfirmDetail"),
      confirmLabel: t("settings.providerUsageCustomConfirmAction"),
      cancelLabel: t("settings.cancel"),
    });
    if (confirmed) setCustomConfirmed(true);
    return confirmed;
  }

  async function setEnabled(enabled: boolean) {
    const next = { ...draft, enabled };
    if (enabled && !(await confirmCustomIfNeeded(next))) return;
    update(() => next);
  }

  async function setMode(mode: UsageQueryMode) {
    const next = applyUsageQueryModePreset(draft, mode);
    if (!(await confirmCustomIfNeeded(next))) return;
    update(() => next);
  }

  function commitTimeout() {
    const raw = timeoutInput.trim();
    const next = clampUsageQueryTimeoutSecs(raw === "" ? Number.NaN : Number(raw));
    setTimeoutInput(String(next));
    update((previous) => ({ ...previous, timeoutSecs: next }));
  }

  async function runTest() {
    const seq = ++testSeqRef.current;
    setTest({ status: "running", data: [], error: null });
    try {
      const result = await testProviderUsage(
        provider.id,
        serializeUsageQueryDraft(draft, isGatewayWebui),
      );
      if (testSeqRef.current !== seq) return;
      if (result?.error) {
        setTest({ status: "error", data: result.data ?? [], error: result.error });
      } else {
        setTest({ status: "success", data: result?.data ?? [], error: null });
      }
    } catch (error) {
      if (testSeqRef.current !== seq) return;
      setTest({
        status: "error",
        data: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const baseUrl = provider.baseUrl;
  const variableBaseUrl = draft.baseUrl.trim() || baseUrl.trim();
  const variableApiKey = draft.apiKey.trim() || provider.apiKey.trim();
  const activeCodingPlanProvider = draft.codingPlanProvider || detectCodingPlanProvider(baseUrl);
  const matchedBalanceProviders = matchBalanceProviders(baseUrl);
  const scriptMode = draft.mode === "custom" || draft.mode === "general" || draft.mode === "newapi";

  function textField(
    id: string,
    labelKey: string,
    key:
      | "baseUrl"
      | "apiKey"
      | "accessToken"
      | "userId"
      | "teamOrganizationId"
      | "teamProjectId"
      | "accessKeyId"
      | "secretAccessKey",
    options?: { secret?: boolean; placeholder?: string },
  ) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {t(labelKey)}
        </Label>
        <Input
          id={id}
          className="h-8 text-xs shadow-none"
          type={options?.secret ? "password" : "text"}
          value={draft[key]}
          placeholder={options?.placeholder}
          autoComplete="off"
          onFocus={options?.secret ? (event) => event.currentTarget.select() : undefined}
          onChange={(event) => {
            const value = event.currentTarget.value;
            update((previous) => ({ ...previous, [key]: value }));
          }}
        />
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-xs text-foreground/90">
          {t("settings.providerUsageEnabled")}
        </div>
        <Switch
          size="sm"
          checked={draft.enabled}
          onCheckedChange={(next) => void setEnabled(next === true)}
          aria-label={t("settings.providerUsageEnabled")}
        />
      </div>
      {draft.enabled ? (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2 text-[11px] leading-5 text-muted-foreground">
            <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
            <span className="shrink-0">{t("settings.providerUsageCredit")}</span>
            <a
              href="https://github.com/farion1231/cc-switch"
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 font-medium text-primary transition-colors hover:underline"
              title={t("settings.providerUsageCreditOpen")}
              aria-label={t("settings.providerUsageCreditOpen")}
            >
              cc-switch
              <ExternalLink className="h-3 w-3" />
            </a>
            <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t("settings.providerUsageMode")}
            </Label>
            <Select
              value={draft.mode}
              onValueChange={(mode) => void setMode(mode as UsageQueryMode)}
            >
              <SelectTrigger className="h-8 w-full text-xs shadow-none">
                <SelectValue>
                  {t(
                    draft.mode === "coding-plan"
                      ? "settings.providerUsageMode.codingPlan"
                      : `settings.providerUsageMode.${draft.mode}`,
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">{t("settings.providerUsageMode.custom")}</SelectItem>
                <SelectItem value="general">{t("settings.providerUsageMode.general")}</SelectItem>
                <SelectItem value="newapi">{t("settings.providerUsageMode.newapi")}</SelectItem>
                <SelectItem value="balance">{t("settings.providerUsageMode.balance")}</SelectItem>
                <SelectItem value="coding-plan">
                  {t("settings.providerUsageMode.codingPlan")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.mode !== "custom" ? (
            <p className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              {draft.mode === "general"
                ? t("settings.providerUsageTemplate.general")
                : draft.mode === "newapi"
                  ? t("settings.providerUsageTemplate.newapi")
                  : draft.mode === "balance"
                    ? t("settings.providerUsageTemplate.balance")
                    : t("settings.providerUsageTemplate.codingPlan")}
            </p>
          ) : null}
          {draft.mode === "balance" && matchedBalanceProviders.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {matchedBalanceProviders.map((entry) => (
                <span
                  key={entry.id}
                  className="inline-flex items-center rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                >
                  {entry.label}
                </span>
              ))}
            </div>
          ) : null}
          {draft.mode === "general" ? (
            <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
              {textField("usage-query-base-url", "settings.providerUsageBaseUrl", "baseUrl", {
                placeholder: baseUrl.trim() || undefined,
              })}
              {textField("usage-query-api-key", "settings.providerUsageApiKey", "apiKey", {
                secret: true,
              })}
            </div>
          ) : null}
          {draft.mode === "custom" ? (
            <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-[11px] leading-5">
              <div className="font-medium text-foreground">
                {t("settings.providerUsageVariables")}
              </div>
              <div className="mt-2 flex min-w-0 items-center gap-2">
                <code className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
                  {"{{baseUrl}}"}
                </code>
                <span className="text-muted-foreground/60">=</span>
                {variableBaseUrl ? (
                  <code className="break-all font-mono text-muted-foreground">
                    {variableBaseUrl}
                  </code>
                ) : (
                  <span className="text-muted-foreground/60 italic">
                    {t("settings.providerUsageVariableNotSet")}
                  </span>
                )}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <code className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
                  {"{{apiKey}}"}
                </code>
                <span className="text-muted-foreground/60">=</span>
                {variableApiKey || (isGatewayWebui && provider.apiKeyConfigured) ? (
                  <>
                    <code className="break-all font-mono text-muted-foreground">
                      {!isGatewayWebui && showVariableApiKey ? variableApiKey : "••••••••"}
                    </code>
                    {!isGatewayWebui ? (
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => setShowVariableApiKey((previous) => !previous)}
                        title={
                          showVariableApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")
                        }
                        aria-label={
                          showVariableApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")
                        }
                      >
                        {showVariableApiKey ? (
                          <EyeOff className="h-3 w-3" />
                        ) : (
                          <Eye className="h-3 w-3" />
                        )}
                      </button>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground/60 italic">
                    {t("settings.providerUsageVariableNotSet")}
                  </span>
                )}
              </div>
            </div>
          ) : null}
          {draft.mode === "newapi" ? (
            <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
              {textField(
                "usage-query-access-token",
                "settings.providerUsageAccessToken",
                "accessToken",
                {
                  secret: true,
                },
              )}
              {textField("usage-query-user-id", "settings.providerUsageUserId", "userId")}
            </div>
          ) : null}
          {draft.mode === "coding-plan" ? (
            <>
              <div className="flex flex-wrap gap-2">
                {USAGE_QUERY_CODING_PLAN_PROVIDERS.map((entry) => (
                  <Button
                    key={entry.id}
                    type="button"
                    size="sm"
                    className="h-7 text-xs"
                    variant={activeCodingPlanProvider === entry.id ? "default" : "outline"}
                    onClick={() =>
                      update((previous) => ({ ...previous, codingPlanProvider: entry.id }))
                    }
                  >
                    {entry.label}
                  </Button>
                ))}
              </div>
              {activeCodingPlanProvider === "zenmux" ? (
                <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                  {textField(
                    "usage-query-zenmux-base-url",
                    "settings.providerUsageBaseUrl",
                    "baseUrl",
                    {
                      placeholder: "https://api.zenmux.com/v1/...",
                    },
                  )}
                  {textField(
                    "usage-query-zenmux-api-key",
                    "settings.providerUsageApiKey",
                    "apiKey",
                    {
                      secret: true,
                      placeholder: "sk-...",
                    },
                  )}
                </div>
              ) : null}
              {activeCodingPlanProvider === "zhipu_team" ? (
                <>
                  <p className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                    {t("settings.providerUsageZhipuTeamHint")}{" "}
                    {t("settings.providerUsageZhipuTeamConsoleLink")}{" "}
                    <a
                      href="https://bigmodel.cn/coding-plan/team/usage-stats"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      bigmodel.cn/coding-plan/team/usage-stats
                    </a>
                  </p>
                  <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                    {textField(
                      "usage-query-team-organization-id",
                      "settings.providerUsageOrganizationId",
                      "teamOrganizationId",
                      { placeholder: t("settings.providerUsageOrganizationIdPlaceholder") },
                    )}
                    {textField(
                      "usage-query-team-project-id",
                      "settings.providerUsageProjectId",
                      "teamProjectId",
                      { placeholder: t("settings.providerUsageProjectIdPlaceholder") },
                    )}
                  </div>
                </>
              ) : null}
              {activeCodingPlanProvider === "volcengine" ? (
                <>
                  <p className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                    {t("settings.providerUsageVolcengineHint")}{" "}
                    {t("settings.providerUsageVolcengineConsoleLink")}{" "}
                    <a
                      href="https://console.volcengine.com/iam/keymanage"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      console.volcengine.com/iam/keymanage
                    </a>
                  </p>
                  <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                    {textField(
                      "usage-query-access-key-id",
                      "settings.providerUsageAccessKeyId",
                      "accessKeyId",
                    )}
                    {textField(
                      "usage-query-secret-access-key",
                      "settings.providerUsageSecretAccessKey",
                      "secretAccessKey",
                      { secret: true },
                    )}
                  </div>
                </>
              ) : null}
            </>
          ) : null}
          <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor="usage-query-timeout" className="text-xs text-muted-foreground">
                {t("settings.providerUsageTimeout")}
              </Label>
              <Input
                id="usage-query-timeout"
                className="h-8 text-xs shadow-none"
                inputMode="numeric"
                value={timeoutInput}
                onChange={(event) => setTimeoutInput(event.currentTarget.value)}
                onBlur={commitTimeout}
              />
              <p className="text-[10.5px] text-muted-foreground">
                {t("settings.providerUsageTimeoutHint")}
              </p>
            </div>
          </div>
          {scriptMode ? (
            <div className="space-y-1.5">
              <Label htmlFor="usage-query-script" className="text-xs text-muted-foreground">
                {t("settings.providerUsageScript")}
              </Label>
              <Textarea
                id="usage-query-script"
                value={draft.script}
                className="min-h-36 font-mono text-xs"
                placeholder={t("settings.providerUsageScriptPlaceholder")}
                spellCheck={false}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  update((previous) => setUsageQueryScript(previous, value));
                }}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 text-xs"
              disabled={test.status === "running"}
              onClick={() => void runTest()}
              title={t("settings.providerUsageTest")}
              aria-label={t("settings.providerUsageTest")}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", test.status === "running" && "animate-spin")}
              />
              {t("settings.providerUsageTest")}
            </Button>
            <div className="min-w-0 flex-1 text-xs" role="status" aria-live="polite">
              {test.status === "running" ? (
                <span className="text-muted-foreground">
                  {t("settings.providerUsageTestRunning")}
                </span>
              ) : null}
              {test.status === "error" ? (
                <span className="text-destructive">
                  {t("settings.providerUsageTestFailed")}
                  {test.error ? `: ${test.error}` : ""}
                </span>
              ) : null}
              {test.status === "success" ? (
                test.data.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {test.data.map((plan, index) => (
                      <UsagePlanLine
                        key={`${plan.planName ?? ""}:${
                          // biome-ignore lint/suspicious/noArrayIndexKey: 套餐无稳定 id，索引即位置语义
                          index
                        }`}
                        plan={getUsagePlanDisplay(plan)}
                      />
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">
                    {t("settings.providerUsageTestEmpty")}
                  </span>
                )
              ) : null}
            </div>
          </div>
          {scriptMode ? (
            <details className="rounded-lg border bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium text-foreground">
                {t("settings.providerUsageScriptHelp")}
              </summary>
              <div className="mt-2 font-medium">{t("settings.providerUsageScriptHelpFormat")}</div>
              <pre className="mt-1 overflow-x-auto rounded-md border bg-background/60 p-2 font-mono text-[11px] leading-4">
                {USAGE_QUERY_SCRIPT_HELP_EXAMPLE}
              </pre>
              <div className="mt-2 font-medium">
                {t("settings.providerUsageScriptHelpExtractor")}
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>{t("settings.providerUsageScriptHelpField.planName")}</li>
                <li>{t("settings.providerUsageScriptHelpField.total")}</li>
                <li>{t("settings.providerUsageScriptHelpField.used")}</li>
                <li>{t("settings.providerUsageScriptHelpField.remaining")}</li>
                <li>{t("settings.providerUsageScriptHelpField.unit")}</li>
                <li>{t("settings.providerUsageScriptHelpField.isValid")}</li>
                <li>{t("settings.providerUsageScriptHelpField.invalidMessage")}</li>
                <li>{t("settings.providerUsageScriptHelpField.extra")}</li>
              </ul>
              <div className="mt-2 font-medium">{t("settings.providerUsageScriptHelpTips")}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>{t("settings.providerUsageScriptHelpTip.variables")}</li>
                <li>{t("settings.providerUsageScriptHelpTip.sandbox")}</li>
                <li>{t("settings.providerUsageScriptHelpTip.wrap")}</li>
                <li>{t("settings.providerUsageScriptHelpTip.origin")}</li>
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      {confirmDialog}
    </div>
  );
}
