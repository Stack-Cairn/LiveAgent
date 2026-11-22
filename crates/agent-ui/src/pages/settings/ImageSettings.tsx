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
import { type ConfirmDialogOptions, useConfirmDialog } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
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
  /** Host navigation calls this guard before switching settings tabs/routes and
   * leaves only once it resolves to true (it asks through an in-app dialog when
   * there are unsaved edits); return a cleanup that unregisters this guard. */
  registerLeaveGuard?: (guard: () => boolean | Promise<boolean>) => () => void;
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
  const { t } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const ask = (options: Omit<ConfirmDialogOptions, "cancelLabel"> & { cancelLabel?: string }) =>
    confirm({ cancelLabel: t("confirmDialog.cancel"), ...options });
  // The leave guard is registered once; it reads the current locale through this ref.
  const confirmLeaveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  confirmLeaveRef.current = () =>
    ask({
      title: t("imageSettings.confirm.leaveTitle"),
      description: t("imageSettings.confirm.leaveDescription"),
      confirmLabel: t("imageSettings.confirm.leave"),
      cancelLabel: t("confirmDialog.keepEditing"),
    });
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
      ? t("imageSettings.enableBlock.unsupportedProtocol")
      : draft?.connections.some((c) => c.id === target.connectionId && !c.enabled)
        ? t("imageSettings.enableBlock.connectionDisabled")
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
    const unregister = registerLeaveGuard?.(() =>
      dirtyRef.current ? confirmLeaveRef.current() : true,
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
  async function selectConnection(id: string) {
    if (
      secretDirty &&
      !(await ask({
        title: t("imageSettings.confirm.switchConnectionTitle"),
        description: t("imageSettings.confirm.switchConnectionDescription"),
        confirmLabel: t("imageSettings.confirm.switchConnection"),
      }))
    )
      return;
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
      setError(t("imageSettings.error.invalidAdvanced"));
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
        setStatus(t("imageSettings.status.loadedReview"));
      } else {
        accept(latest);
        setStatus(t("imageSettings.status.loaded"));
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
        setStatus(t("imageSettings.status.saved"));
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
            setStatus(t("imageSettings.status.secretWritten"));
          }
        },
      );
      value = "";
      const response = await request;
      if (current() && response) {
        accept(response);
        setStatus(t("imageSettings.status.secretBound"));
      }
    } catch (reason) {
      if (current()) setStatus(t("imageSettings.status.secretUncertain"));
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
      wasMutation
        ? t("imageSettings.status.stoppedMutation")
        : t("imageSettings.status.stoppedLoad"),
    );
  }
  async function cancelEdits() {
    if (
      dirty &&
      !(await ask({
        title: t("imageSettings.confirm.cancelEditsTitle"),
        description: t("imageSettings.confirm.cancelEditsDescription"),
        confirmLabel: t("imageSettings.confirm.cancelEdits"),
      }))
    )
      return;
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
    setStatus(t("imageSettings.status.discarded"));
    // An ambiguous write still requires a fresh read, even after local discard.
  }
  async function resolveConflict(prefer: "local" | "remote") {
    if (!saved || !remote) return;
    const local = advancedSettings();
    if (!local) return;
    const result = mergeImageSettings(saved, local, remote, prefer);
    if (
      result.conflicts.length &&
      !(await ask({
        title: t("imageSettings.confirm.mergeTitle"),
        description: t(
          prefer === "local"
            ? "imageSettings.confirm.mergeDescriptionLocal"
            : "imageSettings.confirm.mergeDescriptionRemote",
        ).replace("{count}", String(result.conflicts.length)),
        confirmLabel: t("imageSettings.confirm.merge"),
        tone: "default",
      }))
    )
      return;
    setSaved(remote);
    setDraft(result.draft);
    setRemote(null);
    setReviewRequired(false);
    setAdvanced({});
    clearSecret();
    setError("");
    setStatus(t("imageSettings.status.merged"));
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
          {panel === "connections"
            ? t("imageSettings.title.connections")
            : panel === "targets"
              ? t("imageSettings.title.targets")
              : t("imageSettings.title.all")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {panel === "connections"
            ? t("imageSettings.description.connections")
            : panel === "targets"
              ? t("imageSettings.description.targets")
              : t("imageSettings.description.all")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!!busy || !draft || !publicDirty || reviewRequired || secretDirty}
          onClick={() => void save()}
        >
          {t("imageSettings.save")}
        </Button>
        <Button variant="outline" disabled={!!busy} onClick={() => void refresh()}>
          {t("imageSettings.reload")}
        </Button>
        <Button variant="ghost" disabled={!!busy || !dirty} onClick={() => void cancelEdits()}>
          {t("imageSettings.cancelEdits")}
        </Button>
        {busy && (
          <Button variant="ghost" onClick={stopWaiting}>
            {t("imageSettings.stopWaiting")}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {busy
            ? t("imageSettings.state.busy")
            : dirty
              ? t("imageSettings.state.dirty")
              : t("imageSettings.state.synced")}
          {saved
            ? t("imageSettings.state.revision").replace("{revision}", String(saved.revision))
            : ""}
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
          aria-label={t("imageSettings.conflict.label")}
        >
          <p className="text-sm">
            {t("imageSettings.conflict.draftKept")}
            {remote
              ? t("imageSettings.conflict.summary")
                  .replace("{revision}", String(remote.revision))
                  .replace("{count}", String(conflicts.length))
              : t("imageSettings.conflict.readFirst")}
          </p>
          {remote && (
            <>
              <p className="text-xs text-muted-foreground">
                {t("imageSettings.conflict.mergeHint")}
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
                  onClick={() => void resolveConflict("local")}
                >
                  {t("imageSettings.conflict.mergeLocal")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void resolveConflict("remote")}
                >
                  {t("imageSettings.conflict.mergeRemote")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!!busy}
                  onClick={async () => {
                    const confirmed = await ask({
                      title: t("imageSettings.confirm.adoptRemoteTitle"),
                      description: t("imageSettings.confirm.adoptRemoteDescription"),
                      confirmLabel: t("imageSettings.confirm.adoptRemote"),
                    });
                    if (confirmed) {
                      accept(remote);
                      clearSecret();
                      setError("");
                      setStatus(t("imageSettings.status.adoptedRemote"));
                    }
                  }}
                >
                  {t("imageSettings.conflict.adoptRemote")}
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
                <h3 className="text-sm font-semibold">{t("imageSettings.connections")}</h3>
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (
                      secretDirty &&
                      !(await ask({
                        title: t("imageSettings.confirm.addConnectionTitle"),
                        description: t("imageSettings.confirm.addConnectionDescription"),
                        confirmLabel: t("imageSettings.confirm.addConnection"),
                      }))
                    )
                      return;
                    clearSecret();
                    const next = newImageConnection(
                      `ic_${crypto.randomUUID().replaceAll("-", "")}`,
                    );
                    setDraft({ ...draft, connections: [...draft.connections, next] });
                    setConnectionId(next.id);
                  }}
                >
                  {t("imageSettings.addConnection")}
                </Button>
              </div>
              <Field label={t("imageSettings.selectConnection")}>
                <select
                  className={selectClass}
                  value={connection?.id ?? ""}
                  onChange={(e) => void selectConnection(e.target.value)}
                >
                  <option value="" disabled>
                    {t("imageSettings.selectConnectionPlaceholder")}
                  </option>
                  {draft.connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              {!draft.connections.length && (
                <p className="text-sm text-muted-foreground">{t("imageSettings.noConnections")}</p>
              )}
              {connection && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("imageSettings.connectionName")}>
                      <Input
                        value={connection.name}
                        onChange={(e) => updateConnection({ name: e.target.value })}
                      />
                    </Field>
                    <Field label={t("imageSettings.vendor")}>
                      <Input
                        value={connection.vendor}
                        placeholder={t("imageSettings.vendorPlaceholder")}
                        onChange={(e) => updateConnection({ vendor: e.target.value })}
                      />
                    </Field>
                    <Field label={t("imageSettings.credentialSource")}>
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
                        <option value="independent">
                          {t("imageSettings.credentialSource.independent")}
                        </option>
                        {/* Provider image models already appear in the workbench; this option only remains for older connections. */}
                        {connection.binding.kind === "provider_ref" && (
                          <option value="provider_ref">
                            {t("imageSettings.credentialSource.providerRef")}
                          </option>
                        )}
                      </select>
                    </Field>
                    <Field label={t("imageSettings.maxConcurrent")}>
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
                      <Field label={t("imageSettings.providerId")}>
                        <Input
                          value={connection.binding.providerId}
                          placeholder={t("imageSettings.providerIdPlaceholder")}
                          onChange={(e) =>
                            updateConnection({
                              binding: { kind: "provider_ref", providerId: e.target.value },
                            })
                          }
                        />
                      </Field>
                      <p className="text-xs text-muted-foreground">
                        {t("imageSettings.providerRefHint")}
                      </p>
                    </>
                  ) : (
                    <>
                      <Field label={t("imageSettings.baseUrl")}>
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
                      <Field label={t("imageSettings.authKind")}>
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
                          <option value="api_key_header">
                            {t("imageSettings.authKind.apiKeyHeader")}
                          </option>
                          <option value="signed_request">
                            {t("imageSettings.authKind.signedRequest")}
                          </option>
                        </select>
                      </Field>
                      <Toggle
                        label={t("imageSettings.useSystemProxy")}
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
                          {connection.credentialConfigured
                            ? t("imageSettings.credential.configured")
                            : t("imageSettings.credential.missing")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {canWriteSecret
                            ? t("imageSettings.credential.hint")
                            : t("imageSettings.credential.saveFirst")}
                        </p>
                        <Field label={t("imageSettings.credential.purpose")}>
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
                        <Field label={t("imageSettings.credential.new")}>
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
                            {t("imageSettings.credential.write")}
                          </Button>
                          <Button variant="ghost" disabled={!secretDirty} onClick={clearSecret}>
                            {t("imageSettings.credential.clear")}
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                  <Toggle
                    label={t("imageSettings.enableConnection")}
                    checked={connection.enabled}
                    onChange={(enabled) => updateConnection({ enabled })}
                  />
                  {dependencies.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("imageSettings.dependents").replace(
                        "{targets}",
                        dependencies
                          .map((item) => item.name)
                          .join(t("imageSettings.listSeparator")),
                      )}
                    </p>
                  )}
                  <Button
                    variant="destructive"
                    disabled={dependencies.length > 0}
                    onClick={async () => {
                      const confirmed = await ask({
                        title: t("imageSettings.confirm.deleteConnectionTitle").replace(
                          "{name}",
                          connection.name,
                        ),
                        description: t("imageSettings.confirm.deleteDescription"),
                        confirmLabel: t("imageSettings.confirm.delete"),
                      });
                      if (confirmed) {
                        setDraft(removeImageConnection(draft, connection.id));
                        clearSecret();
                        setConnectionId("");
                      }
                    }}
                  >
                    {t("imageSettings.deleteConnection")}
                  </Button>
                </>
              )}
            </section>
          )}
          {panel === "targets" && draft.connections.length === 0 && (
            <p role="status">{t("imageSettings.noBackendConnections")}</p>
          )}
          {panel !== "connections" && (
            <section className="space-y-3 rounded-xl bg-settings-tile p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t("imageSettings.targets")}</h3>
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
                  {t("imageSettings.addTarget")}
                </Button>
              </div>
              <Field label={t("imageSettings.selectTarget")}>
                <select
                  className={selectClass}
                  value={target?.id ?? ""}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="" disabled>
                    {t("imageSettings.selectTargetPlaceholder")}
                  </option>
                  {draft.targets.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.enabled ? "" : t("imageSettings.targetDisabledSuffix")}
                    </option>
                  ))}
                </select>
              </Field>
              {target && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("imageSettings.targetName")}>
                      <Input
                        value={target.name}
                        onChange={(e) => updateTarget({ name: e.target.value })}
                      />
                    </Field>
                    <Field label={t("imageSettings.targetConnection")}>
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
                    <Field label={t("imageSettings.protocol")}>
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
                          <option value={target.adapter}>
                            {t("imageSettings.protocolCurrent")}
                          </option>
                        )}
                        {imageProtocols.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t("imageSettings.adapterVersion")}>
                      <Input
                        value={target.adapterVersion}
                        onChange={(e) => updateTarget({ adapterVersion: e.target.value })}
                      />
                    </Field>
                    <Field label={t("imageSettings.kind")}>
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
                        <option value="model">{t("imageSettings.kind.model")}</option>
                        <option value="workflow">{t("imageSettings.kind.workflow")}</option>
                      </select>
                    </Field>
                    <Field
                      label={
                        target.kind === "workflow"
                          ? t("imageSettings.remoteId.workflow")
                          : t("imageSettings.remoteId.model")
                      }
                    >
                      <Input
                        value={target.remoteId}
                        placeholder={
                          target.kind === "workflow"
                            ? t("imageSettings.remoteIdPlaceholder.workflow")
                            : t("imageSettings.remoteIdPlaceholder.model")
                        }
                        onChange={(e) => updateTarget({ remoteId: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {t("imageSettings.capabilitiesHint")}
                    </p>
                    <div className="flex flex-wrap gap-4">
                      {(Object.keys(imageOperationLabels) as Operation[]).map((op) => (
                        <Toggle
                          key={op}
                          label={t(`imageSettings.operation.${op}`)}
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
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("imageSettings.maxInputs")}>
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
                    <Field label={t("imageSettings.maxCount")}>
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
                        ["supportsCancel", "capability.cancel"],
                        ["supportsReconcile", "capability.reconcile"],
                        ["supportsContinuation", "capability.continuation"],
                        ["supportsPreview", "capability.preview"],
                      ] as const
                    ).map(([key, label]) => (
                      <Toggle
                        key={key}
                        label={t(`imageSettings.${label}`)}
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
                      {t("imageSettings.advanced.summary")}
                    </summary>
                    <p className="text-xs text-muted-foreground">
                      {t("imageSettings.advanced.parametersHint")}
                    </p>
                    <Field label={t("imageSettings.advanced.parameters")}>
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
                                  label: t("imageSettings.advanced.exampleQuality"),
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
                      {t("imageSettings.advanced.fillExample")}
                    </Button>
                    {target.kind === "workflow" && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          {t("imageSettings.advanced.workflowHint")}
                        </p>
                        <Field label={t("imageSettings.advanced.workflow")}>
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
                    label={t("imageSettings.enableTarget")}
                    checked={target.enabled}
                    // An enabled target can always be turned off; it cannot be turned on for an unfinished adapter or a disabled connection.
                    disabled={!target.enabled && targetEnableBlock !== ""}
                    onChange={(enabled) => updateTarget({ enabled })}
                  />
                  {targetEnableBlock && (
                    <p className="text-xs text-muted-foreground">{targetEnableBlock}</p>
                  )}
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      const confirmed = await ask({
                        title: t("imageSettings.confirm.deleteTargetTitle").replace(
                          "{name}",
                          target.name,
                        ),
                        description: t("imageSettings.confirm.deleteDescription"),
                        confirmLabel: t("imageSettings.confirm.delete"),
                      });
                      if (confirmed) {
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
                    {t("imageSettings.deleteTarget")}
                  </Button>
                </>
              )}
            </section>
          )}
        </fieldset>
      )}
      {dialog}
    </div>
  );
}
