import { workspaceProjectPathKey } from "@liveagent/ui/lib/settings/workspaceProjects";

function hasParentTraversalSegment(pathKey: string): boolean {
  return pathKey.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * 前端护栏:判断一个 cwd 是否落在 project 范围内。
 *
 * 只做规范化后的字符串形状判断——不解析符号链接、不访问文件系统,所以它
 * 会漏掉软链逃逸。真正的授权边界在 Rust 侧 `canonicalize_workdir_within`
 * (双边 canonicalize + 包含性校验),这里的作用是让越界的 Pane 在投放/
 * 恢复时就被挡掉,而不是等后端报错才暴露。布局 JSON 不是授权凭据:即使
 * 前端放行,后端仍会独立复核。
 */
export function pathIsInsideProject(path: unknown, projectPathKey: unknown): boolean {
  const projectKey = workspaceProjectPathKey(projectPathKey);
  if (!projectKey) return false;
  const pathKey = workspaceProjectPathKey(path);
  if (!pathKey) return false;
  // `..` 无法在不触碰文件系统的前提下安全解析,一律视为越界。
  if (hasParentTraversalSegment(pathKey) || hasParentTraversalSegment(projectKey)) return false;
  if (pathKey === projectKey) return true;
  const prefix = projectKey.endsWith("/") ? projectKey : `${projectKey}/`;
  return pathKey.startsWith(prefix);
}

/**
 * 终端 surface 的 launchSpec.cwd 是否与其 ProjectRef 同源。
 *
 * 对 `localTerminal` 与 `sshTerminal` 一视同仁:两种 surface 的 cwd 都是
 * **本地 project 锚点**——`create_ssh` 同样会在本地 canonicalize 它(它是
 * SFTP 的 local root),而不是远端工作目录。因此包含性判断在两种 kind 上
 * 语义一致,越界的 Pane 在投放/恢复阶段就被挡掉。
 */
export function terminalLaunchSpecIsInProject(surface: {
  kind: "localTerminal" | "sshTerminal";
  project: { projectPathKey: string };
  launchSpec: { cwd: string };
}): boolean {
  return pathIsInsideProject(surface.launchSpec.cwd, surface.project.projectPathKey);
}
