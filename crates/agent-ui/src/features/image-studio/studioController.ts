import type {
  CreateJobRequest,
  ExportDestination,
  GenerationParams,
  ImageStudioClient,
  ImageTarget,
  InputAsset,
  Operation,
  ParamCorrection,
} from "../../lib/imaging/types";
import {
  type DraftScope,
  type DraftStorage,
  draftKey,
  maintainParent,
  restoreDraft,
  restoreSubmission,
  restoreSubmissionHistory,
  type StudioDraft,
  serializeDraft,
  serializeSubmission,
  submissionKey,
  verifyDraftAssets,
} from "./drafts";
import { ImageEventStreams } from "./imageEventStreams";
import { allowedFields, defaultParams, pruneParams } from "./paramsBarModel";
import {
  applyJobSnapshot,
  errorAction,
  type FrozenSubmission,
  freezeSubmission,
  initialStudioState,
  markSubmissionUnknown,
  type StudioState,
  submissionWasRejected,
} from "./studioModel";

export interface StudioView {
  state: StudioState;
  targets: ImageTarget[];
  supported: boolean | null;
  loading: boolean;
  projectId: string;
  projectCursor?: string;
  jobCursor?: string;
  draft: StudioDraft;
  operation: Operation;
  count: number;
  notice: string;
  uploading: boolean;
  draftReady: boolean;
  submission: FrozenSubmission | null;
  submissionHistory: FrozenSubmission[];
  dropped: string[];
  unverifiedAssetIds: string[];
  verifyingInputs: boolean;
  /** What the backend actually used for each accepted job, keyed by job id. */
  applied: Record<string, { params: GenerationParams; corrections: ParamCorrection[] }>;
}
const emptyDraft = (): StudioDraft => ({ prompt: "", targetId: "", parameters: {}, inputs: [] });
export class ImageStudioController {
  view: StudioView;
  private listeners = new Set<() => void>();
  private disposed = false;
  private epoch = 0;
  private pendingSubmit = false;
  private submissions = new Map<string, FrozenSubmission | null>();
  private submissionHistories = new Map<string, FrozenSubmission[]>();
  private inputRevision = 0;
  private targetRefresh = 0;
  private uploadAbort?: AbortController;
  private scopeAbort = new AbortController();
  private streams: ImageEventStreams;
  constructor(
    public client: ImageStudioClient,
    private ownerId: string,
    private backendId: string,
    private storage?: DraftStorage,
  ) {
    this.view = {
      state: initialStudioState(ownerId, backendId),
      targets: [],
      supported: null,
      loading: true,
      projectId: "",
      draft: emptyDraft(),
      operation: "generate",
      count: 1,
      notice: "",
      uploading: false,
      draftReady: false,
      submission: null,
      submissionHistory: [],
      dropped: [],
      unverifiedAssetIds: [],
      verifyingInputs: false,
      applied: {},
    };
    this.streams = this.newStreams();
  }
  private newStreams() {
    return new ImageEventStreams(
      this.client,
      () => this.view.state,
      (state) => this.patch({ state }),
      (notice) => this.patch({ notice }),
    );
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.view;
  private patch(patch: Partial<StudioView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private valid(epoch: number) {
    return !this.disposed && epoch === this.epoch;
  }
  private scope() {
    return { ownerId: this.ownerId, backendId: this.backendId, projectId: this.view.projectId };
  }
  /** Unified parameters for the current draft, limited to what the target takes. */
  get params(): GenerationParams {
    return pruneParams(this.target, this.view.draft.parameters);
  }
  setParams(params: GenerationParams) {
    this.updateDraft({ parameters: { ...params } });
  }
  private persist() {
    if (!this.view.projectId || !this.view.draftReady) return;
    const scope = this.scope();
    try {
      this.storage?.setItem(
        draftKey(scope.ownerId, scope.backendId, scope.projectId),
        serializeDraft(scope, this.view.draft, this.view.targets),
      );
    } catch {
      this.patch({ notice: "本地草稿保存失败，请保留当前页面。" });
    }
  }
  private saveSubmission(scope: DraftScope, submission: FrozenSubmission | null): boolean {
    const key = submissionKey(scope);
    this.submissions.set(key, submission);
    const history = this.submissionHistories.get(key) ?? [];
    try {
      if (submission || history.length)
        this.storage?.setItem(key, serializeSubmission(scope, submission, history));
      else this.storage?.removeItem(key);
      return true;
    } catch {
      if (this.view.projectId === scope.projectId)
        this.patch({ notice: "提交记录保存失败，请保留当前页面并恢复本地存储后核对原请求。" });
      return false;
    }
  }
  private settleSubmission(scope: DraftScope, key: string, result: FrozenSubmission | null) {
    const scopeKey = submissionKey(scope);
    const current = this.submissions.get(scopeKey) ?? null;
    // Late responses can settle history, but cannot replace the active intent.
    if (current?.key !== key) {
      const history = this.submissionHistories.get(scopeKey) ?? [];
      if (result?.status === "accepted" && history.some((item) => item.key === key)) {
        this.submissionHistories.set(
          scopeKey,
          history.map((item) => (item.key === key ? result : item)),
        );
        this.saveSubmission(scope, current);
      }
      return current;
    }
    if (current.status === "accepted" && result?.status !== "accepted") return current;
    this.saveSubmission(scope, result);
    return result;
  }
  async start() {
    this.persist();
    this.disposed = false;
    this.scopeAbort = new AbortController();
    this.streams.close();
    this.streams = this.newStreams();
    const epoch = ++this.epoch;
    this.patch({ loading: true, draftReady: false, notice: "" });
    try {
      const capabilities = await this.client.capabilities();
      if (!this.valid(epoch)) return;
      this.patch({ supported: capabilities.supported });
      if (!capabilities.supported) return;
      const [targets, projects] = await Promise.all([
        this.client.listTargets(),
        this.client.listProjects(),
      ]);
      if (!this.valid(epoch)) return;
      this.patch({
        targets,
        state: { ...this.view.state, projects: projects.items },
        projectCursor: projects.nextCursor,
      });
      // Projects are not shown: everything lives in one default project that is
      // created on first use, so the workbench opens straight to the input box.
      let project = projects.items[0];
      if (!project) {
        project = await this.client.createProject("默认");
        if (!this.valid(epoch)) return;
        this.patch({ state: { ...this.view.state, projects: [project] } });
      }
      await this.selectProject(project.id);
    } catch {
      if (this.valid(epoch)) this.patch({ notice: "图像工作台加载失败，请检查后端连接后重试。" });
    } finally {
      if (this.valid(epoch)) this.patch({ loading: false });
    }
  }
  dispose() {
    this.persist();
    this.disposed = true;
    this.epoch++;
    this.uploadAbort?.abort();
    this.scopeAbort.abort();
    this.streams.close();
  }
  updateDraft(patch: Partial<StudioDraft>) {
    const draft = maintainParent({ ...this.view.draft, ...patch });
    if (patch.inputs || "parentAssetId" in patch) this.inputRevision++;
    this.patch({
      draft,
      unverifiedAssetIds: this.view.unverifiedAssetIds.filter((id) =>
        draft.inputs.some((input) => input.assetId === id),
      ),
    });
    this.persist();
  }
  setOperation(operation: Operation) {
    if (!this.target?.capabilities.operations.includes(operation)) return;
    this.patch({ operation });
    this.updateDraft({ inputs: [], parentAssetId: undefined });
  }
  /** 文生图 without reference images, 图生图 with them. */
  get mode(): "text" | "image" {
    return this.view.draft.inputs.length ? "image" : "text";
  }
  /** Whether the current model can take reference images at all. */
  get acceptsImages(): boolean {
    const target = this.target;
    return (
      !!target?.capabilities.operations.includes("reference") && target.capabilities.maxInputs > 0
    );
  }
  removeInput(assetId: string) {
    this.updateDraft({
      inputs: this.view.draft.inputs.filter((input) => input.assetId !== assetId),
    });
  }
  /** The send button: replays an unconfirmed request, otherwise always starts
   * a new task, like sending another chat message. */
  async send() {
    const previous = this.view.submission;
    if (previous?.status === "submitting") return;
    await this.submit(previous?.status === "accepted");
  }
  setCount(count: number) {
    this.patch({ count });
  }

  get target() {
    return this.view.targets.find((target) => target.id === this.view.draft.targetId);
  }
  setTarget(id: string) {
    const next = this.view.targets.find((target) => target.id === id);
    if (next) this.applyTarget(next, this.target);
  }
  public async refreshTargets(): Promise<void> {
    const epoch = this.epoch;
    const refresh = ++this.targetRefresh;
    try {
      const targets = await this.client.listTargets();
      if (!this.valid(epoch) || refresh !== this.targetRefresh) return;
      const previous = this.target;
      const next = targets.find((target) => target.id === this.view.draft.targetId);
      this.patch({ targets });
      if (next) {
        const pendingDrops = this.view.dropped;
        this.applyTarget(next, previous);
        this.patch({ dropped: [...new Set([...pendingDrops, ...this.view.dropped])] });
        if (!next.enabled)
          this.patch({ notice: next.disabledReason || "当前目标已停用，请选择已启用的目标。" });
      } else if (this.view.draft.targetId) {
        this.patch({ notice: "当前目标已删除，请重新选择目标；草稿与原提交记录已保留。" });
      } else {
        this.patch({ notice: "" });
      }
    } catch {
      if (this.valid(epoch) && refresh === this.targetRefresh)
        this.patch({ notice: "图像目标刷新失败，请检查连接后重试。" });
    }
  }
  private applyTarget(next: ImageTarget, previous: ImageTarget | undefined) {
    // Unified parameters carry across models: unsupported ones are kept in the
    // draft but greyed out and omitted on submit, so nothing needs confirming.
    const migration = {
      values: {
        ...defaultParams(next),
        ...(previous ? this.view.draft.parameters : {}),
      } as Record<string, unknown>,
      dropped: [] as string[],
    };
    const operation = next.capabilities.operations.includes(this.view.operation)
      ? this.view.operation
      : (next.capabilities.operations[0] ?? "generate");
    const hasInputs = this.view.draft.inputs.length > 0;
    this.patch({
      operation,
      count: Math.min(this.view.count, next.capabilities.maxCount),
      dropped: migration.dropped,
      notice: hasInputs ? "已切换模型，参考图会保留。" : "",
    });
    const allowed =
      operation === "generate"
        ? []
        : operation === "reference"
          ? ["reference"]
          : operation === "edit"
            ? ["source", "reference"]
            : ["source", "mask"];
    void allowed;
    this.updateDraft({
      targetId: next.id,
      parameters: migration.values,
      // Reference images stay; the send button explains if the model cannot take them.
      inputs: this.view.draft.inputs,
    });
  }
  acknowledgeMigration() {
    this.patch({ dropped: [] });
  }
  async selectProject(projectId: string) {
    if (projectId === this.view.projectId && this.view.draftReady) return;
    this.persist();
    this.epoch++;
    const epoch = this.epoch;
    this.uploadAbort?.abort();
    this.scopeAbort.abort();
    this.scopeAbort = new AbortController();
    this.streams.close();
    this.streams = this.newStreams();
    this.pendingSubmit = false;
    const state = initialStudioState(this.ownerId, this.backendId);
    state.projects = this.view.state.projects;
    const target = this.view.targets.find((item) => item.enabled) ?? this.view.targets[0];
    this.patch({
      projectId,
      state,
      jobCursor: undefined,
      draft: {
        ...emptyDraft(),
        targetId: target?.id ?? "",
        parameters: target ? { ...defaultParams(target) } : {},
      },
      operation: target?.capabilities.operations[0] ?? "generate",
      count: 1,
      submission: null,
      submissionHistory: [],
      uploading: false,
      draftReady: false,
      dropped: [],
      unverifiedAssetIds: [],
      verifyingInputs: false,
      notice: "",
      loading: true,
    });
    const scope = this.scope();
    const signal = this.scopeAbort.signal;
    const loadDraft = async () => {
      try {
        const raw =
          this.storage?.getItem(draftKey(this.ownerId, this.backendId, projectId)) ?? null;
        const key = submissionKey(scope);
        const saved = this.storage?.getItem(key) ?? null;
        const stored = this.submissions.has(key)
          ? (this.submissions.get(key) ?? null)
          : restoreSubmission(saved, scope);
        this.submissionHistories.get(key) ?? restoreSubmissionHistory(saved, scope);
        const restored = await restoreDraft(raw, scope, this.view.targets, async (id) => {
          await this.client.readAsset(id, "thumbnail", signal);
          return true;
        });
        if (!this.valid(epoch)) return;
        if (raw && !restored) throw new Error("Saved draft could not be restored");
        const cached = this.submissions.has(key) ? (this.submissions.get(key) ?? null) : stored;
        const submission = cached?.status === "submitting" ? markSubmissionUnknown(cached) : cached;
        this.submissions.set(key, submission);
        this.patch({
          submission,
          draftReady: true,
          ...(restored
            ? { draft: restored.draft, unverifiedAssetIds: restored.unverifiedAssetIds }
            : {}),
        });
        if (restored?.unverifiedAssetIds.length)
          this.patch({ notice: "部分输入图片暂时无法核验，引用已保留，请重验后提交。" });
        else if (restored?.invalidAssetIds.length)
          this.patch({ notice: `${restored.invalidAssetIds.length} 张输入图已失效，请重新上传。` });
        if (submission?.status === "unknown")
          this.patch({ notice: "已恢复未确认提交，请先核对原请求；将复用冻结请求和原幂等键。" });
        if (restored?.draft.inputs.length) {
          const roles = restored.draft.inputs.map((input) => input.role);
          const desired = roles.includes("mask")
            ? "mask"
            : roles.includes("source")
              ? "edit"
              : "reference";
          if (this.target?.capabilities.operations.includes(desired))
            this.patch({ operation: desired });
          else this.patch({ notice: "草稿输入与当前目标能力不兼容，请调整操作或重新上传。" });
        }
      } catch {
        if (this.valid(epoch))
          this.patch({ notice: "本地草稿或提交记录读取失败，请刷新页面重试。" });
      }
    };
    const loadHistory = async () => {
      try {
        const page = await this.client.listJobs(projectId);
        if (!this.valid(epoch)) return;
        let state = this.view.state;
        for (const job of page.items) state = applyJobSnapshot(state, job);
        this.patch({ state, jobCursor: page.nextCursor });
        for (const job of page.items) this.streams.watch(job);
      } catch {
        if (this.valid(epoch)) this.patch({ notice: "历史记录加载失败，草稿已保留。" });
      }
    };
    await Promise.all([loadDraft(), loadHistory()]);
    if (this.valid(epoch)) this.patch({ loading: false });
  }
  async moreProjects() {
    const epoch = this.epoch;
    const cursor = this.view.projectCursor;
    if (!cursor) return;
    try {
      const page = await this.client.listProjects(cursor);
      if (this.valid(epoch))
        this.patch({
          state: {
            ...this.view.state,
            projects: [
              ...new Map(
                [...this.view.state.projects, ...page.items].map((p) => [p.id, p]),
              ).values(),
            ],
          },
          projectCursor: page.nextCursor,
        });
    } catch {
      if (this.valid(epoch)) this.patch({ notice: "更多项目加载失败，请重试。" });
    }
  }
  async moreJobs() {
    const epoch = this.epoch;
    const cursor = this.view.jobCursor;
    if (!cursor) return;
    try {
      const page = await this.client.listJobs(this.view.projectId, cursor);
      if (!this.valid(epoch)) return;
      let state = this.view.state;
      for (const job of page.items) state = applyJobSnapshot(state, job);
      this.patch({ state, jobCursor: page.nextCursor });
      for (const job of page.items) this.streams.watch(job);
    } catch {
      if (this.valid(epoch)) this.patch({ notice: "更多历史加载失败，请重试。" });
    }
  }
  async createProject(title: string) {
    if (!title.trim()) return;
    const epoch = this.epoch;
    try {
      const project = await this.client.createProject(title.trim());
      if (!this.valid(epoch)) return;
      this.patch({
        state: { ...this.view.state, projects: [project, ...this.view.state.projects] },
      });
      await this.selectProject(project.id);
    } catch {
      if (this.valid(epoch)) this.patch({ notice: "项目创建失败，请重试。" });
    }
  }
  async renameProject(title: string) {
    const project = this.view.state.projects.find((p) => p.id === this.view.projectId);
    if (!project || !title.trim()) return;
    const epoch = this.epoch;
    try {
      const updated = await this.client.updateProject(project.id, title.trim(), project.revision);
      if (this.valid(epoch))
        this.patch({
          state: {
            ...this.view.state,
            projects: this.view.state.projects.map((p) => (p.id === updated.id ? updated : p)),
          },
        });
    } catch {
      if (this.valid(epoch))
        this.patch({ notice: "项目重命名失败，可能已被其他页面修改；请刷新项目列表后重试。" });
    }
  }
  async deleteProject() {
    const projectId = this.view.projectId;
    const epoch = this.epoch;
    try {
      await this.client.deleteProject(projectId);
      if (!this.valid(epoch)) return;
      this.patch({ draftReady: false });
      this.submissions.delete(submissionKey(this.scope()));
      try {
        this.storage?.removeItem(draftKey(this.ownerId, this.backendId, projectId));
        this.storage?.removeItem(submissionKey(this.scope()));
      } catch {
        this.patch({ notice: "项目已删除，但本地草稿清理失败。" });
      }
      const projects = this.view.state.projects.filter((project) => project.id !== projectId);
      this.patch({ state: { ...this.view.state, projects } });
      if (projects[0]) await this.selectProject(projects[0].id);
      else {
        this.epoch++;
        this.streams.close();
        this.streams = this.newStreams();
        this.uploadAbort?.abort();
        this.scopeAbort.abort();
        this.patch({
          projectId: "",
          state: { ...initialStudioState(this.ownerId, this.backendId), projects },
          draft: emptyDraft(),
          submission: null,
          submissionHistory: [],
        });
      }
    } catch {
      if (this.valid(epoch)) this.patch({ notice: "项目删除失败，请重试。" });
    }
  }
  selectAsset(id: string) {
    this.patch({ state: { ...this.view.state, selectedAssetId: id } });
  }
  /** "以此图生成": put a result into the input box as a reference image. */
  editAsset(id: string) {
    if (!this.acceptsImages) {
      this.patch({ notice: "当前模型不支持图生图，请换一个模型。" });
      return;
    }
    if (this.view.draft.inputs.some((input) => input.assetId === id)) return;
    this.patch({ operation: "reference", notice: "" });
    this.updateDraft({ inputs: [...this.view.draft.inputs, { assetId: id, role: "reference" }] });
  }
  cancelUpload() {
    this.uploadAbort?.abort();
    this.patch({ uploading: false, notice: "上传已取消，草稿已保留。" });
  }
  async upload(file: Blob, name: string, role: InputAsset["role"]) {
    if (this.view.uploading || !this.view.projectId) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 20 * 1024 * 1024
    ) {
      this.patch({ notice: "请导入不超过 20 MiB 的 PNG、JPEG 或 WebP 图片。" });
      return;
    }
    if (this.view.draft.inputs.length >= (this.target?.capabilities.maxInputs ?? 0)) {
      this.patch({ notice: "已达到当前目标输入图片上限。" });
      return;
    }
    const epoch = this.epoch;
    const controller = new AbortController();
    this.uploadAbort = controller;
    this.patch({ uploading: true });
    try {
      const asset = await this.client.upload(file, name, controller.signal);
      if (!this.valid(epoch) || controller.signal.aborted) return;
      if (!asset.available) throw new Error("unavailable");
      this.patch({
        state: { ...this.view.state, assets: { ...this.view.state.assets, [asset.id]: asset } },
      });
      this.updateDraft({ inputs: [...this.view.draft.inputs, { assetId: asset.id, role }] });
    } catch {
      if (this.valid(epoch) && !controller.signal.aborted)
        this.patch({ notice: "图片上传失败，请重新上传；草稿已保留。" });
    } finally {
      if (this.valid(epoch) && this.uploadAbort === controller) this.patch({ uploading: false });
    }
  }
  async revalidateInputs() {
    if (this.view.verifyingInputs || !this.view.draftReady) return;
    const epoch = this.epoch;
    const revision = this.inputRevision;
    const signal = this.scopeAbort.signal;
    this.patch({ verifyingInputs: true });
    try {
      const verified = await verifyDraftAssets(this.view.draft, async (id) => {
        await this.client.readAsset(id, "thumbnail", signal);
        return true;
      });
      if (!this.valid(epoch) || revision !== this.inputRevision) return;
      this.patch({ unverifiedAssetIds: verified.unverifiedAssetIds });
      this.updateDraft({
        inputs: verified.draft.inputs,
        parentAssetId: verified.draft.parentAssetId,
      });
      this.patch({
        notice: verified.unverifiedAssetIds.length
          ? "部分输入图片仍无法核验，引用已保留，请检查连接或认证后重验。"
          : verified.invalidAssetIds.length
            ? "已移除确定失效的输入图片，请重新上传。"
            : "输入图片核验通过。",
      });
    } finally {
      if (this.valid(epoch)) this.patch({ verifyingInputs: false });
    }
  }
  validation(): string[] {
    const { draft, count, operation, projectId, uploading, dropped, draftReady } = this.view;
    const target = this.target;
    if (!target) return ["请先在“图像服务”里添加服务并选择模型。"];
    if (!target.enabled) return [target.disabledReason || "当前模型不可用，请在图像服务中检查。"];
    const errors: string[] = [];
    const size = this.params.size;
    if (allowedFields(target).has("size") && size !== "auto" && !/^\d{2,5}x\d{2,5}$/.test(size))
      errors.push("尺寸格式应为 宽x高，例如 1600x900。");
    if (!projectId || !draftReady) errors.push("正在加载，请稍候。");
    if (!draft.prompt.trim()) errors.push("请输入提示词。");
    void operation;
    if (draft.inputs.length && !this.acceptsImages)
      errors.push("当前模型不支持图生图，请移除参考图或换一个模型。");
    if (!Number.isInteger(count) || count < 1 || count > Math.min(16, target.capabilities.maxCount))
      errors.push("请调整生成数量。");
    if (uploading) errors.push("请等待图片上传完成。");
    if (this.view.verifyingInputs || this.view.unverifiedAssetIds.length)
      errors.push("输入图片尚未核验通过，请重验后提交。");
    if (draft.parentAssetId && !draft.inputs.some((input) => input.assetId === draft.parentAssetId))
      errors.push("父图片必须包含在输入图片中，请重新关联或解除版本关联。");
    if (dropped.length) errors.push("请先确认参数调整。");
    if (draft.inputs.length > target.capabilities.maxInputs)
      errors.push(`当前模型最多接受 ${target.capabilities.maxInputs} 张参考图。`);
    return errors;
  }
  async regenerate(acceptedKey: string) {
    if (this.view.submission?.status !== "accepted" || this.view.submission.key !== acceptedKey)
      return;
    await this.submit(true);
  }
  async submit(explicitlyNew = false) {
    if (this.pendingSubmit || this.disposed || !this.view.draftReady) return;
    const previous = this.view.submission;
    if (previous?.status === "accepted" && !explicitlyNew) return;
    if (previous && previous.status !== "accepted" && explicitlyNew) {
      this.patch({ notice: "请先核对原请求，再确认重新生成。" });
      return;
    }
    if (!previous || explicitlyNew) {
      const errors = this.validation();
      if (errors.length) {
        this.patch({ notice: errors.join(" ") });
        return;
      }
    }
    const { draft, projectId, count } = this.view;
    const operation: Operation = draft.inputs.length ? "reference" : "generate";
    // The frozen request keeps the unified parameters in `parameters` so a
    // replay after an unknown response re-sends exactly the same intent.
    const params = { ...this.params, n: count };
    const request: CreateJobRequest = {
      projectId,
      targetId: draft.targetId,
      prompt: draft.prompt,
      parameters: params as unknown as CreateJobRequest["parameters"],
      inputs: draft.inputs.map((input) => ({ assetId: input.assetId, role: "reference" as const })),
      operation,
      count,
    };
    const submission = freezeSubmission(
      previous,
      request,
      () => crypto.randomUUID(),
      explicitlyNew,
    );
    const scope = this.scope();
    if (!this.saveSubmission(scope, { ...submission, status: "submitting" })) {
      this.patch({ submission: markSubmissionUnknown(submission) });
      return;
    }
    this.pendingSubmit = true;
    const epoch = this.epoch;
    this.patch({ submission: { ...submission, status: "submitting" }, notice: "" });
    try {
      const created = await this.createFrozen(submission.request, submission.key);
      const job = created.job;
      const accepted = this.settleSubmission(scope, submission.key, {
        ...submission,
        status: "accepted",
        jobId: job.id,
      });
      if (!this.valid(epoch)) return;
      const corrections = created.corrections ?? [];
      this.patch({
        state: applyJobSnapshot(this.view.state, job),
        submission: accepted,
        ...(created.appliedParams
          ? {
              applied: {
                ...this.view.applied,
                [job.id]: { params: created.appliedParams, corrections },
              },
            }
          : {}),
        ...(corrections.length
          ? { notice: `已按平台限制调整：${corrections.map((c) => c.reason).join("；")}。` }
          : {}),
      });
      this.streams.watch(job);
    } catch (error) {
      // Rejecting a replay (for example after auth expiry) does not settle the original attempt.
      const rejected = (!previous || explicitlyNew) && submissionWasRejected(error);
      const unresolved = this.settleSubmission(
        scope,
        submission.key,
        rejected ? null : markSubmissionUnknown(submission),
      );
      if (this.valid(epoch)) {
        this.patch({
          submission: unresolved,
          notice: rejected
            ? `请求已被拒绝。${errorAction(error)}草稿已保留。`
            : "提交响应未确认。请核对原请求，将复用冻结请求和同一幂等键。草稿已保留。",
        });
      }
    } finally {
      if (this.valid(epoch)) this.pendingSubmit = false;
    }
  }
  /** Submit a frozen request. Profile targets take the unified parameters and
   * let the backend convert them; old backends get the legacy native call. */
  private async createFrozen(request: CreateJobRequest, key: string) {
    const profiles = this.client.profiles;
    if (!profiles) return { job: await this.client.createJob(request, key) };
    const { parameters, ...rest } = request;
    const raw = parameters as unknown as Record<string, unknown>;
    const params: GenerationParams = {
      size: typeof raw.size === "string" ? raw.size : "auto",
      n: request.count,
    };
    for (const field of ["quality", "outputFormat", "moderation"] as const)
      if (typeof raw[field] === "string") params[field] = raw[field] as string;
    if (typeof raw.outputCompression === "number") params.outputCompression = raw.outputCompression;
    if (raw.transparentOutput === true) params.transparentOutput = true;
    return profiles.createJobWithParams({ ...rest, params }, key);
  }
  async refreshJob(id: string) {
    const epoch = this.epoch;
    try {
      const job = await this.client.getJob(id);
      if (!this.valid(epoch)) return;
      this.patch({ state: applyJobSnapshot(this.view.state, job) });
      this.streams.watch(job);
    } catch {
      if (this.valid(epoch)) this.patch({ notice: "任务核对失败，请稍后重试。" });
    }
  }
  async cancelJob(id: string) {
    const epoch = this.epoch;
    try {
      const job = await this.client.cancelJob(id);
      if (!this.valid(epoch)) return;
      this.patch({
        state: applyJobSnapshot(this.view.state, job),
        notice:
          job.cancelEffect === "local_only"
            ? "已停止本地处理，上游可能继续执行或计费。"
            : "已发送取消请求，以任务最终状态为准。",
      });
    } catch {
      if (this.valid(epoch)) this.patch({ notice: "取消响应未确认，请刷新核对任务。" });
    }
  }
  async exportAsset(id: string, destination: ExportDestination) {
    const epoch = this.epoch;
    try {
      const result = await this.client.exportAsset(id, destination);
      if (this.valid(epoch))
        this.patch({ notice: result.saved ? "图片已保存。" : "已取消导出，未保存图片。" });
    } catch (error) {
      if (this.valid(epoch))
        this.patch({ notice: `导出失败。${errorAction(error as { code?: string })}` });
    }
  }
}
