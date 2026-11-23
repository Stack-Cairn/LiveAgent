/** The notification toasts' landmark region. */
export const TOAST_TRANSLATIONS = {
  "zh-CN": {
    "toast.regionLabel": "通知",
  },
  "en-US": {
    "toast.regionLabel": "Notifications",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
