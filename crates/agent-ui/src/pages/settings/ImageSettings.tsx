import {
  cloneElement,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import type {
  ImageConnection,
  ImageStudioClient,
  ImageTarget,
  Operation,
  ImageSettings as Settings,
} from "../../lib/imaging/types";
import {
  connectionDependents,
  type ImageSecretPurpose,
  imageOperationLabels,
  imageProtocols,
  imageSecretPurposeLabels,
  imageSecretPurposes,
  imageSettingsDirty,
  imageSettingsError,
  imageSettingsErrorCode,
  mergeImageSettings,
  newImageConnection,
  newImageTarget,
  parseImageParameters,
  parseWorkflowMapping,
  patchImageConnection,
  patchImageTarget,
  removeImageConnection,
  settingsUpdate,
  unfinishedImageAdapters,
  validateImageSettingsDraft,
  writeAndBindImageSecret,
} from "./imageSettingsAdapter";

export interface ImageSettingsProps {
  panel?: "all" | "connections" | "targets";
  /** Replace client identity whenever owner/backend changes. */
  client: ImageStudioClient;
  onDirtyChange?: (dirty: boolean) => void;
  /** Host navigation calls this guard before switching settings tabs/routes;
   * return a cleanup that unregisters this specific guard. */
  registerLeaveGuard?: (guard: () => boolean) => () => void;
}
const clientKeys = new WeakMap<ImageStudioClient, number>();
let clientSequence = 0;
export function ImageSettings(props: ImageSettingsProps) {
  let key = clientKeys.get(props.client);
  if (key === undefined) {
    key = ++clientSequence;
    clientKeys.set(props.client, key);
  }
  return <ImageSettingsScope key={key} {...props} />;
}
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}
function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
type AdvancedDraft = { parameters?: string; workflow?: string };

function ImageSettingsScope({
  client,
  onDirtyChange,
  registerLeaveGuard,
  panel = "all",
}: ImageSettingsProps) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [remote, setRemote] = useState<Settings | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [advanced, setAdvanced] = useState<Record<string, AdvancedDraft>>({});
  const [busy, setBusy] = useState<"load" | "save" | "secret" | null>("load");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [secretDirty, setSecretDirty] = useState(false);
  const [purpose, setPurpose] = useState<ImageSecretPurpose>("apiKey");
  const secretInput = useRef<HTMLInputElement>(null);
  const bindSecretInput = useCallback((node: HTMLInputElement | null) => {
    if (secretInput.current && secretInput.current !== node) secretInput.current.value = "";
    secretInput.current = node;
  }, []);
  const generation = useRef(0);
  const busyRef = useRef(true);
  const dirtyRef = useRef(false);
  const publicDirty = imageSettingsDirty(saved, draft) || Object.keys(advanced).length > 0;
  const dirty = publicDirty || secretDirty || busy === "save" || busy === "secret";
  dirtyRef.current = dirty;
  const connection = draft?.connections.find((c) => c.id === connectionId);
  const target = draft?.targets.find((t) => t.id === targetId);
  const targetEnableBlock = !target
    ? ""
    : unfinishedImageAdapters.includes(target.adapter)
      ? "后端暂未支持这种图像协议，目标保存后不能启用。"
      : draft?.connections.some((c) => c.id === target.connectionId && !c.enabled)
        ? "所用连接已停用，启用连接后才能启用目标。"
        : "";
  const secretPurposes = draft ? imageSecretPurposes(draft, connectionId) : ["apiKey" as const];
  const selectedPurpose = secretPurposes.includes(purpose) ? purpose : secretPurposes[0];

  function clearSecret() {
    if (secretInput.current) secretInput.current.value = "";
    setSecretDirty(false);
  }
  const accept = useCallback((value: Settings) => {
    setSaved(value);
    setDraft(value);
    setConnectionId((current) =>
      value.connections.some((c) => c.id === current) ? current : (value.connections[0]?.id ?? ""),
    );
    setTargetId((current) =>
      value.targets.some((t) => t.id === current) ? current : (value.targets[0]?.id ?? ""),
    );
    setRemote(null);
    setReviewRequired(false);
    setAdvanced({});
  }, []);
  useLayoutEffect(() => {
    const token = ++generation.current;
    const current = () => generation.current === token;
    busyRef.current = true;
    void client
      .getSettings()
      .then((value) => {
        if (!current()) return;
        accept(value);
        setConnectionId(value.connections[0]?.id ?? "");
        setTargetId(value.targets[0]?.id ?? "");
      })
      .catch((reason: unknown) => {
        if (current()) setError(imageSettingsError(reason));
      })
      .finally(() => {
        if (current()) {
          busyRef.current = false;
          setBusy(null);
        }
      });
    return () => {
      generation.current++;
      if (secretInput.current) secretInput.current.value = "";
    };
  }, [client, accept]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    const unregister = registerLeaveGuard?.(
      () =>
        !dirtyRef.current ||
        window.confirm(
          "图像设置有未保存的修改或正在等待的操作。离开将丢弃本页草稿；已发出的请求可能仍会完成。确定离开？",
        ),
    );
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      unregister?.();
    };
  }, [registerLeaveGuard]);

  function updateConnection(patch: Partial<ImageConnection>) {
    if (!draft || !connection || busyRef.current) return;
    setDraft(patchImageConnection(draft, connection.id, patch));
    setStatus("");
  }
  function updateTarget(patch: Partial<ImageTarget>) {
    if (!draft || !target || busyRef.current) return;
    setDraft({
      ...draft,
      targets: draft.targets.map((t) => (t.id === target.id ? patchImageTarget(t, patch) : t)),
    });
    setStatus("");
  }
  function selectConnection(id: string) {
    if (secretDirty && !window.confirm("切换连接将清空尚未写入的凭据。确定继续？")) return;
    clearSecret();
    setConnectionId(id);
    setPurpose("apiKey");
  }
  function advancedSettings(): Settings | null {
    if (!draft) return null;
    try {
      return {
        ...draft,
        targets: draft.targets.map((t) => {
          const text = advanced[t.id];
          if (!text) return t;
          return patchImageTarget(t, {
            ...(text.parameters !== undefined
              ? { parameters: parseImageParameters(text.parameters) }
              : {}),
            ...(text.workflow !== undefined && t.kind === "workflow"
              ? { workflowMapping: parseWorkflowMapping(text.workflow) }
              : {}),
          });
        }),
      };
    } catch {
      setError("高级配置无效。请检查参数类型、枚举、默认值及工作流节点字段；草稿已保留。");
      return null;
    }
  }
  async function refresh() {
    if (busyRef.current) return;
    const token = ++generation.current;
    busyRef.current = true;
    setBusy("load");
    setError("");
    try {
      const latest = await client.getSettings();
      if (token !== generation.current) return;
      if (publicDirty || reviewRequired) {
        setRemote(latest);
        setReviewRequired(true);
        setStatus("已读取最新设置。请比较并处理草稿后再保存。");
      } else {
        accept(latest);
        setStatus("已读取最新设置。");
      }
    } catch (reason) {
      if (token === generation.current) setError(imageSettingsError(reason));
    } finally {
      if (token === generation.current) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }
  async function handleFailure(reason: unknown, token: number) {
    if (token !== generation.current) return;
    setError(imageSettingsError(reason));
    // Failed responses can be ambiguous. Block blind resubmission until a read.
    setReviewRequired(true);
    if (imageSettingsErrorCode(reason) === "IMAGE_REVISION_CONFLICT") {
      try {
        const latest = await client.getSettings();
        if (token === generation.current) setRemote(latest);
      } catch {
        /* Retain draft and the safe conflict message; refresh remains available. */
      }
    }
  }
  async function save() {
    if (busyRef.current || reviewRequired || secretDirty) return;
    const next = advancedSettings();
    if (!next) return;
    const errors = validateImageSettingsDraft(next);
    if (errors.length) {
      setError(errors.join(" "));
      return;
    }
    const token = ++generation.current;
    busyRef.current = true;
    setBusy("save");
    setError("");
    setStatus("");
    setDraft(next);
    setAdvanced({});
    try {
      const response = await client.saveSettings(settingsUpdate(next));
      if (token === generation.current) {
        accept(response);
        setStatus("图像设置已保存。");
      }
    } catch (reason) {
      await handleFailure(reason, token);
    } finally {
      if (token === generation.current) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }
  async function saveSecret() {
    if (busyRef.current || !saved || !connection || publicDirty || reviewRequired) return;
    let value = secretInput.current?.value ?? "";
    if (!value) return;
    clearSecret();
    const token = ++generation.current;
    const current = () => token === generation.current;
    busyRef.current = true;
    setBusy("secret");
    setError("");
    setStatus("");
    try {
      const request = writeAndBindImageSecret(
        client,
        saved,
        connection.id,
        selectedPurpose,
        value,
        current,
        (next) => {
          if (current()) {
            setDraft(next);
            setStatus("凭据已写入，正在保存引用绑定。");
          }
        },
      );
      value = "";
      const response = await request;
      if (current() && response) {
        accept(response);
        setStatus("凭据已写入并绑定到连接；输入已清空。");
      }
    } catch (reason) {
      if (current())
        setStatus(
          "凭据输入已清空。写入可能已完成；若引用绑定失败，公开引用草稿已保留。请读取最新设置后合并并保存，或重新写入同一用途的凭据。",
        );
      await handleFailure(reason, token);
    } finally {
      value = "";
      if (current()) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }
  function stopWaiting() {
    const wasMutation = busy === "save" || busy === "secret";
    generation.current++;
    busyRef.current = false;
    setBusy(null);
    clearSecret();
    if (wasMutation) setReviewRequired(true);
    setStatus(
      wasMutation ? "已停止等待。请求可能已完成；请读取最新设置后再操作。" : "已停止读取。",
    );
  }
  function cancelEdits() {
    if (dirty && !window.confirm("确定放弃未保存的图像设置和凭据输入？")) return;
    clearSecret();
    setAdvanced({});
    setDraft(saved);
    setConnectionId((current) =>
      saved?.connections.some((c) => c.id === current)
        ? current
        : (saved?.connections[0]?.id ?? ""),
    );
    setTargetId((current) =>
      saved?.targets.some((t) => t.id === current) ? current : (saved?.targets[0]?.id ?? ""),
    );
    setError("");
    setStatus("已放弃本地修改。");
    // An ambiguous write still requires a fresh read, even after local discard.
  }
  function resolveConflict(prefer: "local" | "remote") {
    if (!saved || !remote) return;
    const local = advancedSettings();
    if (!local) return;
    const result = mergeImageSettings(saved, local, remote, prefer);
    if (
      result.conflicts.length &&
      !window.confirm(
        `有 ${result.conflicts.length} 个连接或目标被同时修改。冲突项将使用${prefer === "local" ? "我的草稿" : "服务器版本"}，其余远端修改会保留。确定继续？`,
      )
    )
      return;
    setSaved(remote);
    setDraft(result.draft);
    setRemote(null);
    setReviewRequired(false);
    setAdvanced({});
    clearSecret();
    setError("");
    setStatus("已合并到最新版本。请检查内容并保存。");
  }
  const dependencies = draft && connection ? connectionDependents(draft, connection.id) : [];
  const conflicts =
    saved && draft && remote ? mergeImageSettings(saved, draft, remote).conflicts : [];
  const canWriteSecret =
    !publicDirty &&
    !reviewRequired &&
    !!saved?.connections.some((c) => c.id === connection?.id && c.binding.kind === "independent");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-1">
      <div>
        <h2 className="text-base font-semibold">
          {panel === "connections" ? "图像服务" : panel === "targets" ? "目标设置" : "图像设置"}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {panel === "connections"
            ? "配置图像供应商的地址、认证和凭据。模型与工作流请在创作输入区的目标设置中管理。"
            : panel === "targets"
              ? "选择已有图像连接，配置生成模型或工作流。连接和凭据由后端配置管理。"
              : "供应商里标为生图的模型会直接出现在图像工作台。这里只用来配置需要单独连接的图像服务，例如 RunningHub 模型 API、火山方舟；公开配置保存后，再写入连接凭据。"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!!busy || !draft || !publicDirty || reviewRequired || secretDirty}
          onClick={() => void save()}
        >
          保存设置
        </Button>
        <Button variant="outline" disabled={!!busy} onClick={() => void refresh()}>
          读取最新设置
        </Button>
        <Button variant="ghost" disabled={!!busy || !dirty} onClick={cancelEdits}>
          取消编辑
        </Button>
        {busy && (
          <Button variant="ghost" onClick={stopWaiting}>
            停止等待
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {busy ? "正在处理…" : dirty ? "有未保存的修改" : "已与服务器同步"}
          {saved ? ` · 版本 ${saved.revision}` : ""}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
      {reviewRequired && (
        <section
          className="space-y-2 rounded-xl border border-border p-4"
          aria-label="设置版本冲突"
        >
          <p className="text-sm">
            草稿已保留。
            {remote
              ? `服务器版本 ${remote.revision}，同时修改的项目 ${conflicts.length} 个。`
              : "请先读取最新设置，核对上次操作是否完成。"}
          </p>
          {remote && (
            <>
              <p className="text-xs text-muted-foreground">
                合并保留服务器新加入的连接和目标。冲突按连接或目标逐项识别；选择后仍需保存。
              </p>
              {conflicts.length > 0 && (
                <ul className="list-inside list-disc text-sm">
                  {conflicts.map((id) => (
                    <li key={id}>
                      {draft?.connections.find((c) => c.id === id)?.name ??
                        draft?.targets.find((t) => t.id === id)?.name ??
                        remote.connections.find((c) => c.id === id)?.name ??
                        remote.targets.find((t) => t.id === id)?.name ??
                        id}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => resolveConflict("local")}
                >
                  合并，冲突用我的草稿
                </Button>
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => resolveConflict("remote")}
                >
                  合并，冲突用服务器版本
                </Button>
                <Button
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => {
                    if (window.confirm("确定丢弃本地草稿并采用服务器全部设置？")) {
                      accept(remote);
                      clearSecret();
                      setError("");
                      setStatus("已采用服务器设置。");
                    }
                  }}
                >
                  采用服务器全部设置
                </Button>
              </div>
            </>
          )}
        </section>
      )}
      {draft && (
        <fieldset disabled={!!busy} className="min-w-0 space-y-5">
          {panel !== "targets" && (
            <section className="space-y-3 rounded-xl bg-settings-tile p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">连接</h3>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (secretDirty && !window.confirm("新增连接将清空尚未写入的凭据。确定继续？"))
                      return;
                    clearSecret();
                    const next = newImageConnection(
                      `ic_${crypto.randomUUID().replaceAll("-", "")}`,
                    );
                    setDraft({ ...draft, connections: [...draft.connections, next] });
                    setConnectionId(next.id);
                  }}
                >
                  新增连接
                </Button>
              </div>
              <Field label="选择连接">
                <select
                  className={selectClass}
                  value={connection?.id ?? ""}
                  onChange={(e) => selectConnection(e.target.value)}
                >
                  <option value="" disabled>
                    请选择连接
                  </option>
                  {draft.connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              {!draft.connections.length && (
                <p className="text-sm text-muted-foreground">先添加一个连接，再配置图像目标。</p>
              )}
              {connection && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="连接名称">
                      <Input
                        value={connection.name}
                        onChange={(e) => updateConnection({ name: e.target.value })}
                      />
                    </Field>
                    <Field label="供应商">
                      <Input
                        value={connection.vendor}
                        placeholder="例如 openai、google、runninghub"
                        onChange={(e) => updateConnection({ vendor: e.target.value })}
                      />
                    </Field>
                    <Field label="凭据来源">
                      <select
                        className={selectClass}
                        value={connection.binding.kind}
                        onChange={(e) => {
                          clearSecret();
                          updateConnection({
                            binding:
                              e.target.value === "provider_ref"
                                ? { kind: "provider_ref", providerId: "" }
                                : {
                                    kind: "independent",
                                    baseUrl: "",
                                    authKind: "bearer",
                                    secretRefs: {},
                                  },
                          });
                        }}
                      >
                        <option value="independent">独立图像连接</option>
                        {/* 供应商里的生图模型已直接出现在工作台；只为旧连接保留这一项。 */}
                        {connection.binding.kind === "provider_ref" && (
                          <option value="provider_ref">复用已有供应商</option>
                        )}
                      </select>
                    </Field>
                    <Field label="最大并发任务">
                      <Input
                        type="number"
                        min={1}
                        max={16}
                        value={connection.maxConcurrent}
                        onChange={(e) =>
                          updateConnection({ maxConcurrent: Number(e.target.value) })
                        }
                      />
                    </Field>
                  </div>
                  {connection.binding.kind === "provider_ref" ? (
                    <>
                      <Field label="已有供应商 ID">
                        <Input
                          value={connection.binding.providerId}
                          placeholder="填写聊天供应商设置中的 ID"
                          onChange={(e) =>
                            updateConnection({
                              binding: { kind: "provider_ref", providerId: e.target.value },
                            })
                          }
                        />
                      </Field>
                      <p className="text-xs text-muted-foreground">
                        只复用网络和凭据。图像协议与模型在下方单独配置；保存时由后端检查供应商是否存在。
                      </p>
                    </>
                  ) : (
                    <>
                      <Field label="服务地址">
                        <Input
                          type="url"
                          value={connection.binding.baseUrl}
                          placeholder="https://api.example.com/v1"
                          onChange={(e) => {
                            if (connection.binding.kind === "independent")
                              updateConnection({
                                binding: { ...connection.binding, baseUrl: e.target.value },
                              });
                          }}
                        />
                      </Field>
                      <Field label="认证方式">
                        <select
                          className={selectClass}
                          value={connection.binding.authKind}
                          onChange={(e) => {
                            if (connection.binding.kind === "independent")
                              updateConnection({
                                binding: {
                                  ...connection.binding,
                                  authKind: e.target.value as
                                    | "bearer"
                                    | "api_key_header"
                                    | "signed_request",
                                },
                              });
                          }}
                        >
                          <option value="bearer">Bearer token</option>
                          <option value="api_key_header">API key 请求头</option>
                          <option value="signed_request">签名认证（AK / SK）</option>
                        </select>
                      </Field>
                      <Toggle
                        label="使用系统代理"
                        checked={!!connection.binding.useSystemProxy}
                        onChange={(checked) => {
                          if (connection.binding.kind === "independent")
                            updateConnection({
                              binding: { ...connection.binding, useSystemProxy: checked },
                            });
                        }}
                      />
                      <div className="space-y-3 rounded-lg border border-border p-3">
                        <p className="text-sm">
                          凭据：{connection.credentialConfigured ? "已配置" : "尚未配置"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {canWriteSecret
                            ? "选择凭据用途并写入。相同用途会替换原凭据；签名认证需分别写入 Access Key 和 Secret Key，临时凭据还需 Security Token。"
                            : "先保存公开设置，处理版本冲突后再写入凭据。"}
                        </p>
                        <Field label="凭据用途（purpose）">
                          <select
                            className={selectClass}
                            disabled={!canWriteSecret}
                            value={selectedPurpose}
                            onChange={(e) => {
                              clearSecret();
                              setPurpose(e.target.value as ImageSecretPurpose);
                            }}
                          >
                            {secretPurposes.map((item) => (
                              <option key={item} value={item}>
                                {imageSecretPurposeLabels[item]}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="新凭据">
                          <Input
                            key={connection.id}
                            ref={bindSecretInput}
                            type="password"
                            autoComplete="new-password"
                            spellCheck={false}
                            disabled={!canWriteSecret}
                            onChange={(e) => setSecretDirty(e.target.value.length > 0)}
                          />
                        </Field>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            disabled={!canWriteSecret || !secretDirty}
                            onClick={() => void saveSecret()}
                          >
                            写入并绑定凭据
                          </Button>
                          <Button variant="ghost" disabled={!secretDirty} onClick={clearSecret}>
                            清空输入
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                  <Toggle
                    label="启用连接"
                    checked={connection.enabled}
                    onChange={(enabled) => updateConnection({ enabled })}
                  />
                  {dependencies.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      使用此连接的目标：{dependencies.map((t) => t.name).join("、")}
                      。删除连接前请先移除目标或更换其连接。
                    </p>
                  )}
                  <Button
                    variant="destructive"
                    disabled={dependencies.length > 0}
                    onClick={() => {
                      if (window.confirm(`确定删除连接“${connection.name}”？保存设置后生效。`)) {
                        setDraft(removeImageConnection(draft, connection.id));
                        clearSecret();
                        setConnectionId("");
                      }
                    }}
                  >
                    删除连接
                  </Button>
                </>
              )}
            </section>
          )}
          {panel === "targets" && draft.connections.length === 0 && (
            <p role="status">当前没有可用的图像连接，请先配置后端图像连接。</p>
          )}
          {panel !== "connections" && (
            <section className="space-y-3 rounded-xl bg-settings-tile p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">图像目标</h3>
                <Button
                  variant="outline"
                  disabled={!draft.connections.length}
                  onClick={() => {
                    const next = newImageTarget(
                      `it_${crypto.randomUUID().replaceAll("-", "")}`,
                      connection?.id ?? draft.connections[0].id,
                    );
                    setDraft({ ...draft, targets: [...draft.targets, next] });
                    setTargetId(next.id);
                  }}
                >
                  新增目标
                </Button>
              </div>
              <Field label="选择目标">
                <select
                  className={selectClass}
                  value={target?.id ?? ""}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="" disabled>
                    请选择目标
                  </option>
                  {draft.targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.enabled ? "" : "（禁用）"}
                    </option>
                  ))}
                </select>
              </Field>
              {target && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="目标名称">
                      <Input
                        value={target.name}
                        onChange={(e) => updateTarget({ name: e.target.value })}
                      />
                    </Field>
                    <Field label="使用连接">
                      <select
                        className={selectClass}
                        value={target.connectionId}
                        onChange={(e) => updateTarget({ connectionId: e.target.value })}
                      >
                        {draft.connections.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="图像协议">
                      <select
                        className={selectClass}
                        value={target.adapter}
                        onChange={(e) => {
                          const workflow = e.target.value === "runninghub-workflow";
                          updateTarget({
                            adapter: e.target.value,
                            kind: workflow ? "workflow" : "model",
                            workflowMapping: workflow
                              ? (target.workflowMapping ?? { revision: 1, inputs: [], outputs: [] })
                              : undefined,
                          });
                          setAdvanced((previous) => {
                            const next = { ...previous };
                            if (next[target.id])
                              next[target.id] = { parameters: next[target.id].parameters };
                            return next;
                          });
                        }}
                      >
                        {!imageProtocols.some((p) => p.id === target.adapter) && (
                          <option value={target.adapter}>当前协议（需后端支持）</option>
                        )}
                        {imageProtocols.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="协议适配器版本">
                      <Input
                        value={target.adapterVersion}
                        onChange={(e) => updateTarget({ adapterVersion: e.target.value })}
                      />
                    </Field>
                    <Field label="目标类型">
                      <select
                        className={selectClass}
                        disabled={target.adapter === "runninghub-workflow"}
                        value={target.kind}
                        onChange={(e) =>
                          updateTarget({
                            kind: e.target.value as "model" | "workflow",
                            workflowMapping:
                              e.target.value === "workflow"
                                ? { revision: 1, inputs: [], outputs: [] }
                                : undefined,
                          })
                        }
                      >
                        <option value="model">模型</option>
                        <option value="workflow">工作流</option>
                      </select>
                    </Field>
                    <Field
                      label={
                        target.kind === "workflow"
                          ? "远端工作流 ID（remoteId）"
                          : "远端模型 ID（remoteId）"
                      }
                    >
                      <Input
                        value={target.remoteId}
                        placeholder={target.kind === "workflow" ? "工作流 ID" : "模型 ID"}
                        onChange={(e) => updateTarget({ remoteId: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      声明目标能力（以供应商和后端实际验证为准）
                    </p>
                    <div className="flex flex-wrap gap-4">
                      {(Object.entries(imageOperationLabels) as [Operation, string][]).map(
                        ([op, label]) => (
                          <Toggle
                            key={op}
                            label={label}
                            checked={target.capabilities.operations.includes(op)}
                            onChange={(checked) =>
                              updateTarget({
                                capabilities: {
                                  ...target.capabilities,
                                  operations: checked
                                    ? [...target.capabilities.operations, op]
                                    : target.capabilities.operations.filter((v) => v !== op),
                                },
                              })
                            }
                          />
                        ),
                      )}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="最多输入图片">
                      <Input
                        type="number"
                        min={0}
                        max={16}
                        value={target.capabilities.maxInputs}
                        onChange={(e) =>
                          updateTarget({
                            capabilities: {
                              ...target.capabilities,
                              maxInputs: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                    <Field label="每次最多输出图片">
                      <Input
                        type="number"
                        min={1}
                        max={16}
                        value={target.capabilities.maxCount}
                        onChange={(e) =>
                          updateTarget({
                            capabilities: {
                              ...target.capabilities,
                              maxCount: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                  </div>
                  <div className="flex flex-wrap gap-4">
                    {(
                      [
                        ["supportsCancel", "可取消"],
                        ["supportsReconcile", "可核对结果"],
                        ["supportsContinuation", "可继续编辑"],
                        ["supportsPreview", "可预览"],
                      ] as const
                    ).map(([key, label]) => (
                      <Toggle
                        key={key}
                        label={label}
                        checked={target.capabilities[key]}
                        onChange={(checked) =>
                          updateTarget({ capabilities: { ...target.capabilities, [key]: checked } })
                        }
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-4">
                    {["png", "jpeg", "webp"].map((format) => (
                      <Toggle
                        key={format}
                        label={format.toUpperCase()}
                        checked={target.capabilities.outputFormats.includes(format)}
                        onChange={(checked) =>
                          updateTarget({
                            capabilities: {
                              ...target.capabilities,
                              outputFormats: checked
                                ? [...target.capabilities.outputFormats, format]
                                : target.capabilities.outputFormats.filter((f) => f !== format),
                            },
                          })
                        }
                      />
                    ))}
                  </div>
                  <details className="space-y-3 rounded-lg border border-border p-3">
                    <summary className="cursor-pointer text-sm">
                      高级：参数 schema 与工作流映射
                    </summary>
                    <p className="text-xs text-muted-foreground">
                      参数数组使用 key、label、type、required，可声明
                      enum、minimum、maximum、default、unit。仅填写公开参数，凭据请使用上方专用输入。
                    </p>
                    <Field label="参数 schema（JSON）">
                      <textarea
                        className="min-h-40 w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
                        value={
                          advanced[target.id]?.parameters ??
                          JSON.stringify(target.parameters, null, 2)
                        }
                        spellCheck={false}
                        onChange={(e) =>
                          setAdvanced((previous) => ({
                            ...previous,
                            [target.id]: { ...previous[target.id], parameters: e.target.value },
                          }))
                        }
                      />
                    </Field>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setAdvanced((previous) => ({
                          ...previous,
                          [target.id]: {
                            ...previous[target.id],
                            parameters: JSON.stringify(
                              [
                                {
                                  key: "quality",
                                  label: "质量",
                                  type: "string",
                                  required: false,
                                  enum: ["standard", "high"],
                                  default: "standard",
                                },
                              ],
                              null,
                              2,
                            ),
                          },
                        }))
                      }
                    >
                      填入参数示例
                    </Button>
                    {target.kind === "workflow" && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          RunningHub 映射使用 revision、inputs 和 outputs。每个参数须映射
                          parameterKey → nodeId / inputName，输出声明 nodeId / outputName。
                        </p>
                        <Field label="工作流字段映射（JSON）">
                          <textarea
                            className="min-h-40 w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
                            value={
                              advanced[target.id]?.workflow ??
                              JSON.stringify(
                                target.workflowMapping ?? { revision: 1, inputs: [], outputs: [] },
                                null,
                                2,
                              )
                            }
                            spellCheck={false}
                            onChange={(e) =>
                              setAdvanced((previous) => ({
                                ...previous,
                                [target.id]: { ...previous[target.id], workflow: e.target.value },
                              }))
                            }
                          />
                        </Field>
                      </>
                    )}
                  </details>
                  <Toggle
                    label="启用目标"
                    checked={target.enabled}
                    // 已启用的仍可关闭；未完成的适配器或停用的连接下不能再打开。
                    disabled={!target.enabled && targetEnableBlock !== ""}
                    onChange={(enabled) => updateTarget({ enabled })}
                  />
                  {targetEnableBlock && (
                    <p className="text-xs text-muted-foreground">{targetEnableBlock}</p>
                  )}
                  <Button
                    variant="destructive"
                    onClick={() => {
                      if (window.confirm(`确定删除目标“${target.name}”？保存设置后生效。`)) {
                        setDraft({
                          ...draft,
                          targets: draft.targets.filter((t) => t.id !== target.id),
                        });
                        setAdvanced((previous) => {
                          const next = { ...previous };
                          delete next[target.id];
                          return next;
                        });
                        setTargetId("");
                      }
                    }}
                  >
                    删除目标
                  </Button>
                </>
              )}
            </section>
          )}
        </fieldset>
      )}
    </div>
  );
}
