/** Planning (calendar + tasks) messages. Backend error codes live under `planner.error.*`. */
export const PLANNING_TRANSLATIONS = {
  "zh-CN": {
    "planner.timezoneNotice.title": "日程时区需要检查",
    "planner.timezoneNotice.invalid": "日程或旧数据迁移中的时区无法识别，部分日程功能暂不可用。",
    "planner.timezoneNotice.unsupported":
      "当前客户端无法识别日程时区「{effective}」，显示的时间可能不准确。",
    "planner.timezoneNotice.mismatch":
      "设置的时区「{preference}」与日程实际使用的「{effective}」不一致。",
    "planner.timezoneNotice.device":
      "本机当前时区为「{device}」，日程仍按「{effective}」显示。系统时区的修改会在重启应用后生效。",
    "planner.timezoneNotice.preserved": "原设置与数据已保留，聊天不受影响。",
    "planner.timezoneNotice.settings": "查看时区设置",
    "planner.timezoneNotice.dismiss": "关闭提示",
    "planner.calendar.atStart": "开始时",
    "planner.calendar.dayBefore": "提前 1 天",
    "planner.calendar.manageHint": "用日历区分工作与生活，设置颜色、默认日历和活动的默认通知。",
    "planner.calendar.minutesBefore": "提前 {count} 分钟",
    "planner.calendar.noReminder": "不提醒",
    "planner.cron.every.second": "每秒",
    "planner.display.weekNumbers": "显示 ISO 周数",
    "planner.display.weekStart": "一周的第一天",
    "planner.notificationTitle": "LiveAgent · 日程提醒",
    "planner.settings.showInSidebar": "在侧栏显示日程",
    "planner.settings.showInSidebarHint":
      "与「侧栏快捷入口」中的日程开关同步；隐藏入口不会停用提醒或数据。",
    "planner.settings.workHours": "工作时段",
    "planner.subscription.hint":
      "用 iCal 链接订阅 Google、Outlook、Apple 等日历，只读并按间隔自动更新。",
    "planner.subscription.title": "订阅日历",
  },
  "en-US": {
    "planner.timezoneNotice.title": "Check the calendar time zone",
    "planner.timezoneNotice.invalid":
      "A calendar or legacy migration time zone is not recognized. Some calendar features are unavailable.",
    "planner.timezoneNotice.unsupported":
      "This client does not recognize the calendar time zone “{effective}”. Displayed times may be inaccurate.",
    "planner.timezoneNotice.mismatch":
      "The selected time zone “{preference}” differs from the calendar’s effective time zone “{effective}”.",
    "planner.timezoneNotice.device":
      "This device is now on “{device}”, but the calendar still shows “{effective}”. System time zone changes apply after you restart the app.",
    "planner.timezoneNotice.preserved": "Your settings and data are preserved. Chat is unaffected.",
    "planner.timezoneNotice.settings": "Time zone settings",
    "planner.timezoneNotice.dismiss": "Dismiss",
    "planner.calendar.atStart": "At start",
    "planner.calendar.dayBefore": "1 day before",
    "planner.calendar.manageHint":
      "Separate work and life with calendars: set colors, the default calendar and default event notifications.",
    "planner.calendar.minutesBefore": "{count} minutes before",
    "planner.calendar.noReminder": "No reminder",
    "planner.cron.every.second": "Every second",
    "planner.display.weekNumbers": "Show ISO week numbers",
    "planner.display.weekStart": "First day of the week",
    "planner.notificationTitle": "LiveAgent · Calendar reminder",
    "planner.settings.showInSidebar": "Show Calendar in sidebar",
    "planner.settings.showInSidebarHint":
      "Same as the Calendar switch in Sidebar shortcuts; hiding it doesn’t turn off reminders or data.",
    "planner.settings.workHours": "Working hours",
    "planner.subscription.hint":
      "Subscribe to Google, Outlook, Apple and other calendars with an iCal link — read-only and refreshed automatically.",
    "planner.subscription.title": "Subscribed calendars",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
