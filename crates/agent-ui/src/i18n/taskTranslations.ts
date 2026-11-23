export const TASK_TRANSLATIONS = {
  "zh-CN": {
    "chat.taskProgress.title": "任务进度",
    "chat.taskProgress.step": "第 {current} / {total} 步",
    "chat.taskProgress.running": "运行中",
    "chat.taskProgress.pending": "待处理",
    "chat.taskProgress.paused": "已暂停或中断",
    "chat.taskProgress.completed": "全部完成",
    "chat.taskProgress.taskPaused": "已暂停",
    "chat.taskProgress.taskCompleted": "已完成",
    "chat.taskProgress.completedCount": "已完成",
  },
  "en-US": {
    "chat.taskProgress.title": "Task progress",
    "chat.taskProgress.step": "Step {current} of {total}",
    "chat.taskProgress.running": "Running",
    "chat.taskProgress.pending": "Pending",
    "chat.taskProgress.paused": "Paused or interrupted",
    "chat.taskProgress.completed": "All completed",
    "chat.taskProgress.taskPaused": "Paused",
    "chat.taskProgress.taskCompleted": "Completed",
    "chat.taskProgress.completedCount": "completed",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
