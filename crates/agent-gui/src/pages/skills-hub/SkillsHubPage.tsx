import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { GlassPanel, HubBackdrop, HubHeader } from "../../components/hub/HubChrome";
import {
  Activity,
  AlertTriangle,
  Blend,
  BookOpen,
  Bot,
  Brain,
  Cable,
  Check,
  CircleHelp,
  Cloud,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  Globe,
  House,
  ImageIcon,
  Key,
  Layers,
  LayoutGrid,
  Lightbulb,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquare,
  Package,
  Palette,
  Plug,
  Radio,
  RefreshCw,
  ScanText,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  Shield,
  SkillIcon,
  Sparkles,
  Terminal,
  Timer,
  Trash2,
  Wallet,
  Waypoints,
  Wifi,
  Wrench,
  X,
  Zap,
} from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/button";
import {
  ConfirmActionPopover,
  ConfirmDeletePopover,
} from "../../components/ui/confirm-action-popover";
import { useLocale } from "../../i18n";
import { type AppSettings, updateSkills } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import {
  cancelSkillInstallJob,
  discoverSkills,
  type ExternalSkillEntry,
  type ExternalToolScan,
  getSkillInstallJobStatus,
  isAlwaysEnabledSkillName,
  isUserSelectableSkill,
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
import {
  DEFAULT_INSTALLED_SKILL_SORT,
  type InstalledSkillSort,
  isInstalledSkillSort,
  sortInstalledSkillItems,
} from "../../lib/skills/installedSort";
import {
  getInstalledSkillCardIdentity,
  type InstalledSkillCardIconName,
} from "../../lib/skills/skillCardIdentity";
import {
  getInstalledSkillCardSource,
  getRelativeInstalledAt,
  truncateLocalSkillCardDescription,
} from "../../lib/skills/skillCardMetadata";
import { getSkillTriggerHint } from "../../lib/skills/skillTriggerHint";

type SkillsHubView = "installed" | "store" | "import";

const EXTERNAL_TOOL_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  codebuddy: "CodeBuddy",
};

const STORE_PAGE_LIMIT = 24;
const INSTALLED_SKILL_PREVIEW_LINES = 10_000;
const COPY_FEEDBACK_MS = 1600;
const EMPTY_SKILLS: SkillSummary[] = [];
const TERMINAL_INSTALL_PHASES = new Set(["done", "error", "cancelled"]);
const STORE_SORT_OPTIONS: Array<{ value: ClawHubSort; labelKey: string }> = [
  { value: "downloads", labelKey: "settings.skillsStoreSortMostDownloaded" },
  { value: "stars", labelKey: "settings.skillsStoreSortMostStarred" },
  { value: "installs", labelKey: "settings.skillsStoreSortMostInstalled" },
  { value: "updated", labelKey: "settings.skillsStoreSortRecentlyUpdated" },
  { value: "newest", labelKey: "settings.skillsStoreSortNewest" },
];

const INSTALLED_SORT_OPTIONS: Array<{ value: InstalledSkillSort; labelKey: string }> = [
  { value: "name-asc", labelKey: "settings.skillsInstalledSortNameAsc" },
  { value: "name-desc", labelKey: "settings.skillsInstalledSortNameDesc" },
  { value: "installed-desc", labelKey: "settings.skillsInstalledSortNewest" },
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

const INSTALLED_SKILL_ICON_TONES = [
  "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-200",
  "border-indigo-500/30 bg-indigo-500/12 text-indigo-700 dark:border-indigo-400/30 dark:bg-indigo-400/15 dark:text-indigo-200",
  "border-violet-500/30 bg-violet-500/12 text-violet-700 dark:border-violet-400/30 dark:bg-violet-400/15 dark:text-violet-200",
  "border-fuchsia-500/30 bg-fuchsia-500/12 text-fuchsia-700 dark:border-fuchsia-400/30 dark:bg-fuchsia-400/15 dark:text-fuchsia-200",
  "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/15 dark:text-rose-200",
  "border-orange-500/30 bg-orange-500/12 text-orange-700 dark:border-orange-400/30 dark:bg-orange-400/15 dark:text-orange-200",
  "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200",
  "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-200",
  "border-cyan-500/30 bg-cyan-500/12 text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-400/15 dark:text-cyan-200",
] as const;

const INSTALLED_SKILL_CARD_ICONS: Record<InstalledSkillCardIconName, typeof Activity> = {
  bookOpen: BookOpen,
  bot: Bot,
  brain: Brain,
  cable: Cable,
  circleHelp: CircleHelp,
  cloud: Cloud,
  cpu: Cpu,
  fileText: FileText,
  folder: Folder,
  gitBranch: GitBranch,
  globe: Globe,
  imageIcon: ImageIcon,
  key: Key,
  layoutGrid: LayoutGrid,
  lightbulb: Lightbulb,
  link2: Link2,
  listChecks: ListChecks,
  lock: Lock,
  messageSquare: MessageSquare,
  plug: Plug,
  radio: Radio,
  refreshCw: RefreshCw,
  scanText: ScanText,
  scrollText: ScrollText,
  search: Search,
  send: Send,
  server: Server,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  terminal: Terminal,
  timer: Timer,
  waypoints: Waypoints,
  wifi: Wifi,
  wrench: Wrench,
  zap: Zap,
};

// Intl 格式化器构造开销可观且配置固定（跟随系统 locale），做模块级懒缓存，
// 避免技能多时逐卡重复 new。
let cachedCompactNumberFormat: Intl.NumberFormat | null = null;
let cachedShortDateFormat: Intl.DateTimeFormat | null = null;
let cachedFullDateFormat: Intl.DateTimeFormat | null = null;

function getFullDateFormat() {
  cachedFullDateFormat ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return cachedFullDateFormat;
}

function formatInstalledSkillMetadata(skill: SkillSummary, t: (key: string) => string): string {
  const source = getInstalledSkillCardSource(skill);
  const sourceLabel =
    source === "built-in"
      ? t("settings.skillsInstalledCardSourceBuiltIn")
      : source === "clawhub"
        ? t("settings.skillsInstalledCardSourceClawHub")
        : t("settings.skillsInstalledCardSourceLocal");
  if (source === "built-in") return sourceLabel;

  const relativeInstalledAt = getRelativeInstalledAt(skill.installedAt);
  if (!relativeInstalledAt) return sourceLabel;
  if (relativeInstalledAt.kind === "today") {
    return `${sourceLabel} · ${t("settings.skillsInstalledCardInstalledToday")}`;
  }
  if (relativeInstalledAt.kind === "days-ago") {
    return `${sourceLabel} · ${t("settings.skillsInstalledCardInstalledDaysAgo").replace(
      "{count}",
      String(relativeInstalledAt.days),
    )}`;
  }

  const date = getFullDateFormat().format(new Date(relativeInstalledAt.timestamp));
  return `${sourceLabel} · ${date}`;
}

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

const FROST_SPINNER_SEGMENTS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
] as const;

function FrostSpinner() {
  return (
    <span className="hub-frost-spinner shrink-0" aria-hidden="true">
      {FROST_SPINNER_SEGMENTS.map((segment) => (
        <i key={segment} />
      ))}
    </span>
  );
}

function SkillsContentLoadingState(props: { title: string; description: string }) {
  const { title, description } = props;
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite" aria-busy="true">
      <div className="hub-frost-hero hub-panel-enter px-4 py-3.5">
        <div className="flex items-center gap-3.5">
          <FrostSpinner />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium tracking-tight text-foreground">{title}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
              {description}
            </div>
          </div>
        </div>
        <div className="hub-frost-track mt-3.5" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[1, 2, 3, 4, 5, 6].map((item) => (
          <div key={item} className="hub-frost-skeleton skill-card-enter p-3.5">
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
    </div>
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
          skill.description,
          skill.builtIn ? "1" : "0",
          skill.inlineContent?.length ?? -1,
          skill.source?.registry ?? "",
          skill.source?.slug ?? "",
          skill.installedAt ?? "",
          skill.source?.version ?? "",
        ].join("\0"),
      )
      .sort(),
  ].join("\n");
}

const INSTALLED_SORT_STORAGE_KEY = "skillsHub.installedSort";
const FLIP_HERO_DURATION_MS = 380;
const FLIP_BATCH_HERO_DELAY_MS = 90;
const FLIP_BATCH_STAGGER_LIMIT = 8;
const FLIP_WAVE_DURATION_MS = 280;
const FLIP_WAVE_DELAY_MS = 30;
const FLIP_WAVE_MAX_DELAY_MS = 400;
const FLIP_HERO_TRANSITION = `translate ${FLIP_HERO_DURATION_MS}ms cubic-bezier(0.34, 1.3, 0.64, 1)`;
const FLIP_WAVE_TRANSITION = `translate ${FLIP_WAVE_DURATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;

type FlipMode = "single" | "wave" | "batch";
type FlipPosition = { left: number; top: number };
type FlipRequest = {
  mode: FlipMode;
  heroKeys: ReadonlySet<string>;
  followKeys: ReadonlySet<string>;
};

function readInstalledSortPreference(): InstalledSkillSort {
  if (typeof window === "undefined") return DEFAULT_INSTALLED_SKILL_SORT;
  try {
    const stored = window.localStorage.getItem(INSTALLED_SORT_STORAGE_KEY);
    return isInstalledSkillSort(stored) ? stored : DEFAULT_INSTALLED_SKILL_SORT;
  } catch {
    return DEFAULT_INSTALLED_SKILL_SORT;
  }
}

function resetFlipStyles(element: HTMLElement) {
  element.style.transition = "";
  element.style.translate = "";
  element.style.willChange = "";
  element.style.zIndex = "";
}

function measureFlipRects(grid: HTMLElement, elements: readonly HTMLElement[]) {
  const gridRect = grid.getBoundingClientRect();
  const rects = new Map<string, FlipPosition>();
  for (const element of elements) {
    const key = element.dataset.flipKey;
    if (!key) continue;
    const rect = element.getBoundingClientRect();
    rects.set(key, {
      left: rect.left - gridRect.left,
      top: rect.top - gridRect.top,
    });
  }
  return rects;
}

function useFlipGrid() {
  const gridRef = useRef<HTMLDivElement>(null);
  const previousRectsRef = useRef<Map<string, FlipPosition>>(new Map());
  const previousOrderRef = useRef<string[]>([]);
  const pendingRequestRef = useRef<FlipRequest | null>(null);
  const frameRef = useRef<number | null>(null);
  const phaseTimerRef = useRef<number | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);
  const activeElementsRef = useRef<HTMLElement[]>([]);

  const requestFlip = useCallback(
    (mode: FlipMode, heroKeys: readonly string[], followKeys: readonly string[] = heroKeys) => {
      // 契约：必须在触发重排的 setState 之前调用。此处同步捕获「变更前」布局，
      // 主 effect 只在存在 pending 请求的那次渲染里测量「变更后」布局并做 FLIP —
      // 其余渲染完全不碰 getBoundingClientRect（技能多时曾是主要强制回流来源）。
      const grid = gridRef.current;
      if (grid) {
        const elements = Array.from(grid.querySelectorAll<HTMLElement>("[data-flip-key]"));
        previousRectsRef.current = measureFlipRects(grid, elements);
        previousOrderRef.current = elements.map((element) => element.dataset.flipKey ?? "");
      } else {
        previousRectsRef.current = new Map();
        previousOrderRef.current = [];
      }
      pendingRequestRef.current = {
        mode,
        heroKeys: new Set(heroKeys),
        followKeys: new Set(followKeys),
      };
    },
    [],
  );

  const captureVisibleKey = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return null;
    let scrollParent = grid.parentElement;
    while (scrollParent) {
      const overflowY = window.getComputedStyle(scrollParent).overflowY;
      if (/auto|scroll|overlay/.test(overflowY)) break;
      scrollParent = scrollParent.parentElement;
    }
    const viewport = scrollParent?.getBoundingClientRect();
    const viewportTop = viewport?.top ?? 0;
    const viewportBottom = viewport?.bottom ?? window.innerHeight;
    const elements = grid.querySelectorAll<HTMLElement>("[data-flip-key]");
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > viewportTop && rect.top < viewportBottom) {
        return element.dataset.flipKey ?? null;
      }
    }
    return null;
  }, []);

  const clearAnimation = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (phaseTimerRef.current !== null) {
      window.clearTimeout(phaseTimerRef.current);
      phaseTimerRef.current = null;
    }
    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    for (const element of activeElementsRef.current) {
      resetFlipStyles(element);
    }
    activeElementsRef.current = [];
  }, []);

  useLayoutEffect(() => {
    // 无 pending 请求的渲染不做任何测量/清理：变更前布局已在 requestFlip 时捕获，
    // 进行中的动画也不因无关重渲被打断。
    const request = pendingRequestRef.current;
    if (!request) return;
    pendingRequestRef.current = null;
    clearAnimation();
    const grid = gridRef.current;
    if (!grid) {
      previousRectsRef.current.clear();
      previousOrderRef.current = [];
      return;
    }

    const elements = Array.from(grid.querySelectorAll<HTMLElement>("[data-flip-key]"));
    const nextOrder = elements.map((element) => element.dataset.flipKey ?? "");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const followElement = elements.find((element) => {
      const key = element.dataset.flipKey;
      return key ? request.followKeys.has(key) : false;
    });

    followElement?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });

    const nextRects = measureFlipRects(grid, elements);

    const previousRects = previousRectsRef.current;
    const previousOrder = previousOrderRef.current;
    const orderChanged =
      previousOrder.length !== nextOrder.length ||
      nextOrder.some((key, index) => key !== previousOrder[index]);
    previousRectsRef.current = nextRects;
    previousOrderRef.current = nextOrder;

    if (previousRects.size === 0 || previousOrder.length === 0 || !orderChanged || reducedMotion) {
      return;
    }

    const movedElements: Array<{ element: HTMLElement; hero: boolean }> = [];
    for (const element of elements) {
      const key = element.dataset.flipKey;
      const previousRect = key ? previousRects.get(key) : undefined;
      const nextRect = key ? nextRects.get(key) : undefined;
      if (!previousRect || !nextRect) continue;
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      element.style.transition = "none";
      element.style.translate = `${deltaX}px ${deltaY}px`;
      element.style.willChange = "translate";
      const hero = key ? (request?.heroKeys.has(key) ?? false) : false;
      if (hero) element.style.zIndex = "30";
      movedElements.push({ element, hero });
    }

    if (movedElements.length === 0) return;
    activeElementsRef.current = movedElements.map(({ element }) => element);
    void grid.offsetWidth;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const mode = request?.mode ?? "wave";
      const heroElements = movedElements.filter(({ hero }) => hero);
      const waveElements = movedElements.filter(({ hero }) => !hero);
      const maxWaveDelay = Math.min(
        Math.max(0, waveElements.length - 1) * FLIP_WAVE_DELAY_MS,
        FLIP_WAVE_MAX_DELAY_MS,
      );
      const startWave = () => {
        waveElements.forEach(({ element }, index) => {
          const delay = Math.min(index * FLIP_WAVE_DELAY_MS, FLIP_WAVE_MAX_DELAY_MS);
          element.style.transition = `${FLIP_WAVE_TRANSITION} ${delay}ms`;
          element.style.translate = "0 0";
        });
      };
      const scheduleCleanup = (delay: number) => {
        cleanupTimerRef.current = window.setTimeout(() => {
          for (const { element } of movedElements) {
            resetFlipStyles(element);
          }
          activeElementsRef.current = [];
          cleanupTimerRef.current = null;
        }, delay + 40);
      };

      if (mode === "batch") {
        const staggerHeroes = (request?.heroKeys.size ?? 0) <= FLIP_BATCH_STAGGER_LIMIT;
        heroElements.forEach(({ element }, index) => {
          const delay = staggerHeroes ? index * FLIP_BATCH_HERO_DELAY_MS : 0;
          element.style.transition = `${FLIP_HERO_TRANSITION} ${delay}ms`;
          element.style.translate = "0 0";
        });
        const lastHeroDelay =
          staggerHeroes && heroElements.length > 0
            ? (heroElements.length - 1) * FLIP_BATCH_HERO_DELAY_MS
            : 0;
        const heroPhaseDuration =
          heroElements.length > 0 ? lastHeroDelay + FLIP_HERO_DURATION_MS : 0;
        if (waveElements.length > 0) {
          if (heroPhaseDuration > 0) {
            phaseTimerRef.current = window.setTimeout(() => {
              phaseTimerRef.current = null;
              startWave();
            }, heroPhaseDuration);
          } else {
            startWave();
          }
        }
        const wavePhaseDuration =
          waveElements.length > 0 ? FLIP_WAVE_DURATION_MS + maxWaveDelay : 0;
        scheduleCleanup(heroPhaseDuration + wavePhaseDuration);
        return;
      }

      heroElements.forEach(({ element }) => {
        element.style.transition = FLIP_HERO_TRANSITION;
        element.style.translate = "0 0";
      });
      startWave();
      const heroDuration = heroElements.length > 0 ? FLIP_HERO_DURATION_MS : 0;
      const waveDuration = waveElements.length > 0 ? FLIP_WAVE_DURATION_MS + maxWaveDelay : 0;
      scheduleCleanup(Math.max(heroDuration, waveDuration));
    });
  });

  useLayoutEffect(
    () => () => {
      clearAnimation();
      previousRectsRef.current.clear();
      previousOrderRef.current = [];
      pendingRequestRef.current = null;
    },
    [clearAnimation],
  );

  return { captureVisibleKey, gridRef, requestFlip };
}

type InstalledSkillCardProps = {
  skill: SkillSummary;
  flipKey: string;
  primaryCategory: ClawHubCategorySlug;
  alwaysEnabled: boolean;
  checked: boolean;
  bulkMode: boolean;
  bulkSelected: boolean;
  deleting: boolean;
  deleteDisabled: boolean;
  onToggle: (name: string, on: boolean) => void;
  onEnterBulkMode: (name: string) => void;
  onToggleBulkSelection: (name: string) => void;
  onBulkCardClick: (name: string, shiftKey: boolean) => void;
  onOpenPreview: (skill: SkillSummary) => void;
  onDelete: (skill: SkillSummary) => void;
  onSelectCategory: (category: ClawHubCategorySlug) => void;
};

// 安装卡片抽成 memo 组件：props 只传标量与稳定引用（布尔代替 Set 成员判断、
// primaryCategory 代替数组、latest-ref 回调），父组件的无关状态更新（搜索、
// store 轮询、抽屉开关等）不再重渲整片网格；triggerHint/identity/metadata
// 等派生计算也随之只在自身输入变化时重算。技能数量大时这是主要的卡顿来源。
const InstalledSkillCard = memo(function InstalledSkillCard(props: InstalledSkillCardProps) {
  const {
    skill,
    flipKey,
    primaryCategory,
    alwaysEnabled,
    checked,
    bulkMode,
    bulkSelected,
    deleting,
    deleteDisabled,
    onToggle,
    onEnterBulkMode,
    onToggleBulkSelection,
    onBulkCardClick,
    onOpenPreview,
    onDelete,
    onSelectCategory,
  } = props;
  const { t } = useLocale();
  const triggerHint = useMemo(() => getSkillTriggerHint(skill.description), [skill.description]);
  const cardIdentity = useMemo(
    () => (alwaysEnabled ? null : getInstalledSkillCardIdentity(skill.name, primaryCategory)),
    [alwaysEnabled, primaryCategory, skill.name],
  );
  const CardIcon = alwaysEnabled
    ? SkillIcon
    : INSTALLED_SKILL_CARD_ICONS[cardIdentity?.iconName ?? "circleHelp"];
  const iconTone = cardIdentity ? INSTALLED_SKILL_ICON_TONES[cardIdentity.colorIndex] : null;
  const metadataSource = getInstalledSkillCardSource(skill);
  const MetadataIcon =
    metadataSource === "built-in" ? Lock : metadataSource === "clawhub" ? Cloud : Folder;
  const metadataLabel = useMemo(() => formatInstalledSkillMetadata(skill, t), [skill, t]);
  const card = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all",
            alwaysEnabled
              ? "border-border/55 bg-background/80 text-foreground/85 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] dark:border-white/[0.09] dark:bg-white/[0.06] dark:shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]"
              : cn(
                  iconTone,
                  checked
                    ? "shadow-[0_1px_0_rgba(255,255,255,0.45)_inset]"
                    : "opacity-70 group-hover:opacity-100",
                ),
          )}
        >
          <CardIcon className="h-5 w-5" />
        </div>

        {alwaysEnabled && !bulkMode ? (
          <div
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium text-foreground/75 ring-1 ring-border/45"
            title={t("settings.skillsAlwaysOn")}
          >
            <Lock className="h-2.5 w-2.5" />
            <span>{t("settings.skillsAlwaysOn")}</span>
          </div>
        ) : bulkMode ? (
          alwaysEnabled ? (
            <div
              className="flex shrink-0 items-center"
              title={t("settings.skillsBulkAlwaysOnDisabled")}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-muted-foreground/50 opacity-60"
              >
                <Lock className="h-2.5 w-2.5" />
              </span>
            </div>
          ) : (
            <div className="flex shrink-0 items-center">
              <label
                className="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center"
                title={t("settings.skillsHubBulkSelectLabel")}
              >
                <input
                  type="checkbox"
                  checked={bulkSelected}
                  aria-label={`${t("settings.skillsHubBulkSelectLabel")}: ${skill.name}`}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation();
                    onToggleBulkSelection(skill.name);
                  }}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none flex h-5 w-5 items-center justify-center rounded-full border transition-all",
                    bulkSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background group-hover:border-foreground/40",
                  )}
                >
                  {bulkSelected ? <Check className="h-3 w-3" /> : null}
                </span>
              </label>
            </div>
          )
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              aria-label={`${t("settings.skillsHubBulkSelectLabel")}: ${skill.name}`}
              title={t("settings.skillsHubBulkSelect")}
              onClick={(event) => {
                event.stopPropagation();
                onEnterBulkMode(skill.name);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              className={cn(
                // Google Photos-style bulk entry: hover-faint, touch semi-visible.
                "relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-sm transition-all hover:border-primary/50 hover:text-foreground",
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-70",
              )}
            >
              <span className="h-2 w-2 rounded-full border border-current opacity-40" />
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={checked}
              aria-label={`${t("skills.select")}: ${skill.name}`}
              title={
                checked ? t("settings.skillsHubToggleDisable") : t("settings.skillsHubToggleEnable")
              }
              onClick={(event) => {
                event.stopPropagation();
                onToggle(skill.name, !checked);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full ring-1 transition-all",
                checked
                  ? "bg-emerald-500 ring-emerald-400/45"
                  : "bg-muted-foreground/25 ring-border/40",
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
                  checked ? "translate-x-[1.05rem]" : "translate-x-[0.15rem]",
                )}
              />
            </button>
          </div>
        )}
      </div>

      <div className="mt-2.5 min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
            {skill.name}
          </div>
          {checked ? (
            <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-500/25 dark:bg-emerald-400/12 dark:text-emerald-300 dark:ring-emerald-400/25">
              {t("settings.skillsHubEnabledBadge")}
            </span>
          ) : null}
        </div>
        {triggerHint ? (
          <p className="mt-1 flex min-w-0 items-center gap-1 text-[11px] font-medium leading-[1.35] text-primary/90 dark:text-primary">
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="shrink-0">{t("settings.skillsInstalledCardTrigger")}</span>
            <span className="truncate">{triggerHint}</span>
          </p>
        ) : null}
        {skill.description ? (
          <p
            className={cn(
              "mt-1 text-[11.5px] leading-[1.4] text-muted-foreground",
              triggerHint ? "line-clamp-1" : "line-clamp-2",
            )}
          >
            {skill.description}
          </p>
        ) : null}
        {!alwaysEnabled ? (
          <div className="mt-2">
            <InstalledSkillCategoryChip category={primaryCategory} onSelect={onSelectCategory} />
          </div>
        ) : null}
      </div>

      <div className="mt-2.5 flex min-h-8 items-center gap-1 border-t border-border/30 pt-2 text-[10.5px] text-muted-foreground/70">
        <MetadataIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{metadataLabel}</span>
        {!alwaysEnabled && !bulkMode ? (
          <div className="ml-auto shrink-0">
            <ConfirmDeletePopover name={skill.name} onConfirm={() => onDelete(skill)}>
              {(open) => (
                <button
                  type="button"
                  disabled={deleteDisabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    open();
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
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

  const key = flipKey;
  if (alwaysEnabled) {
    return (
      <button
        data-flip-key={key}
        type="button"
        aria-label={`${t("settings.skillsInstalledPreviewOpen")}: ${skill.name}`}
        onClick={() => {
          if (bulkMode) return;
          onOpenPreview(skill);
        }}
        className={cn(
          "hub-skill-card skill-card-enter group flex h-full min-h-[13rem] w-full cursor-pointer flex-col rounded-2xl border border-border/50 bg-background/75 p-3.5 text-left shadow-[0_1px_0_rgba(255,255,255,0.55)_inset,0_4px_18px_-12px_rgba(15,23,42,0.16)] transition-all hover:-translate-y-0.5 hover:border-border/60 hover:bg-background/85 hover:shadow-[0_4px_16px_-10px_rgba(15,23,42,0.18)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_1px_0_rgba(255,255,255,0.05)_inset,0_4px_18px_-12px_rgba(0,0,0,0.5)] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.07] dark:hover:shadow-[0_4px_16px_-10px_rgba(0,0,0,0.55)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/15",
          "[content-visibility:auto] [contain-intrinsic-size:auto_13rem]",
          bulkMode ? "cursor-default hover:translate-y-0" : null,
        )}
      >
        {card}
      </button>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: The card contains nested controls and cannot be a native button.
    <div
      data-flip-key={key}
      role="button"
      tabIndex={0}
      aria-label={`${t("settings.skillsInstalledPreviewOpen")}: ${skill.name}`}
      onClick={(event) => {
        if (bulkMode) {
          onBulkCardClick(skill.name, event.shiftKey);
          return;
        }
        onOpenPreview(skill);
      }}
      onMouseDown={(event) => {
        // Shift+点击做区间选择时避免浏览器拖出文本选区
        if (bulkMode && event.shiftKey) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (bulkMode && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onBulkCardClick(skill.name, event.shiftKey);
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpenPreview(skill);
      }}
      className={cn(
        "hub-skill-card skill-card-enter group relative flex h-full min-h-[13rem] w-full flex-col rounded-2xl border p-3.5 text-left transition-all",
        "cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-foreground/15",
        "[content-visibility:auto] [contain-intrinsic-size:auto_13rem]",
        // Enabled style always visible; bulk selection overlays primary ring.
        checked
          ? "border-emerald-500/35 bg-emerald-50/90 shadow-[0_1px_0_rgba(255,255,255,0.55)_inset,0_4px_14px_-12px_rgba(16,185,129,0.28)] dark:border-emerald-400/30 dark:bg-emerald-500/12 dark:shadow-[0_1px_0_rgba(255,255,255,0.05)_inset,0_4px_14px_-12px_rgba(16,185,129,0.22)]"
          : "border-border/40 bg-muted/45 text-muted-foreground shadow-none hover:-translate-y-0.5 hover:border-border/55 hover:bg-muted/55 dark:border-white/[0.06] dark:bg-white/[0.025] dark:hover:border-white/[0.10] dark:hover:bg-white/[0.04]",
        bulkSelected ? "ring-2 ring-primary/50 ring-offset-1 ring-offset-background" : null,
      )}
    >
      {card}
    </div>
  );
});

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
  const [hasPresentedInstalledSkills, setHasPresentedInstalledSkills] = useState(false);
  const {
    captureVisibleKey: captureInstalledFlipKey,
    gridRef: installedGridRef,
    requestFlip: requestInstalledFlip,
  } = useFlipGrid();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [installedCategory, setInstalledCategory] = useState<StoreCategoryValue>("all");
  const [installedSort, setInstalledSort] = useState<InstalledSkillSort>(
    readInstalledSortPreference,
  );
  // 批量选择模式：仅在「已安装」「本地导入」页可用。用于在大量技能中快速圈选
  // 一段连续区间（点首项、Shift+点末项）而不必逐个勾选。
  const [bulkMode, setBulkMode] = useState(false);
  // Temporary multi-select set (not persisted). Independent from enable state.
  const [bulkSelection, setBulkSelection] = useState<ReadonlySet<string>>(() => new Set());
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
  const [importingExternalBaseDir, setImportingExternalBaseDir] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<
    Array<{ baseDir: string; name: string; message: string }>
  >([]);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [importToast, setImportToast] = useState<string | null>(null);
  const importToastTimerRef = useRef<number | null>(null);
  const [previewInstalledSkill, setPreviewInstalledSkill] = useState<SkillSummary | null>(null);
  const [installedPreviewState, setInstalledPreviewState] = useState<InstalledSkillPreviewState>(
    () => emptyInstalledSkillPreviewState(),
  );
  const discoverySignatureRef = useRef<string | null>(null);

  // 唯一写入点：setState 与 discoverySignatureRef 必须同步更新，防止签名与状态漂移。
  // 签名未变时跳过 setState，保持 skills 数组引用稳定（下游 memo 链与 store 轮询零重渲）。
  const applyDiscovery = useCallback((nextRootDir: string, nextSkills: SkillSummary[]) => {
    const signature = buildSkillDiscoverySignature(nextRootDir, nextSkills);
    const changed = discoverySignatureRef.current !== signature;
    discoverySignatureRef.current = signature;
    if (changed) {
      setSkills(nextSkills);
      setRootDir(nextRootDir);
    }
    return changed;
  }, []);

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
        const changed = applyDiscovery(discovery.rootDir, discovery.skills);
        if (changed) {
          notifySkillsDiscoveryUpdated();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSkills([]);
        // 失败清空列表后必须同步重置签名，否则下一次成功刷新若内容与
        // 失败前相同会被 applyDiscovery 视为“未变化”而跳过 setState。
        discoverySignatureRef.current = buildSkillDiscoverySignature("", []);
        setLoadError(msg || t("settings.skillsHubLoadFailed"));
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [applyDiscovery, lockedByChatMode, t],
  );

  useEffect(() => {
    if (initialSkills && initialSkills.length > 0) {
      setSkills(initialSkills);
      discoverySignatureRef.current = buildSkillDiscoverySignature(
        initialRootDir ?? "",
        initialSkills,
      );
    }
  }, [initialRootDir, initialSkills]);

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
  // React 19 的 initialValue 让 Hub 外壳先独立提交；大量卡片在可中断的后台
  // render 中准备，全部完成后再原子替换加载态，避免页面切换被首屏列表挂载阻塞。
  const deferredSkills = useDeferredValue(skills, EMPTY_SKILLS);
  const installedContentPending = deferredSkills !== skills;
  useEffect(() => {
    if (!installedContentPending && deferredSkills.length > 0) {
      setHasPresentedInstalledSkills(true);
    }
  }, [deferredSkills, installedContentPending]);
  const selectableSkills = useMemo(() => skills.filter(isUserSelectableSkill), [skills]);
  const selectedCount = selectableSkills.filter((skill) => selected.has(skill.name)).length;
  useEffect(() => {
    try {
      window.localStorage.setItem(INSTALLED_SORT_STORAGE_KEY, installedSort);
    } catch {
      // The preference is non-critical when storage is unavailable.
    }
  }, [installedSort]);
  const installedSkillNames = useMemo(() => new Set(skills.map((skill) => skill.name)), [skills]);
  const requestInstalledSkillFlip = useCallback(
    (mode: FlipMode, names: readonly string[], followNames: readonly string[] = names) => {
      const keys = names.map((name) => `${name}-${rootDir}`);
      const followKeys = followNames.map((name) => `${name}-${rootDir}`);
      requestInstalledFlip(mode, keys, followKeys);
    },
    [requestInstalledFlip, rootDir],
  );

  // 过滤走 deferred 值：技能多时每击键的 filter→classify→sort 链在低优先级
  // 渲染中执行，输入框本身保持即时响应（输入框与空态提示仍绑同步 filter）。
  const deferredFilter = useDeferredValue(filter);
  const textFilteredInstalled = useMemo(() => {
    const text = deferredFilter.trim().toLowerCase();
    if (!text) return deferredSkills;
    return deferredSkills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(text) || skill.description.toLowerCase().includes(text),
    );
  }, [deferredFilter, deferredSkills]);

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
  const sortedFiltered = useMemo(
    () => sortInstalledSkillItems(filtered, installedSort, selected, ({ skill }) => skill),
    [filtered, installedSort, selected],
  );
  const filteredSelectableInstalledNames = useMemo(
    () =>
      sortedFiltered
        .map(({ skill }) => skill.name)
        .filter((name) => !isAlwaysEnabledSkillName(name)),
    [sortedFiltered],
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

  const externalSkillByBaseDir = useMemo(() => {
    const map = new Map<string, { baseDir: string; name: string }>();
    for (const scan of externalScans ?? []) {
      for (const skill of scan.skills) {
        map.set(skill.baseDir, { baseDir: skill.baseDir, name: skill.name });
      }
    }
    return map;
  }, [externalScans]);

  const isExternalSkillInstalled = useCallback(
    (baseDir: string) => {
      const skill = externalSkillByBaseDir.get(baseDir);
      return skill ? installedSkillNames.has(skill.name) : false;
    },
    [externalSkillByBaseDir, installedSkillNames],
  );

  const showImportToast = useCallback((message: string) => {
    if (importToastTimerRef.current !== null) {
      window.clearTimeout(importToastTimerRef.current);
    }
    setImportToast(message);
    importToastTimerRef.current = window.setTimeout(() => {
      setImportToast(null);
      importToastTimerRef.current = null;
    }, 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (importToastTimerRef.current !== null) {
        window.clearTimeout(importToastTimerRef.current);
      }
    };
  }, []);

  const toggleExternalSkill = useCallback(
    (baseDir: string) => {
      // Already-installed skills cannot be selected for import.
      if (isExternalSkillInstalled(baseDir)) return;
      setSelectedExternal((prev) => {
        const next = new Set(prev);
        if (next.has(baseDir)) next.delete(baseDir);
        else next.add(baseDir);
        return next;
      });
    },
    [isExternalSkillInstalled],
  );

  // 批量区间勾选：已安装技能跳过，且不会进入 selectedExternal。
  const batchToggleExternalSkills = useCallback(
    (baseDirs: string[], on: boolean) => {
      setSelectedExternal((prev) => {
        const next = new Set(prev);
        for (const baseDir of baseDirs) {
          if (isExternalSkillInstalled(baseDir)) {
            next.delete(baseDir);
            continue;
          }
          if (on) next.add(baseDir);
          else next.delete(baseDir);
        }
        return next;
      });
    },
    [isExternalSkillInstalled],
  );

  const importSelectedExternalSkills = useCallback(
    async (skill?: ExternalSkillEntry) => {
      if (importProgress) return;
      const selectedSkills = skill
        ? [skill]
        : (externalScans ?? [])
            .flatMap((scan) => scan.skills)
            .filter((item) => selectedExternal.has(item.baseDir));
      const alreadyInstalledSelected = selectedSkills.filter((skill) =>
        installedSkillNames.has(skill.name),
      );
      const targets = selectedSkills.filter((skill) => !installedSkillNames.has(skill.name));
      if (targets.length === 0) {
        if (alreadyInstalledSelected.length > 0) {
          showImportToast(t("settings.skillsImportAlreadyInstalled"));
        }
        return;
      }
      setImportErrors([]);
      setImportedCount(null);
      const failures: Array<{ baseDir: string; name: string; message: string }> = [];
      for (let index = 0; index < targets.length; index += 1) {
        setImportingExternalBaseDir(targets[index].baseDir);
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
      setImportingExternalBaseDir(null);
      setImportProgress(null);
      setImportErrors(failures);
      setImportedCount(targets.length - failures.length);
      if (!skill) setSelectedExternal(new Set());
      await refresh({ silent: true });
    },
    [
      externalScans,
      selectedExternal,
      importProgress,
      refresh,
      installedSkillNames,
      showImportToast,
      t,
    ],
  );

  // Drop installed skills from import selection (cannot re-import).
  useEffect(() => {
    if (!externalScans) return;
    setSelectedExternal((prev) => {
      const next = new Set(
        [...prev].filter((baseDir) => {
          const skill = externalScans
            .flatMap((scan) => scan.skills)
            .find((item) => item.baseDir === baseDir);
          return skill ? !installedSkillNames.has(skill.name) : false;
        }),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [externalScans, installedSkillNames]);

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
    requestInstalledSkillFlip("single", [name], on ? [name] : []);
    setSettings((prev) => updateSkills(prev, { selected: Array.from(next) }));
  }

  const clearBulkUndoTimer = useCallback(() => {
    if (bulkUndoTimerRef.current !== null) {
      window.clearTimeout(bulkUndoTimerRef.current);
      bulkUndoTimerRef.current = null;
    }
  }, []);

  const exitBulkMode = useCallback(() => {
    setBulkMode(false);
    setBulkSelection(new Set());
    bulkAnchorRef.current = null;
  }, []);

  const enterBulkMode = useCallback(
    (initialName?: string) => {
      setBulkMode(true);
      setPreviewInstalledSkill(null);
      if (initialName && !isAlwaysEnabledSkillName(initialName)) {
        clearBulkUndoTimer();
        setBulkUndo(null);
        setBulkSelection(new Set([initialName]));
        bulkAnchorRef.current = initialName;
      }
    },
    [clearBulkUndoTimer],
  );

  const toggleBulkSelectionName = useCallback(
    (name: string) => {
      if (isAlwaysEnabledSkillName(name)) return;
      clearBulkUndoTimer();
      setBulkUndo(null);
      setBulkSelection((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      bulkAnchorRef.current = name;
    },
    [clearBulkUndoTimer],
  );

  const setBulkSelectionRange = useCallback(
    (names: readonly string[], select: boolean) => {
      const selectable = names.filter((name) => !isAlwaysEnabledSkillName(name));
      if (selectable.length === 0) return;
      clearBulkUndoTimer();
      setBulkUndo(null);
      setBulkSelection((prev) => {
        const next = new Set(prev);
        for (const name of selectable) {
          if (select) next.add(name);
          else next.delete(name);
        }
        return next;
      });
    },
    [clearBulkUndoTimer],
  );

  // 批量选择模式下点击卡片：只改 bulkSelection，不改启用状态、不打开预览。
  function handleBulkInstalledCardClick(name: string, orderedNames: string[], shiftKey: boolean) {
    if (isAlwaysEnabledSkillName(name)) return;
    const currentlySelected = bulkSelection.has(name);
    const target = !currentlySelected;

    if (shiftKey && bulkAnchorRef.current && bulkAnchorRef.current !== name) {
      const from = orderedNames.indexOf(bulkAnchorRef.current);
      const to = orderedNames.indexOf(name);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setBulkSelectionRange(orderedNames.slice(lo, hi + 1), target);
        bulkAnchorRef.current = name;
        return;
      }
    }

    toggleBulkSelectionName(name);
  }

  // 批量启用/禁用：作用于 bulkSelection，成功后清空选择并弹出 Undo。
  // 副作用（Undo 快照/定时器/清空选择）都放在 setSettings 之外：
  // 传给 setSettings 的 updater 必须是纯函数（StrictMode 会双调用）。
  const applyBulkEnableState = useCallback(
    (target: boolean) => {
      const names = [...bulkSelection].filter((name) => !isAlwaysEnabledSkillName(name));
      if (names.length === 0) return;

      const before = settings.skills.selected;
      const current = new Set(before);
      const changedNames = names.filter((name) =>
        target ? !current.has(name) : current.has(name),
      );
      const changed = changedNames.length;
      if (changed === 0) return;

      requestInstalledSkillFlip("batch", changedNames, target ? changedNames : []);
      clearBulkUndoTimer();
      setBulkUndo({ selected: before, count: changed });
      bulkUndoTimerRef.current = window.setTimeout(() => {
        setBulkUndo(null);
        bulkUndoTimerRef.current = null;
      }, 6000);
      setBulkSelection(new Set());
      bulkAnchorRef.current = null;
      setSettings((prev) => {
        const next = new Set(prev.skills.selected);
        for (const name of names) {
          if (target) next.add(name);
          else next.delete(name);
        }
        return updateSkills(prev, {
          enabled: target ? true : prev.skills.enabled,
          selected: Array.from(next),
        });
      });
    },
    [
      bulkSelection,
      clearBulkUndoTimer,
      requestInstalledSkillFlip,
      setSettings,
      settings.skills.selected,
    ],
  );

  const undoBulkSelection = useCallback(() => {
    clearBulkUndoTimer();
    if (bulkUndo) {
      const restore = bulkUndo.selected;
      const current = new Set(settings.skills.selected);
      const restoreSet = new Set(restore);
      const changedNames = [...new Set([...current, ...restoreSet])].filter(
        (name) => !isAlwaysEnabledSkillName(name) && current.has(name) !== restoreSet.has(name),
      );
      const followNames = changedNames.filter((name) => restoreSet.has(name) && !current.has(name));
      requestInstalledSkillFlip("batch", changedNames, followNames);
      setSettings((prev) => updateSkills(prev, { selected: restore }));
    }
    setBulkUndo(null);
  }, [
    bulkUndo,
    clearBulkUndoTimer,
    requestInstalledSkillFlip,
    setSettings,
    settings.skills.selected,
  ]);

  async function deleteBulkSelectedInstalledSkills() {
    if (lockedByChatMode || deletingSkillName || !bulkMode) return;
    const targets = skills.filter(
      (skill) => bulkSelection.has(skill.name) && !isAlwaysEnabledSkillName(skill.name),
    );
    if (targets.length === 0) return;

    setLoadError(null);
    const failures: string[] = [];
    for (const skill of targets) {
      setDeletingSkillName(skill.name);
      try {
        await manageSkill({ action: "delete", name: skill.name });
        setSettings((prev) =>
          updateSkills(prev, {
            selected: prev.skills.selected.filter((name) => name !== skill.name),
          }),
        );
        setSkills((prev) => prev.filter((item) => item.name !== skill.name));
        setPreviewInstalledSkill((current) => (current?.name === skill.name ? null : current));
        setBulkSelection((prev) => {
          if (!prev.has(skill.name)) return prev;
          const next = new Set(prev);
          next.delete(skill.name);
          return next;
        });
        const sourceSlug =
          skill.source?.registry === "clawhub" ? skill.source.slug?.trim() || "" : "";
        const sourceOwnerHandle =
          skill.source?.registry === "clawhub" ? skill.source.ownerHandle?.trim() || null : null;
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${skill.name}: ${msg || t("settings.skillsHubDeleteFailed")}`);
      }
    }
    setDeletingSkillName(null);
    if (failures.length > 0) {
      setLoadError(`${t("settings.skillsHubBulkDeleteFailed")}: ${failures.join("; ")}`);
    }
    notifySkillsDiscoveryUpdated();
    await refresh({ silent: true });
  }

  useEffect(() => clearBulkUndoTimer, [clearBulkUndoTimer]);

  // 切换视图时退出批量模式并清空选择与锚点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只需在 view 变化时触发；exitBulkMode 是稳定回调
  useEffect(() => {
    exitBulkMode();
  }, [view]);

  // Esc: clear selection first, then exit bulk mode.
  useEffect(() => {
    if (!bulkMode || lockedByChatMode) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (bulkSelection.size > 0) {
          setBulkSelection(new Set());
          bulkAnchorRef.current = null;
        } else {
          exitBulkMode();
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        const target = event.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
          return;
        }
        // 「全选当前筛选」只对已安装页有定义；其余视图保留浏览器默认 Ctrl+A。
        if (view !== "installed") return;
        event.preventDefault();
        setBulkSelectionRange(filteredSelectableInstalledNames, true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    bulkMode,
    bulkSelection.size,
    exitBulkMode,
    filteredSelectableInstalledNames,
    lockedByChatMode,
    setBulkSelectionRange,
    view,
  ]);

  const bulkSelectedVisibleCount = useMemo(
    () =>
      filteredSelectableInstalledNames.reduce(
        (count, name) => count + (bulkSelection.has(name) ? 1 : 0),
        0,
      ),
    [bulkSelection, filteredSelectableInstalledNames],
  );
  const bulkSelectedHiddenCount = Math.max(0, bulkSelection.size - bulkSelectedVisibleCount);
  const bulkEnableChangeCount = useMemo(() => {
    let count = 0;
    for (const name of bulkSelection) {
      if (isAlwaysEnabledSkillName(name)) continue;
      if (!selected.has(name)) count += 1;
    }
    return count;
  }, [bulkSelection, selected]);
  const bulkDisableChangeCount = useMemo(() => {
    let count = 0;
    for (const name of bulkSelection) {
      if (isAlwaysEnabledSkillName(name)) continue;
      if (selected.has(name)) count += 1;
    }
    return count;
  }, [bulkSelection, selected]);
  const bulkDeleteNames = useMemo(
    () => [...bulkSelection].filter((name) => !isAlwaysEnabledSkillName(name)),
    [bulkSelection],
  );
  const bulkDeletePreview = useMemo(() => {
    const names = bulkDeleteNames.slice(0, 5);
    if (names.length === 0) return "";
    const rest = bulkDeleteNames.length - names.length;
    const joined = names.join(", ");
    return rest > 0
      ? t("settings.skillsHubBulkDeleteMore")
          .replace("{names}", joined)
          .replace("{count}", String(rest))
      : joined;
  }, [bulkDeleteNames, t]);

  function openInstalledSkillPreview(skill: SkillSummary) {
    setPreviewInstalledSkill(skill);
  }

  // memo 卡片的回调走 latest-ref（先例 file-tree）：引用恒定使 memo 不失效，
  // 实现经 ref 每渲染更新到最新闭包。
  const sortedInstalledNames = useMemo(
    () => sortedFiltered.map(({ skill }) => skill.name),
    [sortedFiltered],
  );
  const cardHandlersRef = useRef({
    toggleSkill,
    deleteSkill,
    openInstalledSkillPreview,
    handleBulkInstalledCardClick,
    sortedNames: [] as string[],
  });
  useEffect(() => {
    cardHandlersRef.current = {
      toggleSkill,
      deleteSkill,
      openInstalledSkillPreview,
      handleBulkInstalledCardClick,
      sortedNames: sortedInstalledNames,
    };
  });
  const handleCardToggle = useCallback(
    (name: string, on: boolean) => cardHandlersRef.current.toggleSkill(name, on),
    [],
  );
  const handleCardDelete = useCallback(
    (skill: SkillSummary) => void cardHandlersRef.current.deleteSkill(skill),
    [],
  );
  const handleCardOpenPreview = useCallback(
    (skill: SkillSummary) => cardHandlersRef.current.openInstalledSkillPreview(skill),
    [],
  );
  const handleCardBulkClick = useCallback((name: string, shiftKey: boolean) => {
    const { handleBulkInstalledCardClick, sortedNames } = cardHandlersRef.current;
    handleBulkInstalledCardClick(name, sortedNames, shiftKey);
  }, []);

  function setSkillsEnabled(enabled: boolean) {
    setSettings((prev) => updateSkills(prev, { enabled }));
  }

  const skillsEnabled = settings.skills.enabled;
  const showInitialInstalledContentLoading =
    skills.length > 0 && !hasPresentedInstalledSkills && installedContentPending;
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

            <div className="hub-panel-enter flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
              <div className="inline-flex shrink-0 rounded-2xl border border-border/40 bg-background/60 p-1 backdrop-blur-xl shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] max-sm:max-w-full max-sm:overflow-x-auto max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden dark:border-white/[0.06] dark:bg-white/[0.04] dark:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
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
                        "relative inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-[12.5px] font-medium transition-all max-sm:shrink-0",
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
                      onClick={() => {
                        if (bulkMode) exitBulkMode();
                        else enterBulkMode();
                      }}
                      title={
                        view === "installed"
                          ? t("settings.skillsBulkHint")
                          : t("settings.skillsBulkImportHint")
                      }
                      className={cn(
                        "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-3.5 text-[12.5px] font-medium backdrop-blur-xl transition-all max-sm:px-2.5",
                        bulkMode
                          ? "border-primary/50 bg-primary/10 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_12px_-8px_rgba(15,23,42,0.18)] ring-1 ring-primary/30 dark:border-primary/40 dark:bg-primary/15"
                          : "border-border/40 bg-background/60 text-muted-foreground hover:bg-background/80 hover:text-foreground dark:border-white/[0.06] dark:bg-white/[0.04]",
                      )}
                    >
                      <ListChecks className="h-3.5 w-3.5" />
                      <span>
                        {bulkMode ? t("settings.skillsBulkDone") : t("settings.skillsBulkSelect")}
                      </span>
                    </button>
                  ) : null}
                  {view === "installed" ? (
                    <select
                      value={installedSort}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (!isInstalledSkillSort(value) || value === installedSort) return;
                        const followKey = captureInstalledFlipKey();
                        requestInstalledFlip("wave", [], followKey ? [followKey] : []);
                        setInstalledSort(value);
                      }}
                      aria-label={t("settings.skillsInstalledSortLabel")}
                      title={t("settings.skillsInstalledSortLabel")}
                      className="h-10 max-w-[11rem] shrink-0 cursor-pointer rounded-xl border border-border/40 bg-background/95 px-3 text-[12.5px] font-medium text-foreground outline-hidden [color-scheme:light] transition-all hover:bg-background focus:border-border/60 focus:ring-2 focus:ring-foreground/10 max-sm:max-w-[7.5rem] max-sm:px-2 dark:border-white/[0.06] dark:bg-popover/95 dark:[color-scheme:dark]"
                    >
                      {INSTALLED_SORT_OPTIONS.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                          className="bg-background text-foreground"
                        >
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <div className="relative w-full min-w-0 max-w-md max-sm:flex-1">
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
                      className="h-10 w-full rounded-xl border border-border/40 bg-background/95 pl-10 pr-3 text-[13px] outline-hidden transition-all placeholder:text-muted-foreground/60 focus:border-border/60 focus:bg-background focus:ring-2 focus:ring-foreground/10 dark:bg-popover/95"
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
                <Fragment key={view}>
                  {view === "installed" ? (
                    <div
                      aria-busy={loading || showInitialInstalledContentLoading}
                      className={cn(
                        "h-full min-h-0 overflow-y-auto px-0.5 pr-1 pt-1.5 [overflow-anchor:none]",
                        bulkMode ? "pb-[calc(10rem+env(safe-area-inset-bottom))] sm:pb-24" : "pb-4",
                      )}
                    >
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
                          <SkillsContentLoadingState
                            title={t("settings.skillsScanning")}
                            description={t("settings.skillsHubScanning")}
                          />
                        ) : showInitialInstalledContentLoading ? (
                          <SkillsContentLoadingState
                            title={t("settings.skillsHubPreparing")}
                            description={t("settings.skillsHubPreparingDesc")}
                          />
                        ) : null}

                        {sortedFiltered.length > 0 ? (
                          <div
                            ref={installedGridRef}
                            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                          >
                            {sortedFiltered.map(({ skill, categories }) => {
                              const alwaysEnabled = isAlwaysEnabledSkillName(skill.name);
                              const key = `${skill.name}-${rootDir}`;
                              return (
                                <InstalledSkillCard
                                  key={key}
                                  flipKey={key}
                                  skill={skill}
                                  primaryCategory={categories[0] ?? "other"}
                                  alwaysEnabled={alwaysEnabled}
                                  checked={alwaysEnabled || selected.has(skill.name)}
                                  bulkMode={bulkMode}
                                  bulkSelected={bulkSelection.has(skill.name)}
                                  deleting={deletingSkillName === skill.name}
                                  deleteDisabled={deletingSkillName !== null}
                                  onToggle={handleCardToggle}
                                  onEnterBulkMode={enterBulkMode}
                                  onToggleBulkSelection={toggleBulkSelectionName}
                                  onBulkCardClick={handleCardBulkClick}
                                  onOpenPreview={handleCardOpenPreview}
                                  onDelete={handleCardDelete}
                                  onSelectCategory={setInstalledCategory}
                                />
                              );
                            })}
                          </div>
                        ) : null}

                        {(filter.trim() || installedCategory !== "all") &&
                        sortedFiltered.length === 0 &&
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
                      importingExternalBaseDir={importingExternalBaseDir}
                      loading={externalLoading}
                      error={externalError}
                      query={importQuery}
                      selected={selectedExternal}
                      installedNames={installedSkillNames}
                      importProgress={importProgress}
                      importErrors={importErrors}
                      importedCount={importedCount}
                      importToast={importToast}
                      onDismissImportToast={() => {
                        if (importToastTimerRef.current !== null) {
                          window.clearTimeout(importToastTimerRef.current);
                          importToastTimerRef.current = null;
                        }
                        setImportToast(null);
                      }}
                      bulkMode={bulkMode}
                      onToggle={toggleExternalSkill}
                      onBatchToggle={batchToggleExternalSkills}
                      onRescan={() => void rescanExternalSkills()}
                      onImport={(skill) => void importSelectedExternalSkills(skill)}
                    />
                  )}
                </Fragment>
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

      {bulkMode &&
      view === "installed" &&
      !lockedByChatMode &&
      (!bulkUndo || bulkSelection.size > 0) ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3 max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="hub-panel-enter pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-full border border-border/50 bg-background/95 py-2 pl-4 pr-2 text-[12.5px] shadow-[0_8px_24px_-12px_rgba(15,23,42,0.35)] max-sm:justify-center max-sm:rounded-3xl max-sm:whitespace-nowrap dark:border-white/[0.1] dark:bg-popover/95">
            {bulkSelection.size > 0 ? (
              <>
                <span className="whitespace-nowrap text-foreground/85">
                  {t("settings.skillsBulkSelectedCount").replace(
                    "{count}",
                    String(bulkSelection.size),
                  )}
                  {bulkSelectedHiddenCount > 0
                    ? ` ${t("settings.skillsBulkNotInFilter").replace("{count}", String(bulkSelectedHiddenCount))}`
                    : ""}
                </span>
                <span className="hidden text-muted-foreground/50 sm:inline" aria-hidden="true">
                  │
                </span>
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.08]"
                  onClick={() => setBulkSelectionRange(filteredSelectableInstalledNames, true)}
                >
                  {t("settings.skillsBulkSelectAll")}
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.08]"
                  onClick={() => {
                    setBulkSelection(new Set());
                    bulkAnchorRef.current = null;
                  }}
                >
                  {t("settings.skillsBulkClear")}
                </button>
                <span className="hidden text-muted-foreground/50 sm:inline" aria-hidden="true">
                  │
                </span>
                <button
                  type="button"
                  disabled={bulkEnableChangeCount === 0}
                  className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => applyBulkEnableState(true)}
                >
                  {`${t("settings.skillsBulkEnable")}${bulkEnableChangeCount > 0 ? ` (${bulkEnableChangeCount})` : ""}`}
                </button>
                <button
                  type="button"
                  disabled={bulkDisableChangeCount === 0}
                  className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => applyBulkEnableState(false)}
                >
                  {`${t("settings.skillsBulkDisable")}${bulkDisableChangeCount > 0 ? ` (${bulkDisableChangeCount})` : ""}`}
                </button>
                <ConfirmActionPopover
                  title={t("settings.deleteConfirm")}
                  description={`${t("settings.skillsHubBulkDeleteConfirm").replace("{count}", String(bulkDeleteNames.length))}${bulkDeletePreview ? ` ${bulkDeletePreview}` : ""}`}
                  confirmLabel={t("settings.delete")}
                  onConfirm={() => void deleteBulkSelectedInstalledSkills()}
                >
                  {(open) => (
                    <button
                      type="button"
                      disabled={bulkDeleteNames.length === 0 || deletingSkillName !== null}
                      onClick={open}
                      className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {`${t("settings.skillsHubBulkDelete")}${bulkDeleteNames.length > 0 ? ` (${bulkDeleteNames.length})` : ""}`}
                    </button>
                  )}
                </ConfirmActionPopover>
                <button
                  type="button"
                  onClick={exitBulkMode}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-foreground/[0.08] px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.14]"
                >
                  <X className="h-3.5 w-3.5" />
                  {t("settings.skillsBulkDone")}
                </button>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">
                  {t("settings.skillsBulkClickToSelect")}
                </span>
                <button
                  type="button"
                  onClick={exitBulkMode}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-foreground/[0.08] px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.14]"
                >
                  {t("settings.skillsBulkDone")}
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {bulkUndo && bulkSelection.size === 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3 max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="hub-panel-enter pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-3 rounded-full border border-border/50 bg-background/95 py-2 pl-4 pr-2 text-[12.5px] shadow-[0_8px_24px_-12px_rgba(15,23,42,0.35)] dark:border-white/[0.1] dark:bg-popover/95">
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
  importingExternalBaseDir: string | null;
  importErrors: Array<{ baseDir: string; name: string; message: string }>;
  importedCount: number | null;
  importToast: string | null;
  onDismissImportToast: () => void;
  bulkMode: boolean;
  onToggle: (baseDir: string) => void;
  onBatchToggle: (baseDirs: string[], on: boolean) => void;
  onRescan: () => void;
  onImport: (skill?: ExternalSkillEntry) => void;
}) {
  const {
    scans,
    loading,
    error,
    query,
    selected,
    installedNames,
    importProgress,
    importingExternalBaseDir,
    importErrors,
    importedCount,
    importToast,
    onDismissImportToast,
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
  const importableSelectedCount = useMemo(() => {
    let count = 0;
    for (const scan of scans) {
      for (const skill of scan.skills) {
        if (installedNames.has(skill.name)) continue;
        if (selected.has(skill.baseDir)) count += 1;
      }
    }
    return count;
  }, [scans, installedNames, selected]);

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
  // 「已选 X / Y」与全选按钮都只统计可导入项：已安装项不可选，不计入分子分母。
  const selectableVisibleBaseDirs = useMemo(
    () =>
      activeScan?.skills
        .filter((skill) => !installedNames.has(skill.name))
        .map((skill) => skill.baseDir) ?? [],
    [activeScan, installedNames],
  );
  const selectedSelectableVisibleCount = useMemo(
    () =>
      selectableVisibleBaseDirs.reduce(
        (count, baseDir) => count + (selected.has(baseDir) ? 1 : 0),
        0,
      ),
    [selectableVisibleBaseDirs, selected],
  );
  const allVisibleSelected =
    selectableVisibleBaseDirs.length > 0 &&
    selectedSelectableVisibleCount === selectableVisibleBaseDirs.length;

  return (
    <div
      className={cn(
        "relative h-full min-h-0 overflow-y-auto px-0.5 pr-1 pt-1.5",
        bulkMode ? "pb-[calc(8rem+env(safe-area-inset-bottom))] sm:pb-24" : "pb-4",
      )}
    >
      {importToast ? (
        <div className="pointer-events-none sticky top-2 z-[80] flex justify-end px-1">
          <div className="notify-toast-enter pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-50 px-3 py-2.5 text-sm shadow-lg dark:border-amber-500/25 dark:bg-amber-950">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="min-w-0 flex-1 leading-relaxed text-amber-800 dark:text-amber-200">
              {importToast}
            </p>
            <button
              type="button"
              onClick={onDismissImportToast}
              className="mt-0.5 shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:opacity-100"
              aria-label={t("settings.cancel")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}
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
                {!bulkMode ? (
                  <Button
                    size="sm"
                    className="gap-1.5 rounded-full"
                    disabled={selected.size === 0 || importing || loading}
                    onClick={() => onImport()}
                  >
                    {importing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {importing && importProgress
                      ? `${t("settings.skillsImportProgress")} ${importProgress.done + 1}/${importProgress.total}`
                      : `${t("settings.skillsImportButton")}${importableSelectedCount > 0 ? ` (${importableSelectedCount})` : ""}`}
                  </Button>
                ) : null}
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
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs text-muted-foreground">
                        {t("settings.skillsHubSelectedShort")} {selectedSelectableVisibleCount} /{" "}
                        {selectableVisibleBaseDirs.length}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 rounded-full"
                        disabled={importing || selectableVisibleBaseDirs.length === 0}
                        onClick={() =>
                          onBatchToggle(selectableVisibleBaseDirs, !allVisibleSelected)
                        }
                      >
                        <span
                          className={cn(
                            "flex h-3.5 w-3.5 items-center justify-center rounded border",
                            allVisibleSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border/70 bg-background",
                          )}
                          aria-hidden="true"
                        >
                          {allVisibleSelected ? <Check className="h-2.5 w-2.5" /> : null}
                        </span>
                        {allVisibleSelected
                          ? t("settings.skillsImportDeselectAll")
                          : t("settings.skillsImportSelectAll")}
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                      {activeScan.skills.map((skill) => {
                        const alreadyInstalled = installedNames.has(skill.name);
                        const checked = !alreadyInstalled && selected.has(skill.baseDir);
                        const locked = alreadyInstalled || importing;
                        const installing = importing && skill.baseDir === importingExternalBaseDir;
                        return (
                          // biome-ignore lint/a11y/useSemanticElements: The card contains a separate import control.
                          <div
                            key={skill.baseDir}
                            role="button"
                            tabIndex={locked ? -1 : 0}
                            aria-disabled={locked}
                            aria-pressed={checked}
                            onMouseDown={(event) => {
                              if (bulkMode && event.shiftKey) event.preventDefault();
                            }}
                            onClick={(event) => {
                              if (locked) return;
                              const orderedBaseDirs = activeScan.skills
                                .filter((item) => !installedNames.has(item.name))
                                .map((item) => item.baseDir);
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
                            onKeyDown={(event) => {
                              if (
                                event.target !== event.currentTarget ||
                                (event.key !== "Enter" && event.key !== " ")
                              ) {
                                return;
                              }
                              event.preventDefault();
                              event.currentTarget.click();
                            }}
                            className={cn(
                              "skill-card-enter group flex h-full min-h-[13rem] w-full flex-col rounded-2xl border p-3.5 text-left transition-all focus:outline-none focus:ring-2 focus:ring-foreground/10",
                              alreadyInstalled
                                ? "border-border/55 bg-background/80 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_4px_18px_-12px_rgba(15,23,42,0.18)] dark:border-white/[0.10] dark:bg-white/[0.07] dark:shadow-[0_1px_0_rgba(255,255,255,0.07)_inset,0_4px_18px_-12px_rgba(0,0,0,0.55)]"
                                : checked
                                  ? "border-primary/60 bg-primary/5 shadow-sm shadow-primary/10"
                                  : "border-border/40 bg-background/60 hover:-translate-y-0.5 hover:border-border/55 hover:bg-background/75 hover:shadow-[0_4px_16px_-10px_rgba(15,23,42,0.18)] dark:border-white/[0.05] dark:bg-white/[0.03] dark:hover:border-white/[0.10] dark:hover:bg-white/[0.06] dark:hover:shadow-[0_4px_16px_-10px_rgba(0,0,0,0.55)]",
                              importing && !alreadyInstalled ? "opacity-60" : null,
                            )}
                          >
                            <div className="flex h-full flex-col gap-3">
                              <div className="flex items-start gap-3">
                                <span
                                  className={cn(
                                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors",
                                    alreadyInstalled
                                      ? "border-border/50 bg-muted/40 opacity-50"
                                      : checked
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border/70 bg-background",
                                  )}
                                >
                                  {!alreadyInstalled && checked ? (
                                    <Check className="h-3 w-3" />
                                  ) : null}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="truncate text-[13px] font-semibold leading-tight text-foreground">
                                      {skill.name}
                                    </span>
                                    {alreadyInstalled ? (
                                      <span className="shrink-0 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                        {t("settings.skillsImportInstalledBadge")}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                              <p
                                className="line-clamp-3 min-h-[3rem] text-[11.5px] leading-[1.45] text-muted-foreground"
                                title={skill.description}
                              >
                                {truncateLocalSkillCardDescription(skill.description)}
                              </p>
                              <div className="mt-auto space-y-2.5">
                                <span
                                  className="block truncate px-0.5 text-[10.5px] text-muted-foreground/75"
                                  title={skill.baseDir}
                                >
                                  {skill.baseDir}
                                </span>
                                <Button
                                  type="button"
                                  variant={alreadyInstalled ? "outline" : "default"}
                                  size="sm"
                                  className="h-10 w-full gap-1.5 rounded-xl"
                                  disabled={locked}
                                  aria-busy={installing}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onImport(skill);
                                  }}
                                >
                                  {installing ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : alreadyInstalled ? (
                                    <Check className="h-3.5 w-3.5" />
                                  ) : (
                                    <Download className="h-3.5 w-3.5" />
                                  )}
                                  {installing
                                    ? t("settings.skillsImportProgress")
                                    : alreadyInstalled
                                      ? t("settings.skillsImportInstalledBadge")
                                      : t("settings.skillsBulkImportAction")}
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      {bulkMode ? (
        <div className="pointer-events-none sticky bottom-3 z-20 flex justify-center px-1 pt-2 max-sm:bottom-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <div className="hub-panel-enter pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-full border border-border/50 bg-background/95 py-2 pl-4 pr-2 text-[12.5px] shadow-[0_8px_24px_-12px_rgba(15,23,42,0.35)] max-sm:justify-center max-sm:rounded-3xl max-sm:whitespace-nowrap dark:border-white/[0.1] dark:bg-popover/95">
            {importableSelectedCount > 0 || importing ? (
              <>
                <span className="whitespace-nowrap text-foreground/85">
                  {t("settings.skillsBulkSelectedCount").replace(
                    "{count}",
                    String(importableSelectedCount),
                  )}
                </span>
                <span className="hidden text-muted-foreground/50 sm:inline" aria-hidden="true">
                  │
                </span>
                <button
                  type="button"
                  disabled={importing || loading}
                  className="inline-flex h-7 items-center rounded-full bg-foreground px-3 text-[12px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => onImport()}
                >
                  {importing && importProgress ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      {`${t("settings.skillsImportProgress")} ${importProgress.done + 1}/${importProgress.total}`}
                    </>
                  ) : (
                    `${t("settings.skillsBulkImportAction")}${importableSelectedCount > 0 ? ` (${importableSelectedCount})` : ""}`
                  )}
                </button>
              </>
            ) : (
              <span className="text-muted-foreground">{t("settings.skillsBulkClickToSelect")}</span>
            )}
          </div>
        </div>
      ) : null}
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
        "fixed inset-0 z-50 flex justify-end bg-background/55",
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
          "flex h-full w-full flex-col border-l border-border/45 bg-background shadow-[-18px_0_45px_-28px_rgba(15,23,42,0.45)] dark:border-white/[0.08] dark:bg-popover dark:shadow-[-18px_0_45px_-28px_rgba(0,0,0,0.7)] md:w-2/5 md:max-w-[34rem]",
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

function InstalledSkillCategoryChip(props: {
  category: ClawHubCategorySlug;
  onSelect: (category: ClawHubCategorySlug) => void;
}) {
  const { t } = useLocale();
  const CategoryIcon = STORE_CATEGORY_ICONS[props.category];
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        props.onSelect(props.category);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium text-foreground/75 ring-1 ring-border/45 transition-colors hover:bg-foreground/[0.1]"
    >
      <CategoryIcon className="h-2.5 w-2.5" />
      <span>{t(storeCategoryLabelKey(props.category))}</span>
    </button>
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
                      "skill-card-enter group flex h-full cursor-pointer flex-col rounded-2xl border p-3.5 text-left transition-all focus:outline-none focus:ring-2 focus:ring-foreground/10",
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
        "fixed inset-0 z-50 flex justify-end bg-background/55",
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
          "flex h-full w-full flex-col border-l border-border/45 bg-background shadow-[-18px_0_45px_-28px_rgba(15,23,42,0.45)] dark:border-white/[0.08] dark:bg-popover dark:shadow-[-18px_0_45px_-28px_rgba(0,0,0,0.7)] md:w-2/5 md:max-w-[34rem]",
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
          {STORE_PREVIEW_FIELD_WIDTHS.map((width) => (
            <div
              key={width}
              className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 py-2.5"
            >
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
  cachedCompactNumberFormat ??= new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  return cachedCompactNumberFormat.format(value);
}

function formatStoreDate(value: number) {
  cachedShortDateFormat ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  });
  return cachedShortDateFormat.format(new Date(value));
}

function formatFullStoreDate(value: number) {
  return getFullDateFormat().format(new Date(value));
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
