import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * WebDAV 同步设置面板的纯逻辑。覆盖的都是「出了错用户才会发现」的判断：
 * 保存后能否自动测连接、后台同步失败的横幅何时挂起何时消失。
 */

const loader = createTsModuleLoader();
const form = loader.loadModule("src/pages/settings/backupSyncForm.ts");

/** 一份完整可用的后端视图，各用例按需覆盖字段。 */
function makeView(overrides = {}) {
  return {
    url: "https://dav.example.test/dav/",
    username: "alice",
    hasPassword: true,
    remoteDir: "liveagent",
    profile: "default",
    autoSync: false,
    lastSyncAt: null,
    lastError: null,
    ...overrides,
  };
}

test("preset detection matches on host, not substring", () => {
  assert.equal(form.detectPreset("https://dav.jianguoyun.com/dav/"), "jianguoyun");
  // 关键：`dav.jianguoyun.com.evil.test` 不是坚果云，按 host 判断才拦得住。
  assert.equal(form.detectPreset("https://dav.jianguoyun.com.evil.test/dav/"), "custom");
  assert.equal(form.detectPreset("https://server/remote.php/dav/files/USER/"), "nextcloud");
  assert.equal(form.detectPreset("http://192.168.1.2:5005/"), "synology");
  assert.equal(form.detectPreset("http://192.168.1.2:5006/"), "synology");
  assert.equal(form.detectPreset(""), "custom");
  assert.equal(form.detectPreset("not a url"), "custom");
});

test("the form starts with an empty password and is clean right after loading", () => {
  const view = makeView({ autoSync: true, lastSyncAt: 1_700_000_000_000 });
  const loaded = form.formFromView(view);

  // 后端从不回传密码；表单若回填占位符，原样提交会把占位符写成真密码。
  assert.equal(loaded.password, "");
  assert.equal(loaded.passwordTouched, false);
  assert.equal(form.isDirty(loaded, view), false, "刚加载完不该被当成有未保存改动");
});

test("touching the password alone makes the form dirty", () => {
  const view = makeView();
  const touched = { ...form.formFromView(view), password: "s3cret", passwordTouched: true };

  // 密码不在视图里，只能靠 passwordTouched 判断 —— 否则改完密码「测试连接」
  // 按钮仍然可用，测的却是库里的旧密码。
  assert.equal(form.isDirty(touched, view), true);
});

test("a null view is always dirty so upload/download stay disabled before load", () => {
  assert.equal(form.isDirty(form.emptyForm(), null), true);
});

test("connection test is skipped until every credential field is filled", () => {
  assert.equal(form.canTestSyncConnection(makeView()), true);
  // 只填了地址就先存一版是很正常的操作，此时自动测连接必然失败，
  // 会把一次成功的保存渲染成红色错误。
  assert.equal(form.canTestSyncConnection(makeView({ username: "" })), false);
  assert.equal(form.canTestSyncConnection(makeView({ hasPassword: false })), false);
  assert.equal(form.canTestSyncConnection(makeView({ url: "" })), false);
});

test("an auto-sync failure event raises the persistent banner", () => {
  const prev = makeView({ lastSyncAt: 1_700_000_000_000 });
  const next = form.applySyncStatusEvent(prev, {
    lastSyncAt: null,
    lastError: "WebDAV 认证失败（401）",
  });

  assert.equal(next.lastError, "WebDAV 认证失败（401）");
  // 失败不该抹掉上次成功的时间 —— 用户需要知道配置是从什么时候起不再同步的。
  assert.equal(next.lastSyncAt, prev.lastSyncAt);
  assert.equal(form.isAutoSyncSuccess({ lastSyncAt: null, lastError: "boom" }), false);
});

test("a later success clears the stale failure banner", () => {
  const failed = form.applySyncStatusEvent(makeView(), { lastSyncAt: null, lastError: "boom" });
  const recovered = form.applySyncStatusEvent(failed, {
    lastSyncAt: 1_700_000_123_000,
    lastError: null,
  });

  assert.equal(recovered.lastError, null, "链路恢复后旧横幅必须消失");
  assert.equal(recovered.lastSyncAt, 1_700_000_123_000);
  assert.equal(form.isAutoSyncSuccess({ lastSyncAt: 1_700_000_123_000, lastError: null }), true);
});

test("status events before the view loads are ignored instead of synthesizing one", () => {
  // 视图还没加载完就收到事件时返回 null，而不是凭事件拼一个残缺视图出来。
  assert.equal(form.applySyncStatusEvent(null, { lastSyncAt: 1, lastError: null }), null);

  // 既没时间也没错误的事件不算成功，也不该产生新对象触发无意义的重渲染。
  const view = makeView();
  assert.equal(form.applySyncStatusEvent(view, { lastSyncAt: null, lastError: null }), view);
  assert.equal(form.isAutoSyncSuccess({ lastSyncAt: null, lastError: null }), false);
});
