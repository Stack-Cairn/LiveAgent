// LiveAgent Browser Bridge — MV3 service worker.
//
// 反向连接 LiveAgent 桌面端的桥接服务（ws://127.0.0.1:19222，见 Rust 侧
// services/browser/bridge.rs），在用户日常浏览器里中继 CDP：
//   - browser-level 命令（Target.*）由本文件模拟——只暴露 LiveAgent 自己
//     创建的自动化标签页，用户的其它标签页对桌面端不可见；
//   - session-level 命令按 sessionId → tabId 映射转发 chrome.debugger.sendCommand；
//   - chrome.debugger.onEvent 反向转发为 CDP 事件帧。
// 线型与原生 CDP 一致，桌面端的 CdpConnection/PageSession 无需感知差异。

const BRIDGE_URL = "ws://127.0.0.1:19222";
const RECONNECT_ALARM = "liveagent-bridge-reconnect";
const KEEPALIVE_INTERVAL_MS = 20_000; // MV3 SW 空闲 30s 回收，20s 心跳把它顶住。
const DEBUGGER_PROTOCOL_VERSION = "1.3";

let socket = null;
let keepaliveTimer = null;

// 自动化标签页登记：targetId → { tabId, sessionId|null }。
// targetId/sessionId 都是本扩展编的号，只需在这条连接内自洽。
const targets = new Map();
let nextOrdinal = 1;

function targetForSession(sessionId) {
  for (const [targetId, entry] of targets) {
    if (entry.sessionId === sessionId) return { targetId, ...entry };
  }
  return null;
}

function targetForTab(tabId) {
  for (const [targetId, entry] of targets) {
    if (entry.tabId === tabId) return { targetId, ...entry };
  }
  return null;
}

function send(frame) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function sendResult(id, result) {
  send({ id, result });
}

function sendError(id, message) {
  send({ id, error: { message: String(message) } });
}

// ---- browser-level 命令模拟 -------------------------------------------------

async function handleGetTargets(id) {
  // 只报告仍存活的自动化标签页；用户手关 tab 后这里查不到，桌面端的
  // target_alive 探测即判定会话失效并重建。
  const targetInfos = [];
  for (const [targetId, entry] of targets) {
    try {
      const tab = await chrome.tabs.get(entry.tabId);
      targetInfos.push({
        targetId,
        type: "page",
        title: tab.title ?? "",
        url: tab.url ?? "",
        attached: entry.sessionId !== null,
      });
    } catch {
      targets.delete(targetId);
    }
  }
  sendResult(id, { targetInfos });
}

async function handleCreateTarget(id, params) {
  const url = typeof params?.url === "string" && params.url ? params.url : "about:blank";
  const tab = await chrome.tabs.create({ url, active: true });
  const targetId = `la-target-${nextOrdinal++}`;
  targets.set(targetId, { tabId: tab.id, sessionId: null });
  sendResult(id, { targetId });
}

async function handleAttachToTarget(id, params) {
  const targetId = params?.targetId;
  const entry = targets.get(targetId);
  if (!entry) {
    sendError(id, `unknown targetId ${targetId}: only tabs created by LiveAgent can be attached`);
    return;
  }
  await chrome.debugger.attach({ tabId: entry.tabId }, DEBUGGER_PROTOCOL_VERSION);
  const sessionId = `la-session-${targetId}`;
  entry.sessionId = sessionId;
  sendResult(id, { sessionId });
}

async function handleCloseTarget(id, params) {
  const entry = targets.get(params?.targetId);
  if (entry) {
    targets.delete(params.targetId);
    try {
      await chrome.tabs.remove(entry.tabId);
    } catch {
      // 用户已手关，视同成功。
    }
  }
  sendResult(id, { success: true });
}

// ---- 帧分发 -----------------------------------------------------------------

async function handleFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params, sessionId } = frame;
  if (typeof id !== "number" || typeof method !== "string") return;

  try {
    if (sessionId) {
      const entry = targetForSession(sessionId);
      if (!entry) {
        sendError(id, `unknown sessionId ${sessionId}`);
        return;
      }
      const result = await chrome.debugger.sendCommand(
        { tabId: entry.tabId },
        method,
        params ?? {},
      );
      sendResult(id, result ?? {});
      return;
    }
    switch (method) {
      case "Target.getTargets":
        await handleGetTargets(id);
        break;
      case "Target.createTarget":
        await handleCreateTarget(id, params);
        break;
      case "Target.attachToTarget":
        await handleAttachToTarget(id, params);
        break;
      case "Target.closeTarget":
        await handleCloseTarget(id, params);
        break;
      default:
        sendError(id, `browser-level method ${method} is not supported by the extension bridge`);
    }
  } catch (error) {
    sendError(id, error?.message ?? error);
  }
}

// chrome.debugger 事件 → CDP 事件帧（带映射回去的 sessionId）。
chrome.debugger.onEvent.addListener((source, method, params) => {
  const entry = targetForTab(source.tabId);
  if (!entry || !entry.sessionId) return;
  send({ method, params: params ?? {}, sessionId: entry.sessionId });
});

// 调试器被剥离（用户点了"取消"横幅、tab 崩溃）：撤登记，桌面端下次动作
// 时经 Target.getTargets 察觉并重建会话。
chrome.debugger.onDetach.addListener((source) => {
  const entry = targetForTab(source.tabId);
  if (entry) targets.get(entry.targetId).sessionId = null;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = targetForTab(tabId);
  if (entry) targets.delete(entry.targetId);
});

// ---- 连接生命周期 ------------------------------------------------------------

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch {
    return;
  }
  socket.onopen = () => {
    // 心跳帧只为续 SW 生命周期；桌面端按"无 id 的未知事件"忽略。
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ method: "LiveAgent.ping" }), KEEPALIVE_INTERVAL_MS);
  };
  socket.onmessage = (event) => handleFrame(event.data);
  socket.onclose = () => {
    clearInterval(keepaliveTimer);
    socket = null;
  };
  socket.onerror = () => {
    // onclose 会跟着触发，重连交给 alarm。
  };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});

// SW 每次被唤醒（事件驱动）都尝试补连。
connect();
