import type { SkillSummary } from "@liveagent/ui/lib/skills/index";
import { skillEnvRequirementsSignature } from "@liveagent/ui/lib/skills/skillEnv";

export type SkillScanSummary = {
  total: number;
  added: number;
  updated: number;
  removed: number;
};

export function buildSkillEntrySignature(skill: SkillSummary) {
  return [
    skill.name,
    skill.baseDir,
    skill.skillFile,
    skill.description,
    skill.builtIn ? "1" : "0",
    skill.inlineContent?.length ?? -1,
    skill.source?.registry ?? "",
    skill.source?.slug ?? "",
    skill.installedAt ?? "",
    skill.source?.version ?? "",
    skillEnvRequirementsSignature(skill.envRequirements),
  ].join("\0");
}

export function buildSkillDiscoverySignature(rootDir: string, skills: SkillSummary[]) {
  return [rootDir, ...skills.map(buildSkillEntrySignature).sort()].join("\n");
}

export function summarizeSkillScan(
  previous: SkillSummary[],
  next: SkillSummary[],
): SkillScanSummary {
  const previousByName = new Map(
    previous.map((skill) => [skill.name, buildSkillEntrySignature(skill)]),
  );
  const nextByName = new Map(next.map((skill) => [skill.name, buildSkillEntrySignature(skill)]));
  let added = 0;
  let updated = 0;

  for (const [name, signature] of nextByName) {
    const previousSignature = previousByName.get(name);
    if (previousSignature === undefined) added += 1;
    else if (previousSignature !== signature) updated += 1;
  }

  let removed = 0;
  for (const name of previousByName.keys()) {
    if (!nextByName.has(name)) removed += 1;
  }

  return { total: next.length, added, updated, removed };
}
