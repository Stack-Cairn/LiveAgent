/** Checkpoint rewind preview, result dialogs and the completion notice. Counts use `.one` / `.other` keys. */
export const CHECKPOINT_REWIND_TRANSLATIONS = {
  "zh-CN": {
    "checkpointRewind.notice.restored.one": "恢复\u00A0{count}\u00A0个",
    "checkpointRewind.notice.restored.other": "恢复\u00A0{count}\u00A0个",
    "checkpointRewind.notice.deleted.one": "删除\u00A0{count}\u00A0个",
    "checkpointRewind.notice.deleted.other": "删除\u00A0{count}\u00A0个",
    "checkpointRewind.notice.changes": "{changes}文件",
    "checkpointRewind.notice.conflicts.one": "冲突跳过\u00A0{count}\u00A0个",
    "checkpointRewind.notice.conflicts.other": "冲突跳过\u00A0{count}\u00A0个",
    "checkpointRewind.notice.failed": "失败\u00A0{count}\u00A0个",
    "checkpointRewind.notice.noPreImage": "{count}\u00A0个无前像未回退",
    "checkpointRewind.notice.head": "已回退代码：{changes}",
    "checkpointRewind.notice.headNone": "已回退代码：没有文件需要改动",
    "checkpointRewind.notice.withIssues": "{head}（{issues}）",
    "checkpointRewind.notice.separator": "、",
    "checkpointRewind.preview.restore.one": "将恢复 {count} 个文件",
    "checkpointRewind.preview.restore.other": "将恢复 {count} 个文件",
    "checkpointRewind.preview.delete.one": "将删除 {count} 个文件",
    "checkpointRewind.preview.delete.other": "将删除 {count} 个文件",
    "checkpointRewind.preview.clean.one": "{count} 个文件无变化",
    "checkpointRewind.preview.clean.other": "{count} 个文件无变化",
    "checkpointRewind.preview.skippedDirs.one": "{count} 个已删除的目录无法恢复",
    "checkpointRewind.preview.skippedDirs.other": "{count} 个已删除的目录无法恢复",
    "checkpointRewind.preview.missingBlobs.one": "{count} 个文件缺少改动前快照",
    "checkpointRewind.preview.missingBlobs.other": "{count} 个文件缺少改动前快照",
    "checkpointRewind.preview.unresolvable.one":
      "{count} 个路径无法回退（目录未授权，或路径包含符号链接）",
    "checkpointRewind.preview.unresolvable.other":
      "{count} 个路径无法回退（目录未授权，或路径包含符号链接）",
    "checkpointRewind.preview.captureErrors.one":
      "本轮有 {count} 次快照记录失败，回退结果可能不完整",
    "checkpointRewind.preview.captureErrors.other":
      "本轮有 {count} 次快照记录失败，回退结果可能不完整",
    "checkpointRewind.preview.manualEdits":
      "在编辑器或文件树中的手动修改不在检查点内，将被一并覆盖",
    "checkpointRewind.preview.separator": "，",
    "checkpointRewind.preview.title": "回退到本轮开始前",
    "checkpointRewind.preview.noChanges": "本轮没有可回退的文件改动",
    "checkpointRewind.preview.confirm": "回退",
    "checkpointRewind.preview.cancel": "取消",
    "checkpointRewind.result.conflict": "冲突(已跳过): {path}",
    "checkpointRewind.result.failed": "失败: {path}",
    "checkpointRewind.result.captureErrors.one": "该轮有 {count} 个文件没有前像(捕获失败),未被回退",
    "checkpointRewind.result.captureErrors.other":
      "该轮有 {count} 个文件没有前像(捕获失败),未被回退",
    "checkpointRewind.result.skippedDirs.one": "{count} 个被删除目录无法恢复",
    "checkpointRewind.result.skippedDirs.other": "{count} 个被删除目录无法恢复",
    "checkpointRewind.result.partialTitle": "回退部分未完成",
    "checkpointRewind.result.partialSummary":
      "已恢复 {restored} 个、删除 {deleted} 个；冲突跳过 {conflicts} 个、失败 {failed} 个",
    "checkpointRewind.result.ok": "知道了",
    "checkpointRewind.result.failedTitle": "回退失败",
  },
  "en-US": {
    "checkpointRewind.notice.restored.one": "restored {count} file",
    "checkpointRewind.notice.restored.other": "restored {count} files",
    "checkpointRewind.notice.deleted.one": "deleted {count} file",
    "checkpointRewind.notice.deleted.other": "deleted {count} files",
    "checkpointRewind.notice.changes": "{changes}",
    "checkpointRewind.notice.conflicts.one": "{count} conflict skipped",
    "checkpointRewind.notice.conflicts.other": "{count} conflicts skipped",
    "checkpointRewind.notice.failed": "{count} failed",
    "checkpointRewind.notice.noPreImage": "{count} without pre-image",
    "checkpointRewind.notice.head": "Code rewound: {changes}",
    "checkpointRewind.notice.headNone": "Code rewound: no file changes were needed",
    "checkpointRewind.notice.withIssues": "{head} ({issues})",
    "checkpointRewind.notice.separator": ", ",
    "checkpointRewind.preview.restore.one": "Restore {count} file",
    "checkpointRewind.preview.restore.other": "Restore {count} files",
    "checkpointRewind.preview.delete.one": "Delete {count} file",
    "checkpointRewind.preview.delete.other": "Delete {count} files",
    "checkpointRewind.preview.clean.one": "{count} file unchanged",
    "checkpointRewind.preview.clean.other": "{count} files unchanged",
    "checkpointRewind.preview.skippedDirs.one": "{count} deleted directory cannot be restored",
    "checkpointRewind.preview.skippedDirs.other": "{count} deleted directories cannot be restored",
    "checkpointRewind.preview.missingBlobs.one": "{count} file is missing its pre-edit snapshot",
    "checkpointRewind.preview.missingBlobs.other":
      "{count} files are missing their pre-edit snapshots",
    "checkpointRewind.preview.unresolvable.one":
      "{count} path cannot be rewound (directory not authorized, or the path contains a symlink)",
    "checkpointRewind.preview.unresolvable.other":
      "{count} paths cannot be rewound (directory not authorized, or the path contains a symlink)",
    "checkpointRewind.preview.captureErrors.one":
      "{count} snapshot failed to record in this turn; the rewind may be incomplete",
    "checkpointRewind.preview.captureErrors.other":
      "{count} snapshots failed to record in this turn; the rewind may be incomplete",
    "checkpointRewind.preview.manualEdits":
      "Manual edits made in the editor or file tree are not checkpointed and will be overwritten",
    "checkpointRewind.preview.separator": ", ",
    "checkpointRewind.preview.title": "Rewind to before this turn",
    "checkpointRewind.preview.noChanges": "No file changes to rewind in this turn",
    "checkpointRewind.preview.confirm": "Rewind",
    "checkpointRewind.preview.cancel": "Cancel",
    "checkpointRewind.result.conflict": "Conflict (skipped): {path}",
    "checkpointRewind.result.failed": "Failed: {path}",
    "checkpointRewind.result.captureErrors.one":
      "{count} file had no pre-image (capture failed) and was not rewound",
    "checkpointRewind.result.captureErrors.other":
      "{count} files had no pre-image (capture failed) and were not rewound",
    "checkpointRewind.result.skippedDirs.one": "{count} deleted directory could not be restored",
    "checkpointRewind.result.skippedDirs.other":
      "{count} deleted directories could not be restored",
    "checkpointRewind.result.partialTitle": "Rewind partially completed",
    "checkpointRewind.result.partialSummary":
      "Restored {restored}, deleted {deleted}; {conflicts} skipped due to conflicts, {failed} failed",
    "checkpointRewind.result.ok": "OK",
    "checkpointRewind.result.failedTitle": "Rewind failed",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
