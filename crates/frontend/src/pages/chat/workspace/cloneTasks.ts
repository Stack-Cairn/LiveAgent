import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

export type WorkspaceCloneTask = {
  id: string;
  repositoryName: string;
  targetPath: string;
  branch: string;
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled";
  phase:
    | "preparing"
    | "receiving"
    | "resolving"
    | "finalizing"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number | null;
  detail: string;
  error: string;
  startedAt: number;
};

type StartWorkspaceCloneTaskInput = {
  parent: string;
  name: string;
  remoteUrl: string;
  branch: string;
};

let tasks: WorkspaceCloneTask[] = [];
const dismissedTaskIds = new Set<string>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function hasActiveTask() {
  return tasks.some((task) => task.status === "running" || task.status === "cancelling");
}

function replaceTasks(nextTasks: WorkspaceCloneTask[]) {
  tasks = nextTasks.filter((task) => !dismissedTaskIds.has(task.id));
  emit();
}

function schedulePoll() {
  if (pollTimer !== null || !hasActiveTask()) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    try {
      const nextTasks = await invoke<WorkspaceCloneTask[]>("git_clone_repository_tasks");
      replaceTasks(nextTasks);
    } catch {
      // The next task mutation or UI mount retries; keep the card visible.
    }
    schedulePoll();
  }, 250);
}

async function refreshWorkspaceCloneTasks() {
  const nextTasks = await invoke<WorkspaceCloneTask[]>("git_clone_repository_tasks");
  replaceTasks(nextTasks);
  schedulePoll();
}

export async function startWorkspaceCloneTask(input: StartWorkspaceCloneTaskInput) {
  const task = await invoke<WorkspaceCloneTask>("git_clone_repository_start", {
    parent: input.parent,
    name: input.name,
    remote_url: input.remoteUrl,
    branch: input.branch || undefined,
  });
  dismissedTaskIds.delete(task.id);
  replaceTasks([task, ...tasks.filter((candidate) => candidate.id !== task.id)]);
  schedulePoll();
  return task;
}

export async function cancelWorkspaceCloneTask(taskId: string) {
  const task = await invoke<WorkspaceCloneTask>("git_clone_repository_cancel", { task_id: taskId });
  replaceTasks(tasks.map((candidate) => (candidate.id === task.id ? task : candidate)));
  schedulePoll();
}

export function dismissWorkspaceCloneTask(taskId: string) {
  dismissedTaskIds.add(taskId);
  replaceTasks(tasks.filter((task) => task.id !== taskId));
  // 服务端同步移除终态任务，否则重新挂载后快照会让卡片重现。
  void invoke<WorkspaceCloneTask[]>("git_clone_repository_dismiss", { task_id: taskId })
    .then((nextTasks) => {
      dismissedTaskIds.delete(taskId);
      replaceTasks(nextTasks);
    })
    .catch(() => {
      // 本地 dismissedTaskIds 已隐藏该卡片；服务端移除失败留待下次快照。
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return tasks;
}

export function useWorkspaceCloneTasks() {
  useEffect(() => {
    void refreshWorkspaceCloneTasks().catch(() => {
      // Clone task cards are supplementary UI; a later task mutation retries.
    });
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
