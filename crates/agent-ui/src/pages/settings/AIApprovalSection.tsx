import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@liveagent/ui/components/settings/SettingsLayout";
import {
  SettingsToggleGroup,
  SettingsToggleGroupItem,
} from "@liveagent/ui/components/settings/SettingsToggleGroup";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AIApprovalConfig,
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
} from "./kbrainSettingsAdapter";
import { ModelPicker, type ModelPickerOption } from "./modelPicker";

const MODES = ["off", "risk_only", "auto"] as const;

function sameConfig(left: AIApprovalConfig, right: AIApprovalConfig): boolean {
  return (
    left.mode === right.mode &&
    (left.provider || "") === (right.provider || "") &&
    (left.model || "") === (right.model || "")
  );
}

function connectionScope(kbrain: KBrainSettingsAdapter): string {
  const connection = kbrain.getConnection();
  return JSON.stringify(connection ? [connection.baseUrl, connection.token] : null);
}

export function AIApprovalSection({ kbrain }: { kbrain: KBrainSettingsAdapter }) {
  const { t } = useLocale();
  const [document, setDocument] = useState<KBrainSettingsDocument | null>(null);
  const [draft, setDraft] = useState<AIApprovalConfig>({ mode: "off" });
  const [busy, setBusy] = useState<"load" | "save" | null>("load");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const pending = useRef(false);
  const loadedScope = useRef<string | undefined>(undefined);
  // Set once an older backend (no aiApproval.perRun) is confirmed, so a reload keeps the
  // section, its focus and its loading status instead of unmounting it.
  const shown = useRef(false);
  const dirty = !!document?.aiApproval && !sameConfig(draft, document.aiApproval);
  const refresh = useCallback(async () => {
    const ticket = ++epoch.current;
    const scope = connectionScope(kbrain);
    pending.current = true;
    setBusy("load");
    setDocument(null);
    setError("");
    setSaved(false);
    try {
      const next = await kbrain.getSettings();
      if (ticket !== epoch.current) return;
      if (scope !== connectionScope(kbrain))
        throw new Error(t("settings.aiApproval.connectionChanged"));
      if (!next.aiApproval || !MODES.includes(next.aiApproval.mode))
        throw new Error(t("settings.aiApproval.upgrade"));
      loadedScope.current = scope;
      shown.current = !next.aiApproval.perRun;
      setDocument(next);
      setDraft(next.aiApproval);
    } catch (reason) {
      if (ticket === epoch.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (ticket === epoch.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }, [kbrain, t]);
  useEffect(() => {
    void refresh();
    return () => {
      ++epoch.current;
      pending.current = false;
    };
  }, [refresh]);

  const available = !!document?.models.some(
    (model) => model.provider === draft.provider && model.id === draft.model,
  );
  const valid = draft.mode === "off" || available;
  const selectedValue =
    draft.provider && draft.model ? JSON.stringify([draft.provider, draft.model]) : "";
  const options: ModelPickerOption[] = (document?.models ?? []).map((model) => ({
    value: JSON.stringify([model.provider, model.id]),
    label: model.name || model.id,
    description: model.name && model.name !== model.id ? model.id : undefined,
    providerId: model.provider,
    providerName:
      document?.providers.find((provider) => provider.id === model.provider)?.name ||
      model.provider,
  }));
  const unavailable = !!selectedValue && !available;

  async function save() {
    if (pending.current || !document || !valid || !dirty) return;
    if (loadedScope.current !== connectionScope(kbrain)) {
      setDocument(null);
      setSaved(false);
      setError(t("settings.aiApproval.connectionChanged"));
      return;
    }
    const ticket = ++epoch.current;
    const scope = loadedScope.current;
    pending.current = true;
    setBusy("save");
    setError("");
    setSaved(false);
    try {
      const next = await kbrain.updateSettings({ aiApproval: draft });
      if (ticket !== epoch.current) return;
      if (scope !== connectionScope(kbrain)) {
        setDocument(null);
        throw new Error(t("settings.aiApproval.connectionChanged"));
      }
      if (!next.aiApproval || !MODES.includes(next.aiApproval.mode))
        throw new Error(t("settings.aiApproval.upgrade"));
      setDocument(next);
      setDraft(next.aiApproval);
      setSaved(true);
      window.dispatchEvent(new Event("kbrain:settings-changed"));
    } catch (reason) {
      if (ticket === epoch.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (ticket === epoch.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }

  function change(patch: Partial<AIApprovalConfig>) {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
    setError("");
  }

  // A per-run backend (aiApproval.perRun) needs no global setting: the composer's permission
  // mode decides and auto review uses the session's model. Stay hidden until that is known so
  // the section does not flash on those backends; an older backend shows it once loaded.
  if (document?.aiApproval?.perRun || (!document && !error && !shown.current)) return null;

  return (
    <SettingsSection
      title={t("settings.aiApproval.title")}
      description={t("settings.aiApproval.description")}
      data-testid="ai-approval-settings"
      aria-busy={!!busy}
    >
      <SettingsCard>
        <SettingsRow
          title={t("settings.aiApproval.mode")}
          description={t(`settings.aiApproval.${draft.mode}.description`)}
          control={
            <SettingsToggleGroup
              value={[draft.mode]}
              disabled={!!busy || !document}
              aria-label={t("settings.aiApproval.mode")}
              className="max-w-full flex-wrap"
              onValueChange={(values) => {
                const mode = values[0] as AIApprovalConfig["mode"] | undefined;
                if (mode && MODES.includes(mode)) change({ mode });
              }}
            >
              {MODES.map((mode) => (
                <SettingsToggleGroupItem key={mode} value={mode}>
                  {t(`settings.aiApproval.${mode}`)}
                </SettingsToggleGroupItem>
              ))}
            </SettingsToggleGroup>
          }
        />
        <SettingsRow
          title={t("settings.aiApproval.model")}
          description={t("settings.aiApproval.modelHint")}
          control={
            <div className="w-64 max-w-full">
              <ModelPicker
                options={options}
                value={selectedValue}
                disabled={!!busy || !document || draft.mode === "off"}
                placeholder={
                  unavailable
                    ? `${draft.provider} / ${draft.model} (${t("settings.aiApproval.unavailable")})`
                    : t("settings.aiApproval.selectModel")
                }
                ariaLabel={t("settings.aiApproval.model")}
                variant="plain"
                onChange={(value) => {
                  const [provider, model] = JSON.parse(value) as [string, string];
                  change({ provider, model });
                }}
              />
            </div>
          }
        />
      </SettingsCard>
      {document && draft.mode !== "off" && !available && (
        <p role="alert" className="px-1 text-xs leading-5 text-destructive">
          {t(
            unavailable
              ? "settings.aiApproval.modelUnavailable"
              : document.models.length
                ? "settings.aiApproval.modelRequired"
                : "settings.aiApproval.noModels",
          )}
        </p>
      )}
      <div className="space-y-2 px-1 text-xs leading-5 text-muted-foreground">
        <p>{t("settings.aiApproval.permissions")}</p>
        <p>{t("settings.aiApproval.privacy")}</p>
        {!kbrain.getConnection() && <p>{t("settings.aiApproval.webNotice")}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button
          size="sm"
          disabled={!!busy || !document || !valid || !dirty}
          onClick={() => void save()}
        >
          {t("settings.aiApproval.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={() => {
            if (!dirty || window.confirm(t("settings.aiApproval.discard"))) void refresh();
          }}
        >
          {t("settings.aiApproval.reload")}
        </Button>
        <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {busy
            ? t(`settings.aiApproval.${busy === "load" ? "loading" : "saving"}`)
            : saved
              ? t("settings.aiApproval.saved")
              : dirty
                ? t("settings.aiApproval.unsaved")
                : ""}
        </span>
      </div>
      {error && (
        <p role="alert" className="break-words px-1 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsSection>
  );
}
