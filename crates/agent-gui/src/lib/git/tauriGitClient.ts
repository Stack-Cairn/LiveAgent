import { invoke } from "@tauri-apps/api/core";
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

export const tauriGitClient: GitClient = {
  async status(workdir) {
    return normalizeGitRepositoryState(await invoke("git_status", { workdir }), workdir);
  },
  async discoverRepositories(workdir) {
    return normalizeGitRepositoryDiscovery(
      await invoke("git_discover_repositories", { workdir }),
      workdir,
    );
  },
  async branches(workdir) {
    return normalizeGitBranchesResponse(await invoke("git_branches", { workdir }), workdir);
  },
  async init(workdir, options = {}) {
    return normalizeGitOperationResponse(
      await invoke("git_init", {
        workdir,
        branch: options.branch,
        user_name: options.userName,
        user_email: options.userEmail,
      }),
      workdir,
    );
  },
  async switchBranch(workdir, branch, kind) {
    return normalizeGitOperationResponse(
      await invoke("git_switch_branch", { workdir, branch, kind }),
      workdir,
    );
  },
  async createBranch(workdir, branch, startPoint) {
    return normalizeGitOperationResponse(
      await invoke("git_create_branch", { workdir, branch, start_point: startPoint }),
      workdir,
    );
  },
  async diff(workdir, mode, path) {
    return normalizeGitDiffResponse(await invoke("git_diff", { workdir, mode, path }));
  },
  async log(workdir, options = {}) {
    return normalizeGitLogResponse(
      await invoke("git_log", { workdir, limit: options.limit, skip: options.skip }),
      workdir,
    );
  },
  async commitDetails(workdir, commit) {
    return normalizeGitCommitDetailsResponse(
      await invoke("git_commit_details", { workdir, commit }),
      workdir,
    );
  },
  async compareCommitWithRemote(workdir, commit) {
    return normalizeGitDiffResponse(
      await invoke("git_compare_commit_with_remote", { workdir, commit }),
    );
  },
  async commitDiff(workdir, commit, path) {
    return normalizeGitDiffResponse(await invoke("git_commit_diff", { workdir, commit, path }));
  },
  async stage(workdir, path) {
    return normalizeGitOperationResponse(await invoke("git_stage", { workdir, path }), workdir);
  },
  async stageAll(workdir) {
    return normalizeGitOperationResponse(await invoke("git_stage_all", { workdir }), workdir);
  },
  async unstage(workdir, path) {
    return normalizeGitOperationResponse(await invoke("git_unstage", { workdir, path }), workdir);
  },
  async unstageAll(workdir) {
    return normalizeGitOperationResponse(await invoke("git_unstage_all", { workdir }), workdir);
  },
  async discard(workdir, path, oldPath) {
    return normalizeGitOperationResponse(
      await invoke("git_discard", { workdir, path, old_path: oldPath }),
      workdir,
    );
  },
  async discardAll(workdir) {
    return normalizeGitOperationResponse(await invoke("git_discard_all", { workdir }), workdir);
  },
  async addToGitignore(workdir, path) {
    return normalizeGitOperationResponse(
      await invoke("git_add_to_gitignore", { workdir, path }),
      workdir,
    );
  },
  async openSystemFileLocation(workdir, path) {
    return normalizeGitOperationResponse(
      await invoke("git_open_system_file_location", { workdir, path }),
      workdir,
    );
  },
  async commit(workdir, message) {
    return normalizeGitOperationResponse(await invoke("git_commit", { workdir, message }), workdir);
  },
  async fetch(workdir) {
    return normalizeGitOperationResponse(await invoke("git_fetch", { workdir }), workdir);
  },
  async pull(workdir) {
    return normalizeGitOperationResponse(await invoke("git_pull", { workdir }), workdir);
  },
  async setRemote(workdir, remoteUrl) {
    return normalizeGitOperationResponse(
      await invoke("git_set_remote", { workdir, remote_url: remoteUrl }),
      workdir,
    );
  },
  async push(workdir) {
    return normalizeGitOperationResponse(await invoke("git_push", { workdir }), workdir);
  },
  async deleteBranch(workdir, branch, force) {
    return normalizeGitOperationResponse(
      await invoke("git_delete_branch", { workdir, branch, force }),
      workdir,
    );
  },
  async renameBranch(workdir, branch, newBranch) {
    return normalizeGitOperationResponse(
      await invoke("git_rename_branch", { workdir, branch, new_branch: newBranch }),
      workdir,
    );
  },
  async stashPush(workdir, message) {
    return normalizeGitOperationResponse(
      await invoke("git_stash_push", { workdir, message }),
      workdir,
    );
  },
  async stashPop(workdir) {
    return normalizeGitOperationResponse(await invoke("git_stash_pop", { workdir }), workdir);
  },
};
