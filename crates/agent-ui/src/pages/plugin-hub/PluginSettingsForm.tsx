import { useEffect, useId, useMemo, useState } from "react";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n/index";
import type { PluginInventoryItem, PluginSettingsContribution } from "../../lib/plugins/types";

type ConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 单 Section 插件的配置就是整个 config 对象；多 Section 时按 section id 分键。
 * 这套映射在读与写两侧必须同口径，所以收敛成一对函数而不是散在 JSX 里。
 */
function readSection(config: ConfigRecord, sections: PluginSettingsContribution[], id: string) {
  if (sections.length === 1) return config;
  const scoped = config[id];
  return isRecord(scoped) ? scoped : {};
}

function writeSection(
  config: ConfigRecord,
  sections: PluginSettingsContribution[],
  id: string,
  value: ConfigRecord,
): ConfigRecord {
  return sections.length === 1 ? value : { ...config, [id]: value };
}

function SchemaField(props: {
  fieldKey: string;
  schema: ConfigRecord;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
}) {
  const { fieldKey, schema, value, required, onChange } = props;
  const controlId = useId();
  const label = typeof schema.title === "string" ? schema.title : fieldKey;
  const description = typeof schema.description === "string" ? schema.description : "";
  const type = typeof schema.type === "string" ? schema.type : "string";
  const options = Array.isArray(schema.enum) ? schema.enum : null;

  const control = options ? (
    <Select
      value={typeof value === "string" ? value : ""}
      onValueChange={(next) => onChange(next)}
    >
      <SelectTrigger id={controlId} className="h-8 text-xs">
        {/* value 与 label 一致时才可裸用 SelectValue；这里枚举值即展示值。 */}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={String(option)} value={String(option)}>
            {String(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : type === "boolean" ? (
    <Switch
      id={controlId}
      checked={value === true}
      onCheckedChange={(checked) => onChange(checked)}
    />
  ) : type === "number" || type === "integer" ? (
    <Input
      id={controlId}
      type="number"
      className="h-8 text-xs"
      value={typeof value === "number" ? value : ""}
      onChange={(event) =>
        onChange(event.target.value === "" ? undefined : Number(event.target.value))
      }
    />
  ) : (
    <Input
      id={controlId}
      className="h-8 text-xs"
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
    />
  );

  return (
    <label htmlFor={controlId} className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1 text-[11px] font-medium text-foreground">
        {label}
        {required ? <span className="text-destructive">*</span> : null}
      </span>
      {control}
      {description ? (
        <span className="text-[10px] leading-4 text-muted-foreground">{description}</span>
      ) : null}
    </label>
  );
}

export function PluginSettingsForm(props: {
  item: PluginInventoryItem;
  busy: boolean;
  onSave: (config: ConfigRecord) => Promise<void>;
}) {
  const { item, busy, onSave } = props;
  const { t } = useLocale();
  const sections = item.contributes.settings;
  const [draft, setDraft] = useState<ConfigRecord>(item.config);

  // 保存成功后父层刷新 Inventory，item.config 会带回权威值；以它为准重置草稿，
  // 这样"未保存"提示不会在写回后仍然亮着。
  useEffect(() => setDraft(item.config), [item.config]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(item.config),
    [draft, item.config],
  );

  return (
    <div className="grid gap-4">
      {sections.map((settings) => {
        const sectionValue = readSection(draft, sections, settings.id);
        const properties = isRecord(settings.schema.properties) ? settings.schema.properties : {};
        const requiredKeys = Array.isArray(settings.schema.required)
          ? settings.schema.required.map(String)
          : [];
        const entries = Object.entries(properties);
        return (
          <div key={settings.id} className="grid gap-2.5">
            {sections.length > 1 ? (
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {settings.id}
              </h4>
            ) : null}
            {entries.length === 0 ? (
              // 没有 properties 的 schema 无法生成表单，退回原始 JSON 编辑。
              <Textarea
                aria-label={`${settings.id} JSON`}
                value={JSON.stringify(sectionValue, null, 2)}
                onChange={(event) => {
                  try {
                    const parsed = JSON.parse(event.target.value);
                    if (isRecord(parsed)) {
                      setDraft((prev) => writeSection(prev, sections, settings.id, parsed));
                    }
                  } catch {
                    return;
                  }
                }}
                className="min-h-28 font-mono text-[11px]"
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {entries.map(([key, rawSchema]) => (
                  <SchemaField
                    key={key}
                    fieldKey={key}
                    schema={isRecord(rawSchema) ? rawSchema : {}}
                    value={sectionValue[key]}
                    required={requiredKeys.includes(key)}
                    onChange={(value) =>
                      setDraft((prev) =>
                        writeSection(prev, sections, settings.id, {
                          ...readSection(prev, sections, settings.id),
                          [key]: value,
                        }),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-2.5">
        {dirty ? (
          <span className="mr-auto text-[11px] text-amber-700 dark:text-amber-300">
            {t("pluginHub.unsavedChanges")}
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-xs"
          disabled={!dirty || busy}
          onClick={() => setDraft(item.config)}
        >
          {t("pluginHub.resetConfig")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={!dirty || busy}
          onClick={() => void onSave(draft)}
        >
          {t("pluginHub.saveConfig")}
        </Button>
      </div>
    </div>
  );
}
