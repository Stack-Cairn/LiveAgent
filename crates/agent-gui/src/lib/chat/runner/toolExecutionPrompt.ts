import { buildMemoryToolsSuffixSection } from "../../memory/prompts/injection";
import {
  inferRuntimePlatform,
  normalizeRuntimePlatform,
  type RuntimePlatform,
  runtimePlatformLabel,
} from "../../runtimePlatform";
import type { AdditionalProjectRoot } from "../../tools/pathUtils";

export function buildToolsSuffix(
  workdir: string,
  availableToolNames?: readonly string[],
  runtimePlatformInput?: RuntimePlatform,
  additionalRoots?: readonly AdditionalProjectRoot[],
) {
  const runtimePlatform = normalizeRuntimePlatform(runtimePlatformInput) ?? inferRuntimePlatform();
  const platformLabel = runtimePlatformLabel(runtimePlatform);
  const allowAll = availableToolNames === undefined;
  const toolNames = new Set(availableToolNames ?? []);
  const has = (name: string) => allowAll || toolNames.has(name);
  const hasAny = (...names: string[]) => names.some(has);
  const hasDynamicMcp =
    allowAll || (availableToolNames ?? []).some((name) => name.startsWith("mcp_"));

  const fileTools = ["Read", "Image", "Write", "Edit", "Delete", "List", "Grep", "Glob"].filter(
    has,
  );
  const hasFileTool = fileTools.length > 0;
  const hasReadFamily = hasAny("Read", "List", "Grep", "Glob");
  const canWrite = hasAny("Write", "Edit", "Delete");

  const toolGroups: string[] = [];
  if (fileTools.length > 0) toolGroups.push(`file tools (${fileTools.join(" / ")})`);
  if (has("SkillsManager")) toolGroups.push("skill tools (SkillsManager)");
  if (has("MemoryManager")) toolGroups.push("persistent memory (MemoryManager)");
  if (has("McpManager")) toolGroups.push("MCP configuration management (McpManager)");
  if (has("CronTaskManager")) toolGroups.push("scheduled task management (CronTaskManager)");
  if (has("Agent")) toolGroups.push("subagent delegation (Agent)");
  if (has("SendMessage")) toolGroups.push("subagent message bus (SendMessage)");
  if (has("Bash")) toolGroups.push("the command tool (Bash)");
  if (has("ManagedProcess")) toolGroups.push("managed local processes (ManagedProcess)");
  if (hasAny("TaskCreate", "TaskUpdate", "TaskList")) {
    toolGroups.push("durable task planning (TaskCreate / TaskUpdate / TaskList)");
  }
  if (hasDynamicMcp) toolGroups.push("MCP business tools whose names are prefixed with mcp_");

  const sections: string[] = [];

  sections.push(
    [
      "# Tool-Execution Mode",
      "",
      "In this mode you have access to the tools listed under **Available Tools** at the end of this section. Invoke them when the task requires reading, searching, modifying, or coordinating state (files, commands, agents, MCP services). For pure Q&A, explanation, or analysis that does not depend on current state, answer directly without invoking tools.",
      "",
      "## Final Reply",
      "- Your reply to the user is plain text plus Markdown.",
      "- Never include raw tool-call JSON or raw tool arguments in your reply — describe what you did in plain words instead.",
    ].join("\n"),
  );

  if (hasFileTool || hasAny("Bash", "ManagedProcess", "SSHManager", "McpManager", "Agent")) {
    const additionalRootLines =
      hasFileTool && (additionalRoots?.length ?? 0) > 0
        ? [
            "- Additional project roots available to structured file tools:",
            ...(additionalRoots ?? []).map(
              (root) =>
                `  - \`root://${root.alias}/\` (${root.access === "write" ? "read/write" : "read-only"})`,
            ),
            "- `root://` aliases extend only Read/Image/List/Glob/Grep and, for read/write roots, Write/Edit/Delete. They do not grant Bash or ManagedProcess access and are not accepted as their `cwd`.",
          ]
        : [];
    sections.push(
      [
        "## Workspace & Paths",
        `- Workspace root (sandbox): \`${workdir}\``,
        "- Preferred form: workspace-relative paths exactly as tools return them, e.g. `src/App.tsx`. To target the root itself, omit the optional `path` / `cwd` argument.",
        ...additionalRootLines,
        "- Files inside an enabled Skill: use `skill://<skill>/...` exactly as returned by SkillsManager or file tools.",
        "- Absolute paths, `~/...`, and `file://` URLs are also accepted and auto-normalized; never construct one when a returned path is available.",
        "- Write, Edit, and Delete operate only inside the workspace, writable configured root:// project roots, or enabled writable Skills. Bash `cwd` may point outside the workspace under its existing policy, but additional project roots do not expand that policy.",
        "- Use `/` as the separator everywhere, including Glob and Grep patterns; Windows `\\` is auto-normalized.",
        '- On a path error, follow its guidance: reuse a "Did you mean" candidate verbatim, or locate the file with Glob/Grep first, then retry with the returned path.',
      ].join("\n"),
    );
  }

  if (hasFileTool) {
    const lines: string[] = ["## File Operations"];
    if (hasReadFamily) {
      lines.push(
        "- When the target path is already known, go straight to Read. When it is not, locate it first with Grep / Glob / List, then Read.",
      );
    }
    if (canWrite) {
      lines.push(
        "- Existing files: Write and Edit check the file's current on-disk state automatically; a separate Read is only needed for very large files (>5000 lines). Stale writes are rejected — re-Read and retry if the file changed underneath you.",
        "- New files: call Write with a file path that includes the filename and the full content; parent directories are created automatically. There is no separate create-directory step — to create a directory, Write a file inside it.",
      );
    }
    if (has("Read")) {
      lines.push(
        [
          "- Read pagination:",
          "  • Text — `start_line` (1-based) + `limit`.",
          "  • PDF — `page_start` + `page_limit`.",
          "  • Notebook (`.ipynb`) — `cell_start` + `cell_limit`.",
          "  • Word/Excel/archive uploads — Read returns a best-effort preview or archive entry listing.",
          "- A re-Read of an unchanged file may return an `unchanged` stub instead of repeating content — treat it as confirmation that your prior read is still valid; do not retry to force the full body.",
        ].join("\n"),
      );
    }
    if (has("Write")) {
      lines.push(
        "- Write fully creates or overwrites one text file. The path must include the intended filename, not just a directory.",
      );
    }
    if (has("Edit")) {
      lines.push(
        "- Edit performs exact-string replacement, with automatic fallbacks for line-ending (CRLF/LF), trailing-whitespace, and uniform-indentation drift — copy old_string from Read output as-is and do not pad it with guessed whitespace. If `old_string` matches multiple places, either narrow it until it is unique or pass `replace_all=true` explicitly.",
      );
    }
    if (has("Delete")) {
      lines.push(
        "- Every intentional deletion of a file or directory inside the workspace, a writable root:// project root, or an enabled writable Skill MUST use Delete with the exact path, preferably workspace-relative, root://, or skill://. Use one Delete call per target; deleting a directory is recursive.",
        "- NEVER perform such a deletion through Bash, ManagedProcess, a shell script, or a deletion-oriented CLI, including `rm`, `rmdir`, `unlink`, `find -delete`, `git rm`, `git clean`, PowerShell `Remove-Item`, or cmd `del` / `erase` / `rd`. Structured Delete calls are required so LiveAgent can record the path in Edited Files and the file ledger.",
        "- If a deleted workspace path is tracked by Git and staging is required, call Delete first, then stage only that path with `git add -u -- <exact-workspace-relative-path>`.",
      );
    }
    if (hasAny("Grep", "Glob", "List")) {
      lines.push(
        "- For search, use `Grep.output_mode=content|files|count` with `head_limit`, `offset`, and `context` instead of dumping raw matches.",
      );
    }
    if (has("SkillsManager") && hasReadFamily) {
      lines.push(
        "- For files inside a Skill, call file tools with a path like `skill://<baseDir>/references/guide.md`.",
      );
    }
    if (has("Bash")) {
      const alts: string[] = [];
      if (hasReadFamily) alts.push("read / list / search via `cat`, `ls`, `find`, `grep`, or `rg`");
      if (has("Write")) {
        alts.push(
          "write / create files via heredocs, `tee`, `touch`, `cp`, or `mkdir` just to prepare a parent directory",
        );
      }
      if (alts.length > 0) {
        lines.push(
          `- Do NOT use Bash to ${alts.join(" or ")} for workspace, configured project-root, or Skill files — use the corresponding file tool above.`,
        );
      }
      if (hasReadFamily) {
        lines.push(
          "- Do not run Bash cat/ls/find/grep to read, list, or search workspace, configured root://, or Skill files.",
        );
      }
    }
    sections.push(lines.join("\n"));
  }

  if (has("Image")) {
    sections.push(
      [
        "## Showing Images",
        "- To display any image in the chat UI, call the Image tool.",
        "- Do not embed images with Markdown syntax like ![alt](path), HTML <img>, file:// URLs, or local relative image paths in your final text.",
        has("SkillsManager")
          ? [
              "- Local image: pass `path` exactly as seen, including workspace-relative, absolute, or skill:// paths. Remote image: pass `url` / `urls` or `source` / `sources` directly — do not download unless the user asked to save it locally.",
              "- Do not use Bash, open, xdg-open, Markdown, or HTML to display Skill images.",
            ].join("\n")
          : "- Local image: pass `path` exactly as seen. Remote image: pass `url` / `urls` or `source` / `sources` directly — do not download unless the user asked to save it locally.",
        "- For remote images, call Image with url/urls or source/sources directly instead of downloading them, unless the user explicitly asks to save the file locally.",
        "- Whenever an image path or URL appears in the conversation (from the user, a tool result, or earlier context) and the user should see it, call Image with that path/URL before producing the final reply.",
        "- If another tool saves, downloads, screenshots, generates, or returns an image file path or image URL and the user should see it, call Image with that path or URL before the final response.",
        "- Your final text may caption or describe images already shown via Image; it must not try to render them itself.",
        "- Final text may describe or caption images already displayed by Image, but must not attempt to render images directly.",
      ].join("\n"),
    );
  }

  if (has("Bash")) {
    const bashPlatformLines =
      runtimePlatform === "windows"
        ? [
            `- Current platform: ${platformLabel}. Bash runs through Git Bash with POSIX semantics; pwsh, Windows PowerShell, and cmd are fallbacks used only when Git Bash is not installed.`,
            "- Write POSIX/bash-compatible commands by default: `export`, `&&`, `/dev/null`, forward-slash paths.",
            "- Background commands using `&` must redirect stdout and stderr before detaching, for example `nohup command > /tmp/liveagent-task.log 2>&1 < /dev/null &`.",
            "- If a Bash result header reports `shell_family: powershell` or `shell_family: cmd`, Git Bash is missing: switch to PowerShell syntax and suggest installing Git for Windows or setting `LIVEAGENT_GIT_BASH_PATH`.",
          ]
        : [
            `- Current platform: ${platformLabel}. Bash runs through POSIX shells.`,
            runtimePlatform === "macos"
              ? "- macOS prefers zsh, then Bash, then sh. Use POSIX/zsh-compatible commands."
              : "- Linux prefers Bash, then zsh, then sh. Use POSIX/bash-compatible commands.",
            "- Background commands using `&` must redirect stdout and stderr before detaching, for example `nohup command > /tmp/liveagent-task.log 2>&1 < /dev/null &`.",
          ];
    sections.push(
      [
        "## Bash",
        "- Bash.cwd follows the path rules in **Workspace & Paths**.",
        ...bashPlatformLines,
        '- To run installed Skill scripts, use cwd="skill://<enabled-skill>/scripts" plus a relative command.',
        "- Passing an absolute Skill script path inside the command is also accepted as long as the referenced Skill is enabled in this conversation.",
        "- For endpoint tests with curl, include an explicit timeout such as `--max-time 30` so a stalled local server or upstream request cannot hold the whole turn indefinitely.",
        "- Use ManagedProcess instead of Bash for dev servers, watchers, preview servers, or anything that should keep running.",
        "- For reading, listing, or searching Skill content, always use Read/List/Glob/Grep with skill:// paths — Bash cat/ls/find/grep/rg/sed/awk against ~/.liveagent/skills is still routed back to the file tools.",
        "- Do not guess `skills/` paths inside the workspace; if a Skill is needed, enable it in the chat Skills selector first.",
        "- Do not cd into ~/.liveagent/skills or workspace skills/ guesses.",
      ].join("\n"),
    );
  }

  if (has("Agent")) {
    sections.push(
      [
        "## Agent Delegation",
        "- Use Agent for bounded, independent jobs that benefit from a fresh context: implementation, research, review, discussion, or verification. Do not delegate trivial work you can finish yourself.",
        "- To run multiple independent jobs in parallel, issue ONE Agent call whose `agents` array lists every job. Use sequential Agent calls only when a later job needs an earlier job's output.",
        "- Default to mode=readonly for research, review, and discussion agents. Use mode=worktree (with apply_policy) only when the subagent is expected to produce file changes or the user explicitly asked for file output.",
        "- To continue with an existing delegated agent or a previously formed team, call Agent again with the same stable id(s) and only the new prompt — do not impersonate those agents from this transcript and do not restate their identity fields.",
        "- If an Agent call is rejected, no subagents were started; fix every listed issue and retry with one corrected call.",
      ].join("\n"),
    );
  }

  if (has("SendMessage")) {
    sections.push(
      [
        "## Subagent Message Bus",
        "- Use SendMessage to send concise Markdown messages to the parent agent, all agents (to=*), or a stable delegated-agent id from the roster. Unknown recipients are rejected.",
        "- Messages sent to parent are private to the parent; send to=* when peer agents need to read a report or summary.",
        "- Message delivery is deferred to the next model turn boundary; do not use workspace files as a mailbox.",
      ].join("\n"),
    );
  }

  if (has("ManagedProcess")) {
    const managedProcessPreference =
      "- Prefer ManagedProcess over Bash for `pnpm dev`, `deno run main.ts`, `vite`, file watchers, local web servers, or commands that otherwise require `nohup` and log redirection.";
    sections.push(
      [
        "## ManagedProcess",
        '- Use ManagedProcess(action="start") for dev servers, preview servers, watchers, or other long-running foreground commands that should continue while you run tests.',
        "- Do not append `&` to ManagedProcess.command. It starts the process in the background, redirects stdout/stderr to a log file, and returns process_id/pid/log_path.",
        '- Use ManagedProcess(action="status") to inspect running processes, action="read_log" to inspect recent output, and action="stop" to terminate the process tree.',
        managedProcessPreference,
      ].join("\n"),
    );
  }

  if (hasAny("TaskCreate", "TaskUpdate", "TaskList")) {
    sections.push(
      [
        "## Task Planning",
        "- Proactively use TaskCreate for multi-step work (3+ distinct steps) or multiple user requests; skip it for one trivial action.",
        "- Task IDs are stable and executor-assigned. Use TaskUpdate with taskId; never replace or recreate the list after context compaction.",
        "- Exactly one task may be in_progress. Mark it in_progress before work and completed immediately after it is fully done.",
        "- Use TaskList whenever the authoritative task state is unclear.",
      ].join("\n"),
    );
  }

  if (has("MemoryManager")) {
    sections.push(buildMemoryToolsSuffixSection());
  }

  if (has("McpManager") || hasDynamicMcp) {
    const lines: string[] = ["## MCP"];
    if (has("McpManager")) {
      lines.push(
        "- **McpManager** is configuration only: manage, validate, test, diagnose, restart, stop, or list MCP servers and their tool inventory. It does NOT execute MCP domain calls.",
      );
    }
    if (hasDynamicMcp) {
      lines.push(
        "- The dynamically loaded `mcp_*` tools are where actual MCP domain actions (database queries, API calls, integrations exposed by MCP servers) happen.",
      );
    }
    sections.push(lines.join("\n"));
  }

  sections.push(
    toolGroups.length > 0
      ? ["## Available Tools", ...toolGroups.map((group) => `- ${group}`)].join("\n")
      : "## Available Tools\n- none.",
  );

  return sections.join("\n\n");
}
