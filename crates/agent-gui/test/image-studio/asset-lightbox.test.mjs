import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

for (const close of ["hide", "unmount"]) {
  test(`lightbox ${close} releases existing URLs and ignores late original reads`, async () => {
    const env = await createDomTestEnv({ mocks: {
      "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    } });
    const previousCreate = URL.createObjectURL;
    const previousRevoke = URL.revokeObjectURL;
    const created = [], revoked = [], reads = [];
    URL.createObjectURL = () => { const url = `blob:test-${created.length}`; created.push(url); return url; };
    URL.revokeObjectURL = (url) => revoked.push(url);
    const client = { readAsset: (_id, _variant, signal) => new Promise(resolve => reads.push({ signal, resolve })) };
    const { AssetLightbox } = env.loadModule("@liveagent/ui/features/image-studio/AssetLightbox");
    const host = document.body.appendChild(document.createElement("div"));
    const root = env.createRoot(host);
    const props = { client, assetIds: ["first", "late"], index: 0, title: "test", assets: {}, open: true, onClose() {} };
    let unmounted = false;
    try {
      await env.act(async () => root.render(env.React.createElement(AssetLightbox, props)));
      await env.act(async () => reads[0].resolve(new Blob(["first"])));
      assert.equal(created.length, 1);
      if (close === "unmount") {
        await env.act(async () => root.unmount());
        unmounted = true;
      } else {
        await env.act(async () => root.render(env.React.createElement(AssetLightbox, { ...props, open: false })));
      }
      assert.equal(reads[1].signal.aborted, true);
      assert.deepEqual(revoked, created);
      await env.act(async () => reads[1].resolve(new Blob(["late"])));
      assert.equal(created.length, 1, "a late response must not allocate a URL after cleanup");
      assert.deepEqual(revoked, created);
    } finally {
      if (!unmounted) await env.act(async () => root.unmount());
      host.remove();
      URL.createObjectURL = previousCreate;
      URL.revokeObjectURL = previousRevoke;
      env.cleanup();
    }
  });
}
