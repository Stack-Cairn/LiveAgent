export const TASK_TRANSLATIONS = {
  "zh-CN": {
    "chat.taskProgress.title": "任务进度",
    "chat.taskProgress.step": "第 {current} / {total} 步",
    "chat.taskProgress.running": "运行中",
    "chat.taskProgress.pending": "待处理",
    "chat.taskProgress.paused": "已暂停或中断",
    "chat.taskProgress.completed": "全部完成",
    "chat.taskProgress.completedCount": "已完成",
    "settings.builtinTool.task_create.name": "创建任务",
    "settings.builtinTool.task_create.desc": "向当前运行添加一个任务",
    "settings.builtinTool.task_create.detail": "创建带有稳定数字 ID 的持久任务；仅在对话场景注册。",
    "settings.builtinTool.task_update.name": "更新任务",
    "settings.builtinTool.task_update.desc": "按稳定 ID 更新一个任务",
    "settings.builtinTool.task_update.detail":
      "更新任务状态或内容，不替换整个任务清单；仅在对话场景注册。",
    "settings.builtinTool.task_list.name": "查看任务",
    "settings.builtinTool.task_list.desc": "读取当前运行的完整任务清单",
    "settings.builtinTool.task_list.detail":
      "返回当前运行的权威任务快照与稳定 ID；仅在对话场景注册。",
  },
  "en-US": {
    "chat.taskProgress.title": "Task progress",
    "chat.taskProgress.step": "Step {current} of {total}",
    "chat.taskProgress.running": "Running",
    "chat.taskProgress.pending": "Pending",
    "chat.taskProgress.paused": "Paused or interrupted",
    "chat.taskProgress.completed": "All completed",
    "chat.taskProgress.completedCount": "completed",
    "settings.builtinTool.task_create.name": "Create Task",
    "settings.builtinTool.task_create.desc": "Add one task to the current run",
    "settings.builtinTool.task_create.detail":
      "Create a durable task with a stable numeric ID; chat sessions only.",
    "settings.builtinTool.task_update.name": "Update Task",
    "settings.builtinTool.task_update.desc": "Update one task by stable ID",
    "settings.builtinTool.task_update.detail":
      "Update task status or content without replacing the task list; chat sessions only.",
    "settings.builtinTool.task_list.name": "List Tasks",
    "settings.builtinTool.task_list.desc": "Read the current run's complete task list",
    "settings.builtinTool.task_list.detail":
      "Return the authoritative task snapshot and stable IDs for the current run; chat sessions only.",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
