import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';

const model = createTsModuleLoader().loadModule('@liveagent/ui/pages/settings/imageSettingsAdapter');

// K-brain config_validate.go rejects saving an *enabled* target whose adapter is unfinished.
test('review: switching an enabled target to an unfinished adapter must not leave a draft K-brain will reject', () => {
  const connection = { ...model.newImageConnection('ic_test'), enabled: true };
  const target = { ...model.newImageTarget('it_test', 'ic_test'), remoteId: 'image-model', adapter: 'openai-images', enabled: true };
  const next = model.patchImageTarget(target, { adapter: 'jimeng-image', kind: 'model' });
  const errors = model.validateImageSettingsDraft({ revision: 1, connections: [connection], targets: [next] });
  assert.ok(
    next.enabled === false || errors.length > 0,
    `draft keeps enabled=${next.enabled} on jimeng-image with no local error; save hits K-brain 400 "adapter contract or signing verification is incomplete"`,
  );
});
