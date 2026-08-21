import {
  AlertTriangle,
  BookOpen,
  Key,
  Lock,
  RefreshCw,
  SkillIcon,
} from "@liveagent/ui/components/IconSet";
import { DocumentMarkdown } from "@liveagent/ui/components/markdown/DocumentMarkdown";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { Button } from "@liveagent/ui/components/ui/button";
import { CopyButton } from "@liveagent/ui/components/ui/copy-button";
import { Input } from "@liveagent/ui/components/ui/input";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@liveagent/ui/components/ui/sheet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  isAlwaysEnabledSkillName,
  probeSkillEnvNames,
  type SkillSummary,
} from "@liveagent/ui/lib/skills/index";
import {
  parseSkillEnvAddEntries,
  type ResolvedSkillEnvRequirement,
  resolveSkillEnvStatus,
  type SkillEnvSettingsMap,
  type SkillEnvVarConfig,
} from "@liveagent/ui/lib/skills/skillEnv";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDrawerPresence } from "./useDrawerPresence";

export const INSTALLED_SKILL_PREVIEW_LINES = 10_000;

export type InstalledSkillPreviewState = {
  skillFile: string;
  content: string;
  truncated: boolean;
  loading: boolean;
  error: string | null;
};

export function emptyInstalledSkillPreviewState(): InstalledSkillPreviewState {
  return {
    skillFile: "",
    content: "",
    truncated: false,
    loading: false,
    error: null,
  };
}

function normalizePreviewMetadataText(value: string) {
  return value
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stripLeadingBlankLines(lines: string[]) {
  let index = 0;
  while (index < lines.length && !lines[index].trim()) {
    index += 1;
  }
  return lines.slice(index);
}

function stripReadmeDuplicateSummary(content: string, skill: SkillSummary) {
  const expectedName = normalizePreviewMetadataText(skill.name);
  const expectedDescription = normalizePreviewMetadataText(skill.description);
  let lines = stripLeadingBlankLines(content.split(/\r?\n/));

  if (lines.length > 0 && normalizePreviewMetadataText(lines[0]) === expectedName) {
    lines = stripLeadingBlankLines(lines.slice(1));
  }

  if (expectedDescription && lines.length > 0) {
    const paragraph: string[] = [];
    let index = 0;
    while (index < lines.length && lines[index].trim()) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (normalizePreviewMetadataText(paragraph.join(" ")) === expectedDescription) {
      lines = stripLeadingBlankLines(lines.slice(index));
    }
  }

  return lines.join("\n").trimStart();
}

const FRONTMATTER_PREVIEW_METADATA_KEYS = new Set(["name", "description"]);

function hasPreviewMetadataFrontmatterField(frontmatterBody: string) {
  return frontmatterBody.split(/\r?\n/).some((line) => {
    if (/^[ \t]/.test(line)) return false;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    return match ? FRONTMATTER_PREVIEW_METADATA_KEYS.has(match[1].toLowerCase()) : false;
  });
}

function hasPreviewMetadataInlineFrontmatterField(frontmatterBody: string) {
  return Array.from(frontmatterBody.matchAll(/(?:^|\s)([A-Za-z0-9_-]+)\s*:/g)).some((match) =>
    FRONTMATTER_PREVIEW_METADATA_KEYS.has(match[1].toLowerCase()),
  );
}

function hasDisplayableFrontmatterContent(frontmatterBody: string) {
  return frontmatterBody.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
}

function stripFrontmatterPreviewMetadataFields(frontmatterBody: string) {
  const lines = frontmatterBody.split(/\r?\n/);
  const nextLines: string[] = [];
  let skippingMetadataField = false;

  for (const line of lines) {
    const isIndented = /^[ \t]/.test(line);
    const trimmed = line.trim();
    const keyMatch = isIndented ? null : line.match(/^([A-Za-z0-9_-]+)\s*:/);

    if (keyMatch) {
      skippingMetadataField = FRONTMATTER_PREVIEW_METADATA_KEYS.has(keyMatch[1].toLowerCase());
      if (skippingMetadataField) continue;
    } else if (skippingMetadataField) {
      if (trimmed === "" || isIndented) continue;
      skippingMetadataField = false;
    }

    nextLines.push(line);
  }

  return nextLines.join("\n").trim();
}

function stripInlineFrontmatterPreviewMetadataFields(frontmatterBody: string) {
  const matches = Array.from(frontmatterBody.matchAll(/(?:^|\s)([A-Za-z0-9_-]+)\s*:/g));
  if (matches.length === 0) return frontmatterBody.trim();

  const fields = matches.map((match, index) => {
    const rawIndex = match.index ?? 0;
    const startsWithSpace = /^\s/.test(match[0]);
    const start = rawIndex + (startsWithSpace ? 1 : 0);
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? frontmatterBody.length)
        : frontmatterBody.length;
    return {
      key: match[1].toLowerCase(),
      text: frontmatterBody.slice(start, end).trim(),
    };
  });

  return fields
    .filter((field) => !FRONTMATTER_PREVIEW_METADATA_KEYS.has(field.key))
    .map((field) => field.text)
    .join(" ")
    .trim();
}

function stripMarkdownSkillMetadata(content: string, skill: SkillSummary) {
  let next = content.replace(/^\uFEFF/, "");
  const frontmatter = next.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (frontmatter && hasPreviewMetadataFrontmatterField(frontmatter[1])) {
    const frontmatterBody = stripFrontmatterPreviewMetadataFields(frontmatter[1]);
    const rest = next.slice(frontmatter[0].length);
    next = hasDisplayableFrontmatterContent(frontmatterBody)
      ? `---\n${frontmatterBody}\n---\n${rest}`
      : rest;
  } else {
    const inlineFrontmatter = next.match(/^---[ \t]+([\s\S]*?)[ \t]+---[ \t]*/);
    if (inlineFrontmatter && hasPreviewMetadataInlineFrontmatterField(inlineFrontmatter[1])) {
      const frontmatterBody = stripInlineFrontmatterPreviewMetadataFields(inlineFrontmatter[1]);
      const rest = next.slice(inlineFrontmatter[0].length);
      next = frontmatterBody ? `--- ${frontmatterBody} --- ${rest}` : rest;
    }
  }
  return stripReadmeDuplicateSummary(next, skill);
}

function stripJsonSkillMetadata(content: string) {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return content;
    const next = { ...(parsed as Record<string, unknown>) };
    delete next.name;
    delete next.description;
    return Object.keys(next).length > 0 ? JSON.stringify(next, null, 2) : "";
  } catch {
    return content;
  }
}

function stripInstalledSkillPreviewMetadata(content: string, skill: SkillSummary) {
  if (/\.(md|mdx|markdown)$/i.test(skill.skillFile)) {
    return stripMarkdownSkillMetadata(content, skill);
  }
  if (/\.json$/i.test(skill.skillFile)) {
    return stripJsonSkillMetadata(content);
  }
  return content;
}

export function InstalledSkillPreviewDrawer(props: {
  skill: SkillSummary | null;
  preview: InstalledSkillPreviewState;
  checked: boolean;
  skillsEnabled: boolean;
  envSettings: SkillEnvSettingsMap;
  onEnvVarChange: (skillName: string, varName: string, config: SkillEnvVarConfig | null) => void;
  onClose: () => void;
}) {
  const { onClose, skillsEnabled, envSettings, onEnvVarChange } = props;
  const presence = useDrawerPresence(
    props.skill ? { skill: props.skill, preview: props.preview, checked: props.checked } : null,
  );
  const snapshot = presence.snapshot;
  const snapshotSkill = snapshot?.skill ?? null;
  const snapshotContent = snapshot?.preview.content ?? "";
  const previewContent = useMemo(
    () => (snapshotSkill ? stripInstalledSkillPreviewMetadata(snapshotContent, snapshotSkill) : ""),
    [snapshotContent, snapshotSkill],
  );

  return (
    <Sheet
      open={presence.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={presence.handleOpenChangeComplete}
    >
      {snapshot ? (
        <InstalledSkillPreviewPopup
          skill={snapshot.skill}
          preview={snapshot.preview}
          previewContent={previewContent}
          checked={snapshot.checked}
          skillsEnabled={skillsEnabled}
          envSettings={envSettings}
          onEnvVarChange={onEnvVarChange}
          contentReady={presence.entered && !snapshot.preview.loading}
        />
      ) : null}
    </Sheet>
  );
}

function InstalledSkillPreviewPopup(props: {
  skill: SkillSummary;
  preview: InstalledSkillPreviewState;
  previewContent: string;
  checked: boolean;
  skillsEnabled: boolean;
  envSettings: SkillEnvSettingsMap;
  onEnvVarChange: (skillName: string, varName: string, config: SkillEnvVarConfig | null) => void;
  contentReady: boolean;
}) {
  const {
    skill,
    preview,
    previewContent,
    checked,
    skillsEnabled,
    envSettings,
    onEnvVarChange,
    contentReady,
  } = props;
  const { t } = useLocale();
  const alwaysEnabled = isAlwaysEnabledSkillName(skill.name);
  const source = skill.source;
  const description = skill.description.trim();
  const previewIsMarkdown = /\.(md|mdx|markdown)$/i.test(skill.skillFile);
  const statusLabel = alwaysEnabled
    ? t("settings.skillsInstalledPreviewBuiltIn")
    : checked
      ? t("settings.skillsInstalledPreviewSelected")
      : t("settings.skillsInstalledPreviewUnselected");

  return (
    <SheetPopup
      side="right"
      variant="inset"
      closeLabel={t("settings.cronViewClose")}
      className="w-full sm:max-w-xl"
    >
      <SheetHeader className="flex-row items-center gap-3 px-5 py-4 pr-14">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
          {alwaysEnabled ? <Lock className="h-5 w-5" /> : <SkillIcon className="h-7 w-7" />}
        </div>
        <div className="min-w-0 flex-1 select-text">
          <SheetTitle className="truncate">{skill.name}</SheetTitle>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span>{t("settings.skillsInstalledPreviewStatusLabel")}</span>
              <Badge variant={alwaysEnabled ? "muted" : checked ? "success" : "outline"}>
                {statusLabel}
              </Badge>
            </span>
            {source?.version ? <span>v{source.version}</span> : null}
          </div>
        </div>
      </SheetHeader>

      {/* 详情内容整体放开文字选择(全局默认 user-select:none 保持原生手感)。 */}
      <SheetPanel className="select-text px-5 py-5">
        <div className="flex flex-col gap-5">
          <section aria-labelledby="installed-skill-description">
            <div className="flex items-center justify-between gap-3">
              <h3
                id="installed-skill-description"
                className="text-xs font-semibold text-foreground"
              >
                {t("settings.skillsInstalledPreviewDescription")}
              </h3>
              <CopyButton
                value={description}
                label={t("settings.skillsInstalledPreviewCopyDescription")}
                copiedLabel={t("settings.skillsInstalledPreviewCopied")}
              />
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {description || t("settings.skillsInstalledPreviewNoDescription")}
            </p>
          </section>

          {!alwaysEnabled ? (
            <InstalledSkillEnvSection
              key={skill.name}
              skill={skill}
              envSettings={envSettings}
              onEnvVarChange={onEnvVarChange}
            />
          ) : null}

          {!skillsEnabled ? (
            <div className="rounded-lg border border-border bg-muted p-3">
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
                <span>{t("settings.skillsDisabledHint")}</span>
              </div>
            </div>
          ) : null}

          <section aria-labelledby="installed-skill-details">
            <h3 id="installed-skill-details" className="mb-1 text-xs font-semibold text-foreground">
              {t("settings.skillsInstalledPreviewDetails")}
            </h3>
            <div className="divide-y divide-border">
              <InstalledPreviewField
                label={t("settings.skillsInstalledPreviewBaseDir")}
                value={skill.baseDir}
              />
              <InstalledPreviewField
                label={t("settings.skillsInstalledPreviewSkillFile")}
                value={skill.skillFile}
              />
              <InstalledPreviewField
                label={t("settings.skillsInstalledPreviewSource")}
                value={source?.registry}
              />
              <InstalledPreviewField
                label={t("settings.skillsStorePreviewSlug")}
                value={source?.slug}
              />
              <InstalledPreviewField
                label={t("settings.skillsStorePreviewVersion")}
                value={source?.version}
              />
              <InstalledPreviewField
                label={t("settings.skillsInstalledPreviewPublished")}
                value={source?.publishedAt ? formatInstalledPreviewDate(source.publishedAt) : null}
              />
            </div>
          </section>

          <section aria-labelledby="installed-skill-file-preview">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3
                  id="installed-skill-file-preview"
                  className="text-xs font-semibold text-foreground"
                >
                  {t("settings.skillsInstalledPreviewFilePreview")}
                </h3>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  {preview.skillFile || skill.skillFile}
                </div>
              </div>
              <CopyButton
                value={previewContent}
                label={t("settings.skillsInstalledPreviewCopyFile")}
                copiedLabel={t("settings.skillsInstalledPreviewCopied")}
              />
            </div>

            {!contentReady ? (
              <InstalledPreviewSkeleton />
            ) : (
              <>
                {preview.error ? (
                  <div className="rounded-lg border border-border bg-muted p-3">
                    <div className="flex items-start gap-2 text-xs text-muted-foreground">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
                      <div className="min-w-0">
                        <div>{t("settings.skillsInstalledPreviewUnavailable")}</div>
                        <div className="mt-1 break-words text-[11px]">{preview.error}</div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {previewContent ? (
                  previewIsMarkdown ? (
                    <DocumentMarkdown content={previewContent} />
                  ) : (
                    <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-[11px] leading-5 text-foreground">
                      {previewContent}
                    </pre>
                  )
                ) : preview.error ? null : (
                  <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
                    {t("settings.skillsInstalledPreviewEmpty")}
                  </div>
                )}

                {preview.truncated ? (
                  <div className="mt-2 rounded-lg border border-border bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                    {t("settings.skillsInstalledPreviewTruncated").replace(
                      "{count}",
                      String(INSTALLED_SKILL_PREVIEW_LINES),
                    )}
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </SheetPanel>
    </SheetPopup>
  );
}

function InstalledPreviewField(props: { label: string; value?: string | null }) {
  if (!props.value) return null;
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 text-[12px]">
      <div className="text-muted-foreground">{props.label}</div>
      <div className="min-w-0 break-words text-foreground">{props.value}</div>
    </div>
  );
}

function formatInstalledPreviewDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function InstalledPreviewSkeleton() {
  return (
    <div className="space-y-2">
      <div className="skills-skeleton-pulse h-2.5 w-full rounded-full" />
      <div className="skills-skeleton-pulse h-2.5 w-11/12 rounded-full" />
      <div className="skills-skeleton-pulse h-2.5 w-4/5 rounded-full" />
      <div className="skills-skeleton-pulse h-2.5 w-2/3 rounded-full" />
    </div>
  );
}

function SkillEnvStateBadge(props: { state: ResolvedSkillEnvRequirement["state"] }) {
  const { t } = useLocale();
  if (props.state === "user") {
    return (
      <Badge variant="success" className="h-5 px-1.5 text-[10px]">
        {t("settings.skillsEnvStateUser")}
      </Badge>
    );
  }
  if (props.state === "system") {
    return (
      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
        {t("settings.skillsEnvStateSystem")}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-5 px-1.5 text-[10px] border-amber-500/40 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300"
    >
      {t("settings.skillsEnvStateMissing")}
    </Badge>
  );
}

// 值编辑走"草稿 + blur/Enter 提交"：已保存的值从不回显（WebUI 侧持久化前
// 会脱敏），placeholder 提示已保存状态，重新输入即覆盖。
function SkillEnvValueEditor(props: { configured: boolean; onCommit: (value: string) => void }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (!draft.trim()) return;
    props.onCommit(draft);
    setDraft("");
  };
  return (
    <Input
      type="password"
      autoComplete="off"
      spellCheck={false}
      value={draft}
      placeholder={
        props.configured
          ? t("settings.skillsEnvValueSavedPlaceholder")
          : t("settings.skillsEnvValuePlaceholder")
      }
      className="h-8 min-w-0 flex-1 font-mono text-xs"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

function SkillEnvTextAction(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function InstalledSkillEnvSection(props: {
  skill: SkillSummary;
  envSettings: SkillEnvSettingsMap;
  onEnvVarChange: (skillName: string, varName: string, config: SkillEnvVarConfig | null) => void;
}) {
  const { skill, envSettings, onEnvVarChange } = props;
  const { t } = useLocale();
  const [probeResults, setProbeResults] = useState<Record<string, boolean>>({});
  const [probing, setProbing] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const [addDraft, setAddDraft] = useState("");
  const probeRequestedRef = useRef(false);

  const status = useMemo(
    () => resolveSkillEnvStatus(skill, envSettings, probeResults),
    [skill, envSettings, probeResults],
  );
  const skillConfig = envSettings[skill.name];

  const refreshProbe = useCallback(async () => {
    const names = status.requirements.map((entry) => entry.name);
    if (names.length === 0) return;
    setProbing(true);
    try {
      const results = await probeSkillEnvNames(names);
      setProbeResults((prev) => ({ ...prev, ...results }));
    } catch {
      // 探测失败保持上一次结果，不打断配置流程。
    } finally {
      setProbing(false);
    }
  }, [status.requirements]);

  // 打开抽屉时探测一次系统环境（后端列表探测可能已过期）。
  useEffect(() => {
    if (probeRequestedRef.current) return;
    probeRequestedRef.current = true;
    void refreshProbe();
  }, [refreshProbe]);

  // 主列表 = 明确条目(声明、用户添加/采纳、已填值);纯探测结果只进建议组。
  const isSuggestionRow = (entry: ResolvedSkillEnvRequirement) =>
    (entry.confidence === "strong" || entry.confidence === "weak") &&
    entry.state !== "user" &&
    !entry.effectiveRequired;
  const mainRows = status.requirements.filter((entry) => !isSuggestionRow(entry));
  const suggestionRows = status.requirements.filter(isSuggestionRow);

  const configFor = (name: string) => skillConfig?.[name];
  const withValue = (name: string, patch: Partial<SkillEnvVarConfig>): SkillEnvVarConfig | null => {
    const existing = configFor(name);
    const next: SkillEnvVarConfig = {};
    if (typeof existing?.value === "string" && existing.value.trim()) next.value = existing.value;
    if (existing?.configured === true) next.configured = true;
    if (existing?.override) next.override = existing.override;
    if ("value" in patch) {
      if (patch.value) {
        next.value = patch.value;
        next.configured = true;
      } else {
        // 显式清除：值与 configured 标记一起移除（同步侧据此清掉桌面端已存值）。
        delete next.value;
        delete next.configured;
      }
    }
    if ("override" in patch) {
      if (patch.override) next.override = patch.override;
      else delete next.override;
    }
    return next.value !== undefined || next.configured !== undefined || next.override !== undefined
      ? next
      : null;
  };

  const commitValue = (name: string, value: string) => {
    onEnvVarChange(skill.name, name, withValue(name, { value }));
  };
  const clearValue = (name: string) => {
    onEnvVarChange(skill.name, name, withValue(name, { value: undefined }));
  };
  const markIgnored = (entry: ResolvedSkillEnvRequirement) => {
    onEnvVarChange(skill.name, entry.name, withValue(entry.name, { override: "ignored" }));
  };
  const removeEntry = (entry: ResolvedSkillEnvRequirement) => {
    // 用户添加/采纳的条目"移除"即整条删除,探测条目退回建议组。
    onEnvVarChange(skill.name, entry.name, null);
  };
  const restoreIgnored = (name: string) => {
    onEnvVarChange(skill.name, name, withValue(name, { override: undefined }));
  };
  const adoptEntry = (name: string) => {
    onEnvVarChange(skill.name, name, withValue(name, { override: "required" }));
  };
  const addFromText = (text: string) => {
    const entries = parseSkillEnvAddEntries(text);
    if (entries.length === 0) return false;
    for (const entry of entries) {
      onEnvVarChange(
        skill.name,
        entry.name,
        withValue(entry.name, {
          override: "required",
          ...(entry.value ? { value: entry.value } : {}),
        }),
      );
    }
    return true;
  };

  return (
    <section aria-labelledby="installed-skill-env">
      <div className="flex items-center justify-between gap-3">
        <h3 id="installed-skill-env" className="text-xs font-semibold text-foreground">
          {t("settings.skillsEnvSectionTitle")}
        </h3>
        {status.requirements.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
            disabled={probing}
            onClick={() => void refreshProbe()}
          >
            <RefreshCw className={cn("h-3 w-3", probing && "animate-spin")} />
            {t("settings.skillsEnvRefreshProbe")}
          </Button>
        ) : null}
      </div>

      {!status.satisfied ? (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200">
          <Key className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t("settings.skillsEnvGateHint").replace(
              "{count}",
              String(status.missingRequired.length),
            )}
          </span>
        </div>
      ) : null}

      {mainRows.length > 0 ? (
        <div className="mt-2 space-y-2">
          {mainRows.map((entry) => (
            <div key={entry.name} className="rounded-lg border border-border/70 p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <code className="truncate font-mono text-[11px] font-semibold text-foreground">
                  {entry.name}
                </code>
                {entry.provider ? (
                  <Badge variant="muted" className="h-5 px-1.5 text-[10px]">
                    {entry.provider}
                  </Badge>
                ) : null}
                <span className="ml-auto">
                  <SkillEnvStateBadge state={entry.state} />
                </span>
              </div>
              {entry.description ? (
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  {entry.description}
                </p>
              ) : null}
              <div className="mt-2 flex items-center gap-2">
                <SkillEnvValueEditor
                  configured={entry.state === "user"}
                  onCommit={(value) => commitValue(entry.name, value)}
                />
              </div>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {entry.url ? (
                  <a
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-foreground underline underline-offset-2"
                  >
                    {t("settings.skillsEnvApplyUrl")}
                  </a>
                ) : null}
                {entry.sources.length > 0 ? (
                  <span className="min-w-0 truncate" title={entry.sources.join(", ")}>
                    {t("settings.skillsEnvSources")} {entry.sources.join(", ")}
                  </span>
                ) : null}
                <span className="ml-auto flex items-center gap-3">
                  {entry.state === "user" ? (
                    <SkillEnvTextAction
                      label={t("settings.skillsEnvClearValue")}
                      onClick={() => clearValue(entry.name)}
                    />
                  ) : null}
                  <SkillEnvTextAction
                    label={
                      entry.confidence === "declared"
                        ? t("settings.skillsEnvMarkIgnored")
                        : t("settings.skillsEnvRemoveManual")
                    }
                    onClick={() =>
                      entry.confidence === "declared" ? markIgnored(entry) : removeEntry(entry)
                    }
                  />
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {suggestionRows.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            onClick={() => setOthersOpen((open) => !open)}
          >
            {t("settings.skillsEnvSuggestGroup").replace("{count}", String(suggestionRows.length))}
          </button>
          {othersOpen ? (
            <div className="mt-2 space-y-1.5">
              {suggestionRows.map((entry) => (
                <div
                  key={entry.name}
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5"
                >
                  <code
                    className="min-w-0 truncate font-mono text-[11px] text-foreground"
                    title={entry.sources.join(", ")}
                  >
                    {entry.name}
                  </code>
                  {entry.ignored ? (
                    <Badge variant="muted" className="h-5 px-1.5 text-[10px]">
                      {t("settings.skillsEnvIgnoredBadge")}
                    </Badge>
                  ) : entry.state !== "missing" ? (
                    <SkillEnvStateBadge state={entry.state} />
                  ) : null}
                  <span className="ml-auto flex items-center gap-3">
                    {entry.ignored ? (
                      <SkillEnvTextAction
                        label={t("settings.skillsEnvRestoreIgnored")}
                        onClick={() => restoreIgnored(entry.name)}
                      />
                    ) : (
                      <SkillEnvTextAction
                        label={t("settings.skillsEnvAdopt")}
                        onClick={() => adoptEntry(entry.name)}
                      />
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {mainRows.length === 0 && suggestionRows.length === 0 ? (
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          {t("settings.skillsEnvEmptyHint")}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Input
          value={addDraft}
          placeholder={t("settings.skillsEnvAddPlaceholder")}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          spellCheck={false}
          onChange={(event) => setAddDraft(event.target.value)}
          onPaste={(event) => {
            // 粘贴 NAME=值 或多行 .env 内容时直接批量导入。
            const text = event.clipboardData.getData("text");
            if (!/[\r\n=]/.test(text)) return;
            event.preventDefault();
            if (addFromText(text)) setAddDraft("");
            else setAddDraft(text.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (addFromText(addDraft)) setAddDraft("");
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0"
          disabled={parseSkillEnvAddEntries(addDraft).length === 0}
          onClick={() => {
            if (addFromText(addDraft)) setAddDraft("");
          }}
        >
          {t("settings.skillsEnvAddAction")}
        </Button>
      </div>
    </section>
  );
}
