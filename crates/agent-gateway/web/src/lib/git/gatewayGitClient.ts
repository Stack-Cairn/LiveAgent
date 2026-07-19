import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import {
  type GitClient,
  normalizeGitBranchesResponse,
  normalizeGitCommitDetailsResponse,
  normalizeGitDiffResponse,
  normalizeGitLogResponse,
  normalizeGitOperationResponse,
  normalizeGitRepositoryDiscovery,
  normalizeGitRepositoryState,
} from "./types";

export function createGatewayGitClient(api: GatewayWebSocketClientLike): GitClient {
  return {
    async status(workdir) {
      return normalizeGitRepositoryState(await api.gitRequest("status", workdir), workdir);
    },
    async discoverRepositories(workdir) {
      return normalizeGitRepositoryDiscovery(
        await api.gitRequest("discover_repositories", workdir),
        workdir,
      );
    },
    async branches(workdir) {
      return normalizeGitBranchesResponse(await api.gitRequest("branches", workdir), workdir);
    },
    async init(workdir, options = {}) {
      return normalizeGitOperationResponse(
        await api.gitRequest("init", workdir, {
          branch: options.branch,
          userName: options.userName,
          userEmail: options.userEmail,
        }),
        workdir,
      );
    },
    async switchBranch(workdir, branch, kind) {
      return normalizeGitOperationResponse(
        await api.gitRequest("switch_branch", workdir, { branch, kind }),
        workdir,
      );
    },
    async createBranch(workdir, branch, startPoint) {
      return normalizeGitOperationResponse(
        await api.gitRequest("create_branch", workdir, { branch, startPoint }),
        workdir,
      );
    },
    async diff(workdir, mode, path) {
      return normalizeGitDiffResponse(await api.gitRequest("diff", workdir, { mode, path }));
    },
    async log(workdir, options = {}) {
      return normalizeGitLogResponse(
        await api.gitRequest("log", workdir, { limit: options.limit, skip: options.skip }),
        workdir,
      );
    },
    async commitDetails(workdir, commit) {
      return normalizeGitCommitDetailsResponse(
        await api.gitRequest("commit_details", workdir, { commit }),
        workdir,
      );
    },
    async compareCommitWithRemote(workdir, commit) {
      return normalizeGitDiffResponse(
        await api.gitRequest("compare_commit_with_remote", workdir, { commit }),
      );
    },
    async commitDiff(workdir, commit, path) {
      return normalizeGitDiffResponse(
        await api.gitRequest("commit_diff", workdir, { commit, path }),
      );
    },
    async stage(workdir, path) {
      return normalizeGitOperationResponse(
        await api.gitRequest("stage", workdir, { path }),
        workdir,
      );
    },
    async stageAll(workdir) {
      return normalizeGitOperationResponse(await api.gitRequest("stage_all", workdir), workdir);
    },
    async unstage(workdir, path) {
      return normalizeGitOperationResponse(
        await api.gitRequest("unstage", workdir, { path }),
        workdir,
      );
    },
    async unstageAll(workdir) {
      return normalizeGitOperationResponse(await api.gitRequest("unstage_all", workdir), workdir);
    },
    async discard(workdir, path, oldPath) {
      return normalizeGitOperationResponse(
        await api.gitRequest("discard", workdir, { path, oldPath }),
        workdir,
      );
    },
    async discardAll(workdir) {
      return normalizeGitOperationResponse(await api.gitRequest("discard_all", workdir), workdir);
    },
    async addToGitignore(workdir, path) {
      return normalizeGitOperationResponse(
        await api.gitRequest("add_to_gitignore", workdir, { path }),
        workdir,
      );
    },
    async commit(workdir, message) {
      return normalizeGitOperationResponse(
        await api.gitRequest("commit", workdir, { message }),
        workdir,
      );
    },
    async fetch(workdir) {
      return normalizeGitOperationResponse(await api.gitRequest("fetch", workdir), workdir);
    },
    async pull(workdir) {
      return normalizeGitOperationResponse(await api.gitRequest("pull", workdir), workdir);
    },
    async setRemote(workdir, remoteUrl) {
      return normalizeGitOperationResponse(
        await api.gitRequest("set_remote", workdir, { remoteUrl }),
        workdir,
      );
    },
    async push(workdir) {
      return normalizeGitOperationResponse(await api.gitRequest("push", workdir), workdir);
    },
    async deleteBranch(workdir, branch, force) {
      return normalizeGitOperationResponse(
        await api.gitRequest("delete_branch", workdir, { branch, force }),
        workdir,
      );
    },
    async renameBranch(workdir, branch, newBranch) {
      return normalizeGitOperationResponse(
        await api.gitRequest("rename_branch", workdir, { branch, newBranch }),
        workdir,
      );
    },
    async stashPush(workdir, message) {
      return normalizeGitOperationResponse(
        await api.gitRequest("stash_push", workdir, { message }),
        workdir,
      );
    },
    async stashPop(workdir) {
      return normalizeGitOperationResponse(await api.gitRequest("stash_pop", workdir), workdir);
    },
  };
}
