import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassPanel, HubBackdrop, HubHeader } from "../../components/hub/HubChrome";
import {
  Activity,
  AlertTriangle,
  Blend,
  BookOpen,
  Brain,
  Check,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Folder,
  Globe,
  House,
  Layers,
  ListChecks,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquare,
  Package,
  Palette,
  Plug,
  RefreshCw,
  Search,
  Server,
  Shield,
  SkillIcon,
  Trash2,
  Wallet,
  Wrench,
  X,
  Zap,
} from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/button";
import { ConfirmDeletePopover } from "../../components/ui/confirm-action-popover";
import { useLocale } from "../../i18n";
import { type AppSettings, updateSkills } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import {
  cancelSkillInstallJob,
  discoverSkills,
  type ExternalToolScan,
  getSkillInstallJobStatus,
  isAlwaysEnabledSkillName,
  isUserSelectableSkill,
  isUserSelectableSkillName,
  manageSkill,
  mergeAlwaysEnabledSkillNames,
  notifySkillsDiscoveryUpdated,
  readSkillText,
  type SkillInstallJobSnapshot,
  type SkillSummary,
  scanExternalSkills,
  startSkillInstallJob,
} from "../../lib/skills";
import {
  buildClawHubDownloadUrl,
  buildClawHubSkillKey,
  type ClawHubSkillCard,
  type ClawHubSkillDetail,
  type ClawHubSort,
  getClawHubSkillDetail,
  listClawHubSkills,
  resolveClawHubSkillOwner,
  searchClawHubSkills,
} from "../../lib/skills/clawHub";
import {
  CLAWHUB_CATEGORY_SLUGS,
  type ClawHubCategorySlug,
  classifyClawHubSkill,
} from "../../lib/skills/clawHubCategories";

type SkillsHubView = "installed" | "store" | "import";

const EXTERNAL_TOOL_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  codebuddy: "CodeBuddy",
};

const STORE_PAGE_LIMIT = 24;
const INSTALLED_SKILL_PREVIEW_LINES = 10_000;
const COPY_FEEDBACK_MS = 1600;
const TERMINAL_INSTALL_PHASES = new Set(["done", "error", "cancelled"]);
const STORE_SORT_OPTIONS: Array<{ value: ClawHubSort; labelKey: string }> = [
  { value: "downloads", labelKey: "settings.skillsStoreSortMostDownloaded" },
  { value: "stars", labelKey: "settings.skillsStoreSortMostStarred" },
  { value: "installs", labelKey: "settings.skillsStoreSortMostInstalled" },
  { value: "updated", labelKey: "settings.skillsStoreSortRecentlyUpdated" },
  { value: "newest", labelKey: "settings.skillsStoreSortNewest" },
];

type StoreCategoryValue = "all" | ClawHubCategorySlug;

// 图标与 ClawHub 官网分类侧边栏一一对应（layers/plug/zap/globe/wrench/…）。
const STORE_CATEGORY_ICONS: Record<StoreCategoryValue, typeof Layers> = {
  all: Layers,
  integrations: Plug,
  automation: Zap,
  research: Globe,
  development: Wrench,
  productivity: ListChecks,
  communication: MessageCircle,
  creative: Palette,
  knowledge: BookOpen,
  agents: Brain,
  operations: Activity,
  security: Shield,
  finance: Wallet,
  lifestyle: House,
  other: Package,
};

function storeCategoryLabelKey(value: StoreCategoryValue): string {
  return `settings.skillsStoreCategory${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

// 已安装技能没有 ClawHub 的 topics 字段，用名称+描述做启发式分类。
function classifyInstalledSkill(skill: SkillSummary): ClawHubCategorySlug[] {
  return classifyClawHubSkill({
    slug: skill.name,
    displayName: skill.name,
    summary: skill.description,
    topics: [],
  });
}

const STORE_CATEGORY_OPTIONS: readonly StoreCategoryValue[] = ["all", ...CLAWHUB_CATEGORY_SLUGS];

/** 选中分类后若本地过滤结果少于该值且还有下一页，自动继续拉取补齐。 */
const STORE_CATEGORY_FILL_TARGET = 12;

type StoreSkillInstallState = {
  done: boolean;
  installing: boolean;
  pending: boolean;
  terminalJob: boolean;
  job: SkillInstallJobSnapshot | undefined;
  progress: number | null;
};

type InstalledSkillPreviewState = {
  skillFile: string;
  content: string;
  truncated: boolean;
  loading: boolean;
  error: string | null;
};

function emptyInstalledSkillPreviewState(): InstalledSkillPreviewState {
  return {
    skillFile: "",
    content: "",
    truncated: false,
    loading: false,
    error: null,
  };
}

function fallbackCopyText(text: string) {
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallbackCopyText(text);
    }
  }
  return fallbackCopyText(text);
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

function ScanActivityDots() {
  return (
    <span className="ml-0.5 inline-flex gap-[2px]" aria-hidden="true">
      <span className="skills-scan-dot h-1 w-1 rounded-full bg-foreground/55" />
      <span className="skills-scan-dot h-1 w-1 rounded-full bg-foreground/55" />
      <span className="skills-scan-dot h-1 w-1 rounded-full bg-foreground/55" />
    </span>
  );
}

function FrostSpinner() {
  return (
    <span className="hub-frost-spinner shrink-0" aria-hidden="true">
      {Array.from({ length: 12 }).map((_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

function buildSkillDiscoverySignature(rootDir: string, skills: SkillSummary[]) {
  return [
    rootDir,
    ...skills
      .map((skill) =>
        [
          skill.name,
          skill.baseDir,
          skill.skillFile,
          skill.source?.registry ?? "",
          skill.source?.slug ?? "",
          skill.source?.version ?? "",
        ].join("\0"),
      )
      .sort(),
  ].join("\n");
}

type SkillsHubPageProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  initialSkills?: SkillSummary[];
  initialRootDir?: string;
  isAgentMode: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
};

export function SkillsHubPage(props: SkillsHubPageProps) {
  const {
    settings,
    setSettings,
    initialSkills,
    initialRootDir,
    isAgentMode,
    sidebarOpen,
    onOpenSidebar,
  } = props;
  const { t } = useLocale();
  const lockedByChatMode = !isAgentMode;

  const [skills, setSkills] = useState<SkillSummary[]>(initialSkills ?? []);
  const [rootDir, setRootDir] = useState(initialRootDir ?? "");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [installedCategory, setInstalledCategory] = useState<StoreCategoryValue>("all");
  // 批量选择模式：仅在「已安装」「本地导入」页可用。用于在大量技能中快速圈选
  // 一段连续区间（点首项、Shift+点末项）而不必逐个勾选。
  const [bulkMode, setBulkMode] = useState(false);
  const bulkAnchorRef = useRef<string | null>(null);
  const [bulkUndo, setBulkUndo] = useState<{ selected: string[]; count: number } | null>(null);
  const bulkUndoTimerRef = useRef<number | null>(null);
  const [view, setView] = useState<SkillsHubView>("installed");
  const [storeQuery, setStoreQuery] = useState("");
  const [storeSort, setStoreSort] = useState<ClawHubSort>("downloads");
  const [storeItems, setStoreItems] = useState<ClawHubSkillCard[]>([]);
  const [storeCursor, setStoreCursor] = useState<string | null>(null);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeLoadingMore, setStoreLoadingMore] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [installJobs, setInstallJobs] = useState<Record<string, SkillInstallJobSnapshot>>({});
  const [installingByStoreKey, setInstallingByStoreKey] = useState<Record<string, string>>({});
  const [pendingInstallKeys, setPendingInstallKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pendingInstallTokensRef = useRef(new Map<string, symbol>());
  const [deletingSkillName, setDeletingSkillName] = useState<string | null>(null);
  const [externalScans, setExternalScans] = useState<ExternalToolScan[] | null>(null);
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [selectedExternal, setSelectedExternal] = useState<ReadonlySet<string>>(new Set());
  const [importQuery, setImportQuery] = useState("");
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [importErrors, setImportErrors] = useState<
    Array<{ baseDir: string; name: string; message: string }>
  >([]);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [previewInstalledSkill, setPreviewInstalledSkill] = useState<SkillSummary | null>(null);
  const [installedPreviewState, setInstalledPreviewState] = useState<InstalledSkillPreviewState>(
    () => emptyInstalledSkillPreviewState(),
  );
  const discoverySignatureRef = useRef(
    buildSkillDiscoverySignature(initialRootDir ?? "", initialSkills ?? []),
  );

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (lockedByChatMode) {
        setSkills([]);
        setRootDir("");
        setLoadError(null);
        setLoading(false);
        discoverySignatureRef.current = buildSkillDiscoverySignature("", []);
        return;
      }
      const silent = options?.silent === true;
      if (!silent) {
        setLoading(true);
      }
      setLoadError(null);
      try {
        const discovery = await discoverSkills({ force: true });
        const signature = buildSkillDiscoverySignature(discovery.rootDir, discovery.skills);
        const changed = discoverySignatureRef.current !== signature;
        discoverySignatureRef.current = signature;
        setSkills(discovery.skills);
        setRootDir(discovery.rootDir);
        if (changed) {
          notifySkillsDiscoveryUpdated();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSkills([]);
        setLoadError(msg || t("settings.skillsHubLoadFailed"));
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [lockedByChatMode, t],
  );

  useEffect(() => {
    if (initialSkills && initialSkills.length > 0) {
      setSkills(initialSkills);
    }
  }, [initialSkills]);

  useEffect(() => {
    if (initialRootDir) {
      setRootDir(initialRootDir);
    }
  }, [initialRootDir]);

  useEffect(() => {
    if ((initialSkills?.length ?? 0) === 0) {
      void refresh();
    }
  }, [initialSkills?.length, refresh]);

  const selected = useMemo(
    () => new Set(mergeAlwaysEnabledSkillNames(settings.skills.selected)),
    [settings.skills.selected],
  );
  const selectableSkills = useMemo(() => skills.filter(isUserSelectableSkill), [skills]);
  const selectedCount = selectableSkills.filter((skill) => selected.has(skill.name)).length;
  const installedSkillNames = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);

  const textFilteredInstalled = useMemo(() => {
    const text = filter.trim().toLowerCase();
    if (!text) return skills;
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(text) || skill.description.toLowerCase().includes(text),
    );
  }, [filter, skills]);

  // 已安装技能同样按 ClawHub 分区分类，让两个页签体验一致。始终启用（内置）
  // 技能没有真正的用途归属，统一归到 other 一栏而不参与语义分类。
  const categorizedInstalled = useMemo(
    () =>
      textFilteredInstalled.map((skill) => ({
        skill,
        categories: isAlwaysEnabledSkillName(skill.name)
          ? (["other"] as ClawHubCategorySlug[])
          : classifyInstalledSkill(skill),
      })),
    [textFilteredInstalled],
  );

  const installedCategoryCounts = useMemo(() => {
    const counts = new Map<StoreCategoryValue, number>();
    counts.set("all", categorizedInstalled.length);
    for (const { categories } of categorizedInstalled) {
      for (const category of categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return counts;
  }, [categorizedInstalled]);

  const filtered = useMemo(
    () =>
      installedCategory === "all"
        ? categorizedInstalled
        : categorizedInstalled.filter(({ categories }) => categories.includes(installedCategory)),
    [categorizedInstalled, installedCategory],
  );

  useEffect(() => {
    if (view === "installed" && !lockedByChatMode) return;
    setPreviewInstalledSkill(null);
  }, [lockedByChatMode, view]);

  const rescanExternalSkills = useCallback(async () => {
    setExternalLoading(true);
    setExternalError(null);
    try {
      const scans = await scanExternalSkills();
      setExternalScans(scans);
      // 剔除本次扫描已不存在的勾选项，避免按钮计数虚高或静默空导入
      const validBaseDirs = new Set(scans.flatMap((scan) => scan.skills.map((s) => s.baseDir)));
      setSelectedExternal((prev) => {
        const next = new Set([...prev].filter((baseDir) => validBaseDirs.has(baseDir)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      setExternalScans([]);
      setSelectedExternal(new Set());
      setExternalError(err instanceof Error ? err.message : String(err));
    } finally {
      setExternalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "import" || lockedByChatMode) return;
    if (externalScans !== null || externalLoading) return;
    void rescanExternalSkills();
  }, [view, lockedByChatMode, externalScans, externalLoading, rescanExternalSkills]);

  const toggleExternalSkill = useCallback((baseDir: string) => {
    setSelectedExternal((prev) => {
      const next = new Set(prev);
      if (next.has(baseDir)) {
        next.delete(baseDir);
      } else {
        next.add(baseDir);
      }
      return next;
    });
  }, []);

  // 批量模式下的区间勾选：把一组待导入技能统一设为选中/不选中。
  const batchToggleExternalSkills = useCallback((baseDirs: string[], on: boolean) => {
    setSelectedExternal((prev) => {
      const next = new Set(prev);
      for (const baseDir of baseDirs) {
        if (on) next.add(baseDir);
        else next.delete(baseDir);
      }
      return next;
    });
  }, []);

  const importSelectedExternalSkills = useCallback(async () => {
    const targets = (externalScans ?? [])
      .flatMap((scan) => scan.skills)
      .filter((skill) => selectedExternal.has(skill.baseDir));
    if (targets.length === 0 || importProgress) return;
    setImportErrors([]);
    setImportedCount(null);
    const failures: Array<{ baseDir: string; name: string; message: string }> = [];
    for (let index = 0; index < targets.length; index += 1) {
      setImportProgress({ done: index, total: targets.length });
      try {
        await manageSkill({
          action: "install",
          source: targets[index].baseDir,
          conflict: "backup",
        });
      } catch (err) {
        failures.push({
          baseDir: targets[index].baseDir,
          name: targets[index].name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setImportProgress(null);
    setImportErrors(failures);
    setImportedCount(targets.length - failures.length);
    setSelectedExternal(new Set());
    await refresh({ silent: true });
  }, [externalScans, selectedExternal, importProgress, refresh]);

  useEffect(() => {
    if (!previewInstalledSkill) {
      setInstalledPreviewState(emptyInstalledSkillPreviewState());
      return;
    }

    let cancelled = false;
    const skillFile = previewInstalledSkill.skillFile;
    setInstalledPreviewState({
      skillFile,
      content: "",
      truncated: false,
      loading: true,
      error: null,
    });

    void readSkillText({
      path: skillFile,
      offset: 0,
      length: INSTALLED_SKILL_PREVIEW_LINES,
    })
      .then((result) => {
        if (cancelled) return;
        setInstalledPreviewState({
          skillFile,
          content: result.content,
          truncated: result.truncated,
          loading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setInstalledPreviewState({
          skillFile,
          content: previewInstalledSkill.inlineContent ?? "",
          truncated: previewInstalledSkill.inlineContentTruncated ?? false,
          loading: false,
          error: msg || t("settings.skillsInstalledPreviewUnavailable"),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [previewInstalledSkill, t]);

  const installedStoreState = useMemo(() => {
    const installed = new Map<string, SkillSummary>();
    const slugs = new Set<string>();
    for (const skill of skills) {
      if (skill.source?.registry !== "clawhub") continue;
      const slug = skill.source.slug?.trim();
      if (!slug) continue;
      slugs.add(slug);
      installed.set(
        buildClawHubSkillKey({ slug, ownerHandle: skill.source.ownerHandle ?? null }),
        skill,
      );
    }
    return { installed, slugs };
  }, [skills]);
  const completedInstallState = useMemo(() => {
    const keys = new Set<string>();
    const slugs = new Set<string>();
    for (const [storeKey, jobId] of Object.entries(installingByStoreKey)) {
      const job = installJobs[jobId];
      if (job?.phase === "done") {
        keys.add(storeKey);
        if (job.slug?.trim()) slugs.add(job.slug.trim());
      }
    }
    for (const job of Object.values(installJobs)) {
      if (job.phase === "done" && job.slug?.trim()) {
        slugs.add(job.slug.trim());
        keys.add(
          buildClawHubSkillKey({
            slug: job.slug.trim(),
            ownerHandle: job.ownerHandle ?? null,
          }),
        );
      }
    }
    return { keys, slugs };
  }, [installJobs, installingByStoreKey]);
  const installedStoreKeys = useMemo(() => {
    const keys = new Set(installedStoreState.installed.keys());
    for (const key of completedInstallState.keys) {
      keys.add(key);
    }
    return keys;
  }, [completedInstallState.keys, installedStoreState.installed]);
  const installedStoreSlugs = useMemo(() => {
    const slugs = new Set(installedStoreState.slugs);
    for (const slug of completedInstallState.slugs) {
      slugs.add(slug);
    }
    return slugs;
  }, [completedInstallState.slugs, installedStoreState.slugs]);

  useEffect(() => {
    if (view !== "store" || lockedByChatMode) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const query = storeQuery.trim();
      setStoreLoading(true);
      setStoreError(null);
      setStoreCursor(null);
      try {
        if (query) {
          const results = await searchClawHubSkills({ query, limit: STORE_PAGE_LIMIT });
          if (!cancelled) {
            setStoreItems(results);
            setStoreCursor(null);
          }
        } else {
          const results = await listClawHubSkills({
            sort: storeSort,
            limit: STORE_PAGE_LIMIT,
          });
          if (!cancelled) {
            setStoreItems(results.items);
            setStoreCursor(results.nextCursor);
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setStoreItems([]);
          setStoreCursor(null);
          setStoreError(msg || t("settings.skillsHubStoreLoadFailed"));
        }
      } finally {
        if (!cancelled) {
          setStoreLoading(false);
        }
      }
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [lockedByChatMode, storeQuery, storeSort, t, view]);

  useEffect(() => {
    if (view !== "store" || lockedByChatMode) return;

    const syncLocalSkills = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh({ silent: true });
    };

    syncLocalSkills();
    window.addEventListener("focus", syncLocalSkills);
    document.addEventListener("visibilitychange", syncLocalSkills);
    const timer = window.setInterval(syncLocalSkills, 10_000);

    return () => {
      window.removeEventListener("focus", syncLocalSkills);
      document.removeEventListener("visibilitychange", syncLocalSkills);
      window.clearInterval(timer);
    };
  }, [lockedByChatMode, refresh, view]);

  const enableInstalledSkillsFromJob = useCallback(
    (job: SkillInstallJobSnapshot) => {
      const installedNames = (job.installed ?? [])
        .map((item) => item.name?.trim())
        .filter((name): name is string => Boolean(name) && !isAlwaysEnabledSkillName(name));
      if (installedNames.length === 0) return;

      setSettings((prev) => {
        const next = new Set(prev.skills.selected);
        let changed = prev.skills.enabled !== true;
        for (const name of installedNames) {
          if (!next.has(name)) {
            next.add(name);
            changed = true;
          }
        }
        if (!changed) return prev;
        return updateSkills(prev, {
          enabled: true,
          selected: Array.from(next),
        });
      });
    },
    [setSettings],
  );

  useEffect(() => {
    const activeJobs = Object.values(installJobs).filter(
      (job) => !TERMINAL_INSTALL_PHASES.has(job.phase),
    );
    if (activeJobs.length === 0) return;

    const timer = window.setInterval(() => {
      for (const job of activeJobs) {
        void getSkillInstallJobStatus(job.jobId)
          .then((next) => {
            setInstallJobs((prev) => ({ ...prev, [next.jobId]: next }));
            if (TERMINAL_INSTALL_PHASES.has(next.phase)) {
              if (next.phase === "done") {
                enableInstalledSkillsFromJob(next);
                void refresh({ silent: true });
              }
            }
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            setInstallJobs((prev) => ({
              ...prev,
              [job.jobId]: {
                ...job,
                phase: "error",
                error: msg || t("settings.skillsHubInstallStatusFailed"),
                finishedAt: Date.now(),
              },
            }));
          });
      }
    }, 600);

    return () => window.clearInterval(timer);
  }, [enableInstalledSkillsFromJob, installJobs, refresh, t]);

  async function loadMoreStore() {
    if (!storeCursor || storeLoading || storeLoadingMore || storeQuery.trim()) return;
    setStoreLoadingMore(true);
    setStoreError(null);
    try {
      const requestedLimit = Math.max(storeItems.length + STORE_PAGE_LIMIT, STORE_PAGE_LIMIT);
      const results = await listClawHubSkills({
        sort: storeSort,
        limit: requestedLimit,
      });
      const nextItems = dedupeStoreItems(results.items);
      if (nextItems.length > storeItems.length) {
        setStoreItems(nextItems);
        setStoreCursor(results.nextCursor);
      } else {
        setStoreCursor(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStoreError(msg || t("settings.skillsHubStoreLoadMoreFailed"));
    } finally {
      setStoreLoadingMore(false);
    }
  }

  async function installStoreSkill(skill: ClawHubSkillCard) {
    const initialStoreKey = buildClawHubSkillKey(skill);
    const initialJobId = installingByStoreKey[initialStoreKey];
    const initialJob = initialJobId ? installJobs[initialJobId] : undefined;
    if (
      lockedByChatMode ||
      pendingInstallTokensRef.current.has(initialStoreKey) ||
      installedStoreKeys.has(initialStoreKey) ||
      (!skill.ownerHandle && installedStoreSlugs.has(skill.slug)) ||
      (initialJob && !TERMINAL_INSTALL_PHASES.has(initialJob.phase))
    ) {
      return;
    }

    const pendingToken = Symbol(initialStoreKey);
    pendingInstallTokensRef.current.set(initialStoreKey, pendingToken);
    setPendingInstallKeys(new Set(pendingInstallTokensRef.current.keys()));
    setStoreError(null);
    try {
      const resolvedSkill = await resolveClawHubSkillOwner(skill);
      const storeKey = buildClawHubSkillKey(resolvedSkill);
      const activePendingToken = pendingInstallTokensRef.current.get(storeKey);
      if (activePendingToken && activePendingToken !== pendingToken) return;
      if (storeKey !== initialStoreKey) {
        pendingInstallTokensRef.current.set(storeKey, pendingToken);
        setPendingInstallKeys(new Set(pendingInstallTokensRef.current.keys()));
      }
      setStoreItems((prev) =>
        prev.map((item) =>
          item.slug === resolvedSkill.slug &&
          item.updatedAt === resolvedSkill.updatedAt &&
          (!item.ownerHandle || item.ownerHandle === resolvedSkill.ownerHandle)
            ? resolvedSkill
            : item,
        ),
      );
      const existingJobId = installingByStoreKey[storeKey];
      const existingJob = existingJobId ? installJobs[existingJobId] : undefined;
      if (
        installedStoreKeys.has(storeKey) ||
        (existingJob && !TERMINAL_INSTALL_PHASES.has(existingJob.phase))
      ) {
        return;
      }
      const job = await startSkillInstallJob({
        source: buildClawHubDownloadUrl(resolvedSkill.slug, resolvedSkill.ownerHandle),
        label: resolvedSkill.displayName,
        slug: resolvedSkill.slug,
        ownerHandle: resolvedSkill.ownerHandle,
        version: resolvedSkill.latestVersion,
        conflict: "backup",
      });
      setInstallJobs((prev) => ({ ...prev, [job.jobId]: job }));
      setInstallingByStoreKey((prev) => ({
        ...prev,
        [initialStoreKey]: job.jobId,
        [storeKey]: job.jobId,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStoreError(msg || t("settings.skillsHubInstallFailed"));
    } finally {
      let changed = false;
      for (const [storeKey, token] of pendingInstallTokensRef.current) {
        if (token !== pendingToken) continue;
        pendingInstallTokensRef.current.delete(storeKey);
        changed = true;
      }
      if (changed) {
        setPendingInstallKeys(new Set(pendingInstallTokensRef.current.keys()));
      }
    }
  }

  async function deleteSkill(skill: SkillSummary) {
    if (lockedByChatMode || isAlwaysEnabledSkillName(skill.name) || deletingSkillName) return;
    const skillName = skill.name;
    const sourceSlug = skill.source?.registry === "clawhub" ? skill.source.slug?.trim() || "" : "";
    const sourceOwnerHandle =
      skill.source?.registry === "clawhub" ? skill.source.ownerHandle?.trim() || null : null;
    setLoadError(null);
    setDeletingSkillName(skillName);
    try {
      await manageSkill({ action: "delete", name: skillName });
      setSettings((prev) =>
        updateSkills(prev, {
          selected: prev.skills.selected.filter((name) => name !== skillName),
        }),
      );
      setSkills((prev) => prev.filter((item) => item.name !== skillName));
      setPreviewInstalledSkill((current) => (current?.name === skillName ? null : current));
      if (sourceSlug) {
        const sourceKey = buildClawHubSkillKey({
          slug: sourceSlug,
          ownerHandle: sourceOwnerHandle,
        });
        setInstallingByStoreKey((prev) => {
          if (!(sourceKey in prev)) return prev;
          const next = { ...prev };
          delete next[sourceKey];
          return next;
        });
        setInstallJobs((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [jobId, job] of Object.entries(prev)) {
            if (
              job.slug?.trim() === sourceSlug &&
              (!sourceOwnerHandle || job.ownerHandle?.trim() === sourceOwnerHandle)
            ) {
              delete next[jobId];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      notifySkillsDiscoveryUpdated();
      await refresh({ silent: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg || t("settings.skillsHubDeleteFailed"));
    } finally {
      setDeletingSkillName(null);
    }
  }

  function toggleSkill(name: string, on: boolean) {
    if (isAlwaysEnabledSkillName(name)) return;
    const next = new Set(settings.skills.selected);
    if (on) next.add(name);
    else next.delete(name);
    setSettings((prev) => updateSkills(prev, { selected: Array.from(next) }));
  }

  const clearBulkUndoTimer = useCallback(() => {
    if (bulkUndoTimerRef.current !== null) {
      window.clearTimeout(bulkUndoTimerRef.current);
      bulkUndoTimerRef.current = null;
    }
  }, []);

  // 批量把一组已安装技能设为开/关。始终启用的技能被忽略；记录操作前的选择快照
  // 供撤销。names 应为「当前筛选可见」的技能，让批量只作用于用户看到的范围。
  const applyBulkInstalledSelection = useCallback(
    (names: string[], target: boolean) => {
      const selectable = names.filter(isUserSelectableSkillName);
      if (selectable.length === 0) return;

      setSettings((prev) => {
        const before = prev.skills.selected;
        const next = new Set(before);
        let changed = 0;
        for (const name of selectable) {
          if (target && !next.has(name)) {
            next.add(name);
            changed += 1;
          } else if (!target && next.has(name)) {
            next.delete(name);
            changed += 1;
          }
        }
        if (changed === 0) return prev;
        clearBulkUndoTimer();
        setBulkUndo({ selected: before, count: changed });
        bulkUndoTimerRef.current = window.setTimeout(() => {
          setBulkUndo(null);
          bulkUndoTimerRef.current = null;
        }, 6000);
        return updateSkills(prev, {
          enabled: target ? true : prev.skills.enabled,
          selected: Array.from(next),
        });
      });
    },
    [clearBulkUndoTimer, setSettings],
  );

  const undoBulkSelection = useCallback(() => {
    clearBulkUndoTimer();
    setBulkUndo((current) => {
      if (current) {
        setSettings((prev) => updateSkills(prev, { selected: current.selected }));
      }
      return null;
    });
  }, [clearBulkUndoTimer, setSettings]);

  // 在批量模式下点击某张已安装卡片。Shift+点击时以上一次锚点为起点，把可见列表
  // 中该区间内的技能统一设为「与被点技能翻转后一致」的状态。
  function handleBulkInstalledCardClick(name: string, orderedNames: string[], shiftKey: boolean) {
    if (isAlwaysEnabledSkillName(name)) return;
    const currentlyOn = selected.has(name);
    const target = !currentlyOn;

    if (shiftKey && bulkAnchorRef.current && bulkAnchorRef.current !== name) {
      const from = orderedNames.indexOf(bulkAnchorRef.current);
      const to = orderedNames.indexOf(name);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        applyBulkInstalledSelection(orderedNames.slice(lo, hi + 1), target);
        bulkAnchorRef.current = name;
        return;
      }
    }

    toggleSkill(name, target);
    bulkAnchorRef.current = name;
  }

  useEffect(() => clearBulkUndoTimer, [clearBulkUndoTimer]);

  // 离开可用批量的页签或退出批量模式时，复位锚点与刷选状态。
  useEffect(() => {
    if (view === "store") {
      setBulkMode(false);
    }
    if (!bulkMode) {
      bulkAnchorRef.current = null;
    }
  }, [view, bulkMode]);

  function openInstalledSkillPreview(skill: SkillSummary) {
    setPreviewInstalledSkill(skill);
  }

  function handleInstalledSkillCardKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    skill: SkillSummary,
  ) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openInstalledSkillPreview(skill);
  }

  function setSkillsEnabled(enabled: boolean) {
    setSettings((prev) => updateSkills(prev, { enabled }));
  }

  const skillsEnabled = settings.skills.enabled;
  const skillsStatusHint = lockedByChatMode
    ? t("settings.skillsDisabledInChatMode")
    : skillsEnabled
      ? null
      : null;

  return (
    <div className="hub-page hub-page-enter relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <HubBackdrop tone="amber" />

      <div className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden">
        <HubHeader
          icon={<Blend className="h-6 w-6" />}
          title={t("settings.skillsHubTitle")}
          subtitle={rootDir ? rootDir : t("settings.skillsHubSubtitle")}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={onOpenSidebar}
        />

        <div className="hub-scroll min-h-0 flex-1 overflow-hidden px-5 pb-6 pt-2 sm:px-6 lg:px-8 xl:px-10">
          <div className="hub-content-stage mx-auto flex h-full min-h-0 w-full max-w-[1320px] flex-col gap-4">
            {/* Status pill row */}
            <div
              className={cn(
                "hub-panel-enter relative overflow-hidden rounded-2xl border backdrop-blur-xl",
                skillsEnabled
                  ? "border-border/50 bg-background/75 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_8px_24px_-18px_rgba(15,23,42,0.18)] dark:border-white/[0.09] dark:bg-white/[0.05] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_8px_24px_-18px_rgba(0,0,0,0.6)]"
                  : "border-border/40 bg-background/60",
              )}
            >
              <div className="flex items-center gap-3 px-4 py-3.5 sm:gap-x-5 sm:px-5">
                <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-3.5">
                  <div
                    className={cn(
                      "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border transition-colors",
                      skillsEnabled
                        ? "border-border/50 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
                        : "border-border/40 bg-muted/40 text-muted-foreground",
                    )}
                  >
                    <Plug className="h-5 w-5" />
                    {skillsEnabled ? (
                      <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <div className="text-[13.5px] font-semibold tracking-tight text-foreground">
                        {skillsEnabled
                          ? t("settings.skillsHubEnabled")
                          : t("settings.skillsHubDisabled")}
                      </div>
                      {selectableSkills.length > 0 && (
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums backdrop-blur-md",
                            selectedCount > 0
                              ? "bg-foreground/[0.06] text-foreground/85 ring-1 ring-border/50"
                              : "bg-background/60 text-muted-foreground ring-1 ring-border/40",
                          )}
                        >
                          <span className="font-semibold">{selectedCount}</span>
                          <span className="opacity-50">/</span>
                          <span className="opacity-80">{selectableSkills.length}</span>
                          <span className="ml-0.5 opacity-70">
                            {t("settings.skillsHubSelectedShort")}
                          </span>
                        </span>
                      )}
                    </div>
                    {skillsStatusHint ? (
                      <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                        {skillsStatusHint}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={skillsEnabled}
                    disabled={lockedByChatMode}
                    onClick={() => setSkillsEnabled(!skillsEnabled)}
                    className={cn(
                      "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ring-1 transition-all",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                      skillsEnabled
                        ? "bg-emerald-500 ring-emerald-400/45 shadow-[0_2px_10px_-3px_rgba(16,185,129,0.65)] dark:bg-emerald-400 dark:ring-emerald-300/45"
                        : "bg-muted-foreground/25 ring-border/40",
                    )}
                    title={
                      skillsEnabled
                        ? t("settings.skillsHubToggleDisable")
                        : t("settings.skillsHubToggleEnable")
                    }
                  >
                    <span
                      className={cn(
                        "pointer-events-none inline-block h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform",
                        skillsEnabled ? "translate-x-[1.4rem]" : "translate-x-[0.15rem]",
                      )}
                    />
                  </button>

                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-8 shrink-0 gap-1.5 rounded-full border-border/50 bg-background/70 px-3 backdrop-blur-md",
                      loading && "border-border/60 bg-background/85 text-foreground",
                    )}
                    onClick={() => void refresh()}
                    disabled={loading || lockedByChatMode}
                    title={loading ? t("settings.skillsScanning") : t("settings.skillsScan")}
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                    <span className="hidden sm:inline-grid items-center">
                      <span
                        className="invisible col-start-1 row-start-1 inline-flex items-center justify-center whitespace-nowrap"
                        aria-hidden="true"
                      >
                        <span>{t("settings.skillsScanning")}</span>
                        <ScanActivityDots />
                      </span>
                      <span className="col-start-1 row-start-1 inline-flex items-center justify-center whitespace-nowrap">
                        <span>
                          {loading ? t("settings.skillsScanning") : t("settings.skillsScan")}
                        </span>
                        {loading ? <ScanActivityDots /> : null}
                      </span>
                    </span>
                  </Button>
                </div>
              </div>
            </div>

            <div className="hub-panel-enter flex items-center justify-between gap-3">
              <div className="inline-flex shrink-0 rounded-2xl border border-border/40 bg-background/60 p-1 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                {[
                  {
                    value: "installed" as const,
                    label: t("settings.skillsHubInstalledTab"),
                    icon: Server,
                    count: selectableSkills.length,
                  },
                  {
                    value: "store" as const,
                    label: t("settings.skillsHubStoreTab"),
                    icon: Cloud,
                    count: null,
                  },
                  {
                    value: "import" as const,
                    label: t("settings.skillsHubImportTab"),
                    icon: Download,
                    count: null,
                  },
                ].map((item) => {
                  const Icon = item.icon;
                  const active = view === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setView(item.value)}
                      className={cn(
                        "relative inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-[12.5px] font-medium transition-all",
                        active
                          ? "bg-background/85 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_12px_-8px_rgba(15,23,42,0.18)] ring-1 ring-border/45 dark:bg-white/[0.08] dark:ring-white/[0.09] dark:shadow-[0_1px_0_rgba(255,255,255,0.07)_inset,0_4px_12px_-8px_rgba(0,0,0,0.55)]"
                          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{item.label}</span>
                      {item.count !== null && item.count > 0 ? (
                        <span
                          className={cn(
                            "ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                            active
                              ? "bg-foreground/[0.08] text-foreground/85"
                              : "bg-muted/70 text-muted-foreground",
                          )}
                        >
                          {item.count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {!lockedByChatMode ? (
                <div className="flex w-full min-w-0 items-center justify-end gap-2">
                  {view !== "store" ? (
                    <button
                      type="button"
                      aria-pressed={bulkMode}
                      onClick={() => setBulkMode((prev) => !prev)}
                      title={
                        view === "installed"
                          ? t("settings.skillsBulkHint")
                          : t("settings.skillsBulkImportHint")
                      }
                      className={cn(
                        "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-3.5 text-[12.5px] font-medium backdrop-blur-xl transition-all",
                        bulkMode
                          ? "border-border/55 bg-background/85 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_12px_-8px_rgba(15,23,42,0.18)] ring-1 ring-border/45 dark:border-white/[0.09] dark:bg-white/[0.08] dark:ring-white/[0.09]"
                          : "border-border/40 bg-background/60 text-muted-foreground hover:bg-background/80 hover:text-foreground dark:border-white/[0.06] dark:bg-white/[0.04]",
                      )}
                    >
                      <ListChecks className="h-3.5 w-3.5" />
                      <span>{t("settings.skillsBulkSelect")}</span>
                    </button>
                  ) : null}
                  <div className="relative w-full min-w-0 max-w-md">
                    <Search className="absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={
                        view === "installed" ? filter : view === "store" ? storeQuery : importQuery
                      }
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        if (view === "installed") {
                          setFilter(value);
                        } else if (view === "store") {
                          setStoreQuery(value);
                        } else {
                          setImportQuery(value);
                        }
                      }}
                      placeholder={
                        view === "installed"
                          ? t("settings.skillsSearch")
                          : view === "store"
                            ? t("settings.skillsStoreSearch")
                            : t("settings.skillsImportSearchPlaceholder")
                      }
                      className="h-10 w-full rounded-xl border border-border/40 bg-background/60 pl-10 pr-3 text-[13px] outline-hidden backdrop-blur-xl transition-all placeholder:text-muted-foreground/60 focus:border-border/60 focus:bg-background/85 focus:ring-2 focus:ring-foreground/10"
                    />
                  </div>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {lockedByChatMode ? (
                <div className="h-full min-h-0 overflow-y-auto pb-4 pr-1">
                  <GlassPanel tone="muted" className="hub-panel-enter">
                    <div className="flex items-start gap-3">
                      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">
                        {t("settings.skillsDisabledInChatMode")}
                      </span>
                    </div>
                  </GlassPanel>
                </div>
              ) : (
                <>
                  {view === "installed" ? (
                    <div className="h-full min-h-0 overflow-y-auto px-0.5 pb-4 pr-1 pt-1.5">
                      <div className="flex flex-col gap-5">
                        {skills.length > 0 ? (
                          <StoreCategoryChips
                            value={installedCategory}
                            counts={installedCategoryCounts}
                            onChange={setInstalledCategory}
                          />
                        ) : null}

                        {bulkMode ? (
                          <div className="hub-panel-enter flex items-center gap-2 text-[11px] text-muted-foreground/80">
                            <ListChecks className="h-3.5 w-3.5 shrink-0" />
                            <span>{t("settings.skillsBulkHint")}</span>
                          </div>
                        ) : null}

                        {loadError ? (
                          <GlassPanel tone="error" className="hub-panel-enter">
                            <div className="flex items-center gap-2">
                              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                              <span className="text-xs text-destructive">{loadError}</span>
                            </div>
                          </GlassPanel>
                        ) : null}

                        {!skillsEnabled ? (
                          <GlassPanel tone="muted" className="hub-panel-enter">
                            <div className="flex items-center gap-2">
                              <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">
                                {t("settings.skillsDisabledHint")}
                              </span>
                            </div>
                          </GlassPanel>
                        ) : null}

                        {!loading && skills.length === 0 && !loadError ? (
                          <GlassPanel className="hub-panel-enter">
                            <div className="flex flex-col items-center gap-3 py-8 text-center">
                              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
                                <BookOpen className="h-5 w-5 text-muted-foreground" />
                              </div>
                              <div className="space-y-1">
                                <p className="text-sm font-medium text-muted-foreground">
                                  {t("settings.skillsNotFound")}
                                </p>
                                <p className="text-xs text-muted-foreground/70">
                                  {t("settings.skillsNotFoundHint")}
                                </p>
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                className="mt-1 gap-1.5 rounded-full"
                                onClick={() => void refresh()}
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                                {t("settings.skillsRescan")}
                              </Button>
                            </div>
                          </GlassPanel>
                        ) : null}

                        {loading && skills.length === 0 ? (
                          <>
                            <div className="hub-frost-hero hub-panel-enter px-4 py-3.5">
                              <div className="flex items-center gap-3.5">
                                <FrostSpinner />
                                <div className="min-w-0 flex-1">
                                  <div className="text-[13px] font-medium tracking-tight text-foreground">
                                    {t("settings.skillsScanning")}
                                  </div>
                                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                                    {t("settings.skillsHubScanning")}
                                  </div>
                                </div>
                              </div>
                              <div className="hub-frost-track mt-3.5" />
                            </div>

                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                              {[1, 2, 3, 4, 5, 6].map((item) => (
                                <div
                                  key={item}
                                  className="hub-frost-skeleton skill-card-enter p-3.5"
                                >
                                  <div className="flex items-center gap-3">
                                    <div className="skills-skeleton-shimmer h-9 w-9 shrink-0 rounded-lg" />
                                    <div className="flex-1 space-y-2">
                                      <div className="skills-skeleton-shimmer h-3.5 w-28 rounded" />
                                      <div className="skills-skeleton-shimmer h-3 w-full max-w-[12rem] rounded" />
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : null}

                        {filtered.length > 0 ? (
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {filtered.map(({ skill, categories }) => {
                              const alwaysEnabled = isAlwaysEnabledSkillName(skill.name);
                              const checked = alwaysEnabled || selected.has(skill.name);
                              const deleting = deletingSkillName === skill.name;
                              const deleteDisabled = deletingSkillName !== null;
                              const PrimaryCategoryIcon =
                                STORE_CATEGORY_ICONS[categories[0] ?? "other"];
                              const card = (
                                <>
                                  <div className="flex items-start justify-between gap-2">
                                    <div
                                      className={cn(
                                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all",
                                        checked
                                          ? "border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
                                          : "border-border/30 bg-muted/50 text-muted-foreground group-hover:border-border/50 group-hover:bg-background/70 group-hover:text-foreground/85",
                                      )}
                                    >
                                      <PrimaryCategoryIcon className="h-5 w-5" />
                                    </div>

                                    {alwaysEnabled ? (
                                      <div
                                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium text-foreground/75 ring-1 ring-border/45"
                                        title={t("settings.skillsAlwaysOn")}
                                      >
                                        <Lock className="h-2.5 w-2.5" />
                                        <span>{t("settings.skillsAlwaysOn")}</span>
                                      </div>
                                    ) : (
                                      <div
                                        className="flex shrink-0 items-center gap-1.5"
                                        onClick={(event) => event.stopPropagation()}
                                        onKeyDown={(event) => event.stopPropagation()}
                                      >
                                        <label className="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center">
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            aria-label={`${t("skills.select")}: ${skill.name}`}
                                            onClick={(event) => event.stopPropagation()}
                                            onChange={(event) => {
                                              event.stopPropagation();
                                              toggleSkill(skill.name, event.currentTarget.checked);
                                            }}
                                            className="peer sr-only"
                                          />
                                          <span
                                            aria-hidden="true"
                                            className={cn(
                                              "pointer-events-none flex h-5 w-5 items-center justify-center rounded-md border transition-all",
                                              "peer-focus-visible:outline-hidden peer-focus-visible:ring-2 peer-focus-visible:ring-foreground/15",
                                              checked
                                                ? "border-foreground/80 bg-foreground/85 text-background shadow-[0_2px_6px_-2px_rgba(15,23,42,0.35)] dark:shadow-[0_2px_6px_-2px_rgba(0,0,0,0.6)]"
                                                : "border-border bg-background group-hover:border-foreground/40",
                                            )}
                                          >
                                            {checked ? <Check className="h-3 w-3" /> : null}
                                          </span>
                                        </label>
                                      </div>
                                    )}
                                  </div>

                                  <div className="mt-2.5 min-w-0 flex-1">
                                    <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                                      {skill.name}
                                    </div>
                                    {skill.description ? (
                                      <p className="mt-1 line-clamp-2 text-[11.5px] leading-[1.4] text-muted-foreground">
                                        {skill.description}
                                      </p>
                                    ) : null}
                                    {!alwaysEnabled ? (
                                      <div className="mt-2">
                                        <SkillCategoryBadges
                                          categories={categories}
                                          onSelect={setInstalledCategory}
                                        />
                                      </div>
                                    ) : null}
                                  </div>

                                  <div className="mt-2.5 flex min-h-8 items-center gap-1 border-t border-border/30 pt-2 text-[10.5px] text-muted-foreground/70">
                                    <FileText className="h-3 w-3 shrink-0" />
                                    <span className="truncate">{skill.skillFile}</span>
                                    {!alwaysEnabled ? (
                                      <div
                                        className="ml-auto shrink-0"
                                        onClick={(event) => event.stopPropagation()}
                                        onKeyDown={(event) => event.stopPropagation()}
                                      >
                                        <ConfirmDeletePopover
                                          name={skill.name}
                                          onConfirm={() => void deleteSkill(skill)}
                                        >
                                          {(open) => (
                                            <button
                                              type="button"
                                              disabled={deleteDisabled}
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                open();
                                              }}
                                              className={cn(
                                                "flex h-6 w-6 items-center justify-center rounded-md border border-border/35 bg-background/65 text-muted-foreground transition-all",
                                                "hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive",
                                                "disabled:cursor-not-allowed",
                                                // Hover-revealed on pointer devices; keyboard focus and
                                                // touch (no hover — webui mobile) keep it reachable.
                                                deleting
                                                  ? "pointer-events-auto opacity-100"
                                                  : cn(
                                                      "pointer-events-none opacity-0 group-hover:pointer-events-auto focus-visible:pointer-events-auto [@media(hover:none)]:pointer-events-auto",
                                                      deleteDisabled
                                                        ? "group-hover:opacity-60 focus-visible:opacity-60 [@media(hover:none)]:opacity-60"
                                                        : "group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
                                                    ),
                                              )}
                                              title={t("settings.skillsHubDeleteSkill")}
                                            >
                                              {deleting ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                              ) : (
                                                <Trash2 className="h-3.5 w-3.5" />
                                              )}
                                            </button>
                                          )}
                                        </ConfirmDeletePopover>
                                      </div>
                                    ) : null}
                                  </div>
                                </>
                              );

                              const key = `${skill.name}-${rootDir}`;
                              if (alwaysEnabled) {
                                return (
                                  <button
                                    key={key}
                                    type="button"
                                    aria-label={`${t("settings.skillsInstalledPreviewOpen")}: ${skill.name}`}
                                    onClick={() => openInstalledSkillPreview(skill)}
                                    className="hub-skill-card skill-card-enter group flex h-full w-full cursor-pointer flex-col rounded-2xl border border-border/50 bg-background/75 p-3.5 text-left backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.55)_inset,0_4px_18px_-12px_rgba(15,23,42,0.16)] transition-all hover:-translate-y-0.5 hover:border-border/60 hover:bg-background/85 hover:shadow-[0_4px_16px_-10px_rgba(15,23,42,0.18)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_1px_0_rgba(255,255,255,0.05)_inset,0_4px_18px_-12px_rgba(0,0,0,0.5)] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.07] dark:hover:shadow-[0_4px_16px_-10px_rgba(0,0,0,0.55)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/15"
                                  >
                                    {card}
                                  </button>
                                );
                              }

                              return (
                                // biome-ignore lint/a11y/useSemanticElements: The card contains nested controls and cannot be a native button.
                                <div
                                  key={key}
                                  role="button"
                                  tabIndex={0}
                                  aria-label={`${t("settings.skillsInstalledPreviewOpen")}: ${skill.name}`}
                                  onClick={(event) => {
                                    if (bulkMode) {
                                      handleBulkInstalledCardClick(
                                        skill.name,
                                        filtered.map((entry) => entry.skill.name),
                                        event.shiftKey,
                                      );
                                      return;
                                    }
                                    openInstalledSkillPreview(skill);
                                  }}
                                  onMouseDown={(event) => {
                                    // Shift+点击做区间选择时避免浏览器拖出文本选区
                                    if (bulkMode && event.shiftKey) event.preventDefault();
                                  }}
                                  onKeyDown={(event) => {
                                    if (bulkMode && (event.key === "Enter" || event.key === " ")) {
                                      event.preventDefault();
                                      handleBulkInstalledCardClick(
                                        skill.name,
                                        filtered.map((entry) => entry.skill.name),
                                        event.shiftKey,
                                      );
                                      return;
                                    }
                                    handleInstalledSkillCardKeyDown(event, skill);
                                  }}
                                  className={cn(
                                    "hub-skill-card skill-card-enter group flex h-full w-full flex-col rounded-2xl border p-3.5 text-left transition-all",
                                    "cursor-pointer backdrop-blur-xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/15",
                                    checked
                                      ? "border-border/55 bg-background/80 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_18px_-12px_rgba(15,23,42,0.18)] dark:border-white/[0.10] dark:bg-white/[0.07] dark:shadow-[0_1px_0_rgba(255,255,255,0.07)_inset,0_4px_18px_-12px_rgba(0,0,0,0.55)]"
                                      : "border-border/35 bg-background/55 hover:-translate-y-0.5 hover:border-border/55 hover:bg-background/70 hover:shadow-[0_4px_16px_-10px_rgba(15,23,42,0.18)] dark:border-white/[0.05] dark:bg-white/[0.03] dark:hover:border-white/[0.10] dark:hover:bg-white/[0.06] dark:hover:shadow-[0_4px_16px_-10px_rgba(0,0,0,0.55)]",
                                  )}
                                >
                                  {card}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}

                        {(filter.trim() || installedCategory !== "all") &&
                        filtered.length === 0 &&
                        skills.length > 0 ? (
                          <GlassPanel tone="muted" className="hub-panel-enter">
                            <p className="py-2 text-center text-sm text-muted-foreground">
                              {filter.trim()
                                ? t("settings.skillsNoMatch").replace("{filter}", filter)
                                : t("settings.skillsStoreEmptyTitle")}
                            </p>
                          </GlassPanel>
                        ) : null}
                      </div>
                    </div>
                  ) : view === "store" ? (
                    <SkillsStoreView
                      items={storeItems}
                      query={storeQuery}
                      sort={storeSort}
                      loading={storeLoading}
                      loadingMore={storeLoadingMore}
                      error={storeError}
                      cursor={storeCursor}
                      installedKeys={installedStoreKeys}
                      installedSlugs={installedStoreSlugs}
                      pendingInstallKeys={pendingInstallKeys}
                      installingByStoreKey={installingByStoreKey}
                      installJobs={installJobs}
                      onSortChange={setStoreSort}
                      onLoadMore={() => void loadMoreStore()}
                      onInstall={(skill) => void installStoreSkill(skill)}
                    />
                  ) : (
                    <SkillsImportView
                      scans={externalScans ?? []}
                      loading={externalLoading}
                      error={externalError}
                      query={importQuery}
                      selected={selectedExternal}
                      installedNames={installedSkillNames}
                      importProgress={importProgress}
                      importErrors={importErrors}
                      importedCount={importedCount}
                      bulkMode={bulkMode}
                      onToggle={toggleExternalSkill}
                      onBatchToggle={batchToggleExternalSkills}
                      onRescan={() => void rescanExternalSkills()}
                      onImport={() => void importSelectedExternalSkills()}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {previewInstalledSkill ? (
        <InstalledSkillPreviewDrawer
          skill={previewInstalledSkill}
          preview={installedPreviewState}
          checked={
            isAlwaysEnabledSkillName(previewInstalledSkill.name) ||
            selected.has(previewInstalledSkill.name)
          }
          skillsEnabled={skillsEnabled}
          onClose={() => setPreviewInstalledSkill(null)}
        />
      ) : null}

      {bulkUndo ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
          <div className="hub-panel-enter pointer-events-auto flex items-center gap-3 rounded-full border border-border/50 bg-background/90 py-2 pl-4 pr-2 text-[12.5px] shadow-[0_8px_24px_-12px_rgba(15,23,42,0.35)] backdrop-blur-xl dark:border-white/[0.1] dark:bg-white/[0.08]">
            <span className="text-foreground/85">
              {t("settings.skillsBulkUpdated").replace("{count}", String(bulkUndo.count))}
            </span>
            <button
              type="button"
              onClick={undoBulkSelection}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-foreground/[0.08] px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.14]"
            >
              {t("settings.skillsBulkUndo")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SkillsImportView(props: {
  scans: ExternalToolScan[];
  loading: boolean;
  error: string | null;
  query: string;
  selected: ReadonlySet<string>;
  installedNames: ReadonlySet<string>;
  importProgress: { done: number; total: number } | null;
  importErrors: Array<{ baseDir: string; name: string; message: string }>;
  importedCount: number | null;
  bulkMode: boolean;
  onToggle: (baseDir: string) => void;
  onBatchToggle: (baseDirs: string[], on: boolean) => void;
  onRescan: () => void;
  onImport: () => void;
}) {
  const {
    scans,
    loading,
    error,
    query,
    selected,
    installedNames,
    importProgress,
    importErrors,
    importedCount,
    bulkMode,
    onToggle,
    onBatchToggle,
    onRescan,
    onImport,
  } = props;
  const { t } = useLocale();
  const bulkAnchorRef = useRef<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredScans = useMemo(
    () =>
      scans.map((scan) => ({
        ...scan,
        skills: normalizedQuery
          ? scan.skills.filter(
              (skill) =>
                skill.name.toLowerCase().includes(normalizedQuery) ||
                skill.description.toLowerCase().includes(normalizedQuery),
            )
          : scan.skills,
      })),
    [scans, normalizedQuery],
  );
  const importing = importProgress !== null;

  const [activeTool, setActiveTool] = useState<string>(scans[0]?.tool ?? "claude-code");
  const userChoseToolRef = useRef(false);
  // 扫描结果就绪后自动定位到第一个有技能的工具；用户手动切换后不再干预
  useEffect(() => {
    if (userChoseToolRef.current || scans.length === 0) return;
    const preferred =
      scans.find((scan) => scan.skills.length > 0) ?? scans.find((scan) => scan.exists) ?? scans[0];
    if (preferred && preferred.tool !== activeTool) {
      setActiveTool(preferred.tool);
    }
  }, [scans, activeTool]);
  const activeScan = filteredScans.find((scan) => scan.tool === activeTool);

  return (
    <div className="h-full min-h-0 overflow-y-auto px-0.5 pb-4 pr-1 pt-1.5">
      <div className="flex flex-col gap-4">
        {error ? (
          <GlassPanel tone="error" className="hub-panel-enter">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              <span className="text-xs text-destructive">
                {t("settings.skillsImportScanFailed")}: {error}
              </span>
            </div>
          </GlassPanel>
        ) : null}

        {importErrors.length > 0 ? (
          <GlassPanel tone="error" className="hub-panel-enter">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                <span className="text-xs font-medium text-destructive">
                  {t("settings.skillsImportFailed")}
                </span>
              </div>
              {importErrors.map((failure) => (
                <div key={failure.baseDir} className="pl-6 text-[11px] text-destructive/90">
                  {failure.name}: {failure.message}
                </div>
              ))}
            </div>
          </GlassPanel>
        ) : null}

        {importedCount !== null && importedCount > 0 ? (
          <GlassPanel tone="muted" className="hub-panel-enter">
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 shrink-0 text-[hsl(var(--chat-success))]" />
              <span className="text-xs text-muted-foreground">
                {t("settings.skillsImportDone")} ({importedCount})
              </span>
            </div>
          </GlassPanel>
        ) : null}

        {loading ? (
          <GlassPanel className="hub-panel-enter">
            <div className="flex items-center gap-3 py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {t("settings.skillsImportScanning")}
              </span>
            </div>
          </GlassPanel>
        ) : (
          <>
            <div className="hub-panel-enter flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex shrink-0 rounded-2xl border border-border/40 bg-background/60 p-1 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                {filteredScans.map((scan) => {
                  const toolLabel = EXTERNAL_TOOL_LABELS[scan.tool] ?? scan.tool;
                  const active = scan.tool === activeTool;
                  return (
                    <button
                      key={scan.tool}
                      type="button"
                      onClick={() => {
                        userChoseToolRef.current = true;
                        setActiveTool(scan.tool);
                      }}
                      className={cn(
                        "relative inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-[12.5px] font-medium transition-all",
                        active
                          ? "bg-background/85 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_12px_-8px_rgba(15,23,42,0.18)] ring-1 ring-border/45 dark:bg-white/[0.08] dark:ring-white/[0.09] dark:shadow-[0_1px_0_rgba(255,255,255,0.07)_inset,0_4px_12px_-8px_rgba(0,0,0,0.55)]"
                          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                      )}
                    >
                      <Folder className="h-3.5 w-3.5" />
                      <span>{toolLabel}</span>
                      {scan.exists ? (
                        <span
                          className={cn(
                            "ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                            active
                              ? "bg-foreground/[0.08] text-foreground/85"
                              : "bg-muted/70 text-muted-foreground",
                          )}
                        >
                          {scan.skills.length}
                        </span>
                      ) : (
                        <span className="ml-0.5 text-[10px] text-muted-foreground/70">
                          {t("settings.skillsImportNotDetected")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 rounded-full"
                  disabled={loading || importing}
                  onClick={onRescan}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                  {t("settings.skillsImportRescan")}
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5 rounded-full"
                  disabled={selected.size === 0 || importing || loading}
                  onClick={onImport}
                >
                  {importing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {importing && importProgress
                    ? `${t("settings.skillsImportProgress")} ${importProgress.done + 1}/${importProgress.total}`
                    : `${t("settings.skillsImportButton")}${selected.size > 0 ? ` (${selected.size})` : ""}`}
                </Button>
              </div>
            </div>

            {bulkMode ? (
              <div className="hub-panel-enter flex items-center gap-2 text-[11px] text-muted-foreground/80">
                <ListChecks className="h-3.5 w-3.5 shrink-0" />
                <span>{t("settings.skillsBulkImportHint")}</span>
              </div>
            ) : null}

            {activeScan ? (
              <div key={activeScan.tool} className="hub-panel-enter flex flex-col gap-3">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/70">
                  <span className="font-mono">{activeScan.rootDir}</span>
                  {activeScan.tool === "codebuddy" && activeScan.exists ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{t("settings.skillsImportCodebuddyHint")}</span>
                    </>
                  ) : null}
                  {activeScan.errors.length > 0 ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        {t("settings.skillsImportUnparsable").replace(
                          "{count}",
                          String(activeScan.errors.length),
                        )}
                      </span>
                    </>
                  ) : null}
                  {activeScan.exists && activeScan.skills.length > 0 ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{t("settings.skillsImportOverwriteHint")}</span>
                    </>
                  ) : null}
                </p>

                {!activeScan.exists ? (
                  <GlassPanel tone="muted">
                    <p className="py-2 text-center text-xs text-muted-foreground">
                      {t("settings.skillsImportNotDetected")} · {activeScan.rootDir}
                    </p>
                  </GlassPanel>
                ) : activeScan.skills.length === 0 ? (
                  <GlassPanel tone="muted">
                    <p className="py-2 text-center text-xs text-muted-foreground">
                      {t("settings.skillsImportEmpty")}
                    </p>
                  </GlassPanel>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {activeScan.skills.map((skill) => {
                      const checked = selected.has(skill.baseDir);
                      const alreadyInstalled = installedNames.has(skill.name);
                      return (
                        <button
                          key={skill.baseDir}
                          type="button"
                          disabled={importing}
                          onMouseDown={(event) => {
                            if (bulkMode && event.shiftKey) event.preventDefault();
                          }}
                          onClick={(event) => {
                            const orderedBaseDirs = activeScan.skills.map((item) => item.baseDir);
                            if (
                              bulkMode &&
                              event.shiftKey &&
                              bulkAnchorRef.current &&
                              bulkAnchorRef.current !== skill.baseDir
                            ) {
                              const from = orderedBaseDirs.indexOf(bulkAnchorRef.current);
                              const to = orderedBaseDirs.indexOf(skill.baseDir);
                              if (from !== -1 && to !== -1) {
                                const [lo, hi] = from < to ? [from, to] : [to, from];
                                onBatchToggle(orderedBaseDirs.slice(lo, hi + 1), !checked);
                                bulkAnchorRef.current = skill.baseDir;
                                return;
                              }
                            }
                            onToggle(skill.baseDir);
                            bulkAnchorRef.current = skill.baseDir;
                          }}
                          className={cn(
                            "group flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60",
                            checked
                              ? "border-primary/60 bg-primary/5 shadow-sm shadow-primary/10"
                              : "border-border/40 bg-background/60 hover:border-border/70 hover:bg-background/85",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                              checked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border/70 bg-background",
                            )}
                          >
                            {checked ? <Check className="h-3 w-3" /> : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-[13px] font-medium text-foreground">
                                {skill.name}
                              </span>
                              {alreadyInstalled ? (
                                <span className="shrink-0 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                  {t("settings.skillsImportInstalledBadge")}
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
                              {skill.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function InstalledSkillPreviewDrawer(props: {
  skill: SkillSummary;
  preview: InstalledSkillPreviewState;
  checked: boolean;
  skillsEnabled: boolean;
  onClose: () => void;
}) {
  const { skill, preview, checked, skillsEnabled, onClose } = props;
  const { t } = useLocale();
  const alwaysEnabled = isAlwaysEnabledSkillName(skill.name);
  const source = skill.source;
  const description = skill.description.trim();
  const previewIsMarkdown = /\.(md|mdx|markdown)$/i.test(skill.skillFile);
  const previewContent = stripInstalledSkillPreviewMetadata(preview.content, skill);
  const statusLabel = alwaysEnabled
    ? t("settings.skillsInstalledPreviewBuiltIn")
    : checked
      ? t("settings.skillsInstalledPreviewSelected")
      : t("settings.skillsInstalledPreviewUnselected");

  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 200);
  }, [closing, onClose]);

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex justify-end bg-background/35 backdrop-blur-[2px]",
        closing ? "skills-drawer-backdrop-closing" : "skills-drawer-backdrop",
      )}
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
    >
      <aside
        className={cn(
          "flex h-full w-full flex-col border-l border-border/45 bg-background/95 shadow-[-18px_0_45px_-28px_rgba(15,23,42,0.45)] dark:border-white/[0.08] dark:bg-popover/95 dark:shadow-[-18px_0_45px_-28px_rgba(0,0,0,0.7)] backdrop-blur-xl md:w-2/5 md:max-w-[34rem]",
          closing ? "skills-drawer-panel-closing" : "skills-drawer-panel",
        )}
      >
        <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]">
            {alwaysEnabled ? <Lock className="h-5 w-5" /> : <SkillIcon className="h-7 w-7" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
              {t("settings.skillsInstalledPreviewTitle")}
            </div>
            <h2 className="mt-1 truncate text-base font-semibold tracking-tight text-foreground">
              {skill.name}
            </h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1",
                  alwaysEnabled
                    ? "bg-foreground/[0.06] text-foreground/75 ring-border/45"
                    : checked
                      ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300"
                      : "bg-muted/45 text-muted-foreground ring-border/35",
                )}
              >
                {statusLabel}
              </span>
              {source?.version ? <span>v{source.version}</span> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            title={t("settings.cronViewClose")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-4">
            <div className="grid gap-3">
              <div className="rounded-2xl border border-border/40 bg-background/70 p-3.5 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.07] dark:bg-white/[0.05] dark:shadow-[0_1px_0_rgba(255,255,255,0.05)_inset]">
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/45 bg-background/80 text-foreground/75">
                    <SkillIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {t("settings.skillsInstalledPreviewName")}
                    </div>
                    <div className="mt-1 break-words text-[15px] font-semibold leading-snug text-foreground">
                      {skill.name}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-border/40 bg-background/60 p-3.5 shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/40 bg-muted/35 text-muted-foreground">
                    <BookOpen className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {t("settings.skillsInstalledPreviewDescription")}
                    </div>
                    <p className="mt-1.5 text-[13px] leading-6 text-muted-foreground">
                      {description || t("settings.skillsInstalledPreviewNoDescription")}
                    </p>
                    <div className="mt-2 flex justify-end">
                      <SkillPreviewCopyButton
                        value={description}
                        label={t("settings.skillsInstalledPreviewCopyDescription")}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {!skillsEnabled ? (
              <div className="rounded-2xl border border-border/40 bg-muted/35 p-3">
                <div className="flex items-start gap-2 text-[12px] text-muted-foreground">
                  <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65" />
                  <span>{t("settings.skillsDisabledHint")}</span>
                </div>
              </div>
            ) : null}

            <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
              <div className="mb-2 text-[12px] font-semibold text-foreground">
                {t("settings.skillsInstalledPreviewDetails")}
              </div>
              <div className="divide-y divide-border/30">
                <StorePreviewField
                  label={t("settings.skillsInstalledPreviewBaseDir")}
                  value={skill.baseDir}
                />
                <StorePreviewField
                  label={t("settings.skillsInstalledPreviewSkillFile")}
                  value={skill.skillFile}
                />
                <StorePreviewField
                  label={t("settings.skillsInstalledPreviewSource")}
                  value={source?.registry}
                />
                <StorePreviewField
                  label={t("settings.skillsStorePreviewSlug")}
                  value={source?.slug}
                />
                <StorePreviewField
                  label={t("settings.skillsStorePreviewVersion")}
                  value={source?.version}
                />
                <StorePreviewField
                  label={t("settings.skillsInstalledPreviewPublished")}
                  value={source?.publishedAt ? formatFullStoreDate(source.publishedAt) : null}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[12px] font-semibold text-foreground">
                  {t("settings.skillsInstalledPreviewFilePreview")}
                </div>
                <div className="flex min-w-0 items-center gap-1">
                  <div className="truncate text-[10.5px] text-muted-foreground/70">
                    {preview.skillFile || skill.skillFile}
                  </div>
                  <SkillPreviewCopyButton
                    value={previewContent}
                    label={t("settings.skillsInstalledPreviewCopyFile")}
                  />
                </div>
              </div>

              {preview.loading ? (
                <InstalledPreviewSkeleton />
              ) : (
                <>
                  {preview.error ? (
                    <div className="rounded-xl border border-border/35 bg-muted/35 p-3">
                      <div className="flex items-start gap-2 text-[12px] text-muted-foreground">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65" />
                        <div className="min-w-0">
                          <div>{t("settings.skillsInstalledPreviewUnavailable")}</div>
                          <div className="mt-1 break-words text-[11px] opacity-75">
                            {preview.error}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {previewContent ? (
                    previewIsMarkdown ? (
                      <Markdown
                        content={previewContent}
                        className="text-[12px] leading-5 text-muted-foreground"
                      />
                    ) : (
                      <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/35 p-3 font-mono text-[11px] leading-5 text-muted-foreground">
                        {previewContent}
                      </pre>
                    )
                  ) : preview.error ? null : (
                    <div className="rounded-xl border border-border/35 bg-muted/30 p-3 text-[12px] text-muted-foreground">
                      {t("settings.skillsInstalledPreviewEmpty")}
                    </div>
                  )}

                  {preview.truncated ? (
                    <div className="mt-2 rounded-xl border border-border/35 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                      {t("settings.skillsInstalledPreviewTruncated").replace(
                        "{count}",
                        String(INSTALLED_SKILL_PREVIEW_LINES),
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function SkillPreviewCopyButton(props: { value: string; label: string }) {
  const { value, label } = props;
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!value || !(await copyText(value))) return;
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }, [value]);

  const accessibleLabel = copied ? t("settings.skillsInstalledPreviewCopied") : label;

  return (
    <button
      type="button"
      disabled={!value}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-35"
      onClick={() => void handleCopy()}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
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

function StoreCategoryChips(props: {
  value: StoreCategoryValue;
  counts: ReadonlyMap<StoreCategoryValue, number>;
  onChange: (value: StoreCategoryValue) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="hub-panel-enter">
      <div className="flex max-w-full flex-wrap items-center gap-1 rounded-xl border border-border/40 bg-background/60 p-1 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
        {STORE_CATEGORY_OPTIONS.map((value) => {
          const CategoryIcon = STORE_CATEGORY_ICONS[value];
          const active = props.value === value;
          const count = props.counts.get(value) ?? 0;
          return (
            <button
              key={value}
              type="button"
              onClick={() => props.onChange(value)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11.5px] font-medium transition-all",
                active
                  ? "bg-background/85 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] ring-1 ring-border/45 dark:bg-white/[0.08] dark:ring-white/[0.09] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
                  : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
              )}
            >
              <CategoryIcon className="h-3.5 w-3.5" />
              <span>{t(storeCategoryLabelKey(value))}</span>
              <span
                className={cn(
                  "inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                  active
                    ? "bg-foreground/[0.08] text-foreground/85"
                    : "bg-muted/70 text-muted-foreground",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SkillCategoryBadges(props: {
  categories: ClawHubCategorySlug[];
  topics?: string[];
  onSelect: (category: ClawHubCategorySlug) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {props.categories.map((category) => {
        const BadgeIcon = STORE_CATEGORY_ICONS[category];
        return (
          <button
            key={category}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onSelect(category);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium text-foreground/75 ring-1 ring-border/45 transition-colors hover:bg-foreground/[0.1]"
          >
            <BadgeIcon className="h-2.5 w-2.5" />
            <span>{t(storeCategoryLabelKey(category))}</span>
          </button>
        );
      })}
      {(props.topics ?? []).slice(0, 3).map((topic) => (
        <span
          key={topic}
          className="shrink-0 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {topic}
        </span>
      ))}
    </div>
  );
}

function SkillsStoreView(props: {
  items: ClawHubSkillCard[];
  query: string;
  sort: ClawHubSort;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  cursor: string | null;
  installedKeys: Set<string>;
  installedSlugs: Set<string>;
  pendingInstallKeys: ReadonlySet<string>;
  installingByStoreKey: Record<string, string>;
  installJobs: Record<string, SkillInstallJobSnapshot>;
  onSortChange: (value: ClawHubSort) => void;
  onLoadMore: () => void;
  onInstall: (skill: ClawHubSkillCard) => void;
}) {
  const {
    items,
    query,
    sort,
    loading,
    loadingMore,
    error,
    cursor,
    installedKeys,
    installedSlugs,
    pendingInstallKeys,
    installingByStoreKey,
    installJobs,
    onSortChange,
    onLoadMore,
    onInstall,
  } = props;
  const { t } = useLocale();
  const searching = query.trim().length > 0;
  const refreshing = loading && items.length > 0;
  const [previewSkill, setPreviewSkill] = useState<ClawHubSkillCard | null>(null);
  const [previewDetail, setPreviewDetail] = useState<ClawHubSkillDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [storeCategory, setStoreCategory] = useState<StoreCategoryValue>("all");

  const categorizedItems = useMemo(
    () =>
      items.map((skill) => ({
        skill,
        categories: classifyClawHubSkill(skill),
      })),
    [items],
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<StoreCategoryValue, number>();
    counts.set("all", categorizedItems.length);
    for (const { categories } of categorizedItems) {
      for (const category of categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return counts;
  }, [categorizedItems]);

  const filteredItems = useMemo(
    () =>
      storeCategory === "all"
        ? categorizedItems
        : categorizedItems.filter(({ categories }) => categories.includes(storeCategory)),
    [categorizedItems, storeCategory],
  );

  // 分类是本地过滤：选中分类后结果太少且还有下一页时自动补页，
  // 避免出现"一屏只剩两张卡"的稀疏页面。
  useEffect(() => {
    if (storeCategory === "all" || searching) return;
    if (!cursor || loading || loadingMore) return;
    if (filteredItems.length >= STORE_CATEGORY_FILL_TARGET) return;
    onLoadMore();
  }, [cursor, filteredItems.length, loading, loadingMore, onLoadMore, searching, storeCategory]);

  useEffect(() => {
    if (!previewSkill) {
      setPreviewDetail(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setPreviewDetail(null);
    setPreviewError(null);
    setPreviewLoading(true);

    void resolveClawHubSkillOwner(previewSkill)
      .then((resolvedSkill) => {
        if (
          !cancelled &&
          buildClawHubSkillKey(resolvedSkill) !== buildClawHubSkillKey(previewSkill)
        ) {
          setPreviewSkill(resolvedSkill);
        }
        return getClawHubSkillDetail(resolvedSkill.slug, resolvedSkill.ownerHandle);
      })
      .then((detail) => {
        if (!cancelled) {
          setPreviewDetail(detail);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setPreviewError(msg || t("settings.skillsHubDetailLoadFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [previewSkill, t]);

  function getInstallState(skill: ClawHubSkillCard): StoreSkillInstallState {
    const storeKey = buildClawHubSkillKey(skill);
    const pending = pendingInstallKeys.has(storeKey);
    const jobId = installingByStoreKey[storeKey];
    const job = jobId ? installJobs[jobId] : undefined;
    const terminalJob = Boolean(job && TERMINAL_INSTALL_PHASES.has(job.phase));
    const done =
      installedKeys.has(storeKey) ||
      (!skill.ownerHandle && installedSlugs.has(skill.slug)) ||
      job?.phase === "done";
    return {
      done,
      installing: pending || Boolean(job && !terminalJob),
      pending,
      terminalJob,
      job,
      progress: pending ? null : job ? getInstallProgressPercent(job) : null,
    };
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="hub-panel-enter flex items-center justify-start">
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex max-w-full shrink-0 items-center gap-1 overflow-x-auto rounded-xl border border-border/40 bg-background/60 p-1 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
            {STORE_SORT_OPTIONS.map((option) => {
              const active = sort === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSortChange(option.value)}
                  disabled={searching}
                  className={cn(
                    "h-8 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-[11.5px] font-medium transition-all",
                    "disabled:cursor-not-allowed disabled:opacity-45",
                    active
                      ? "bg-background/85 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] ring-1 ring-border/45 dark:bg-white/[0.08] dark:ring-white/[0.09] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
                      : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
                  )}
                >
                  {t(option.labelKey)}
                </button>
              );
            })}
          </div>
          <Loader2
            aria-hidden={!refreshing}
            className={cn(
              "h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground transition-opacity duration-200 motion-reduce:transition-none",
              refreshing ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
      </div>

      <StoreCategoryChips
        value={storeCategory}
        counts={categoryCounts}
        onChange={setStoreCategory}
      />

      {error ? (
        <GlassPanel tone="error" className="hub-panel-enter">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            <span className="text-xs text-destructive">{error}</span>
          </div>
        </GlassPanel>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-0.5 pb-4 pr-1 pt-1.5">
        <div className="flex flex-col gap-4">
          {loading && items.length === 0 ? (
            <>
              <div className="hub-frost-hero hub-panel-enter px-4 py-3.5">
                <div className="flex items-center gap-3.5">
                  <FrostSpinner />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium tracking-tight text-foreground">
                      {t("settings.skillsStoreLoadingTitle")}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                      {t("settings.skillsStoreLoadingDesc")}
                    </div>
                  </div>
                </div>
                <div className="hub-frost-track mt-3.5" />
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {[1, 2, 3, 4, 5, 6].map((item) => (
                  <div key={item} className="hub-frost-skeleton skill-card-enter p-3.5">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="skills-skeleton-shimmer h-9 w-9 shrink-0 rounded-lg" />
                        <div className="flex-1 space-y-2">
                          <div className="skills-skeleton-shimmer h-3.5 w-full max-w-[8rem] rounded" />
                          <div className="skills-skeleton-shimmer h-3 w-full max-w-[11rem] rounded" />
                        </div>
                      </div>
                      <div className="skills-skeleton-shimmer h-8 w-full rounded-xl" />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {!loading && items.length === 0 && !error ? (
            <GlassPanel className="hub-panel-enter">
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
                  <Cloud className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {t("settings.skillsStoreEmptyTitle")}
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    {t("settings.skillsStoreEmptyDesc")}
                  </p>
                </div>
              </div>
            </GlassPanel>
          ) : null}

          {items.length > 0 ? (
            <div
              className={cn(
                "grid gap-3 transition-[opacity,filter] duration-300 ease-out motion-reduce:transition-none sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                refreshing && "pointer-events-none opacity-50 blur-[1px] saturate-50",
              )}
            >
              {filteredItems.map(({ skill, categories }) => {
                const { done, installing, pending, job, progress } = getInstallState(skill);
                const link = buildClawHubSkillUrl(skill);
                const PrimaryCategoryIcon = STORE_CATEGORY_ICONS[categories[0] ?? "other"];

                return (
                  // biome-ignore lint/a11y/useSemanticElements: The card contains nested controls and cannot be a native button.
                  <div
                    key={buildClawHubSkillKey(skill)}
                    role="button"
                    tabIndex={0}
                    aria-label={skill.displayName}
                    onClick={() => setPreviewSkill(skill)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setPreviewSkill(skill);
                      }
                    }}
                    className={cn(
                      "skill-card-enter group flex h-full cursor-pointer flex-col rounded-2xl border p-3.5 text-left backdrop-blur-xl transition-all focus:outline-none focus:ring-2 focus:ring-foreground/10",
                      done
                        ? "border-border/55 bg-background/80 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_18px_-12px_rgba(15,23,42,0.18)] dark:border-white/[0.10] dark:bg-white/[0.07] dark:shadow-[0_1px_0_rgba(255,255,255,0.07)_inset,0_4px_18px_-12px_rgba(0,0,0,0.55)]"
                        : "border-border/40 bg-background/60 hover:-translate-y-0.5 hover:border-border/55 hover:bg-background/75 hover:shadow-[0_4px_16px_-10px_rgba(15,23,42,0.18)] dark:border-white/[0.05] dark:bg-white/[0.03] dark:hover:border-white/[0.10] dark:hover:bg-white/[0.06] dark:hover:shadow-[0_4px_16px_-10px_rgba(0,0,0,0.55)]",
                    )}
                  >
                    <div className="flex h-full flex-col gap-3">
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all",
                            done
                              ? "border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
                              : "border-border/30 bg-muted/50 text-muted-foreground group-hover:border-border/50 group-hover:bg-background/70 group-hover:text-foreground/85",
                          )}
                        >
                          <PrimaryCategoryIcon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-start gap-1.5">
                            <span className="truncate text-[13px] font-semibold leading-tight text-foreground">
                              {skill.displayName}
                            </span>
                            {link ? (
                              <a
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                                title={t("settings.skillsStoreOpenInClawHub")}
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                          </div>
                          <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                            v{skill.latestVersion ?? t("settings.skillsStoreVersionLatest")}
                          </div>
                        </div>
                      </div>

                      <SkillCategoryBadges
                        categories={categories}
                        topics={skill.topics}
                        onSelect={setStoreCategory}
                      />

                      {skill.summary ? (
                        <p className="line-clamp-3 text-[11.5px] leading-[1.45] text-muted-foreground">
                          {skill.summary}
                        </p>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/30 pt-2 text-[10.5px] text-muted-foreground/75">
                        <span
                          className="inline-flex items-center gap-1"
                          title={t("settings.skillsStorePreviewDownloads")}
                        >
                          <span className="h-1 w-1 rounded-full bg-foreground/40" />
                          {formatCompactNumber(skill.downloads)}
                        </span>
                        <span
                          className="inline-flex items-center gap-1"
                          title={t("settings.skillsStorePreviewStars")}
                        >
                          <span className="h-1 w-1 rounded-full bg-foreground/40" />
                          {formatCompactNumber(skill.stars)}
                        </span>
                        <span
                          className="inline-flex items-center gap-1"
                          title={t("settings.skillsStorePreviewInstalls")}
                        >
                          <span className="h-1 w-1 rounded-full bg-foreground/40" />
                          {formatCompactNumber(skill.installsCurrent)}
                        </span>
                        {skill.updatedAt ? (
                          <span className="ml-auto opacity-75">
                            {formatStoreDate(skill.updatedAt)}
                          </span>
                        ) : null}
                      </div>

                      {installing && !done ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-3 text-[10.5px] text-muted-foreground">
                            <span>{installPhaseLabel(pending ? undefined : job, t)}</span>
                            {job && !pending ? (
                              <span className="flex items-center gap-1.5">
                                {formatInstallProgress(job)}
                                <button
                                  type="button"
                                  title={t("settings.cancel")}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void cancelSkillInstallJob(job.jobId).catch(() => undefined);
                                  }}
                                  onKeyDown={(event) => event.stopPropagation()}
                                  className="text-muted-foreground/70 transition-colors hover:text-foreground"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            ) : null}
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
                            {progress === null ? (
                              <div className="hub-loading-progress h-full rounded-full bg-foreground/55" />
                            ) : (
                              <div
                                className="h-full rounded-full bg-foreground/65 transition-[width] duration-300"
                                style={{ width: `${progress}%` }}
                              />
                            )}
                          </div>
                        </div>
                      ) : null}

                      {job?.phase === "error" && job.error && !done && !pending ? (
                        <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                          {job.error}
                        </div>
                      ) : null}

                      <Button
                        type="button"
                        variant={done ? "outline" : "default"}
                        size="sm"
                        className={cn(
                          "mt-auto h-9 gap-1.5 rounded-xl",
                          done &&
                            "border-border/55 bg-background/75 text-foreground/85 backdrop-blur-md",
                        )}
                        disabled={done || installing}
                        aria-busy={installing}
                        onClick={(event) => {
                          event.stopPropagation();
                          onInstall(skill);
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {installing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : done ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Cloud className="h-3.5 w-3.5" />
                        )}
                        {installing
                          ? installPhaseLabel(pending ? undefined : job, t)
                          : done
                            ? t("settings.skillsStoreInstalled")
                            : t("settings.skillsStoreInstall")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {items.length > 0 && filteredItems.length === 0 && !loading && !loadingMore && !cursor ? (
            <GlassPanel tone="muted" className="hub-panel-enter">
              <p className="py-2 text-center text-sm text-muted-foreground">
                {t("settings.skillsStoreEmptyTitle")}
              </p>
            </GlassPanel>
          ) : null}

          {cursor && !searching ? (
            <div className="hub-panel-enter flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-full border-border/50 bg-background/70 backdrop-blur-md"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loadingMore && "animate-spin")} />
                {loadingMore
                  ? t("settings.skillsStoreLoadingMore")
                  : t("settings.skillsStoreLoadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      {previewSkill ? (
        <SkillsStorePreviewDrawer
          skill={previewSkill}
          detail={previewDetail}
          loading={previewLoading}
          error={previewError}
          installState={getInstallState(previewSkill)}
          onClose={() => setPreviewSkill(null)}
          onInstall={() => onInstall(previewSkill)}
        />
      ) : null}
    </div>
  );
}

function SkillsStorePreviewDrawer(props: {
  skill: ClawHubSkillCard;
  detail: ClawHubSkillDetail | null;
  loading: boolean;
  error: string | null;
  installState: StoreSkillInstallState;
  onClose: () => void;
  onInstall: () => void;
}) {
  const { skill, detail, loading, error, installState, onClose, onInstall } = props;
  const { t } = useLocale();
  const data = detail ?? skill;
  const link = data.webUrl ?? buildClawHubSkillUrl(data);
  const version = data.latestVersion ?? t("settings.skillsStoreVersionLatest");
  const owner = detail?.ownerDisplayName ?? data.ownerHandle;
  const supportedOs = detail?.supportedOs ?? [];
  const supportedSystems = detail?.supportedSystems ?? [];
  const actionLabel = installState.installing
    ? installPhaseLabel(installState.pending ? undefined : installState.job, t)
    : installState.done
      ? t("settings.skillsStoreInstalled")
      : t("settings.skillsStoreInstall");

  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 200);
  }, [closing, onClose]);

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex justify-end bg-background/35 backdrop-blur-[2px]",
        closing ? "skills-drawer-backdrop-closing" : "skills-drawer-backdrop",
      )}
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
    >
      <aside
        className={cn(
          "flex h-full w-full flex-col border-l border-border/45 bg-background/95 shadow-[-18px_0_45px_-28px_rgba(15,23,42,0.45)] dark:border-white/[0.08] dark:bg-popover/95 dark:shadow-[-18px_0_45px_-28px_rgba(0,0,0,0.7)] backdrop-blur-xl md:w-2/5 md:max-w-[34rem]",
          closing ? "skills-drawer-panel-closing" : "skills-drawer-panel",
        )}
      >
        <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]">
            {detail?.ownerImage ? (
              <img
                src={detail.ownerImage}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <SkillIcon className="h-7 w-7" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
              {t("settings.skillsStorePreviewTitle")}
            </div>
            <h2 className="mt-1 truncate text-base font-semibold tracking-tight text-foreground">
              {data.displayName}
            </h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              {owner ? <span className="truncate">@{owner}</span> : null}
              <span>v{version}</span>
              {data.updatedAt ? <span>{formatStoreDate(data.updatedAt)}</span> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            title={t("settings.cronViewClose")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-4">
            {data.summary ? (
              <p className="text-[13px] leading-6 text-muted-foreground">{data.summary}</p>
            ) : null}

            <div className="grid grid-cols-3 gap-2">
              <StorePreviewMetric
                label={t("settings.skillsStorePreviewDownloads")}
                value={formatCompactNumber(data.downloads)}
              />
              <StorePreviewMetric
                label={t("settings.skillsStorePreviewStars")}
                value={formatCompactNumber(data.stars)}
              />
              <StorePreviewMetric
                label={t("settings.skillsStorePreviewInstalls")}
                value={formatCompactNumber(data.installsCurrent)}
              />
            </div>

            {installState.installing && !installState.done ? (
              <div className="rounded-2xl border border-border/50 bg-background/75 p-3 backdrop-blur-md">
                <div className="flex items-center justify-between gap-3 text-[11px] text-foreground/85">
                  <span>
                    {installPhaseLabel(installState.pending ? undefined : installState.job, t)}
                  </span>
                  {installState.job && !installState.pending ? (
                    <span>{formatInstallProgress(installState.job)}</span>
                  ) : null}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
                  {installState.progress === null ? (
                    <div className="hub-loading-progress h-full rounded-full bg-foreground/55" />
                  ) : (
                    <div
                      className="h-full rounded-full bg-foreground/65 transition-[width] duration-300"
                      style={{ width: `${installState.progress}%` }}
                    />
                  )}
                </div>
              </div>
            ) : null}

            {installState.job?.phase === "error" &&
            installState.job.error &&
            !installState.done &&
            !installState.pending ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-3 text-[12px] text-destructive">
                {installState.job.error}
              </div>
            ) : null}

            {error ? (
              <div className="rounded-2xl border border-border/40 bg-muted/35 p-3">
                <div className="flex items-start gap-2 text-[12px] text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/65" />
                  <span>{t("settings.skillsStorePreviewDetailUnavailable")}</span>
                </div>
              </div>
            ) : null}

            {loading ? (
              <StorePreviewSkeleton />
            ) : (
              <>
                <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
                  <div className="mb-2 text-[12px] font-semibold text-foreground">
                    {t("settings.skillsStorePreviewMetadata")}
                  </div>
                  <div className="divide-y divide-border/30">
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewSlug")}
                      value={data.slug}
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewOwner")}
                      value={owner}
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewVersion")}
                      value={version}
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewUpdated")}
                      value={data.updatedAt ? formatFullStoreDate(data.updatedAt) : null}
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewCreated")}
                      value={detail?.createdAt ? formatFullStoreDate(detail.createdAt) : null}
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewPublished")}
                      value={
                        detail?.latestVersionCreatedAt
                          ? formatFullStoreDate(detail.latestVersionCreatedAt)
                          : null
                      }
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewLicense")}
                      value={detail?.license}
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewOs")}
                      value={supportedOs.length > 0 ? supportedOs.join(", ") : null}
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewSystems")}
                      value={supportedSystems.length > 0 ? supportedSystems.join(", ") : null}
                    />
                    <StorePreviewField
                      label={t("settings.skillsStorePreviewModeration")}
                      value={detail?.moderationStatus}
                    />
                  </div>
                </div>

                {detail?.latestVersionChangelog ? (
                  <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
                    <div className="mb-2 text-[12px] font-semibold text-foreground">
                      {t("settings.skillsStorePreviewChangelog")}
                    </div>
                    <p className="whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground">
                      {detail.latestVersionChangelog}
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 gap-2 border-t border-border/40 px-5 py-4">
          {link ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 flex-1 gap-1.5 rounded-xl border-border/50 bg-background/70"
              render={
                <a href={link} target="_blank" rel="noreferrer">
                  <span className="sr-only">{t("settings.skillsStoreOpenInClawHub")}</span>
                </a>
              }
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("settings.skillsStoreOpenInClawHub")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={installState.done ? "outline" : "default"}
            size="sm"
            className={cn(
              "h-9 flex-1 gap-1.5 rounded-xl",
              installState.done &&
                "border-border/55 bg-background/75 text-foreground/85 backdrop-blur-md",
            )}
            disabled={installState.done || installState.installing}
            aria-busy={installState.installing}
            onClick={onInstall}
          >
            {installState.installing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : installState.done ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Cloud className="h-3.5 w-3.5" />
            )}
            {actionLabel}
          </Button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function StorePreviewMetric(props: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/35 bg-background/60 px-3 py-2.5">
      <div className="text-[10.5px] text-muted-foreground">{props.label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">{props.value}</div>
    </div>
  );
}

const STORE_PREVIEW_FIELD_WIDTHS = [
  "w-[82%]",
  "w-2/3",
  "w-[55%]",
  "w-3/4",
  "w-[45%]",
  "w-3/5",
] as const;

function StorePreviewSkeleton() {
  return (
    <>
      <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
        <div className="skills-skeleton-pulse mb-3 h-2.5 w-12 rounded-full" />
        <div className="divide-y divide-border/30">
          {STORE_PREVIEW_FIELD_WIDTHS.map((width, i) => (
            <div key={i} className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 py-2.5">
              <div className="skills-skeleton-pulse h-2.5 w-14 rounded-full" />
              <div className={cn("skills-skeleton-pulse h-2.5 rounded-full", width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-border/40 bg-background/60 p-3">
        <div className="skills-skeleton-pulse mb-3 h-2.5 w-16 rounded-full" />
        <div className="space-y-2">
          <div className="skills-skeleton-pulse h-2.5 w-full rounded-full" />
          <div className="skills-skeleton-pulse h-2.5 w-11/12 rounded-full" />
          <div className="skills-skeleton-pulse h-2.5 w-3/5 rounded-full" />
        </div>
      </div>
    </>
  );
}

function StorePreviewField(props: { label: string; value?: string | null }) {
  if (!props.value) return null;
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 text-[12px]">
      <div className="text-muted-foreground">{props.label}</div>
      <div className="min-w-0 break-words text-foreground">{props.value}</div>
    </div>
  );
}

function dedupeStoreItems(items: ClawHubSkillCard[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const storeKey = buildClawHubSkillKey(item);
    if (seen.has(storeKey)) return false;
    seen.add(storeKey);
    return true;
  });
}

function buildClawHubSkillUrl(skill: ClawHubSkillCard) {
  if (!skill.ownerHandle) return null;
  return `https://clawhub.ai/${encodeURIComponent(skill.ownerHandle)}/${encodeURIComponent(skill.slug)}`;
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatStoreDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatFullStoreDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function getInstallProgressPercent(job: SkillInstallJobSnapshot) {
  if (job.phase === "done") return 100;
  if (!job.totalBytes || job.totalBytes <= 0) return null;
  return Math.max(2, Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 100)));
}

function formatInstallProgress(job: SkillInstallJobSnapshot) {
  if (job.phase === "done") return "100%";
  if (job.totalBytes && job.totalBytes > 0) {
    return `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`;
  }
  return job.downloadedBytes > 0 ? formatBytes(job.downloadedBytes) : "";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next >= 10 || unit === 0 ? Math.round(next) : next.toFixed(1)} ${units[unit]}`;
}

function installPhaseLabel(job: SkillInstallJobSnapshot | undefined, t: (key: string) => string) {
  switch (job?.phase) {
    case "queued":
      return t("settings.skillsStorePhaseQueued");
    case "downloading":
      return t("settings.skillsStorePhaseDownloading");
    case "extracting":
      return t("settings.skillsStorePhaseExtracting");
    case "validating":
      return t("settings.skillsStorePhaseValidating");
    case "installing":
      return t("settings.skillsStorePhaseInstalling");
    case "done":
      return t("settings.skillsStoreInstalled");
    case "error":
      return t("settings.skillsStorePhaseError");
    default:
      return t("settings.skillsStorePhasePreparing");
  }
}
