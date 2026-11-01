import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { Trash2 } from "@liveagent/ui/components/IconSet";
import { SettingsSection } from "@liveagent/ui/components/settings/SettingsLayout";
import {
  SettingsToggleGroup,
  SettingsToggleGroupItem,
} from "@liveagent/ui/components/settings/SettingsToggleGroup";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isImeKeyboardEvent } from "../../components/chat/MentionComposerInputUtils";
import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "../../components/settings/SettingsSelect";
import { ConfirmDeletePopover } from "../../components/ui/confirm-action-popover";
import { Select, SelectItem, SelectValue } from "../../components/ui/select";
import type {
  KBrainSettingsAdapter,
  PermissionRule,
  PermissionRuleEffect,
  PermissionRuleInput,
  PermissionRuleList,
} from "./kbrainSettingsAdapter";

const EFFECTS: readonly PermissionRuleEffect[] = ["deny", "allow"];
const ADD_SCOPES: readonly PermissionRuleInput["scope"][] = ["user", "project"];

function connectionScope(kbrain: KBrainSettingsAdapter): string {
  const connection = kbrain.getConnection();
  return JSON.stringify(connection ? [connection.baseUrl, connection.token] : null);
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatTime(value: string | undefined): string {
  if (!value) return "";
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : time.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Settings → 权限: the rules "allow and remember" stored, for all projects and for the
 * chosen project, with delete and a form to add allow or deny rules by hand. Session rules
 * stay with their session and are not listed here.
 */
export function PermissionRulesSection({
  kbrain,
  settings,
}: {
  kbrain: KBrainSettingsAdapter;
  settings: SettingsSectionProps["settings"];
}) {
  const { t } = useLocale();
  // Archived and hidden projects are not offered, the same as in scheduled tasks.
  const projects = useMemo(() => {
    const excluded = new Set(
      [
        ...settings.system.archivedWorkspaceProjectPaths,
        ...settings.system.hiddenWorkspaceProjectPaths,
      ].map(workspaceProjectPathKey),
    );
    return settings.system.workspaceProjects
      .filter((project) => !excluded.has(workspaceProjectPathKey(project.path)))
      .map((project) => ({ path: project.path, name: project.name || project.path }));
  }, [settings]);
  const [chosen, setChosen] = useState("");
  const workspace = projects.some((project) => project.path === chosen)
    ? chosen
    : (projects[0]?.path ?? "");

  const [supported, setSupported] = useState<boolean | null>(kbrain.getCapabilities ? null : true);
  // The list remembers the project it was loaded for: deleting a project rule names that
  // project, and another project's rules are not shown while the chosen one loads.
  const [loaded, setLoaded] = useState<{ workspace: string; list: PermissionRuleList } | null>(
    null,
  );
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [effect, setEffect] = useState<PermissionRuleEffect>("deny");
  const [scope, setScope] = useState<PermissionRuleInput["scope"]>("user");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const epoch = useRef(0);

  useEffect(() => {
    if (!kbrain.getCapabilities) return;
    let active = true;
    void kbrain
      .getCapabilities()
      .then((capabilities) => {
        if (active) setSupported(Number(capabilities.permission_rules) >= 1);
      })
      .catch((reason) => {
        if (!active) return;
        setSupported(true);
        setLoadError(messageOf(reason));
      });
    return () => {
      active = false;
    };
  }, [kbrain]);

  // Each load gets a ticket; an answer for an older project or connection is dropped.
  const reload = useCallback(
    async (target: string) => {
      if (!kbrain.listPermissionRules) return;
      const ticket = ++epoch.current;
      const connection = connectionScope(kbrain);
      setLoading(true);
      setLoadError("");
      try {
        const next = await kbrain.listPermissionRules(target ? { workspace: target } : {});
        if (ticket !== epoch.current) return;
        if (connection !== connectionScope(kbrain))
          throw new Error(t("settings.permissions.connectionChanged"));
        setLoaded({ workspace: target, list: next });
      } catch (reason) {
        if (ticket !== epoch.current) return;
        setLoaded(null);
        setLoadError(messageOf(reason));
      } finally {
        if (ticket === epoch.current) setLoading(false);
      }
    },
    [kbrain, t],
  );

  useEffect(() => {
    if (supported) void reload(workspace);
    return () => {
      ++epoch.current;
    };
  }, [reload, supported, workspace]);

  const addScope = workspace ? scope : "user";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError("");
    try {
      await action();
      // The project chosen now: the user may have switched while the action ran.
      await reload(workspaceRef.current);
      return true;
    } catch (reason) {
      setActionError(messageOf(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const rule = draft.trim();
    if (!rule || busy || !kbrain.addPermissionRule) return;
    const addRule = kbrain.addPermissionRule;
    const input: PermissionRuleInput = {
      rule,
      effect,
      scope: addScope,
      ...(addScope === "project" ? { workspace } : {}),
    };
    if (await run(() => addRule(input))) setDraft("");
  }

  function remove(rule: PermissionRule, ruleWorkspace: string) {
    const deleteRule = kbrain.deletePermissionRule;
    if (!deleteRule) return;
    void run(() =>
      deleteRule({
        id: rule.id,
        scope: rule.scope,
        ...(rule.scope === "project" ? { workspace: ruleWorkspace } : {}),
      }),
    );
  }

  if (supported === null) return null;

  const list = loaded?.list ?? null;
  const userRules = list?.rules.filter((rule) => rule.scope === "user") ?? [];
  const projectRules = list?.rules.filter((rule) => rule.scope === "project") ?? [];
  const projectLoaded = !!loaded && loaded.workspace === workspace;
  const loadedWorkspace = loaded?.workspace ?? "";

  const renderRules = (rules: PermissionRule[]) =>
    rules.length === 0 ? (
      <p className="px-3 py-2 text-xs text-muted-foreground">{t("settings.permissions.empty")}</p>
    ) : (
      <ul className="divide-y divide-border/60">
        {rules.map((rule) => (
          <li
            key={`${rule.scope}:${rule.id}`}
            data-permission-rule={rule.rule}
            className="flex min-w-0 items-start gap-3 px-3 py-2"
          >
            <div className="min-w-0 flex-1 space-y-0.5">
              <code className="block break-all font-mono text-xs text-foreground">{rule.rule}</code>
              <p className="break-words text-tiny text-muted-foreground">
                {[
                  rule.createdAt
                    ? t("settings.permissions.addedAt").replace(
                        "{time}",
                        formatTime(rule.createdAt),
                      )
                    : "",
                  rule.sourceSession
                    ? t("settings.permissions.fromSession").replace(
                        "{id}",
                        rule.sourceSession.slice(0, 8),
                      )
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <span
              className={
                rule.effect === "deny"
                  ? "shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 text-tiny text-destructive"
                  : "shrink-0 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-tiny text-emerald-700 dark:text-emerald-400"
              }
            >
              {t(`settings.permissions.${rule.effect}`)}
            </span>
            <ConfirmDeletePopover name={rule.rule} onConfirm={() => remove(rule, loadedWorkspace)}>
              {(open) => (
                <Button
                  variant="ghost"
                  size="sm"
                  data-delete-rule=""
                  disabled={busy}
                  aria-label={t("settings.permissions.delete")}
                  title={t("settings.permissions.delete")}
                  onClick={open}
                  className="size-7 shrink-0 p-0 text-muted-foreground"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </ConfirmDeletePopover>
          </li>
        ))}
      </ul>
    );

  return (
    <SettingsSection
      title={t("settings.permissions.title")}
      description={t("settings.permissions.description")}
      data-testid="permission-rules-settings"
      aria-busy={loading || busy}
    >
      {!supported ? (
        <p className="px-1 text-xs leading-5 text-muted-foreground">
          {t("settings.permissions.upgrade")}
        </p>
      ) : (
        <div className="space-y-5">
          {loadError ? (
            <p role="alert" className="break-words px-1 text-xs leading-5 text-destructive">
              {loadError}
            </p>
          ) : null}

          <div data-permission-rules="user" className="rounded-xl border border-border/60">
            <h3 className="px-3 pt-2.5 pb-1 text-xs font-medium text-foreground">
              {t("settings.permissions.userScope")}
            </h3>
            {list ? renderRules(userRules) : null}
          </div>

          <div data-permission-rules="project" className="rounded-xl border border-border/60">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 pt-2.5 pb-1">
              <h3 className="text-xs font-medium text-foreground">
                {t("settings.permissions.projectScope")}
              </h3>
              {projects.length > 0 ? (
                <Select value={workspace} onValueChange={(value) => setChosen(String(value))}>
                  <SettingsSelectTrigger
                    aria-label={t("settings.permissions.project")}
                    className="min-w-0 max-w-full"
                  >
                    <SelectValue>
                      {projects.find((project) => project.path === workspace)?.name ?? workspace}
                    </SelectValue>
                  </SettingsSelectTrigger>
                  <SettingsSelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.path} value={project.path}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SettingsSelectContent>
                </Select>
              ) : null}
            </div>
            {projects.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t("settings.permissions.noProject")}
              </p>
            ) : projectLoaded ? (
              <>
                <p className="break-all px-3 text-tiny text-muted-foreground">{workspace}</p>
                {renderRules(projectRules)}
              </>
            ) : null}
          </div>

          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <h3 className="text-xs font-medium text-foreground">
              {t("settings.permissions.addTitle")}
            </h3>
            <input
              data-permission-rule-input=""
              value={draft}
              disabled={busy}
              placeholder={t("settings.permissions.rulePlaceholder")}
              aria-label={t("settings.permissions.rule")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // The Enter that commits an IME candidate (keyCode 229 in WebKit) picks
                // a word; it does not add the rule.
                if (event.key === "Enter" && !isImeKeyboardEvent(event)) {
                  event.preventDefault();
                  void add();
                }
              }}
              className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
            />
            <div className="flex flex-wrap items-center gap-2">
              <SettingsToggleGroup
                value={[effect]}
                disabled={busy}
                aria-label={t("settings.permissions.effect")}
                className="max-w-full flex-wrap"
                onValueChange={(values) => {
                  const next = values[0] as PermissionRuleEffect | undefined;
                  if (next && EFFECTS.includes(next)) setEffect(next);
                }}
              >
                {EFFECTS.map((value) => (
                  <SettingsToggleGroupItem key={value} value={value}>
                    {t(`settings.permissions.${value}`)}
                  </SettingsToggleGroupItem>
                ))}
              </SettingsToggleGroup>
              <SettingsToggleGroup
                value={[addScope]}
                disabled={busy}
                aria-label={t("settings.permissions.scope")}
                className="max-w-full flex-wrap"
                onValueChange={(values) => {
                  const next = values[0] as PermissionRuleInput["scope"] | undefined;
                  if (next && ADD_SCOPES.includes(next)) setScope(next);
                }}
              >
                {ADD_SCOPES.map((value) => (
                  <SettingsToggleGroupItem
                    key={value}
                    value={value}
                    disabled={value === "project" && !workspace}
                  >
                    {t(
                      value === "user"
                        ? "settings.permissions.userScope"
                        : "settings.permissions.projectScope",
                    )}
                  </SettingsToggleGroupItem>
                ))}
              </SettingsToggleGroup>
              <Button
                size="sm"
                disabled={busy || !draft.trim()}
                onClick={() => void add()}
                className="ml-auto h-8 px-3 text-xs"
              >
                {t("settings.permissions.add")}
              </Button>
            </div>
            {actionError ? (
              <p role="alert" className="break-words text-xs leading-5 text-destructive">
                {actionError}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
