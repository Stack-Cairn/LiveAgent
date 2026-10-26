import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';

const model = createTsModuleLoader().loadModule('@liveagent/ui/pages/settings/imageSettingsAdapter');

// K-brain config_validate.go:142 rejects "enabled target uses a disabled connection".
test('review: turning on the target toggle under a disabled connection must not yield a draft K-brain will reject', () => {
  const connection = { ...model.newImageConnection('ic_test'), enabled: false };
  const target = { ...model.newImageTarget('it_test', 'ic_test'), remoteId: 'image-model' };
  // ImageSettings.tsx Toggle onChange -> updateTarget({ enabled: true }) -> patchImageTarget
  const next = model.patchImageTarget(target, { enabled: true });
  const errors = model.validateImageSettingsDraft({ revision: 1, connections: [connection], targets: [next] });
  assert.ok(
    next.enabled === false || errors.length > 0,
    `draft keeps enabled=${next.enabled} on a disabled connection with no local error; save hits K-brain IMAGE_INVALID_INPUT`,
  );
});
