import type {
  MentionComposerHandle,
  MentionComposerSkill,
} from "@liveagent/ui/components/chat/MentionComposer";
import type {
  GitCommitContextPayload,
  GitFileContextPayload,
} from "@liveagent/ui/components/project-tools/git-review/index";
import type { CodeMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import { type MutableRefObject, useCallback, useMemo, useRef, useState } from "react";
import type { AppSettings } from "../settings";
import { updateSkills } from "../settings";
import { mergeAlwaysEnabledSkillNames } from "../skills";

export function resolveEnabledComposerSkills<TSkill extends MentionComposerSkill>(
  availableSkills: readonly TSkill[],
  selectedSkillNames: readonly string[],
  skillsEnabled: boolean,
) {
  if (!skillsEnabled || selectedSkillNames.length === 0 || availableSkills.length === 0) {
    return [];
  }
  const skillsByName = new Map(availableSkills.map((skill) => [skill.name, skill]));
  return selectedSkillNames
    .map((name) => skillsByName.get(name))
    .filter((skill): skill is TSkill => Boolean(skill));
}

export function findCodeReviewSkill<TSkill extends MentionComposerSkill & { builtIn?: boolean }>(
  availableSkills: readonly TSkill[],
) {
  return availableSkills.find(
    (skill) => skill.name === "liveagent-code-review" && skill.builtIn === true,
  );
}

export function useComposerSkillSelection<
  TSkill extends MentionComposerSkill & { builtIn?: boolean },
>(
  availableSkills: readonly TSkill[],
  selectedSkillNames: readonly string[],
  skillsEnabled: boolean,
) {
  const enabledComposerSkills = useMemo(
    () => resolveEnabledComposerSkills(availableSkills, selectedSkillNames, skillsEnabled),
    [availableSkills, selectedSkillNames, skillsEnabled],
  );
  const codeReviewSkill = useMemo(() => findCodeReviewSkill(availableSkills), [availableSkills]);
  return { enabledComposerSkills, codeReviewSkill };
}

export function appendManagedSkillSelections(current: readonly string[], names: readonly string[]) {
  const next = mergeAlwaysEnabledSkillNames(current);
  const seen = new Set(next);
  for (const rawName of names) {
    const name = String(rawName).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    next.push(name);
  }
  return next;
}

export function useInsertCodeReviewSkill<TSkill extends MentionComposerSkill>(params: {
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  codeReviewSkill: TSkill | undefined;
  setSettings: (updater: (previousSettings: AppSettings) => AppSettings) => void;
}) {
  const { composerRef, codeReviewSkill, setSettings } = params;
  return useCallback(() => {
    const composer = composerRef.current;
    if (!composer || !codeReviewSkill) return;
    setSettings((previousSettings) => {
      const selected = appendManagedSkillSelections(previousSettings.skills.selected, [
        codeReviewSkill.name,
      ]);
      if (selected.join("\n") === previousSettings.skills.selected.join("\n")) {
        return previousSettings;
      }
      return updateSkills(previousSettings, { selected });
    });
    const alreadyInserted = composer
      .getDraft()
      .skillMentions.some((skill) => skill.name === codeReviewSkill.name);
    if (!alreadyInserted) {
      composer.insertSkillMention(codeReviewSkill);
    }
    composer.focus();
  }, [codeReviewSkill, composerRef, setSettings]);
}

export function useComposerActions(composerRef: MutableRefObject<MentionComposerHandle | null>) {
  const [isSuggestionTyping, setIsSuggestionTyping] = useState(false);
  const suggestionTypingRef = useRef(false);
  const handleRightDockInsertFileMention = useCallback(
    (path: string, kind: "file" | "dir") => {
      composerRef.current?.insertFileMention(path, kind);
      composerRef.current?.focus();
    },
    [composerRef],
  );
  const handleRightDockInsertCommitMention = useCallback(
    (commit: GitCommitContextPayload) => {
      composerRef.current?.insertCommitMention(commit);
      composerRef.current?.focus();
    },
    [composerRef],
  );
  const handleRightDockInsertGitFileMention = useCallback(
    (file: GitFileContextPayload) => {
      composerRef.current?.insertGitFileMention(file);
      composerRef.current?.focus();
    },
    [composerRef],
  );
  const handleInsertCodeMention = useCallback(
    (reference: CodeMentionReference) => {
      composerRef.current?.insertCodeMention(reference);
      composerRef.current?.focus();
    },
    [composerRef],
  );
  const handleEmptyStateSuggestion = useCallback(
    (text: string) => {
      const composer = composerRef.current;
      if (!composer || suggestionTypingRef.current) return;
      suggestionTypingRef.current = true;
      setIsSuggestionTyping(true);
      void composer.typeText(text).finally(() => {
        suggestionTypingRef.current = false;
        setIsSuggestionTyping(false);
      });
    },
    [composerRef],
  );

  return {
    isSuggestionTyping,
    handleRightDockInsertFileMention,
    handleRightDockInsertCommitMention,
    handleRightDockInsertGitFileMention,
    handleInsertCodeMention,
    handleEmptyStateSuggestion,
  };
}
