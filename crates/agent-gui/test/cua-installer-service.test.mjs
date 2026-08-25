/**
 * CUA Driver 安装器服务（cuaService）契约测试。
 *
 * 目标：保证 desktopCuaService 把所有 cua_driver_* Tauri Command 正确
 * 桥接到前端——即便后端 Command 改名 / 加参数，前端调用面要稳定。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "./helpers/load-ts-module.mjs";

function loadCuaService(invokeMock, listenMock) {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          return invokeMock(command, args);
        },
      },
      "@tauri-apps/api/event": {
        async listen(eventName, handler) {
          return listenMock(eventName, handler);
        },
      },
    },
  });
  return loader.loadModule("src/lib/cua/cuaService.ts");
}

test("desktopCuaService.detectDriver forwards to cua_driver_detect", async () => {
  const calls = [];
  const { desktopCuaService } = loadCuaService((command) => {
    calls.push(command);
    if (command === "cua_driver_detect") {
      return { installed: false, daemonRunning: false, platform: "macos" };
    }
    return null;
  });

  const detection = await desktopCuaService.detectDriver();
  assert.deepEqual(calls, ["cua_driver_detect"]);
  assert.equal(detection.installed, false);
  assert.equal(detection.daemonRunning, false);
  assert.equal(detection.platform, "macos");
});

test("desktopCuaService.installDriver forwards to cua_driver_install", async () => {
  const calls = [];
  const { desktopCuaService } = loadCuaService((command) => {
    calls.push(command);
    if (command === "cua_driver_install") {
      return { success: true, log: "ok", daemonStarted: true, installedVersion: "0.3.1" };
    }
    return null;
  });

  const result = await desktopCuaService.installDriver();
  assert.deepEqual(calls, ["cua_driver_install"]);
  assert.equal(result.success, true);
  assert.equal(result.installedVersion, "0.3.1");
});

test("desktopCuaService.updateDriver forwards apply flag to cua_driver_update", async () => {
  const calls = [];
  const { desktopCuaService } = loadCuaService((command, args) => {
    calls.push({ command, args });
    if (command === "cua_driver_update") {
      return { updateAvailable: args?.apply === true, log: "", newVersion: "0.3.2" };
    }
    return null;
  });

  const checkOnly = await desktopCuaService.updateDriver(false);
  const applied = await desktopCuaService.updateDriver(true);
  assert.equal(checkOnly.updateAvailable, false);
  assert.equal(applied.updateAvailable, true);
  assert.deepEqual(
    calls.map((c) => c.command),
    ["cua_driver_update", "cua_driver_update"],
  );
  assert.equal(calls[0].args.apply, false);
  assert.equal(calls[1].args.apply, true);
});

test("desktopCuaService.startDriverDaemon unwraps { ok, error } response", async () => {
  const { desktopCuaService } = loadCuaService((command) => {
    if (command === "cua_driver_start_daemon") return { ok: true };
    return null;
  });
  assert.equal(await desktopCuaService.startDriverDaemon(), true);

  const failed = loadCuaService((command) => {
    if (command === "cua_driver_start_daemon") return { ok: false, error: { kind: "x" } };
    return null;
  });
  const svc = failed.loadModule ? null : null;
  // direct re-import using same factory pattern
  const failed2 = createTsModuleLoader2((command) => {
    if (command === "cua_driver_start_daemon") return { ok: false, error: { kind: "x" } };
    return null;
  });
  const { desktopCuaService: svc2 } = failed2.loadModule("src/lib/cua/cuaService.ts");
  assert.equal(await svc2.startDriverDaemon(), false);
});

// inline secondary loader to avoid helper leakage
function createTsModuleLoader2(invokeImpl) {
  return createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": { invoke: invokeImpl },
      "@tauri-apps/api/event": { async listen() { return () => {}; } },
    },
  });
}

test("desktopCuaService.subscribeProgress registers a Tauri listener", async () => {
  const events = [];
  const { desktopCuaService } = loadCuaService(
    () => null,
    (eventName, handler) => {
      events.push({ eventName, handler });
      // 模拟 listen 立刻把 fake event 推给 handler 验证 payload 透传。
      handler({ payload: { stage: "starting", message: "hi" } });
      return () => {};
    },
  );

  let received = null;
  const unlisten = await desktopCuaService.subscribeProgress((event) => {
    received = event;
  });
  assert.equal(typeof unlisten, "function");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventName, "cua_install_progress");
  assert.deepEqual(received, { stage: "starting", message: "hi" });
});

test("desktopCuaService.getInstallPreview forwards to cua_driver_install_preview", async () => {
  const calls = [];
  const { desktopCuaService } = loadCuaService((command) => {
    calls.push(command);
    if (command === "cua_driver_install_preview") {
      return {
        platform: "macos",
        command: {
          program: "/bin/bash",
          args: ["-c", "curl ... | bash"],
          description: "macOS / Linux installer",
          needsSudo: false,
        },
      };
    }
    return null;
  });
  const preview = await desktopCuaService.getInstallPreview();
  assert.deepEqual(calls, ["cua_driver_install_preview"]);
  assert.equal(preview.command.program, "/bin/bash");
  assert.equal(preview.platform, "macos");
});
