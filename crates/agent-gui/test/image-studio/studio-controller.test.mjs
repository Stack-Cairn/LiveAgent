import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';

const loader = createTsModuleLoader();
const { ImageStudioController } = loader.loadModule('@liveagent/ui/features/image-studio/studioController');
const { draftKey, serializeDraft, submissionKey, serializeSubmission } = loader.loadModule('@liveagent/ui/features/image-studio/drafts');
const wire = loader.loadModule('@liveagent/ui/lib/imaging/testdata/wire-v1.json');
const target = {
  ...wire.settings.targets[0], id: 't', enabled: true, parameters: [],
  capabilities: { ...wire.settings.targets[0].capabilities, operations: ['generate', 'edit', 'reference'], maxInputs: 4, maxCount: 4 },
};
const project = (id, title = id) => ({ id, title, revision: 1 });
const archive = project('archive', '图像工作台');
const old = project('old');
const scope = projectId => ({ ownerId: 'o', backendId: 'b', projectId });
const draft = prompt => ({ prompt, targetId: 't', parameters: {}, inputs: [] });
const job = (projectId, id, assetIds = []) => ({
  id, projectId, request: { ...draft('original'), projectId, operation: 'generate', count: 1 },
  status: 'succeeded', revision: 1, assetIds, items: [], usage: null,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
// Uploads first read the file's magic bytes; wait until the network request is actually out.
const until = async (ready) => { for (let i = 0; i < 50 && !ready(); i++) await tick(); assert.ok(ready(), 'condition never became true'); };
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function client(overrides = {}) {
  return {
    capabilities: async () => ({ supported: true }), listTargets: async () => [target],
    listProjects: async () => ({ items: [old, archive] }), listJobs: async () => ({ items: [] }),
    createProject: async () => { throw Error('unexpected creation'); },
    readAsset: async () => new Blob(), subscribe: async () => {}, ...overrides,
  };
}
function controller(overrides = {}, store = storage(), owner = 'o', backend = 'b') {
  return new ImageStudioController(client(overrides), owner, backend, store);
}

test('empty start creates one fixed-title archive and can submit immediately; restart reuses it', async () => {
  const projects = []; const titles = []; const requests = []; const store = storage();
  const api = {
    listProjects: async () => ({ items: [...projects] }),
    createProject: async title => { titles.push(title); projects.push(archive); return archive; },
    createJob: async (request, key) => { requests.push({ request, key }); return job(request.projectId, 'new'); },
  };
  const c = controller(api, store);
  try {
    await c.start(); assert.equal(c.view.projectId, 'archive'); assert.equal(c.view.loading, false); assert.equal(c.view.draftReady, true);
    c.updateDraft({ prompt: 'cat' }); await c.submit(); assert.equal(requests[0].request.projectId, 'archive');
    await c.start(); assert.equal(c.view.loading, false); assert.equal(c.view.draft.prompt, 'cat');
    assert.equal(c.view.submission.key, requests[0].key); assert.deepEqual(titles, ['图像工作台']);
  } finally { c.dispose(); }
  const restored = controller(api, store);
  try { await restored.start(); assert.equal(restored.view.projectId, 'archive'); assert.equal(restored.view.draft.prompt, 'cat'); assert.equal(titles.length, 1); }
  finally { restored.dispose(); }
});

test('failed archive creation leaves start retryable without a scope/loading deadlock', async () => {
  let attempts = 0;
  const c = controller({ listProjects: async () => ({ items: [] }), createProject: async () => { if (++attempts === 1) throw Error('503'); return archive; } });
  try {
    await c.start(); assert.equal(c.view.loading, false); assert.equal(c.view.draftReady, false); assert.match(c.view.notice, /初始化失败/);
    await c.start(); assert.equal(attempts, 2); assert.equal(c.view.projectId, 'archive'); assert.equal(c.view.loading, false); assert.equal(c.view.draftReady, true);
  } finally { c.dispose(); }
});

test('overlapping starts share archive creation and only the latest epoch becomes ready', async () => {
  const pending = deferred(); let creates = 0;
  const c = controller({ listProjects: async () => ({ items: [] }), createProject: () => { creates++; return pending.promise; } });
  try {
    const first = c.start(); await tick(); const second = c.start(); await tick();
    assert.equal(creates, 1); pending.resolve(archive); await Promise.all([first, second]);
    assert.equal(c.view.projectId, 'archive'); assert.equal(c.view.draftReady, true); assert.equal(c.view.loading, false);
  } finally { c.dispose(); }
});

test('startup scans project pages, prefers the titled archive and retains every legacy history', async () => {
  const pages = []; const histories = [];
  const c = controller({
    listProjects: async cursor => { pages.push(cursor); return cursor ? { items: [archive] } : { items: [old], nextCursor: 'projects-2' }; },
    listJobs: async id => { histories.push(id); return { items: [job(id, `job-${id}`)] }; },
  });
  try {
    await c.start(); assert.deepEqual(pages, [undefined, 'projects-2']); assert.equal(c.view.projectId, 'archive');
    assert.deepEqual(histories.sort(), ['archive', 'old']); assert.equal(Object.keys(c.view.state.jobs).length, 2);
    assert.equal(c.view.state.projects.length, 2); assert.equal(c.view.projectCursor, undefined);
  } finally { c.dispose(); }
});

test('legacy-only installations reuse an existing archive without creating an extra project', async () => {
  const c = controller({ listProjects: async () => ({ items: [old] }) });
  try { await c.start(); assert.equal(c.view.projectId, 'old'); assert.equal(c.view.draftReady, true); }
  finally { c.dispose(); }
});

test('remembered archive restores its own draft and unknown request ahead of list order', async () => {
  const store = storage(); const c = controller({}, store);
  await c.start(); c.updateDraft({ prompt: 'archive draft' }); await c.selectProject('old');
  c.updateDraft({ prompt: 'old draft' });
  const unknown = { key: 'paid-key', status: 'unknown', request: { projectId: 'old', targetId: 't', prompt: 'frozen', parameters: {}, inputs: [], operation: 'generate', count: 1 } };
  store.setItem(submissionKey(scope('old')), serializeSubmission(scope('old'), unknown, [unknown]));
  c.dispose();
  const calls = []; const restored = controller({ createJob: async (request, key) => { calls.push({ request, key }); return job('old', 'paid-job'); } }, store);
  try {
    await restored.start(); assert.equal(restored.view.projectId, 'old'); assert.equal(restored.view.draft.prompt, 'old draft');
    assert.equal(restored.view.submission.key, 'paid-key'); assert.equal(restored.view.submissionHistory[0].key, 'paid-key');
    await restored.submit(); assert.equal(calls[0].request.prompt, 'old draft'); assert.equal(calls[0].request.projectId, 'old'); assert.notEqual(calls[0].key, 'paid-key');
    await restored.selectProject('archive'); assert.equal(restored.view.draft.prompt, 'archive draft'); assert.equal(restored.view.submission, null); assert.deepEqual(restored.view.submissionHistory, []);
    const isolated = controller({}, store, 'other');
    try { await isolated.start(); assert.equal(isolated.view.projectId, 'archive'); assert.equal(isolated.view.draft.prompt, ''); assert.equal(isolated.view.submission, null); }
    finally { isolated.dispose(); }
  } finally { restored.dispose(); }
});

test('moreJobs keeps cursors with their projects, rotates pages fairly and prevents duplicate fetches', async () => {
  const calls = []; const pending = deferred();
  const c = controller({ listJobs: async (id, cursor) => {
    calls.push([id, cursor]);
    if (!cursor) return { items: [job(id, `${id}-1`)], nextCursor: `${id}-2` };
    if (cursor === 'archive-2') return pending.promise;
    return { items: [job(id, `${id}-2`)] };
  } });
  try {
    await c.start(); const more = c.moreJobs(); await c.moreJobs(); assert.equal(calls.length, 3);
    pending.resolve({ items: [job('archive', 'archive-2')], nextCursor: 'archive-3' }); await more;
    await c.moreJobs(); await c.moreJobs();
    assert.deepEqual(calls.slice(2), [['archive', 'archive-2'], ['old', 'old-2'], ['archive', 'archive-3']]);
    assert.equal(c.view.jobCursor, undefined); assert.equal(c.view.projectId, 'archive'); assert.equal(Object.keys(c.view.state.jobs).length, 4);
  } finally { c.dispose(); }
});

test('failed first-page history is retryable through moreJobs without hiding other histories', async () => {
  let fail = true; const calls = [];
  const c = controller({ listJobs: async (id, cursor) => { calls.push([id, cursor]); if (id === 'old' && fail) throw Error('503'); return { items: [job(id, `job-${id}`)] }; } });
  try {
    await c.start(); assert.equal(c.view.draftReady, true); assert.ok(c.view.state.jobs['job-archive']); assert.ok(c.view.jobCursor);
    fail = false; await c.moreJobs(); assert.deepEqual(calls.at(-1), ['old', undefined]); assert.ok(c.view.state.jobs['job-old']); assert.equal(c.view.jobCursor, undefined);
  } finally { c.dispose(); }
});

test('late history page cannot advance the queue or merge results after a scope change', async () => {
  const pending = deferred(); let paging = false;
  const c = controller({ listJobs: async (id, cursor) => {
    if (cursor && paging) return pending.promise;
    return { items: [], nextCursor: `${id}-next` };
  } });
  try {
    await c.start(); paging = true; const more = c.moreJobs(); await c.selectProject('old');
    pending.resolve({ items: [job('archive', 'stale')], nextCursor: 'wrong' }); await more;
    assert.equal(c.view.state.jobs.stale, undefined); assert.equal(c.view.projectId, 'old'); assert.equal(c.view.jobCursor, 'old-next');
  } finally { c.dispose(); }
});

test('editing a legacy result restores its project scope before changing inputs or submitting', async () => {
  const store = storage(); store.setItem(draftKey('o', 'b', 'old'), serializeDraft(scope('old'), draft('old prompt'), [target]));
  const calls = [];
  const c = controller({
    listJobs: async id => ({ items: id === 'old' ? [job('old', 'legacy', ['ia_legacy'])] : [] }),
    createJob: async (request, key) => { calls.push({ request, key }); return job(request.projectId, 'edited'); },
  }, store);
  try {
    await c.start(); c.updateDraft({ prompt: 'keep archive draft' }); await c.editAsset('ia_legacy');
    assert.equal(c.view.projectId, 'old'); assert.equal(c.view.draft.prompt, 'old prompt'); assert.equal(c.view.operation, 'edit');
    assert.deepEqual(c.view.draft.inputs, [{ assetId: 'ia_legacy', role: 'source' }]);
    await c.submit(); assert.equal(calls[0].request.projectId, 'old'); assert.equal(calls[0].request.parentAssetId, 'ia_legacy');
    await c.selectProject('archive'); assert.equal(c.view.draft.prompt, 'keep archive draft'); assert.deepEqual(c.view.draft.inputs, []); assert.equal(c.view.submission, null);
  } finally { c.dispose(); }
});

test('editing legacy result supports reference fallback and ignores a superseded scope restoration', async () => {
  const pending = deferred(); const store = storage();
  store.setItem(draftKey('o', 'b', 'old'), serializeDraft(scope('old'), { ...draft('old'), inputs: [{ assetId: 'ia_wait', role: 'reference' }] }, [target]));
  const c = controller({
    listTargets: async () => [{ ...target, capabilities: { ...target.capabilities, operations: ['generate', 'reference'] } }],
    listJobs: async id => ({ items: id === 'old' ? [job('old', 'legacy', ['ia_legacy'])] : [] }),
    readAsset: () => pending.promise,
  }, store);
  try {
    await c.start(); const editing = c.editAsset('ia_legacy'); await tick(); await c.selectProject('archive');
    pending.resolve(new Blob()); await editing; assert.equal(c.view.projectId, 'archive'); assert.deepEqual(c.view.draft.inputs, []);
    await c.editAsset('ia_legacy'); assert.equal(c.view.projectId, 'old'); assert.equal(c.view.operation, 'reference');
    assert.deepEqual(c.view.draft.inputs, [{ assetId: 'ia_legacy', role: 'reference' }]);
  } finally { c.dispose(); }
});

test('new model configuration auto-selects an enabled model after an empty start and preserves prompt', async () => {
  const c = controller({ listTargets: async () => [] });
  try {
    await c.start(); c.updateDraft({ prompt: 'keep me' }); assert.equal(c.view.draft.targetId, '');
    const enabled = { ...target, parameters: [{ key: 'size', label: '尺寸', type: 'string', default: 'large' }] };
    c.client.listTargets = async () => [{ ...target, id: 'disabled', enabled: false }, enabled];
    await c.refreshTargets(); assert.equal(c.view.draft.targetId, 't'); assert.equal(c.view.draft.prompt, 'keep me'); assert.deepEqual(c.view.draft.parameters, { size: 'large' });
    assert.deepEqual(c.validation(), []); c.setTarget('t'); assert.equal(c.view.draft.targetId, 't');
  } finally { c.dispose(); }
});

test('restart while submit is in flight restores unknown; the next click is a fresh request and a late failure cannot undo it', async () => {
  const pending = deferred(); const calls = [];
  const c = controller({ createJob: (request, key) => { calls.push({ request, key }); return pending.promise; } });
  try {
    await c.start(); c.updateDraft({ prompt: 'frozen' }); const sending = c.submit(); const key = c.view.submission.key;
    await c.start(); assert.equal(c.view.submission.status, 'unknown'); assert.equal(c.view.submission.key, key); assert.equal(c.view.loading, false);
    c.client.createJob = async (request, retryKey) => { calls.push({ request, key: retryKey }); return job('archive', 'receipt'); };
    await c.submit(); assert.notEqual(calls[1].key, key); assert.equal(c.view.submission.status, 'accepted');
    pending.reject(Error('late disconnect')); await sending; assert.equal(c.view.submission.status, 'accepted');
  } finally { c.dispose(); }
});

test('restoreJob restores the complete request in its own project without submitting or losing history', async () => {
  let sends = 0;
  const historical = { ...job('old', 'history'), request: {
    projectId: 'old', prompt: 'historical prompt', targetId: 't', parameters: { quality: 'high' },
    inputs: [{ assetId: 'ia_parent', role: 'source' }], parentAssetId: 'ia_parent', operation: 'edit', count: 3,
  } };
  const c = controller({
    listJobs: async (id, cursor) => ({
      items: id === 'old' ? [cursor ? historical : job('old', 'recent')] : [job('archive', 'archive-history')],
      ...(id === 'old' && !cursor ? { nextCursor: 'old-older' } : {}),
    }),
    createJob: async () => { sends++; return historical; },
  });
  try {
    await c.start(); await c.moreJobs(); c.updateDraft({ prompt: 'archive draft' }); await c.restoreJob('history');
    assert.equal(sends, 0); assert.equal(c.view.projectId, 'old'); assert.equal(c.view.operation, 'edit'); assert.equal(c.view.count, 3);
    assert.equal(c.view.draft.prompt, 'historical prompt'); assert.equal(c.view.draft.targetId, 't'); assert.deepEqual(c.view.draft.parameters, { quality: 'high' });
    assert.deepEqual(c.view.draft.inputs, historical.request.inputs); assert.equal(c.view.draft.parentAssetId, 'ia_parent');
    assert.ok(c.view.state.jobs.history); assert.ok(c.view.state.jobs['archive-history']);
    c.updateDraft({ parameters: { quality: 'low' } }); assert.deepEqual(historical.request.parameters, { quality: 'high' });
    await c.selectProject('archive'); assert.equal(c.view.draft.prompt, 'archive draft');
  } finally { c.dispose(); }
});

test('restoreJob retains transient input references and the unknown submission but removes definitive missing inputs', async () => {
  const historical = { ...job('archive', 'history'), request: {
    projectId: 'archive', prompt: 'history', targetId: 't', parameters: {},
    inputs: [{ assetId: 'ia_parent', role: 'source' }], parentAssetId: 'ia_parent', operation: 'edit', count: 1,
  } };
  const calls = [];
  const c = controller({
    listJobs: async id => ({ items: id === 'archive' ? [historical] : [] }),
    readAsset: async () => { throw Error('network'); },
    createJob: async (request, key) => { calls.push({ request, key }); throw Error('lost receipt'); },
  });
  try {
    await c.start(); c.updateDraft({ prompt: 'frozen' }); await c.submit(); const key = c.view.submission.key;
    await c.restoreJob('history'); assert.equal(c.view.draft.prompt, 'history'); assert.deepEqual(c.view.unverifiedAssetIds, ['ia_parent']);
    assert.equal(c.view.draft.parentAssetId, 'ia_parent'); assert.equal(c.view.submission.key, key); assert.equal(c.view.submission.request.prompt, 'frozen'); assert.equal(calls.length, 1);
    await c.submit(); assert.equal(calls.length, 1, 'unverified inputs block a new request'); assert.match(c.view.notice, /核验/);
    c.client.readAsset = async () => { throw { status: 404, code: 'IMAGE_NOT_FOUND' }; };
    await c.restoreJob('history'); assert.deepEqual(c.view.draft.inputs, []); assert.equal(c.view.draft.parentAssetId, undefined); assert.equal(c.view.verifyingInputs, false);
  } finally { c.dispose(); }
});

test('pending restoreJob cannot overwrite newer typing or a changed project', async () => {
  const pending = deferred();
  const historical = { ...job('archive', 'history'), request: {
    projectId: 'archive', prompt: 'history', targetId: 't', parameters: {},
    inputs: [{ assetId: 'ia_parent', role: 'source' }], operation: 'edit', count: 1,
  } };
  const c = controller({ listJobs: async id => ({ items: id === 'archive' ? [historical] : [] }), readAsset: () => pending.promise });
  try {
    await c.start(); const restoring = c.restoreJob('history'); c.updateDraft({ prompt: 'newer typing' });
    pending.resolve(new Blob()); await restoring; assert.equal(c.view.draft.prompt, 'newer typing'); assert.deepEqual(c.view.draft.inputs, []); assert.equal(c.view.verifyingInputs, false);
    const next = deferred(); c.client.readAsset = () => next.promise; const switched = c.restoreJob('history');
    await c.selectProject('old'); next.resolve(new Blob()); await switched; assert.equal(c.view.projectId, 'old'); assert.equal(c.view.draft.prompt, ''); assert.equal(c.view.verifyingInputs, false);
  } finally { c.dispose(); }
});

function pendingRequest(projectId, key, status = 'unknown') {
  return { key, status, request: { projectId, targetId: 't', prompt: 'original frozen prompt', operation: 'generate', count: 1, parameters: {}, inputs: [] } };
}

test('jobless archive unknown request stays discoverable after restoreJob switches archive and restart remembers it', async () => {
  const store = storage(); const calls = [];
  const historical = job('old', 'old-history');
  const api = {
    listJobs: async id => ({ items: id === 'old' ? [historical] : [] }),
    createJob: async (request, key) => { calls.push({ request, key }); throw Error('lost receipt'); },
  };
  const first = controller(api, store);
  let originalKey;
  try {
    await first.start(); first.updateDraft({ prompt: 'A prompt' }); await first.submit(); originalKey = first.view.submission.key;
    assert.equal(first.view.state.jobs['old-history'].projectId, 'old');
    assert.equal(first.view.pendingSubmissions[0].projectId, 'archive');
    assert.equal(first.view.pendingSubmissions[0].submission.key, originalKey);
    await first.restoreJob('old-history'); assert.equal(first.view.projectId, 'old'); assert.equal(first.view.submission, null);
    assert.equal(first.view.pendingSubmissions[0].submission.key, originalKey); assert.equal(calls.length, 1);
  } finally { first.dispose(); }
  const restarted = controller({ ...api, createJob: async (request, key) => { calls.push({ request, key }); return job('archive', 'receipt'); } }, store);
  try {
    await restarted.start(); assert.equal(restarted.view.projectId, 'old'); assert.equal(restarted.view.submission, null);
    assert.deepEqual(restarted.view.pendingSubmissions.map(item => [item.projectId, item.submission.key, item.submission.status]), [['archive', originalKey, 'unknown']]);
    await restarted.selectPendingSubmission('archive'); assert.equal(calls.length, 1, 'scope recovery never sends');
    assert.equal(restarted.view.projectId, 'archive'); assert.equal(restarted.view.submission.key, originalKey);
    assert.equal(restarted.view.draft.prompt, 'A prompt'); assert.ok(restarted.view.state.jobs['old-history']);
    restarted.updateDraft({ prompt: 'edited after recovery' }); await restarted.submit();
    assert.equal(calls.length, 2); assert.notEqual(calls[1].key, originalKey); assert.equal(calls[1].request.prompt, 'edited after recovery'); assert.equal(calls[1].request.projectId, 'archive');
    assert.deepEqual(restarted.view.pendingSubmissions, []);
  } finally { restarted.dispose(); }
});

test('pending index tracks live submitting and off-scope accepted responses without selecting the old archive', async () => {
  const receipt = deferred();
  const c = controller({
    listJobs: async id => ({ items: id === 'old' ? [job('old', 'old-history')] : [] }),
    createJob: () => receipt.promise,
  });
  try {
    await c.start(); c.updateDraft({ prompt: 'in flight' }); const sending = c.submit();
    assert.equal(c.view.pendingSubmissions[0].submission.status, 'submitting'); const key = c.view.submission.key;
    await c.restoreJob('old-history'); assert.equal(c.view.pendingSubmissions[0].submission.key, key);
    receipt.resolve(job('archive', 'receipt')); await sending;
    assert.equal(c.view.projectId, 'old'); assert.equal(c.view.submission, null); assert.deepEqual(c.view.pendingSubmissions, []);
    await c.selectPendingSubmission('archive'); assert.equal(c.view.projectId, 'old', 'accepted scopes are not pending navigation targets');
  } finally { c.dispose(); }
});

test('pending scan validates known scopes, strips extra private fields and never rewrites corrupt records', async () => {
  const store = storage(); const secret = 'PRIVATE_SENTINEL';
  const valid = pendingRequest('archive', 'K1', 'submitting');
  valid.credentials = secret; valid.request.authorization = secret;
  valid.request.inputs = [{ assetId: 'ia_input', role: 'source', downloadUrl: secret }];
  store.setItem(submissionKey(scope('archive')), serializeSubmission(scope('archive'), valid));
  const corrupt = '{malformed'; store.setItem(submissionKey(scope('old')), corrupt);
  store.setItem(submissionKey(scope('orphan')), serializeSubmission(scope('orphan'), pendingRequest('orphan', 'orphan-key')));
  const foreign = project('foreign'); const invalid = project('invalid');
  store.setItem(submissionKey(scope('foreign')), serializeSubmission({ ...scope('foreign'), ownerId: 'other-owner' }, pendingRequest('foreign', secret)));
  const malformed = pendingRequest('invalid', 'invalid-key'); malformed.request.parameters = { nested: { token: secret } };
  store.setItem(submissionKey(scope('invalid')), serializeSubmission(scope('invalid'), malformed));
  const c = controller({ listProjects: async () => ({ items: [archive, old, foreign, invalid] }) }, store);
  try {
    await c.start(); assert.deepEqual(c.view.pendingSubmissions.map(item => [item.projectId, item.submission.status]), [['archive', 'unknown']]);
    assert.equal(JSON.stringify(c.view.pendingSubmissions).includes(secret), false); assert.equal(JSON.stringify(c.view.submission).includes(secret), false);
    assert.equal(store.getItem(submissionKey(scope('old'))), corrupt);
    await c.selectPendingSubmission('orphan'); assert.equal(c.view.projectId, 'archive');
    await c.selectPendingSubmission('foreign'); assert.equal(c.view.projectId, 'archive');
    await c.selectProject('old'); assert.equal(c.view.draftReady, false); assert.equal(store.getItem(submissionKey(scope('old'))), corrupt);
    assert.equal(c.view.pendingSubmissions[0].submission.key, 'K1');
  } finally { c.dispose(); }
});

test('moreJobs rotates a repeatedly failing archive behind healthy pages and keeps its cursor retryable', async () => {
  const calls = []; let fail = true;
  const c = controller({ listJobs: async (id, cursor) => {
    calls.push([id, cursor]);
    if (!cursor) return { items: [], nextCursor: `${id}-2` };
    if (id === 'archive' && fail) throw Error('persistent outage');
    return { items: [job(id, `${id}-older`)] };
  } });
  try {
    await c.start(); await c.moreJobs(); assert.equal(c.view.jobCursor, 'old-2');
    await c.moreJobs(); assert.ok(c.view.state.jobs['old-older']); assert.equal(c.view.jobCursor, 'archive-2');
    await c.moreJobs(); assert.equal(c.view.jobCursor, 'archive-2'); fail = false;
    await c.moreJobs(); assert.ok(c.view.state.jobs['archive-older']); assert.equal(c.view.jobCursor, undefined);
    assert.deepEqual(calls.slice(2), [['archive', 'archive-2'], ['old', 'old-2'], ['archive', 'archive-2'], ['archive', 'archive-2']]);
  } finally { c.dispose(); }
});

for (const switchInput of ['operation', 'model']) {
  test(`switching ${switchInput} during upload cancels the old upload and ignores a late result`, async () => {
    const pending = deferred(); let signal;
    const c = controller({
      listTargets: async () => [target, { ...target, id: 'other-model' }],
      upload: (_file, _name, currentSignal) => { signal = currentSignal; return pending.promise; },
    });
    try {
      await c.start(); c.setOperation('edit');
      const upload = c.upload(new Blob(['image'], { type: 'image/png' }), 'cat.png', 'source');
      await until(() => signal);
      if (switchInput === 'operation') c.setOperation('generate');
      else c.setTarget('other-model');
      assert.equal(signal.aborted, true);
      assert.equal(c.view.uploading, false);
      pending.resolve({ id: 'ia_old_source', available: true }); await upload;
      assert.deepEqual(c.view.draft.inputs, []);
    } finally { c.dispose(); }
  });
}

test('refreshing an unchanged model while uploading keeps its input request active', async () => {
  const pending = deferred(); let signal;
  const c = controller({ upload: (_file, _name, currentSignal) => { signal = currentSignal; return pending.promise; } });
  try {
    await c.start(); c.setOperation('edit');
    const upload = c.upload(new Blob(['image'], { type: 'image/png' }), 'cat.png', 'source');
    await until(() => signal);
    await c.refreshTargets();
    assert.equal(signal.aborted, false); assert.equal(c.view.uploading, true);
    pending.resolve({ id: 'ia_current_source', available: true }); await upload;
    assert.deepEqual(c.view.draft.inputs, [{ assetId: 'ia_current_source', role: 'source' }]);
  } finally { c.dispose(); }
});

test('deleteJob removes the entry and its selection; 404 counts as gone; 409 keeps it with guidance', async () => {
  const deleted = []; let failWith;
  const jobs = [job('archive', 'keep', ['ia_keep']), job('archive', 'gone', ['ia_gone']), job('archive', 'busy')];
  const c = controller({
    listJobs: async id => ({ items: id === 'archive' ? jobs : [] }),
    deleteJob: async id => { deleted.push(id); if (failWith) throw Object.assign(Error('rejected'), { status: failWith }); },
  });
  try {
    await c.start();
    c.selectJob('gone'); assert.equal(c.view.state.selectedAssetId, 'ia_gone');
    await c.deleteJob('gone');
    assert.equal(c.view.state.jobs.gone, undefined);
    assert.equal(c.view.state.selectedJobId, undefined); assert.equal(c.view.state.selectedAssetId, undefined);
    c.selectAsset('ia_keep'); assert.equal(c.view.state.selectedJobId, 'keep', 'picking an image also records its job');
    failWith = 409; await c.deleteJob('busy');
    assert.ok(c.view.state.jobs.busy); assert.match(c.view.notice, /仍在进行/);
    failWith = 404; await c.deleteJob('busy');
    assert.equal(c.view.state.jobs.busy, undefined, 'already deleted elsewhere');
    assert.equal(c.view.state.selectedJobId, 'keep', 'unrelated selection survives');
    assert.deepEqual(deleted, ['gone', 'busy', 'busy']);
  } finally { c.dispose(); }
});

test('framing rides in the prompt for size-less targets, is split back on restore, and refreshes never claim a model switch', async () => {
  const sizeless = { ...target, parameters: [] };
  const requests = [];
  const framed = { ...job('archive', 'framed', ['ia_f']), request: { ...draft('cat'), prompt: 'cat\n\n【画面参数】画面比例 3:4；分辨率 1K（约 768×1024 像素）', projectId: 'archive', operation: 'generate', count: 1 } };
  const c = controller({
    listTargets: async () => [sizeless],
    listJobs: async id => ({ items: id === 'archive' ? [framed] : [] }),
    createJob: async (request, key) => { requests.push(request); return job(request.projectId, 'new'); },
  });
  try {
    await c.start();
    c.updateDraft({ prompt: 'dog', inputs: [{ assetId: 'ia_x', role: 'reference' }] });
    c.updateDraft({ inputs: [] });
    await c.refreshTargets();
    assert.doesNotMatch(c.view.notice, /模型已切换/, 'same model after refresh is not a switch');
    c.updateDraft({ framing: { ratio: '16:9', tier: '2K' } });
    await c.submit();
    assert.equal(requests[0].prompt, 'dog\n\n【画面参数】画面比例 16:9；分辨率 2K（约 2048×1152 像素）');
    await c.restoreJob('framed');
    assert.equal(c.view.draft.prompt, 'cat');
    assert.deepEqual(c.view.draft.framing, { ratio: '3:4', tier: '1K' });
  } finally { c.dispose(); }
});

for (const switchInput of ['operation', 'model']) {
  test(`switching ${switchInput} while the file format is still being checked cancels before any request`, async () => {
    let calls = 0;
    const c = controller({
      listTargets: async () => [target, { ...target, id: 'other-model' }],
      upload: async () => { calls++; return { id: 'ia_never', available: true }; },
    });
    try {
      await c.start(); c.setOperation('edit');
      const upload = c.upload(new Blob(['image'], { type: 'image/png' }), 'cat.png', 'source');
      assert.equal(c.view.uploading, true, 'the upload slot is claimed synchronously');
      if (switchInput === 'operation') c.setOperation('generate');
      else c.setTarget('other-model');
      await upload;
      assert.equal(calls, 0); assert.deepEqual(c.view.draft.inputs, []); assert.equal(c.view.uploading, false);
    } finally { c.dispose(); }
  });
}

test('upload relabels a JPEG saved as .png, rejects known unsupported formats locally and explains backend rejections', async () => {
  const uploads = []; let failWith;
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);
  const gifBytes = new TextEncoder().encode('GIF89a-fixture--');
  const c = controller({
    upload: async (file, name) => {
      uploads.push({ type: file.type, name });
      if (failWith) throw Object.assign(Error('rejected'), failWith);
      return { id: `ia_${uploads.length}`, available: true };
    },
  });
  try {
    await c.start(); c.setOperation('edit');
    await c.upload(new Blob([jpegBytes], { type: 'image/png' }), 'photo.png', 'source');
    assert.deepEqual(uploads[0], { type: 'image/jpeg', name: 'photo.png' }, 'real type wins over the extension');
    assert.match(c.view.notice, /实际格式 JPEG/);
    assert.deepEqual(c.view.draft.inputs, [{ assetId: 'ia_1', role: 'source' }]);
    await c.upload(new Blob([gifBytes], { type: 'image/png' }), 'anim.png', 'reference');
    assert.equal(uploads.length, 1, 'GIF never reaches the backend'); assert.match(c.view.notice, /GIF/);
    assert.equal(c.view.uploading, false);
    await c.upload(new Blob(['plain text'], { type: 'text/plain' }), 'notes.txt', 'reference');
    assert.equal(uploads.length, 1); assert.match(c.view.notice, /无法识别图片格式/);
    failWith = { status: 422, code: 'IMAGE_INVALID_INPUT' };
    await c.upload(new Blob(['corrupt'], { type: 'image/png' }), 'broken.png', 'reference');
    assert.equal(uploads.length, 2, 'unrecognised bytes with an allowed type are left to the backend');
    assert.match(c.view.notice, /已损坏|无法解码/);
    failWith = { status: 413, code: 'IMAGE_TOO_LARGE' };
    await c.upload(new Blob([jpegBytes], { type: 'image/jpeg' }), 'big.jpg', 'reference');
    assert.match(c.view.notice, /20 MiB/);
  } finally { c.dispose(); }
});

test('review fixes: history refresh keeps an in-flight request; acceptance selects the new job; unchanged targets keep draft and notice', async () => {
  const pending = deferred();
  const c = controller({
    listJobs: async id => ({ items: id === 'archive' ? [job('archive', 'old', ['ia_old'])] : [] }),
    createJob: () => pending.promise,
  });
  try {
    await c.start();
    c.selectJob('old');
    c.updateDraft({ prompt: 'fresh' });
    const sending = c.submit();
    await c.refreshHistory();
    assert.equal(c.view.submission.status, 'submitting', 'refresh must not mark the request unknown');
    assert.equal(c.view.draft.prompt, 'fresh');
    pending.resolve(job('archive', 'new', []));
    await sending;
    assert.equal(c.view.submission.status, 'accepted');
    assert.ok(c.view.state.jobs.new);
    assert.equal(c.view.state.selectedJobId, 'new', 'the preview follows the job just submitted');
    c.showNotice({ key: 'keep me' });
    const draft = c.view.draft;
    await c.refreshTargets();
    assert.equal(c.view.draft, draft, 'an unchanged model must not replace the draft');
    assert.equal(c.view.notice, 'keep me');
    const seq = c.view.noticeSeq;
    c.showNotice({ key: 'keep me' });
    assert.equal(c.view.noticeSeq, seq + 1, 'an identical notice restarts its timer');
  } finally { c.dispose(); }
});

test('review fixes: restoring a plain job clears draft framing; network failures name the connection', async () => {
  const plain = { ...job('archive', 'plain', []), request: { ...draft('plain prompt'), projectId: 'archive', operation: 'generate', count: 1 } };
  const c = controller({
    listTargets: async () => [{ ...target, parameters: [] }],
    listJobs: async id => ({ items: id === 'archive' ? [plain] : [] }),
    upload: async () => { throw Object.assign(Error('offline'), { code: 'IMAGE_NETWORK_ERROR', status: 0 }); },
  });
  try {
    await c.start();
    c.updateDraft({ framing: { ratio: '16:9' } });
    await c.restoreJob('plain');
    assert.equal(c.view.draft.prompt, 'plain prompt');
    assert.equal(c.view.draft.framing, undefined, 'stale framing must not leak into a restored request');
    c.setOperation('edit');
    await c.upload(new Blob(['image'], { type: 'image/png' }), 'cat.png', 'source');
    assert.match(c.view.notice, /无法连接/);
  } finally { c.dispose(); }
});
