import type { PlanningBackend, PlanningEvent, PlanningSnapshot, Todo } from "@liveagent/ui/lib/planning/types";
const zone = "Asia/Shanghai", now = Date.now(), base = { revision: 1, createdAt: now, updatedAt: now };
const monday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; })();
const at = (day: number, h: number, m = 0) => { const d = new Date(monday); d.setDate(d.getDate() + day); d.setHours(h, m, 0, 0); return d.getTime(); };
const ymd = (day: number) => { const d = new Date(monday); d.setDate(d.getDate() + day); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
let n = 0;
const todo = (title: string, x: Partial<Todo> = {}): Todo => ({ ...base, id: `t${++n}`, title, notes: "", status: "open", dueReminder: false, groupId: "g-work", sortOrder: n, ...x });
const ev = (cal: string, title: string, day: number, sh: number, sm: number, eh: number, em: number, x: Partial<PlanningEvent> = {}): PlanningEvent =>
  ({ ...base, id: `e${++n}`, calendarId: cal, title, notes: "", time: { kind: "timed", startAt: at(day, sh, sm), endAt: at(day, eh, em), timeZone: zone }, ...x });
const todos: Todo[] = [
  todo("【重要】Q4 产品路线图评审材料", { priority: "high", dueAt: at(0, 12), dueTimeZone: zone }),
  todo("输出根因与改进措施清单", { dueAt: at(0, 15), dueTimeZone: zone }),
  todo("梳理续约条款差异", { dueAt: at(1, 12), dueTimeZone: zone }),
  todo("法务复核合同条款", { dueAt: at(2, 12), dueTimeZone: zone, parentId: "t1" }),
  todo("技术分享 PPT 定稿", { dueAt: at(2, 14), dueTimeZone: zone }),
  todo("对齐设计 / 研发排期", { dueAt: at(4, 12), dueTimeZone: zone }),
  todo("提交部门周报", { dueAt: at(4, 16), dueTimeZone: zone }), todo("OKR 打分提交", { dueAt: at(3, 11), dueTimeZone: zone }),
  todo("提交 9 月差旅报销", { dueAt: at(5, 12), dueTimeZone: zone, groupId: "" }),
  todo("预约牙医检查", { dueDate: ymd(5), dueTimeZone: zone, groupId: "g-life" }),
  todo("给父母打电话", { dueDate: ymd(6), dueTimeZone: zone, groupId: "g-life" }),
  todo("产出 9 月数据报表"),
  todo("整理故障时间线与影响面", { status: "completed", completedAt: now }),
];
const id = (title: string) => todos.find((t) => t.title === title)!.id;
const events: PlanningEvent[] = [
  ev("work", "项目例会", 0, 8, 30, 9, 30), ev("work", "团队站会", 1, 9, 30, 9, 45), ev("work", "团队站会", 2, 9, 30, 9, 45),
  ev("work", "【重要】Q4 产品路线图评审材料", 0, 10, 0, 11, 30, { todoId: id("【重要】Q4 产品路线图评审材料") }),
  ev("work", "产品设计评审会", 0, 14, 0, 15, 0), ev("work", "客户 A 续签沟通会", 1, 10, 0, 11, 30),
  ev("work", "面试：后端工程师候选人", 1, 14, 0, 15, 0), ev("work", "产出 9 月数据报表", 2, 10, 0, 12, 0, { todoId: id("产出 9 月数据报表") }),
  ev("work", "技术分享 PPT 定稿", 2, 14, 0, 15, 30, { todoId: id("技术分享 PPT 定稿") }), ev("work", "与法务对齐合同条款", 2, 16, 0, 17, 0),
  ev("goog", "季度 OKR 复盘（Google 订阅）", 3, 10, 0, 11, 30), ev("work", "架构方案讨论", 3, 10, 30, 12, 30), ev("work", "面试：前端候选人", 1, 14, 30, 16, 0), ev("life", "阅读：Q4 技术趋势扫描", 4, 11, 0, 12, 0),
  ev("life", "晨跑 + 拉伸", 5, 9, 0, 10, 0), ev("life", "陪家人采购", 5, 14, 0, 16, 0), ev("work", "下周计划梳理", 6, 15, 0, 16, 0),
  { ...base, id: "hol", calendarId: "hol", title: "国庆节", notes: "", time: { kind: "allDay", startDate: ymd(3), endDateExclusive: ymd(5), timeZone: zone } },
];
const snap: PlanningSnapshot = { seq: 1, timeZone: zone,
  calendars: [
    { ...base, id: "work", name: "工作", color: "#2563EB", sortOrder: 0, isDefault: true, reminderMinutes: 10, sourceKind: "local", readOnly: false },
    { ...base, id: "life", name: "个人", color: "#0F766E", sortOrder: 1, isDefault: false, reminderMinutes: null, sourceKind: "local", readOnly: false },
    { ...base, id: "goog", name: "Google 工作日历", color: "#DB2777", sortOrder: 2, isDefault: false, reminderMinutes: null, sourceKind: "subscription", readOnly: true },
    { ...base, id: "hol", name: "中国节假日", color: "#16A34A", sortOrder: 3, isDefault: false, reminderMinutes: null, sourceKind: "subscription", readOnly: true }],
  groups: [{ ...base, id: "g-work", name: "工作", color: "#7C3AED", sortOrder: 1 }, { ...base, id: "g-life", name: "生活", color: "#D97706", sortOrder: 2 }],
  tags: [], todos, events, reminders: [], sources: [],
  subscriptions: [{ calendarId: "goog", host: "calendar.google.com", refreshMinutes: 60, nextAt: now + 3e6, lastSyncedAt: now - 6e5, lastError: null },
    { calendarId: "hol", host: "calendars.icloud.com", refreshMinutes: 1440, nextAt: now + 3e6, lastSyncedAt: now - 36e5, lastError: null }] };
const master: PlanningEvent = ev("work", "周例会（重复）", 0, 16, 0, 17, 0, { id: "rec", recurrence: { frequency: "weekly", interval: 1, weekdays: [0, 3], count: 12, until: null, excludedDates: [] } });
snap.eventMasters = [...snap.events, master];
snap.events = [...snap.events, ...[0, 3].map((d) => ({ ...master, id: `rec@${ymd(d)}`, seriesId: "rec", originalDate: ymd(d), time: { kind: "timed" as const, startAt: at(d, 16), endAt: at(d, 17), timeZone: zone } }))];
export const backend: PlanningBackend = { scope: () => "h", async call<T>(a: string) {
  return (a === "query" ? structuredClone(snap) : { status: "ok", seq: 1, item: null, replayed: false, message: null }) as T; }, subscribe: () => () => {} };
