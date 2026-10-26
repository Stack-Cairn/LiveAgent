import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
const model = createTsModuleLoader().loadModule('@liveagent/ui/pages/settings/imageSettingsAdapter');
const plain = value => JSON.parse(JSON.stringify(value));
const fixture = () => ({ revision: 4, connections: [model.newImageConnection('ic_test')], targets: [{ ...model.newImageTarget('it_test', 'ic_test'), remoteId: 'image-model' }] });
const secretRef = `is_${'a'.repeat(32)}`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('provider protocols include the distinct RollDek profile and preserve independent image identity', () => {
  assert.deepEqual(plain(model.imageProtocols).map(p => p.id), ['openai-images', 'rolldek-images', 'google-generate-content-image', 'volcengine-ark-image', 'jimeng-image', 'runninghub-workflow', 'runninghub-model']);
  const settings = fixture();
  settings.connections[0].binding = { kind: 'provider_ref', providerId: 'existing-chat-provider' };
  assert.equal(model.validateImageSettingsDraft(settings).length, 0);
  const update = model.settingsUpdate(settings);
  assert.equal(update.expectedRevision, 4);
  assert.deepEqual(plain(update.connections[0].binding), { kind: 'provider_ref', providerId: 'existing-chat-provider' });
  assert.equal(update.targets[0].adapter, 'openai-images');
  assert.equal(update.targets[0].enabled, false);
  settings.connections[0].binding.providerId = '';
  assert.ok(model.validateImageSettingsDraft(settings).length);
});

test('connection deletion reports concrete dependencies and never silently deletes targets', () => {
  const settings = fixture();
  assert.deepEqual(plain(model.connectionDependents(settings, 'ic_test')).map(t => t.id), ['it_test']);
  assert.throws(() => model.removeImageConnection(settings, 'ic_test'));
  assert.equal(settings.connections.length, 1);
  assert.equal(model.removeImageConnection({ ...settings, targets: [] }, 'ic_test').connections.length, 0);
});

test('edits keep targets enabled; only disabling the connection disables its targets', () => {
  const settings = fixture();
  settings.targets[0].enabled = true;
  // No verification step any more: editing a target or its connection keeps it usable.
  for (const patch of [{ name: 'Renamed' }, { remoteId: 'other-model' }, { adapter: 'volcengine-ark-image' }, { parameters: [{ key: 'size' }] }, { connectionId: 'ic_other' }]) {
    assert.equal(model.patchImageTarget(settings.targets[0], patch).enabled, true);
  }
  // The backend cannot run unfinished adapters, so switching to one disables the target.
  assert.equal(model.patchImageTarget(settings.targets[0], { adapter: 'jimeng-image' }).enabled, false);
  assert.equal(model.patchImageConnection(settings, 'ic_test', { name: 'Renamed' }).targets[0].enabled, true);
  assert.equal(model.patchImageConnection(settings, 'ic_test', { binding: { kind: 'provider_ref', providerId: 'chat' } }).targets[0].enabled, true);
  assert.equal(model.patchImageConnection(settings, 'ic_test', { enabled: false }).targets[0].enabled, false);
  assert.equal(model.newImageTarget('it_new', 'ic_test').enabled, false);
});

test('schema validates strict types, bounds, unique keys, enum/default, and rejects unknown fields', () => {
  const spec = { key: 'steps', label: '步数', type: 'integer', required: false, minimum: 1, maximum: 8, enum: [1, 4, 8], default: 4 };
  assert.equal(model.parseImageParameters(JSON.stringify([spec]))[0].default, 4);
  for (const value of [[spec, spec], [{ ...spec, enum: [] }], [{ ...spec, enum: [1, '4'] }], [{ ...spec, enum: [1, 1] }], [{ ...spec, default: 2 }], [{ ...spec, maximum: 0 }], [{ ...spec, minimum: 1.5 }], [{ ...spec, type: 'boolean' }], [{ ...spec, secret: 'SENTINEL' }], [{ key: 'flag', label: '开关', type: 'boolean', required: false, default: 'true' }]]) {
    assert.throws(() => model.parseImageParameters(JSON.stringify(value)));
  }
  assert.throws(() => model.parseImageParameters('{"SENTINEL"'), error => !error.message.includes('SENTINEL'));
});

test('RunningHub workflow maps all declared parameters and rejects duplicate or missing slots', () => {
  const settings = fixture();
  const target = settings.targets[0];
  target.adapter = 'runninghub-workflow'; target.kind = 'workflow'; target.remoteId = 'workflow-123';
  target.parameters = [{ key: 'prompt', label: '提示词', type: 'string', required: true }];
  const mapping = { revision: 1, inputs: [{ parameterKey: 'prompt', nodeId: '6', inputName: 'text' }], outputs: [{ nodeId: '9', outputName: 'images' }] };
  target.workflowMapping = model.parseWorkflowMapping(JSON.stringify(mapping));
  assert.equal(model.validateImageSettingsDraft(settings).length, 0);
  assert.throws(() => model.parseWorkflowMapping(JSON.stringify({ ...mapping, inputs: [...mapping.inputs, ...mapping.inputs] })));
  assert.throws(() => model.parseWorkflowMapping(JSON.stringify({ ...mapping, outputs: [...mapping.outputs, ...mapping.outputs] })));
  assert.throws(() => model.parseWorkflowMapping(JSON.stringify({ ...mapping, revision: 0 })));
  target.workflowMapping = { ...mapping, inputs: [] };
  assert.ok(model.validateImageSettingsDraft(settings).length);
  target.workflowMapping = mapping; target.parameters = [];
  assert.ok(model.validateImageSettingsDraft(settings).length);
});

test('public validation rejects credential-bearing addresses, literal refs and invalid image capabilities', () => {
  for (const baseUrl of ['https://user:password@example.com', 'https://example.com?key=SENTINEL', 'https://example.com/#SENTINEL', 'file:///tmp']) {
    const settings = fixture(); settings.connections[0].binding.baseUrl = baseUrl;
    const errors = model.validateImageSettingsDraft(settings);
    assert.ok(errors.length); assert.ok(!errors.join(' ').includes('SENTINEL'));
  }
  const settings = fixture();
  settings.connections[0].binding.secretRefs = { api_key: 'literal-SENTINEL' };
  assert.ok(model.validateImageSettingsDraft(settings).length);
  settings.connections[0].binding.secretRefs = { api_key: secretRef };
  settings.targets[0].capabilities.operations = ['mask'];
  assert.ok(model.validateImageSettingsDraft(settings).length);
  settings.targets[0].capabilities.maxInputs = 2;
  assert.equal(model.validateImageSettingsDraft(settings).length, 0);
});

test('three-way revision merge preserves local draft, remote additions and remote untouched edits', () => {
  const base = fixture(); const draft = structuredClone(base); const remote = structuredClone(base);
  draft.connections[0].name = 'My connection'; remote.targets[0].name = 'Remote target';
  remote.connections.push(model.newImageConnection('ic_remote')); remote.revision = 5;
  const result = model.mergeImageSettings(base, draft, remote);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.draft.revision, 5);
  assert.equal(result.draft.connections[0].name, 'My connection');
  assert.equal(result.draft.connections.length, 2);
  assert.equal(result.draft.targets[0].name, 'Remote target');
  assert.equal(draft.revision, 4);
  assert.equal(base.connections[0].name, '新图像连接');
  assert.equal(model.imageSettingsDirty(base, draft), true);
  assert.equal(model.imageSettingsDirty(base, structuredClone(base)), false);
});

test('conflicting edits and deletion are explicit and support either resolution', () => {
  const base = fixture(); const draft = structuredClone(base); const remote = structuredClone(base);
  draft.connections[0].name = 'Mine'; remote.connections[0].name = 'Theirs'; remote.revision = 6;
  assert.deepEqual(plain(model.mergeImageSettings(base, draft, remote).conflicts), ['ic_test']);
  assert.equal(model.mergeImageSettings(base, draft, remote, 'local').draft.connections[0].name, 'Mine');
  assert.equal(model.mergeImageSettings(base, draft, remote, 'remote').draft.connections[0].name, 'Theirs');
  draft.connections = [];
  assert.equal(model.mergeImageSettings(base, draft, remote, 'local').draft.connections.length, 0);
  assert.equal(model.mergeImageSettings(base, draft, remote, 'remote').draft.connections.length, 1);
});

test('secret writes require a previously saved independent connection and a valid purpose', async () => {
  let calls = 0;
  const client = { writeSecret: async () => { calls++; }, saveSettings: async () => { calls++; } };
  const saved = fixture();
  for (const [settings, id, purpose] of [[saved, 'ic_absent', 'api_key'], [saved, 'ic_test', 'bad purpose'], [{ ...saved, connections: [{ ...saved.connections[0], binding: { kind: 'provider_ref', providerId: 'chat' } }] }, 'ic_test', 'api_key']]) {
    assert.equal(await model.writeAndBindImageSecret(client, settings, id, purpose, 'SENTINEL', () => true, () => {}), null);
  }
  assert.equal(calls, 0);
});

test('secret write binds returned ref through saveSettings and never adds literal to public drafts', async () => {
  const calls = []; let publicDraft; let input;
  const saved = fixture();
  const client = {
    writeSecret: async request => { input = request; calls.push(['write', request.connectionId, request.purpose, request.value]); return { ref: secretRef, configured: true }; },
    saveSettings: async request => {
      calls.push(['save', request.expectedRevision]);
      assert.equal(request.connections[0].binding.secretRefs.secretKey, secretRef);
      assert.ok(!JSON.stringify(request).includes('SENTINEL'));
      return { revision: 5, connections: request.connections, targets: request.targets };
    },
  };
  const result = await model.writeAndBindImageSecret(client, saved, 'ic_test', 'secret_key', 'SENTINEL', () => true, next => { publicDraft = next; });
  assert.deepEqual(calls, [['write', 'ic_test', 'secretKey', 'SENTINEL'], ['save', 4]]);
  assert.equal(input.value, '');
  assert.equal(result.revision, 5);
  assert.equal(publicDraft.connections[0].binding.secretRefs.secretKey, secretRef);
  assert.ok(!JSON.stringify(publicDraft).includes('SENTINEL'));
  assert.equal(saved.connections[0].binding.secretRefs.secretKey, undefined);
});

test('binding conflict retains prepared public ref draft without revoking an existing purpose', async () => {
  const saved = fixture(); let prepared; let writes = 0; let input;
  const client = {
    writeSecret: async value => { writes++; input = value; return { ref: secretRef, configured: true }; },
    saveSettings: async () => { throw { code: 'IMAGE_REVISION_CONFLICT', message: 'SENTINEL' }; },
  };
  await assert.rejects(model.writeAndBindImageSecret(client, saved, 'ic_test', 'api_key', 'SENTINEL', () => true, next => { prepared = next; }));
  assert.equal(writes, 1);
  assert.equal(input.value, '');
  assert.equal(prepared.connections[0].binding.secretRefs.apiKey, secretRef);
  assert.equal(prepared.revision, 4);
});

test('cancelled or replaced client scope cannot bind a late secret response', async () => {
  const pending = deferred(); let active = true; let saves = 0; let drafts = 0; let input;
  const client = { writeSecret: value => { input = value; return pending.promise; }, saveSettings: async () => { saves++; } };
  const request = model.writeAndBindImageSecret(client, fixture(), 'ic_test', 'api_key', 'SENTINEL', () => active, () => { drafts++; });
  active = false; pending.resolve({ ref: secretRef, configured: true });
  assert.equal(await request, null);
  assert.equal(saves, 0); assert.equal(drafts, 0); assert.equal(input.value, '');
});

test('late binding response cannot publish after cancellation; invalid secret refs never get persisted', async () => {
  const pending = deferred(); let active = true; let started = false;
  const request = model.writeAndBindImageSecret({ writeSecret: async () => ({ ref: secretRef, configured: true }), saveSettings: () => { started = true; return pending.promise; } }, fixture(), 'ic_test', 'api_key', 'SENTINEL', () => active, () => {});
  await Promise.resolve(); await Promise.resolve(); assert.equal(started, true);
  active = false; pending.resolve(fixture()); assert.equal(await request, null);
  let saves = 0;
  await assert.rejects(model.writeAndBindImageSecret({ writeSecret: async () => ({ ref: 'literal-SENTINEL', configured: true }), saveSettings: async () => { saves++; } }, fixture(), 'ic_test', 'api_key', 'SENTINEL', () => true, () => {}));
  assert.equal(saves, 0);
});

test('transport and parser errors never reflect raw messages, request IDs, or secret sentinels', () => {
  for (const code of ['IMAGE_REVISION_CONFLICT', 'IMAGE_CONNECTION_IN_USE', 'IMAGE_AUTH_REQUIRED', 'IMAGE_INVALID_INPUT', 'SENTINEL']) {
    const message = model.imageSettingsError({ code, message: 'SENTINEL', requestId: 'SENTINEL', details: { secret: 'SENTINEL' } });
    assert.ok(!message.includes('SENTINEL'));
  }
  assert.ok(!model.imageSettingsError(new Error('SENTINEL')).includes('SENTINEL'));
  assert.throws(() => model.parseWorkflowMapping('{"SENTINEL"'), error => !error.message.includes('SENTINEL'));
});

test('mounted settings protects dirty navigation, clears secrets and isolates client replacement', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://local.test' });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const loader = createTsModuleLoader({ mocks: {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    '../../components/ui/button': { Button: ({ variant: _variant, ...props }) => React.createElement('button', props) },
    '../../components/ui/input': { Input: props => React.createElement('input', props) },
  } });
  const { ImageSettings } = loader.loadModule('@liveagent/ui/pages/settings/ImageSettings');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  let guard; let latestDirty; let confirms = 0; let allowLeave = false;
  dom.window.confirm = () => { confirms++; return allowLeave; };
  const registerLeaveGuard = value => { guard = value; return () => { if (guard === value) guard = undefined; }; };
  const onDirtyChange = value => { latestDirty = value; };
  const render = client => root.render(React.createElement(ImageSettings, { client, registerLeaveGuard, onDirtyChange }));
  const click = async text => { const button = [...container.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(button, text); await React.act(async () => button.click()); };
  try {
    const client = { getSettings: async () => fixture() };
    await React.act(async () => render(client));
    assert.equal(guard(), true); assert.equal(latestDirty, false);
    await click('新增连接');
    assert.equal(latestDirty, true); assert.equal(guard(), false); assert.equal(confirms, 1);
    const unload = new dom.window.Event('beforeunload', { cancelable: true });
    dom.window.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true);
    allowLeave = true; await click('取消编辑'); assert.equal(latestDirty, false);
    const firstPassword = container.querySelector('input[type=password]');
    // Keep a detached DOM reference: cleanup must erase it, not only hide the field.
    firstPassword.value = 'SENTINEL';
    const pending = deferred(); const replacement = { getSettings: () => pending.promise };
    await React.act(async () => render(replacement));
    assert.equal(firstPassword.value, '');
    assert.equal(container.querySelector('input[type=password]'), null);
    assert.ok(!container.textContent.includes('新图像连接'));
    const newer = fixture(); newer.connections[0].name = 'New scope connection';
    await React.act(async () => render({ getSettings: async () => newer }));
    await React.act(async () => pending.resolve(fixture()));
    assert.ok(container.textContent.includes('New scope connection'));
    assert.ok(!container.textContent.includes('SENTINEL'));
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    if (previous.act === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT; else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
