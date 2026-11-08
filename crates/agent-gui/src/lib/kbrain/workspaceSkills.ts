import type { AppSettings, WorkspaceResourceSettingsMode } from "../settings";
import { getConfiguredKBrainConnection } from "./runtimeConnection";
import { fetchKBrain } from "./transport";

/** One project's skills override for PUT /v1/skills/settings; "inherit" clears it. */
export type WorkspaceSkillsOverride = {
  workdir: string;
  mode: WorkspaceResourceSettingsMode;
  skillNames: string[];
};

function override(settings: AppSettings, workdir: string): WorkspaceSkillsOverride {
  const entry = settings.system.workspaceResourceSettings[workdir];
  const mode = entry?.mode ?? "inherit";
  return { workdir, mode, skillNames: mode === "custom" ? [...(entry?.skillNames ?? [])] : [] };
}

/** Projects whose skills mode or custom skill list changed between two settings. */
export function changedWorkspaceSkillsOverrides(
  prev: AppSettings,
  next: AppSettings,
): WorkspaceSkillsOverride[] {
  const paths = new Set([
    ...Object.keys(prev.system.workspaceResourceSettings),
    ...Object.keys(next.system.workspaceResourceSettings),
  ]);
  const out: WorkspaceSkillsOverride[] = [];
  for (const workdir of paths) {
    const before = override(prev, workdir);
    const after = override(next, workdir);
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push(after);
  }
  return out;
}

/** Every project that overrides skills (mode custom or off). */
export function workspaceSkillsOverrides(settings: AppSettings): WorkspaceSkillsOverride[] {
  return Object.keys(settings.system.workspaceResourceSettings)
    .map((workdir) => override(settings, workdir))
    .filter((entry) => entry.mode !== "inherit");
}

type PutSkillsSettings = (body: Record<string, unknown>) => Promise<Response>;

const defaultPut: PutSkillsSettings = (body) =>
  fetchKBrain("/v1/skills/settings", { method: "PUT", body: JSON.stringify(body) });

/**
 * Saves project skills overrides to K-brain, which applies them to runs in that
 * workdir. A project folder that no longer exists is refused by K-brain (422)
 * and skipped: there is nothing left to apply it to. Other failures are thrown
 * after every project was tried.
 */
export async function saveWorkspaceSkillsOverrides(
  overrides: readonly WorkspaceSkillsOverride[],
  skills: AppSettings["skills"],
  put: PutSkillsSettings = defaultPut,
): Promise<void> {
  let failure: unknown;
  for (const entry of overrides) {
    try {
      const response = await put({
        workdir: entry.workdir,
        enabled: skills.enabled,
        selected: skills.selected,
        mode: entry.mode,
        skillNames: entry.skillNames,
      });
      if (response.ok) continue;
      const text = await response.text();
      if (response.status === 422 && entry.mode === "inherit") continue;
      if (
        response.status === 422 &&
        /no such file|cannot find the (?:file|path)|must be a directory/i.test(text)
      ) {
        console.warn(`[skills] skipped project skills for missing folder ${entry.workdir}`);
        continue;
      }
      throw new Error(text || `K-brain skills settings failed (${response.status})`);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

const SYNCED_KEY = "liveagent.kbrain-workspace-skills-synced.v1";

/**
 * Project skills overrides saved by older LiveAgent builds never reached
 * K-brain. Sends them once per K-brain data root; later edits are saved as
 * they happen.
 */
export async function syncWorkspaceSkillsOverridesOnce(
  settings: AppSettings,
  put: PutSkillsSettings = defaultPut,
): Promise<void> {
  const connection = getConfiguredKBrainConnection();
  const key = `${SYNCED_KEY}:${connection?.storageId ?? connection?.baseUrl ?? "default"}`;
  try {
    if (localStorage.getItem(key) === "1") return;
  } catch {
    return;
  }
  await saveWorkspaceSkillsOverrides(workspaceSkillsOverrides(settings), settings.skills, put);
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Re-sending the same overrides is harmless.
  }
}
