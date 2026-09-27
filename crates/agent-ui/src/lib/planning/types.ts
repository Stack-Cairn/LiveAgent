export type EventTime =
  | { kind: "timed"; startAt: number; endAt: number; timeZone: string }
  | { kind: "allDay"; startDate: string; endDateExclusive: string; timeZone: string };
export interface PlanningCalendar {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  isDefault: boolean;
  reminderMinutes: number | null;
  sourceKind: string;
  readOnly: boolean;
  externalId?: string | null;
  revision: number;
}
export interface PlanningCategory {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  revision: number;
}
export interface Todo {
  sortOrder?: number;
  parentId?: string | null;
  deletedAt?: number | null;
  groupId?: string | null;
  tagIds?: string[];
  priority?: "low" | "medium" | "high";
  reminderMinutes?: number;
  id: string;
  title: string;
  notes: string;
  status: "open" | "completed";
  estimateMinutes?: number | null;
  dueAt?: number | null;
  dueDate?: string | null;
  dueTimeZone?: string | null;
  dueReminder: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}
export interface Recurrence {
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  weekdays: number[];
  count?: number | null;
  until?: string | null;
  excludedDates: string[];
}
export interface PlanningEvent {
  deletedAt?: number | null;
  tagIds?: string[];
  id: string;
  calendarId: string;
  todoId?: string | null;
  title: string;
  titleOverride?: string | null;
  notes: string;
  time: EventTime;
  recurrence?: Recurrence | null;
  seriesId?: string | null;
  originalDate?: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface PlanningReminder {
  id: string;
  targetType: "todo" | "event";
  targetId: string;
  title: string;
  origin: "todo_due" | "event_start" | "manual";
  triggerAt: number;
  snoozedUntil?: number | null;
  status: "pending" | "acknowledged" | "completed";
  notifiedAt?: number | null;
  leaseUntil?: number | null;
  attempts: number;
  nextAttemptAt: number;
  revision: number;
}
export interface PlanningSourceLink {
  id: string;
  targetType: "todo" | "event";
  targetId: string;
  providerKind: string;
  accountId?: string | null;
  externalId: string;
  title: string;
  revision: number;
}
/** iCal subscription status; the feed URL stays in the desktop backend. */
export interface PlanningSubscription {
  calendarId: string;
  host: string;
  refreshMinutes: number;
  nextAt: number;
  lastSyncedAt?: number | null;
  lastError?: string | null;
}
export interface PlanningSnapshot {
  seq: number;
  timeZone: string;
  calendars: PlanningCalendar[];
  todos: Todo[];
  groups?: PlanningCategory[];
  tags?: PlanningCategory[];
  events: PlanningEvent[];
  eventMasters?: PlanningEvent[];
  todoSchedules?: { todoId: string; count: number; minutes: number; hasFuture: boolean }[];
  reminders: PlanningReminder[];
  sources: PlanningSourceLink[];
  subscriptions?: PlanningSubscription[];
}
export interface PlanningQuery {
  from?: number;
  to?: number;
}
export type PlanningAction =
  | `group.${"create" | "update" | "delete"}`
  | `tag.${"create" | "update" | "delete"}`
  | "timezone.set"
  | "calendar.create"
  | "calendar.update"
  | "calendar.delete"
  | "calendar.import"
  | "todo.create"
  | "todo.import"
  | "todo.update"
  | "todo.delete"
  | "todo.restore"
  | "todo.purge"
  | "todo.move"
  | "todo.schedule"
  | "event.create"
  | "event.update"
  | "event.delete"
  | "event.restore"
  | "event.purge"
  | "event.exception"
  | "event.restoreException"
  | "reminder.create"
  | "reminder.acknowledge"
  | "reminder.snooze"
  | "reminder.delete"
  | "source.create";
export interface PlanningMutation {
  requestId: string;
  action: PlanningAction;
  id?: string;
  expectedRevision?: number;
  data: Record<string, unknown>;
}
export interface PlanningMutationResult<T = unknown> {
  status: "ok" | "conflict";
  seq: number;
  item: T | null;
  replayed: boolean;
  message: string | null;
}
export interface PlanningBackend {
  scope(): string;
  call<T>(action: string, input?: unknown): Promise<T>;
  subscribe(listener: (seq?: number) => void): () => void;
}
