import type { MentionComposerSkill } from "@liveagent/ui/components/chat/MentionComposerModel";
import { subscribeSkillsDiscoveryUpdated } from "@liveagent/ui/lib/skills/index";
import { useEffect, useState } from "react";
import { kbrainSkillsAdapter } from "../../../agent-ui-adapters/kbrainSkills";

/**
 * K-brain 后端模式下输入框可选的技能。技能的安装与启用由 K-brain 管理，前端的
 * 本地技能发现在该模式下关闭，所以这里按工作目录从 K-brain 读取已启用的技能，
 * 供“/”弹层的“技能”分类使用。读取失败时返回空列表，指令不受影响。
 */
export function useKBrainComposerSkills(
  enabled: boolean,
  workdir: string | undefined,
): MentionComposerSkill[] {
  const [skills, setSkills] = useState<MentionComposerSkill[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    return subscribeSkillsDiscoveryUpdated(() => setRevision((value) => value + 1));
  }, [enabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 用于在技能发现变更后重新读取后端列表。
  useEffect(() => {
    if (!enabled) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    void kbrainSkillsAdapter
      .list(workdir?.trim() || undefined)
      .then((result) => {
        if (cancelled) return;
        if (!result.settings.enabled) {
          setSkills([]);
          return;
        }
        const selected = new Set(result.settings.selected);
        setSkills(
          (result.skills ?? [])
            .filter((skill) => selected.has(skill.name))
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
              skillFile: skill.skillFile,
              baseDir: skill.baseDir,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
    // revision 触发技能增删后的重新读取。
  }, [enabled, workdir, revision]);
  return skills;
}
