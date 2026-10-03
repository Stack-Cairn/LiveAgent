const MODEL_GENERATING_STATUS_PATTERN = /^第\s*\d+\s*轮：模型生成中\.\.\.$/;

export const VIBING_STATUS = "Vibing...";

export function normalizeLiveToolStatus(status: string | null) {
  if (status && MODEL_GENERATING_STATUS_PATTERN.test(status)) return VIBING_STATUS;
  return status;
}

// Desktop compaction progress is locale-neutral and always ends with the elapsed
// clock ("0:41", "12.3k · 0:41", "→ transcript · 1:10"). Older desktops sent
// whole Chinese sentences under the same flag; those are not shown as a suffix.
const COMPACTION_PROGRESS_PATTERN = /^.{0,40}\d+:\d{2}$/;

export function compactionProgressDetail(status: string | null | undefined) {
  const text = status?.trim();
  return text && COMPACTION_PROGRESS_PATTERN.test(text) ? text : null;
}
