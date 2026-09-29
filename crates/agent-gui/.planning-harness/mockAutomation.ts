const monday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; })();
const at = (day: number, h: number, m = 0) => { const d = new Date(monday); d.setDate(d.getDate() + day); d.setHours(h, m, 0, 0); return d.getTime(); };
const ymd = (day: number) => { const d = new Date(monday); d.setDate(d.getDate() + day); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const now = Date.now();
const run = (id: string, taskId: string, start: number, success: boolean) => ({ id, taskId, startedAt: start, finishedAt: start + 42_000, state: "done", success, durationMs: 42_000, exitCode: success ? 0 : 1, outputPreview: success ? "synced 128 rows" : "connection refused" });
const tasks = [
  { id: "sync", name: "每日数据同步", cron: "0 0 9 * * *", kind: "bash", lastRun: run("r0", "sync", at(0, 9), true) },
  { id: "report", name: "周报汇总", cron: "0 30 17 * * FRI", kind: "prompt" },
  { id: "health", name: "服务健康检查", cron: "0 */5 * * * *", kind: "http" },
];
const occurrences: { taskId: string; at: number }[] = [];
const runs: ReturnType<typeof run>[] = [];
for (let d = 0; d < 7; d++) { const t = at(d, 9); if (t > now) occurrences.push({ taskId: "sync", at: t }); else runs.push(run(`s${d}`, "sync", t, d !== 1)); }
if (at(4, 17, 30) > now) occurrences.push({ taskId: "report", at: at(4, 17, 30) });
const summaries = Array.from({ length: 7 }, (_, d) => ({ taskId: "health", date: ymd(d), planned: at(d, 0) > now ? 288 : 0, plannedTruncated: false, ran: at(d, 0) > now ? 0 : 288, failed: d === 0 ? 3 : 0, firstAt: at(d, 0), lastAt: at(d, 23, 55) }));
export const backend = {
  async fetchSnapshot() { return { cron: { revision: 1, tasks: [] }, hooks: { revision: 1, hooks: [] } }; },
  async cronOccurrences() { return { timeZone: "Asia/Shanghai", now, tasks, occurrences, runs, summaries }; },
  subscribe() { return () => {}; },
};
