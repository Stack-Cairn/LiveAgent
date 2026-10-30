import type {
  CreateJobRequest,
  ExportDestination,
  ImageProject,
  ImageStudioClient,
  ImageTarget,
  InputAsset,
  Operation,
  ParameterSpec,
  Scalar,
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
import { composeFramedPrompt, splitFramedPrompt, usesPromptFraming } from "./framing";
import { ImageEventStreams } from "./imageEventStreams";
import { MAX_UPLOAD_BYTES, sniffImage, UPLOAD_MIMES } from "./imageSniff";
import { defaultParameters, migrateParameters, validateParameters } from "./parameterModel";
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
import { parameterLabel, type Translate } from "./studioText";

export interface PendingSubmission {
  projectId: string;
  submission: FrozenSubmission;
}
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
  /** Bumps on every non-empty notice, so an identical repeat restarts its timer. */
  noticeSeq: number;
  uploading: boolean;
  draftReady: boolean;
  submission: FrozenSubmission | null;
  submissionHistory: FrozenSubmission[];
  pendingSubmissions: PendingSubmission[];
  dropped: string[];
  unverifiedAssetIds: string[];
  verifyingInputs: boolean;
}
const emptyDraft = (): StudioDraft => ({ prompt: "", targetId: "", parameters: {}, inputs: [] });
function uploadFailureNotice(error: unknown): string {
  const { status, code } = (error ?? {}) as { status?: number; code?: string };
  if (status === 413 || code === "IMAGE_TOO_LARGE")
    return "上传失败：图片超过 20 MiB 上限，请压缩后再上传。";
  if (status === 422 || code === "IMAGE_INVALID_INPUT")
    return "上传失败：图片内容已损坏、无法解码或像素超过 4000 万，请换一张 PNG、JPEG 或 WebP 图片。";
  if (
    code === "IMAGE_NETWORK_ERROR" ||
    status === 0 ||
    code === "KBRAIN_TRANSPORT_UNAVAILABLE" ||
    error instanceof TypeError
  )
    return "上传失败：无法连接图像服务，请检查后端后重试；草稿已保留。";
  return "图片上传失败，请重新上传；草稿已保留。";
}

export class ImageStudioController {
  view: StudioView;
  private listeners = new Set<() => void>();
  private disposed = false;
  private epoch = 0;
  private pendingSubmit = false;
  private submissions = new Map<string, FrozenSubmission | null>();
  private submissionHistories = new Map<string, FrozenSubmission[]>();
  private inputRevision = 0;
  private draftRestore = 0;
  private targetRefresh = 0;
  private droppedSpecs = new Map<string, ParameterSpec>();
  private archiveCreation?: Promise<ImageProject>;
  private historyQueue: { projectId: string; cursor?: string }[] = [];
  private historyPage?: { epoch: number };
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
      noticeSeq: 0,
      uploading: false,
      draftReady: false,
      submission: null,
      submissionHistory: [],
      pendingSubmissions: [],
      dropped: [],
      unverifiedAssetIds: [],
      verifyingInputs: false,
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
    const announces = typeof patch.notice === "string" && patch.notice !== "";
    this.view = {
      ...this.view,
      ...patch,
      ...(announces ? { noticeSeq: this.view.noticeSeq + 1 } : {}),
    };
    this.view.pendingSubmissions = this.view.state.projects.flatMap(({ id: projectId }) => {
      const submission = this.submissions.get(
        submissionKey({ ownerId: this.ownerId, backendId: this.backendId, projectId }),
      );
      return submission && ["submitting", "unknown"].includes(submission.status)
        ? [{ projectId, submission }]
        : [];
    });
    for (const listener of this.listeners) listener();
  }
  private valid(epoch: number) {
    return !this.disposed && epoch === this.epoch;
  }
  private scope() {
    return { ownerId: this.ownerId, backendId: this.backendId, projectId: this.view.projectId };
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
        this.patch({ notice: "提交记录保存失败；若页面中断，请在历史中确认任务是否已创建。" });
      return false;
    } finally {
      this.patch({});
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
  private sanitizeSubmission(submission: FrozenSubmission): FrozenSubmission {
    // Persisted snapshots may contain extra fields; expose only the public request contract.
    const request = submission.request;
    return {
      ...freezeSubmission(
        {
          projectId: request.projectId,
          targetId: request.targetId,
          operation: request.operation,
          prompt: request.prompt,
          parameters: { ...request.parameters },
          inputs: request.inputs.map(({ assetId, role }) => ({ assetId, role })),
          count: request.count,
          ...(request.parentAssetId ? { parentAssetId: request.parentAssetId } : {}),
        },
        () => submission.key,
      ),
      status: submission.status,
      ...(submission.jobId ? { jobId: submission.jobId } : {}),
    };
  }
  private loadKnownSubmissions(projects: ImageProject[]) {
    for (const { id: projectId } of projects) {
      const scope = { ownerId: this.ownerId, backendId: this.backendId, projectId };
      const key = submissionKey(scope);
      if (this.submissions.has(key)) continue;
      try {
        const saved = this.storage?.getItem(key) ?? null;
        const restored = restoreSubmission(saved, scope);
        const submission = restored ? this.sanitizeSubmission(restored) : null;
        const history = restoreSubmissionHistory(saved, scope).map((item) =>
          this.sanitizeSubmission(item),
        );
        this.submissions.set(key, submission);
        this.submissionHistories.set(key, history);
      } catch {
        // Leave unreadable records untouched; selecting that scope still blocks unsafe writes.
      }
    }
  }
  private archiveKey() {
    return `image-studio:archive:v1:${JSON.stringify([this.ownerId, this.backendId])}`;
  }
  async start() {
    this.persist();
    this.disposed = false;
    this.uploadAbort?.abort();
    this.scopeAbort.abort();
    this.scopeAbort = new AbortController();
    this.pendingSubmit = false;
    this.historyQueue = [];
    this.historyPage = undefined;
    this.streams.close();
    this.streams = this.newStreams();
    const epoch = ++this.epoch;
    this.patch({
      loading: true,
      draftReady: false,
      uploading: false,
      verifyingInputs: false,
      notice: "",
    });
    try {
      const capabilities = await this.client.capabilities();
      if (!this.valid(epoch)) return;
      this.patch({ supported: capabilities.supported });
      if (!capabilities.supported) return;
      const [targets, firstPage] = await Promise.all([
        this.client.listTargets(),
        this.client.listProjects(),
      ]);
      if (!this.valid(epoch)) return;
      const projects = new Map(firstPage.items.map((project) => [project.id, project]));
      let cursor = firstPage.nextCursor;
      while (cursor) {
        const page = await this.client.listProjects(cursor);
        if (!this.valid(epoch)) return;
        for (const project of page.items) projects.set(project.id, project);
        cursor = page.nextCursor;
      }
      if (!projects.size) {
        // Share an in-flight creation across start retries; never create once per epoch.
        this.archiveCreation ??= this.client.createProject("图像工作台");
        const creation = this.archiveCreation;
        try {
          const project = await creation;
          if (!this.valid(epoch)) return;
          projects.set(project.id, project);
        } catch {
          if (this.valid(epoch)) this.patch({ notice: "图像工作台初始化失败，请重试。" });
          return;
        } finally {
          if (this.archiveCreation === creation) this.archiveCreation = undefined;
        }
      }
      let remembered = this.view.projectId;
      try {
        remembered = this.storage?.getItem(this.archiveKey()) || remembered;
      } catch {
        // Draft restoration independently guards against overwriting unreadable storage.
      }
      const archive =
        projects.get(remembered) ??
        [...projects.values()].find((project) => project.title === "图像工作台") ??
        projects.values().next().value;
      if (!archive) throw new Error("Image archive unavailable");
      this.loadKnownSubmissions([...projects.values()]);
      this.patch({
        targets,
        state: {
          ...initialStudioState(this.ownerId, this.backendId),
          projects: [...projects.values()],
        },
        projectCursor: undefined,
      });
      await this.selectProject(archive.id);
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
    if (this.view.uploading && operation !== this.view.operation) this.cancelUpload();
    this.patch({ operation });
    this.updateDraft({ inputs: [], parentAssetId: undefined });
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
        // Focus/open refreshes usually return the same model; re-applying it would
        // replace the draft object and abort in-flight restores or revalidation.
        // Compare the whole definition: not every backend bumps revision on edits.
        const unchanged =
          previous !== undefined && JSON.stringify(previous) === JSON.stringify(next);
        if (!unchanged) {
          const pendingDrops = this.view.dropped;
          this.applyTarget(next, previous);
          this.patch({ dropped: [...new Set([...pendingDrops, ...this.view.dropped])] });
        }
        if (!next.enabled)
          this.patch({ notice: next.disabledReason || "当前模型已停用，请选择已启用的模型。" });
      } else if (this.view.draft.targetId) {
        this.patch({ notice: "当前模型已删除，请重新选择模型；草稿与原提交记录已保留。" });
      } else {
        const available = targets.find((target) => target.enabled);
        if (available) this.applyTarget(available, undefined);
        else this.patch({ notice: "" });
      }
    } catch {
      if (this.valid(epoch) && refresh === this.targetRefresh)
        this.patch({ notice: "图像模型刷新失败，请检查连接后重试。" });
    }
  }
  /** Dropped keys belong to the previous target; the banner names them by its spec. */
  droppedLabels(t: Translate = (key) => key): string[] {
    return this.view.dropped.map((key) => {
      const spec = this.droppedSpecs.get(key);
      return spec ? parameterLabel(spec, t) : key;
    });
  }
  private applyTarget(next: ImageTarget, previous: ImageTarget | undefined) {
    if (this.view.uploading && (next.id !== previous?.id || next.revision !== previous?.revision))
      this.cancelUpload();
    const migration = previous
      ? migrateParameters(previous, next, this.view.draft.parameters)
      : { values: defaultParameters(next), dropped: [] };
    for (const spec of previous?.parameters ?? [])
      if (migration.dropped.includes(spec.key)) this.droppedSpecs.set(spec.key, spec);
    const operation = next.capabilities.operations.includes(this.view.operation)
      ? this.view.operation
      : (next.capabilities.operations[0] ?? "generate");
    // Target refreshes re-apply the same model; only an actual switch warrants the warning.
    const switched = previous !== undefined && previous.id !== next.id;
    const hasInputs = switched && this.view.draft.inputs.length > 0;
    this.patch({
      operation,
      count: Math.min(this.view.count, next.capabilities.maxCount),
      dropped: migration.dropped,
      notice: hasInputs
        ? "模型已切换，请重新确认输入图片的参考或编辑方式；新模型不保证继承原上下文。"
        : "",
    });
    const allowed =
      operation === "generate"
        ? []
        : operation === "reference"
          ? ["reference"]
          : operation === "edit"
            ? ["source", "reference"]
            : ["source", "mask"];
    this.updateDraft({
      targetId: next.id,
      parameters: migration.values,
      inputs: this.view.draft.inputs
        .filter((input) => allowed.includes(input.role))
        .slice(0, next.capabilities.maxInputs),
    });
  }
  acknowledgeMigration() {
    this.patch({ dropped: [] });
  }
  async selectPendingSubmission(projectId: string): Promise<void> {
    if (!this.view.pendingSubmissions.some((item) => item.projectId === projectId)) return;
    await this.selectProject(projectId);
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
    this.historyQueue = [];
    this.historyPage = undefined;
    // History is shared across archives; only the editable draft and submission change scope.
    const state = { ...this.view.state, selectedAssetId: undefined, selectedJobId: undefined };
    const target = this.view.targets.find((item) => item.enabled) ?? this.view.targets[0];
    this.patch({
      projectId,
      state,
      jobCursor: undefined,
      draft: {
        ...emptyDraft(),
        targetId: target?.id ?? "",
        parameters: target ? defaultParameters(target) : {},
      },
      operation: target?.capabilities.operations.includes("generate")
        ? "generate"
        : (target?.capabilities.operations[0] ?? "generate"),
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
        const history =
          this.submissionHistories.get(key) ??
          restoreSubmissionHistory(saved, scope).map((item) => this.sanitizeSubmission(item));
        const restored = await restoreDraft(raw, scope, this.view.targets, async (id) => {
          await this.client.readAsset(id, "thumbnail", signal);
          return true;
        });
        if (!this.valid(epoch)) return;
        if (raw && !restored) throw new Error("Saved draft could not be restored");
        const cached = this.submissions.has(key) ? (this.submissions.get(key) ?? null) : stored;
        const submission = cached
          ? this.sanitizeSubmission(
              cached.status === "submitting" ? markSubmissionUnknown(cached) : cached,
            )
          : null;
        this.submissions.set(key, submission);
        this.submissionHistories.set(key, history);
        this.patch({
          submission,
          submissionHistory: history,
          draftReady: true,
          ...(restored
            ? { draft: restored.draft, unverifiedAssetIds: restored.unverifiedAssetIds }
            : {}),
        });
        if (!this.view.draft.targetId) {
          const available = this.view.targets.find((target) => target.enabled);
          if (available) this.applyTarget(available, undefined);
        }
        try {
          this.storage?.setItem(this.archiveKey(), projectId);
        } catch {
          this.patch({ notice: "历史归档选择保存失败，请保留当前页面。" });
        }
        if (restored?.unverifiedAssetIds.length)
          this.patch({ notice: "部分输入图片暂时无法核验，引用已保留，请重验后提交。" });
        else if (restored?.invalidAssetIds.length)
          this.patch({ notice: `${restored.invalidAssetIds.length} 张输入图已失效，请重新上传。` });
        if (submission?.status === "unknown")
          this.patch({
            notice: "上次提交结果未确认，请先在历史中确认任务是否已创建，再决定是否重新生成。",
          });
        if (restored?.draft.inputs.length) {
          const roles = restored.draft.inputs.map((input) => input.role);
          const desired = roles.includes("mask")
            ? "mask"
            : roles.includes("source")
              ? "edit"
              : "reference";
          if (this.target?.capabilities.operations.includes(desired))
            this.patch({ operation: desired });
          else this.patch({ notice: "草稿输入与当前模型能力不兼容，请调整操作或重新上传。" });
        }
      } catch {
        if (this.valid(epoch))
          this.patch({ notice: "本地草稿或提交记录读取失败，已暂停保存与提交，请重试加载。" });
      }
    };
    const loadHistory = async () => {
      const projectIds = [...new Set([projectId, ...state.projects.map((project) => project.id)])];
      const pages = await Promise.all(
        projectIds.map(async (id) => {
          try {
            return { projectId: id, page: await this.client.listJobs(id) };
          } catch {
            return { projectId: id, page: undefined };
          }
        }),
      );
      if (!this.valid(epoch)) return;
      let nextState = this.view.state;
      for (const { projectId: id, page } of pages) {
        if (!page || page.nextCursor)
          this.historyQueue.push({ projectId: id, cursor: page?.nextCursor });
        for (const job of page?.items ?? []) nextState = applyJobSnapshot(nextState, job);
      }
      this.patch({ state: nextState, jobCursor: this.nextHistoryCursor() });
      for (const job of Object.values(nextState.jobs)) this.streams.watch(job);
      if (pages.some(({ page }) => !page))
        this.patch({ notice: "部分历史加载失败，可通过加载更多重试；草稿会独立恢复。" });
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
      if (this.valid(epoch)) this.patch({ notice: "更多历史加载失败，请重试。" });
    }
  }
  private nextHistoryCursor() {
    // Public cursor remains a load-more signal; each backend cursor stays paired with its project.
    return this.historyQueue[0]?.cursor ?? (this.historyQueue.length ? "initial" : undefined);
  }
  async moreJobs() {
    const epoch = this.epoch;
    const next = this.historyQueue[0];
    if (!next || this.historyPage?.epoch === epoch) return;
    const pending = { epoch };
    this.historyPage = pending;
    try {
      const page = await this.client.listJobs(next.projectId, next.cursor);
      if (!this.valid(epoch)) return;
      this.historyQueue.shift();
      if (page.nextCursor)
        this.historyQueue.push({ projectId: next.projectId, cursor: page.nextCursor });
      let state = this.view.state;
      for (const job of page.items) state = applyJobSnapshot(state, job);
      this.patch({ state, jobCursor: this.nextHistoryCursor() });
      for (const job of page.items) this.streams.watch(job);
    } catch {
      if (this.valid(epoch)) {
        this.historyQueue.shift();
        this.historyQueue.push(next);
        this.patch({
          jobCursor: this.nextHistoryCursor(),
          notice: "更多历史加载失败，已保留重试并继续加载其他历史。",
        });
      }
    } finally {
      if (this.historyPage === pending) this.historyPage = undefined;
    }
  }
  /** History button: re-reads every archive's first page and merges it. Unlike
   * start(), it keeps the draft, uploads and an in-flight submission intact. */
  async refreshHistory() {
    if (!this.view.draftReady) return this.start();
    const epoch = this.epoch;
    this.patch({ loading: true });
    try {
      const ids = [
        ...new Set([this.view.projectId, ...this.view.state.projects.map((p) => p.id)]),
      ].filter(Boolean);
      const pages = await Promise.all(
        ids.map(async (id) => {
          try {
            return await this.client.listJobs(id);
          } catch {
            return undefined;
          }
        }),
      );
      if (!this.valid(epoch)) return;
      let state = this.view.state;
      for (const page of pages)
        for (const job of page?.items ?? []) state = applyJobSnapshot(state, job);
      this.patch({ state });
      for (const job of Object.values(state.jobs)) this.streams.watch(job);
      if (pages.some((page) => !page)) this.patch({ notice: "部分历史刷新失败，请稍后重试。" });
    } finally {
      if (this.valid(epoch)) this.patch({ loading: false });
    }
  }
  showNotice(text: string) {
    this.patch({ notice: text });
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
      if (this.valid(epoch)) this.patch({ notice: "历史创建失败，请重试。" });
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
        this.patch({ notice: "历史重命名失败，可能已被其他页面修改；请刷新历史列表后重试。" });
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
        this.patch({ notice: "历史已删除，但本地草稿清理失败。" });
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
      if (this.valid(epoch)) this.patch({ notice: "历史删除失败，请重试。" });
    }
  }
  dismissNotice(notice = this.view.notice) {
    // Only clear the message the caller saw; a newer notice must survive a stale timer.
    if (this.view.notice === notice) this.patch({ notice: "" });
  }
  selectAsset(id: string) {
    const owner = Object.values(this.view.state.jobs).find((job) => job.assetIds.includes(id));
    this.patch({
      state: { ...this.view.state, selectedAssetId: id, selectedJobId: owner?.id },
    });
  }
  selectJob(id: string) {
    const job = this.view.state.jobs[id];
    if (!job) return;
    this.patch({
      state: { ...this.view.state, selectedJobId: id, selectedAssetId: job.assetIds[0] },
    });
  }
  async deleteJob(id: string) {
    const epoch = this.epoch;
    const forget = () => {
      const { [id]: _job, ...jobs } = this.view.state.jobs;
      const { [id]: _seq, ...lastSeqByJob } = this.view.state.lastSeqByJob;
      const { [id]: _gap, ...snapshotNeeded } = this.view.state.snapshotNeeded;
      const removed = this.view.state.jobs[id];
      const selectedHere =
        this.view.state.selectedJobId === id ||
        (removed?.assetIds.includes(this.view.state.selectedAssetId ?? "") ?? false);
      this.patch({
        state: {
          ...this.view.state,
          jobs,
          lastSeqByJob,
          snapshotNeeded,
          ...(selectedHere ? { selectedJobId: undefined, selectedAssetId: undefined } : {}),
        },
        notice: "已删除历史记录。",
      });
    };
    try {
      await this.client.deleteJob(id);
      if (this.valid(epoch)) forget();
    } catch (error) {
      if (!this.valid(epoch)) return;
      const status = (error as { status?: number }).status;
      // Already gone on the backend (another window, or a retried click).
      if (status === 404) forget();
      else if (status === 409) this.patch({ notice: "任务仍在进行，请先取消或等待结束后再删除。" });
      else this.patch({ notice: "删除失败，请检查连接后重试。" });
    }
  }
  async restoreJob(id: string) {
    const job = this.view.state.jobs[id];
    if (!job) return;
    const restoration = ++this.draftRestore;
    if (job.projectId !== this.view.projectId) {
      const selecting = this.selectProject(job.projectId);
      const epoch = this.epoch;
      await selecting;
      if (!this.valid(epoch) || restoration !== this.draftRestore) return;
    }
    if (!this.view.draftReady) return;
    const epoch = this.epoch;
    const previousDraft = this.view.draft;
    const signal = this.scopeAbort.signal;
    this.patch({ verifyingInputs: true });
    try {
      const request = job.request;
      const { prompt, framing } = splitFramedPrompt(request.prompt);
      const verified = await verifyDraftAssets(
        {
          prompt,
          framing,
          targetId: request.targetId,
          parameters: { ...request.parameters },
          inputs: request.inputs.map((input) => ({ ...input })),
          parentAssetId: request.parentAssetId,
        },
        async (assetId) => {
          await this.client.readAsset(assetId, "thumbnail", signal);
          return true;
        },
      );
      if (
        !this.valid(epoch) ||
        restoration !== this.draftRestore ||
        this.view.draft !== previousDraft
      )
        return;
      this.patch({
        operation: request.operation,
        count: request.count,
        dropped: [],
        unverifiedAssetIds: verified.unverifiedAssetIds,
        notice: verified.unverifiedAssetIds.length
          ? "历史输入图片暂时无法核验，引用已保留，请重验后提交。"
          : verified.invalidAssetIds.length
            ? "历史输入图片已失效，请重新上传后提交。"
            : "已恢复历史请求，可调整后生成。",
      });
      this.updateDraft(verified.draft);
      if (!this.target?.enabled) this.patch({ notice: "历史模型当前不可用，请选择已启用的模型。" });
      if (this.view.submission?.status === "unknown")
        this.patch({ notice: "历史草稿已恢复；另有一次提交结果未确认，请先在历史中确认。" });
    } finally {
      if (this.valid(epoch) && restoration === this.draftRestore)
        this.patch({ verifyingInputs: false });
    }
  }
  async editAsset(id: string) {
    const original = Object.values(this.view.state.jobs).find((job) => job.assetIds.includes(id));
    if (original && original.projectId !== this.view.projectId) {
      const selecting = this.selectProject(original.projectId);
      const epoch = this.epoch;
      await selecting;
      if (!this.valid(epoch) || !this.view.draftReady) return;
    }
    const target = this.target;
    if (!target) return;
    const operation = target.capabilities.operations.includes("edit")
      ? "edit"
      : target.capabilities.operations.includes("reference")
        ? "reference"
        : undefined;
    if (!operation) {
      this.patch({ notice: "当前模型不支持图片编辑或参考生成，请先切换模型。" });
      return;
    }
    this.patch({
      operation,
      notice:
        original?.request.targetId !== target.id
          ? "将以新模型的参考或编辑方式创建版本，不保证继承原上下文。"
          : "已绑定父图片，将创建新版本。",
    });
    this.updateDraft({
      inputs: [{ assetId: id, role: operation === "edit" ? "source" : "reference" }],
      parentAssetId: id,
    });
  }
  cancelUpload() {
    this.uploadAbort?.abort();
    this.patch({ uploading: false, notice: "上传已取消，草稿已保留。" });
  }
  async upload(file: Blob, name: string, role: InputAsset["role"]) {
    if (this.view.uploading || !this.view.projectId) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      this.patch({ notice: "上传失败：图片超过 20 MiB 上限，请压缩后再上传。" });
      return;
    }
    if (this.view.draft.inputs.length >= (this.target?.capabilities.maxInputs ?? 0)) {
      this.patch({ notice: "已达到当前模型输入图片上限。" });
      return;
    }
    // Claim the upload slot synchronously so a model/operation switch during the
    // format check cancels it exactly like one during the network request.
    const epoch = this.epoch;
    const controller = new AbortController();
    this.uploadAbort = controller;
    this.patch({ uploading: true });
    const reject = (notice: string) => {
      if (this.uploadAbort === controller) this.patch({ uploading: false, notice });
    };
    try {
      // Trust the bytes over the extension-derived File.type (see imageSniff.ts).
      const sniffed = await sniffImage(file);
      if (!this.valid(epoch) || controller.signal.aborted) return;
      if (sniffed.kind === "unsupported")
        return reject(`上传失败：这是 ${sniffed.label} 图片，目前只支持 PNG、JPEG 和 WebP。`);
      if (sniffed.kind === "unknown" && !UPLOAD_MIMES.includes(file.type))
        return reject("上传失败：无法识别图片格式，目前只支持 PNG、JPEG 和 WebP。");
      let relabeled = "";
      if (sniffed.kind === "supported" && sniffed.mime !== file.type) {
        if (file.type) relabeled = `文件扩展名与内容不符，已按实际格式 ${sniffed.label} 上传。`;
        file = new File([file], name, { type: sniffed.mime });
      }
      const asset = await this.client.upload(file, name, controller.signal);
      if (!this.valid(epoch) || controller.signal.aborted) return;
      if (!asset.available) throw new Error("unavailable");
      this.patch({
        state: { ...this.view.state, assets: { ...this.view.state.assets, [asset.id]: asset } },
      });
      this.updateDraft({ inputs: [...this.view.draft.inputs, { assetId: asset.id, role }] });
      if (relabeled) this.patch({ notice: relabeled });
    } catch (error) {
      if (this.valid(epoch) && !controller.signal.aborted)
        this.patch({ notice: uploadFailureNotice(error) });
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
  validation(t: Translate = (key) => key): string[] {
    const { draft, count, operation, projectId, uploading, dropped, draftReady } = this.view;
    const target = this.target;
    if (!target?.enabled) return ["请选择已启用并验证的图像模型。"];
    const errors = validateParameters(target, draft.parameters).map((error) => {
      const spec = target.parameters.find((p) => p.key === error.key);
      return `${spec ? parameterLabel(spec, t) : error.key}：${error.message}`;
    });
    if (!projectId || !draftReady) errors.push("请等待历史与草稿恢复，加载失败时请重试。");
    if (!draft.prompt.trim()) errors.push("请输入提示词。");
    if (!target.capabilities.operations.includes(operation)) errors.push("模型不支持此操作。");
    if (!Number.isInteger(count) || count < 1 || count > Math.min(16, target.capabilities.maxCount))
      errors.push("请调整生成数量。");
    if (uploading) errors.push("请等待图片上传完成。");
    if (this.view.verifyingInputs || this.view.unverifiedAssetIds.length)
      errors.push("输入图片尚未核验通过，请重验后提交。");
    if (draft.parentAssetId && !draft.inputs.some((input) => input.assetId === draft.parentAssetId))
      errors.push("父图片必须包含在输入图片中，请重新关联或解除版本关联。");
    if (dropped.length) errors.push("请先确认参数调整。");
    const roles = draft.inputs.map((input) => input.role);
    if (draft.inputs.length > target.capabilities.maxInputs) errors.push("输入图片超过模型上限。");
    if (operation === "reference" && !roles.includes("reference")) errors.push("请添加参考图片。");
    if (["edit", "mask"].includes(operation) && !roles.includes("source"))
      errors.push("请添加原始图片。");
    if (operation === "mask" && !roles.includes("mask")) errors.push("请添加遮罩图片。");
    const allowed =
      operation === "generate"
        ? []
        : operation === "reference"
          ? ["reference"]
          : operation === "edit"
            ? ["source", "reference"]
            : ["source", "mask"];
    if (roles.some((role) => !allowed.includes(role)))
      errors.push("输入图片用途与操作不兼容，请移除后重新添加。");
    return errors;
  }
  /** Every click is a new job built from the current draft; only an in-flight request blocks it. */
  async submit(t?: Translate) {
    if (this.pendingSubmit || this.disposed || !this.view.draftReady) return;
    const errors = this.validation(t);
    if (errors.length) {
      this.patch({ notice: errors.join(" ") });
      return;
    }
    const { draft, projectId, count, operation } = this.view;
    const request: CreateJobRequest = {
      projectId,
      targetId: draft.targetId,
      prompt: usesPromptFraming(this.target)
        ? composeFramedPrompt(draft.prompt, draft.framing)
        : draft.prompt,
      parameters: draft.parameters as Record<string, Scalar>,
      inputs: draft.inputs,
      operation,
      count,
      ...(draft.parentAssetId ? { parentAssetId: draft.parentAssetId } : {}),
    };
    const submission = freezeSubmission(request, () => crypto.randomUUID());
    const scope = this.scope();
    // Recorded before dispatch so a crash mid-request still surfaces as "待核对" on restart.
    const recorded = this.saveSubmission(scope, { ...submission, status: "submitting" });
    this.pendingSubmit = true;
    const epoch = this.epoch;
    this.patch({
      submission: { ...submission, status: "submitting" },
      ...(recorded ? { notice: "" } : {}),
    });
    try {
      const job = await this.client.createJob(submission.request, submission.key);
      const accepted = this.settleSubmission(scope, submission.key, {
        ...submission,
        status: "accepted",
        jobId: job.id,
      });
      if (this.disposed) return;
      if (!this.valid(epoch)) {
        // History is shared across archives: a late success still belongs in it.
        this.patch({ state: applyJobSnapshot(this.view.state, job) });
        this.streams.watch(job);
        return;
      }
      const state = applyJobSnapshot(this.view.state, job);
      this.patch({
        // The preview follows the job just submitted, even after a history pick.
        state: { ...state, selectedJobId: job.id, selectedAssetId: undefined },
        submission: accepted,
      });
      this.streams.watch(job);
    } catch (error) {
      const rejected = submissionWasRejected(error);
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
            : "提交结果未确认，任务可能已经创建。请刷新历史确认后再决定是否重新生成；草稿已保留。",
        });
      }
    } finally {
      if (this.valid(epoch)) this.pendingSubmit = false;
    }
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
