import { AlertTriangle, BookOpen, Lock, SkillIcon } from "@liveagent/app/components/icons";
import { DocumentMarkdown } from "@liveagent/ui/components/markdown/DocumentMarkdown";
import { Badge } from "@liveagent/ui/components/ui/badge";
import { CopyButton } from "@liveagent/ui/components/ui/copy-button";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@liveagent/ui/components/ui/sheet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";
import { useMemo } from "react";

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
  onClose: () => void;
}) {
  const { onClose, skillsEnabled } = props;
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
  contentReady: boolean;
}) {
  const { skill, preview, previewContent, checked, skillsEnabled, contentReady } = props;
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
        <div className="min-w-0 flex-1">
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

      <SheetPanel className="px-5 py-5">
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
