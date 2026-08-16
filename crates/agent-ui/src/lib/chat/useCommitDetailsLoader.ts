import { useCallback, useEffect, useRef } from "react";
import type { GitClient } from "../git/types";
import {
  buildGitHubCommitUrl,
  type CommitDetailsLoader,
  type CommitDisplayReference,
} from "./userMessageContent";

export function useCommitDetailsLoader(
  workspaceRoot?: string,
  gitClient?: GitClient | null,
  cacheResetKey?: string,
) {
  const commitDetailsCacheRef = useRef(new Map<string, CommitDisplayReference>());

  useEffect(() => {
    if (cacheResetKey !== undefined) {
      commitDetailsCacheRef.current.clear();
    }
  }, [cacheResetKey]);

  return useCallback<CommitDetailsLoader>(
    async (commit) => {
      const workdir = workspaceRoot?.trim() ?? "";
      const sha = commit.sha.trim();
      if (!gitClient || !workdir || !sha) return null;
      const cacheKey = `${workdir}\u0000${sha}`;
      const cached = commitDetailsCacheRef.current.get(cacheKey);
      if (cached) return cached;
      const response = await gitClient.commitDetails(workdir, sha);
      const details = response.commit;
      const resolved: CommitDisplayReference = {
        sha: details.sha,
        shortSha: details.shortSha,
        subject: details.subject,
        body: details.body,
        authorName: details.authorName,
        authorEmail: details.authorEmail,
        authorDate: details.authorDate,
        fileCount: details.fileCount,
        filesChanged: details.filesChanged,
        insertions: details.insertions,
        deletions: details.deletions,
        stat: details.stat,
        remoteName: details.remoteName,
        remoteUrl: details.remoteUrl,
        githubUrl:
          commit.githubUrl ||
          buildGitHubCommitUrl(details.remoteUrl || response.state.remoteUrl, details.sha) ||
          undefined,
      };
      commitDetailsCacheRef.current.set(cacheKey, resolved);
      return resolved;
    },
    [gitClient, workspaceRoot],
  );
}
