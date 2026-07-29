import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export type TaskCompletionNotificationState = "completed" | "failed";

export async function sendTaskCompletionNotification(params: {
  state: TaskCompletionNotificationState;
  title: string;
  completedBody: string;
  failedBody: string;
}) {
  if (await getCurrentWindow().isFocused()) return;

  let permissionGranted = await isPermissionGranted();
  if (!permissionGranted) {
    permissionGranted = (await requestPermission()) === "granted";
  }
  if (!permissionGranted) return;

  sendNotification({
    title: params.title,
    body: params.state === "completed" ? params.completedBody : params.failedBody,
  });
}
