import {
  type AppSettings,
  getRightDockFileTreeState,
  openRightDockSingletonTab,
  updateRightDockFileTreeState,
} from "@liveagent/app/lib/settings";
import type { ChangedFilesActions } from "@liveagent/ui/components/chat/ChangedFilesCard";
import type { GitReviewFocusRequest } from "@liveagent/ui/components/project-tools/RightDockContext";
import { expandedPathsForFileTreePath } from "@liveagent/ui/components/project-tools/rightDockModel";
import { useCallback, useMemo, useRef, useState } from "react";

type UseChangedFilesActionsParams = {
  terminalProjectPathKey: string;
  setRightDockOpen: (open: boolean) => void;
  setSettings: (updater: (previousSettings: AppSettings) => AppSettings) => void;
  onOpenFile: (path: string) => void;
};

export function useChangedFilesActions(params: UseChangedFilesActionsParams) {
  const { terminalProjectPathKey, setRightDockOpen, setSettings, onOpenFile } = params;
  const gitReviewFocusNonceRef = useRef(0);
  const [gitReviewFocusRequest, setGitReviewFocusRequest] = useState<GitReviewFocusRequest | null>(
    null,
  );
  const handleGitReviewFocusRequestHandled = useCallback((nonce: number) => {
    setGitReviewFocusRequest((current) => (current && current.nonce === nonce ? null : current));
  }, []);
  const handleChangedFileOpenDiff = useCallback(
    (path: string | null) => {
      if (!terminalProjectPathKey) return;
      setRightDockOpen(true);
      setSettings((previousSettings) =>
        openRightDockSingletonTab(previousSettings, terminalProjectPathKey, "gitReview"),
      );
      gitReviewFocusNonceRef.current += 1;
      setGitReviewFocusRequest({
        path: (path ?? "").trim(),
        nonce: gitReviewFocusNonceRef.current,
      });
    },
    [setRightDockOpen, setSettings, terminalProjectPathKey],
  );
  const handleChangedFileReveal = useCallback(
    (path: string) => {
      if (!terminalProjectPathKey) return;
      const selectedPath = path
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!selectedPath) return;
      setRightDockOpen(true);
      setSettings((previousSettings) => {
        const opened = openRightDockSingletonTab(
          previousSettings,
          terminalProjectPathKey,
          "fileTree",
        );
        const current = getRightDockFileTreeState(opened.customSettings, terminalProjectPathKey);
        return updateRightDockFileTreeState(opened, terminalProjectPathKey, {
          query: "",
          selectedPath,
          expandedPaths: Array.from(
            new Set([...current.expandedPaths, ...expandedPathsForFileTreePath(selectedPath)]),
          ),
          bumpRevision: true,
        });
      });
    },
    [setRightDockOpen, setSettings, terminalProjectPathKey],
  );
  const changedFilesActions = useMemo<ChangedFilesActions>(
    () => ({
      onOpenFile,
      onRevealInFileTree: handleChangedFileReveal,
      onOpenDiff: handleChangedFileOpenDiff,
    }),
    [handleChangedFileOpenDiff, handleChangedFileReveal, onOpenFile],
  );

  return {
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleChangedFileOpenDiff,
    handleChangedFileReveal,
    changedFilesActions,
  };
}
