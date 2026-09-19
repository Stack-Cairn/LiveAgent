import type { ClawHubSkillCard } from "@liveagent/ui/lib/skills/clawHub";
import type { SkillInstallJobSnapshot } from "@liveagent/ui/lib/skills/index";

let cachedCompactNumberFormat: Intl.NumberFormat | null = null;
let cachedShortDateFormat: Intl.DateTimeFormat | null = null;
let cachedFullDateFormat: Intl.DateTimeFormat | null = null;

export function getFullDateFormat() {
  cachedFullDateFormat ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return cachedFullDateFormat;
}

export function buildClawHubSkillUrl(skill: ClawHubSkillCard) {
  if (!skill.ownerHandle) return null;
  return `https://clawhub.ai/${encodeURIComponent(skill.ownerHandle)}/${encodeURIComponent(skill.slug)}`;
}

export function formatCompactNumber(value: number) {
  cachedCompactNumberFormat ??= new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  return cachedCompactNumberFormat.format(value);
}

export function formatStoreDate(value: number) {
  cachedShortDateFormat ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  });
  return cachedShortDateFormat.format(new Date(value));
}

export function formatFullStoreDate(value: number) {
  return getFullDateFormat().format(new Date(value));
}

export function getInstallProgressPercent(job: SkillInstallJobSnapshot) {
  if (job.phase === "done") return 100;
  if (!job.totalBytes || job.totalBytes <= 0) return null;
  return Math.max(2, Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 100)));
}

export function formatInstallProgress(job: SkillInstallJobSnapshot) {
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

export function installPhaseLabel(
  job: SkillInstallJobSnapshot | undefined,
  t: (key: string) => string,
) {
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
