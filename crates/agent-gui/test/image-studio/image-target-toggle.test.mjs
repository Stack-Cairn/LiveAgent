import assert from 'node:assert/strict';
import test from 'node:test';
import { createTsModuleLoader } from '../helpers/load-ts-module.mjs';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';

const model = createTsModuleLoader().loadModule('@liveagent/ui/pages/settings/imageSettingsAdapter');

// K-brain internal/imaging/config_validate.go still rejects any enabled target whose adapter is
// jimeng-image / runninghub-workflow / google-interactions-image ("adapter contract or signing
// verification is incomplete"), even after the verification requirement was dropped.
for (const adapter of ['jimeng-image', 'runninghub-workflow']) {
  test(`review: 启用目标 toggle must not be offered for backend-rejected adapter ${adapter}`, async () => {
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
    const target = { ...model.newImageTarget('it_test', 'ic_test'), remoteId: 'image-model', adapter };
    const settings = { revision: 4, connections: [{ ...model.newImageConnection('ic_test'), enabled: true }], targets: [target] };
    try {
      await React.act(async () => root.render(React.createElement(ImageSettings, {
        client: { getSettings: async () => settings }, registerLeaveGuard: () => () => {}, onDirtyChange: () => {},
      })));
      const label = [...container.querySelectorAll('label')].find(l => l.textContent.trim() === '启用目标');
      assert.ok(label, 'toggle rendered');
      const box = label.querySelector('input[type=checkbox]');
      assert.equal(box.disabled, true, `toggle is clickable for ${adapter}, but K-brain rejects saving an enabled ${adapter} target`);
    } finally {
      await React.act(async () => root.unmount());
      dom.window.close();
      if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
      if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
      if (previous.act === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT; else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    }
  });
}
