import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { localizePlanningError } from "@liveagent/ui/lib/planning/i18n";
import { taskDescendants } from "@liveagent/ui/lib/planning/taskLists";
import { zonedParts } from "@liveagent/ui/lib/planning/time";
import type { PlanningMutationResult, PlanningSnapshot } from "@liveagent/ui/lib/planning/types";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

const queryTool: Tool = {
  name: "PlanningQuery",
  description:
    "Read the user's persistent Planning calendars, Todos, time blocks and reminders. These are separate from the run-local Task tools. Returns task lists (groups) as well. Deleted records are hidden unless includeTrash is true. Filter Todos by groupId/status/search, or events by eventId. starred:true returns starred Todos (the UI star is priority=high); overdue:true returns open Todos whose deadline has passed (the calendar pending-tasks rollup). Query by todoId to obtain the latest Todo and its blocks; includeDescendants:true includes the entire subtree. parentId filters immediate children (null means root); calendarId filters a calendar. Todos expose parentId and sortOrder for hierarchy and sibling ordering. Empty groupId selects My Tasks; once the user deleted My Tasks, snapshot.defaultGroupId names the list that replaces it. Optional from/to are epoch milliseconds (1–366 days) and expand recurring occurrences. Without a range, events are recurrence masters. Never infer completion from a scheduled block or an Agent run finishing.",
  parameters: Type.Object({
    todoId: Type.Optional(Type.String()),
    eventId: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
    parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    includeDescendants: Type.Optional(Type.Boolean()),
    calendarId: Type.Optional(Type.String()),
    status: Type.Optional(Type.String({ enum: ["open", "completed"] })),
    starred: Type.Optional(Type.Boolean()),
    overdue: Type.Optional(Type.Boolean()),
    search: Type.Optional(Type.String()),
    includeTrash: Type.Optional(Type.Boolean()),
    from: Type.Optional(Type.Number()),
    to: Type.Optional(Type.Number()),
  }),
};
const mutationActions = [
  "calendar.create",
  "calendar.update",
  "calendar.delete",
  "calendar.import",
  "group.create",
  "group.update",
  "group.delete",
  "todo.create",
  "todo.update",
  "todo.move",
  "todo.delete",
  "todo.restore",
  "todo.purge",
  "todo.schedule",
  "event.create",
  "event.update",
  "event.delete",
  "event.restore",
  "event.purge",
  "event.exception",
  "event.split",
  "event.restoreException",
  "reminder.create",
  "reminder.snooze",
  "reminder.acknowledge",
  "reminder.delete",
] as const;
const mutateTool: Tool = {
  name: "PlanningMutate",
  description: `Modify persistent Planning data in one transaction. Read first; all updates/deletes/schedule require id and the exact expectedRevision from PlanningQuery. On conflict reread and reconcile with the user; never blindly overwrite. requestId is required, stable across retries, unique for changed parameters.
Actions and data:
group.create/update {name,color?,sortOrder?}; group.delete {} moves its Todos to the default list (My Tasks, or defaultGroupId) without deleting them; deleting the defaultGroupId list restores My Tasks. A Todo without groupId lands in the default list. List names must be unique. Use returned IDs as groupId.
calendar.create {name,color}; calendar.update {name?,color?,isDefault?,reminderMinutes?}; calendar.delete {moveTo} migrates all blocks. calendar.import on a target calendar id/revision accepts {entries:[{uid,title,notes?,time}]} (1–200), deduplicated by UID. snapshot.timeZone is the app-wide default time zone (Settings → General); it cannot be changed from this tool. event.restoreException {date,exceptionId?,exceptionRevision?} uses the master id/revision to restore an occurrence.
todo.create/update {title?,notes?,estimateMinutes?,status?:open|completed,dueAt?,dueDate?,dueTimeZone?,dueReminder?,reminderMinutes?:0..10080,groupId?,parentId?,priority?:low|medium|high}; reminderMinutes is the advance offset before the deadline; dueAt/dueDate are mutually exclusive (set the other to null when changing kind); a date-only deadline is midnight in dueTimeZone. Null clears groupId/parentId/deadline. parentId supports recursive subtasks with the same fields and operations as root tasks, inherits the parent list and rejects cycles; moving a parent to another list also moves its entire subtree, while moving a child alone to a different list detaches it. Recycling a parent promotes its children without deleting them. todo.delete {} moves the task and linked blocks to the recycle bin; todo.restore {} restores them; todo.purge {} permanently removes a trashed task and its blocks, only on explicit user request. todo.create also accepts optional schedule:{calendarId,time} to create a task and its block atomically. todo.move {parentId?,groupId?,beforeId?,afterId?,relativeRevision?} reorders or reparents the full subtree atomically. Null parentId means root; omitted keeps current parent. beforeId/afterId (exclusive) must be a sibling in the destination, and require its exact relativeRevision; with neither, append. Read sortOrder for persistent sibling order. todo.schedule {calendarId,time,title?,notes?} creates an additional block, never completes the Todo.
event.create {calendarId,title,time,notes?,todoId?,recurrence?,reminderMinutes?}; event.update {time?,title?,titleOverride?,notes?,calendarId?,recurrence?,reminderMinutes?}; reminderMinutes is the notification offset before the start (0..10080), -1 disables it, null follows the calendar default; linked task title/notes are shared across the Todo and every block, never independent overrides; event.delete {} moves a block or full series to the recycle bin; event.restore {} restores it; event.purge {} permanently removes a trashed block or series, only on explicit user request. event.exception uses the master id and revision with {date,time,title?,notes?} or {date,delete:true} for a single occurrence. event.split uses the master id and revision with {date,delete:true} to end the series before date, or {date,title?,notes?,calendarId?,time?,recurrence?,reminderMinutes?} to start a new series from date with those changes ("this and following"); date must be an occurrence after the first.
Time is {kind:timed,startAt,endAt,timeZone} with epoch milliseconds and IANA zone, minimum 15 min; or {kind:allDay,startDate,endDateExclusive,timeZone} with YYYY-MM-DD and exclusive end. Recurrence is {frequency:daily|weekly|monthly|yearly,interval,weekdays:[0=Monday..6],count?,until?,excludedDates:[]}.
reminder.create {targetType:todo|event,targetId,triggerAt} adds an independent time reminder, including before a Todo deadline; reminder.snooze {minutes}; reminder.acknowledge/delete {}.
Only mark a Todo completed when its objective is actually achieved. External source calendars can be read-only.`,
  parameters: Type.Object({
    requestId: Type.String({ minLength: 8, maxLength: 128 }),
    action: Type.Union(mutationActions.map((action) => Type.Literal(action))),
    id: Type.Optional(Type.String()),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    data: Type.Record(Type.String(), Type.Any()),
  }),
};
export function createPlanningTools(): BuiltinToolBundle {
  const executeToolCall = async (
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> => {
    let text: string;
    let isError = false;
    try {
      if (signal?.aborted) throw new Error("Cancelled");
      const args = call.arguments as Record<string, unknown>;
      if (call.name === "PlanningQuery") {
        const snapshot = await invoke<PlanningSnapshot>("planning_query", {
          query: { from: args.from, to: args.to },
        });
        const now = Date.now();
        const today = zonedParts(now, snapshot.timeZone).date;
        const filtered =
          args.starred === true ||
          args.overdue === true ||
          Object.hasOwn(args, "parentId") ||
          ["todoId", "groupId", "status", "search"].some((key) => typeof args[key] === "string");
        const subtree =
          typeof args.todoId === "string" && args.includeDescendants === true
            ? taskDescendants(snapshot.todos, args.todoId)
            : null;
        const deletedTodos = new Set(snapshot.todos.filter((t) => t.deletedAt).map((t) => t.id));
        const deletedEvents = new Set(
          (snapshot.eventMasters ?? snapshot.events).filter((e) => e.deletedAt).map((e) => e.id),
        );
        snapshot.todos = snapshot.todos.filter(
          (t) =>
            (args.includeTrash === true || !t.deletedAt) &&
            (typeof args.todoId !== "string" ||
              (subtree ? subtree.has(t.id) : t.id === args.todoId)) &&
            (!Object.hasOwn(args, "parentId") || (t.parentId ?? null) === args.parentId) &&
            (typeof args.groupId !== "string" || (t.groupId ?? "") === args.groupId) &&
            (typeof args.status !== "string" || t.status === args.status) &&
            (args.starred !== true || t.priority === "high") &&
            (args.overdue !== true ||
              (t.status === "open" &&
                ((t.dueAt != null && t.dueAt < now) ||
                  (t.dueDate != null && t.dueDate < today)))) &&
            (typeof args.search !== "string" ||
              `${t.title} ${t.notes}`.toLowerCase().includes(args.search.toLowerCase())),
        );
        const todoIds = new Set(snapshot.todos.map((t) => t.id));
        snapshot.events = snapshot.events.filter(
          (e) =>
            (args.includeTrash === true ||
              (!e.deletedAt &&
                !deletedTodos.has(e.todoId ?? "") &&
                !deletedEvents.has(e.seriesId ?? ""))) &&
            (typeof args.calendarId !== "string" || e.calendarId === args.calendarId) &&
            (!filtered || (e.todoId && todoIds.has(e.todoId))) &&
            (typeof args.eventId !== "string" ||
              e.id === args.eventId ||
              e.seriesId === args.eventId),
        );
        if (filtered || typeof args.calendarId === "string" || typeof args.eventId === "string") {
          const eventIds = new Set(
            snapshot.events.flatMap((e) => [e.id, e.seriesId].filter(Boolean)),
          );
          snapshot.reminders = snapshot.reminders.filter((r) =>
            r.targetType === "todo" ? todoIds.has(r.targetId) : eventIds.has(r.targetId),
          );
          snapshot.sources = snapshot.sources.filter((r) =>
            r.targetType === "todo" ? todoIds.has(r.targetId) : eventIds.has(r.targetId),
          );
          snapshot.todoSchedules = snapshot.todoSchedules?.filter((s) => todoIds.has(s.todoId));
          delete snapshot.eventMasters;
        }
        delete snapshot.eventMasters;
        // Tags are not part of the calendar the user sees, so the Agent neither reads nor sets them.
        delete snapshot.tags;
        for (const item of [...snapshot.todos, ...snapshot.events]) delete item.tagIds;
        text = JSON.stringify(snapshot);
      } else if (call.name === "PlanningMutate") {
        if (
          typeof args.action !== "string" ||
          !mutationActions.some((action) => action === args.action)
        )
          throw new Error("Unsupported Planning action");
        if (
          typeof args.data === "object" &&
          args.data !== null &&
          Object.hasOwn(args.data, "tagIds")
        )
          throw new Error("Planning tags are not supported");
        const response = await invoke<PlanningMutationResult>("planning_mutate", { input: args });
        isError = response.status === "conflict";
        // Backend messages are locale-neutral codes; the model reads them in English.
        text = JSON.stringify({
          ...response,
          message: response.message ? localizePlanningError(response.message, "en-US") : null,
        });
      } else throw new Error(`Unknown tool: ${call.name}`);
    } catch (error) {
      isError = true;
      text = localizePlanningError(error, "en-US");
    }
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text }],
      details: {},
      isError,
      timestamp: Date.now(),
    };
  };
  return {
    groupId: "system",
    tools: [queryTool, mutateTool],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "PlanningQuery",
        { groupId: "system", kind: "planning", isReadOnly: true, displayCategory: "system" },
      ],
      [
        "PlanningMutate",
        { groupId: "system", kind: "planning", isReadOnly: false, displayCategory: "system" },
      ],
    ]),
  };
}
