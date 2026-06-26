import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const runtimeStatus = loader.loadModule("src/app/chatRuntimeStatus.ts");

test("edit resend starts with vibing status instead of preparing", () => {
  assert.equal(runtimeStatus.getInitialChatRuntimeToolStatus(false), null);
  assert.equal(runtimeStatus.getInitialChatRuntimeToolStatus(true), "Vibing...");
});

test("edit resend preparing controls keep the UI in vibing state", () => {
  assert.equal(runtimeStatus.getPreparingChatRuntimeToolStatus(false), "Preparing request...");
  assert.equal(runtimeStatus.getPreparingChatRuntimeToolStatus(true), "Vibing...");

  assert.equal(
    runtimeStatus.shouldApplyPreparingChatRuntimeStatus({
      currentStatus: "Preparing request...",
      isCompaction: false,
      isEditResend: true,
    }),
    true,
  );
  assert.equal(
    runtimeStatus.shouldApplyPreparingChatRuntimeStatus({
      currentStatus: "Starting desktop runtime...",
      isCompaction: false,
      isEditResend: true,
    }),
    true,
  );
  assert.equal(
    runtimeStatus.shouldApplyPreparingChatRuntimeStatus({
      currentStatus: "Reading files...",
      isCompaction: false,
      isEditResend: true,
    }),
    false,
  );
  assert.equal(
    runtimeStatus.shouldApplyPreparingChatRuntimeStatus({
      currentStatus: "Preparing request...",
      isCompaction: true,
      isEditResend: true,
    }),
    false,
  );
});

test("remote queued run clears retained local stream after stop", () => {
  assert.equal(
    runtimeStatus.shouldClearRetainedLocalStreamForRemoteRun({
      isRunning: true,
      nextRunKey: "queued-run",
      previousRunKey: "",
      hasRetainedLiveStream: true,
      hasLocalRunning: false,
      hasAbortController: false,
    }),
    true,
  );

  assert.equal(
    runtimeStatus.shouldClearRetainedLocalStreamForRemoteRun({
      isRunning: true,
      nextRunKey: "queued-run",
      previousRunKey: "old-run",
      hasRetainedLiveStream: true,
      hasLocalRunning: false,
      hasAbortController: false,
    }),
    false,
  );
  assert.equal(
    runtimeStatus.shouldClearRetainedLocalStreamForRemoteRun({
      isRunning: true,
      nextRunKey: "queued-run",
      previousRunKey: "",
      hasRetainedLiveStream: true,
      hasLocalRunning: true,
      hasAbortController: false,
    }),
    false,
  );
  assert.equal(
    runtimeStatus.shouldClearRetainedLocalStreamForRemoteRun({
      isRunning: true,
      nextRunKey: "queued-run",
      previousRunKey: "",
      hasRetainedLiveStream: true,
      hasLocalRunning: false,
      hasAbortController: true,
    }),
    false,
  );
});

test("remote idle events only clear the matching active run when identified", () => {
  assert.equal(
    runtimeStatus.shouldApplyRemoteIdleEvent({
      eventRunKey: "old-run",
      activeRunKey: "new-run",
    }),
    false,
  );
  assert.equal(
    runtimeStatus.shouldApplyRemoteIdleEvent({
      eventRunKey: "new-run",
      activeRunKey: "new-run",
    }),
    true,
  );
  assert.equal(
    runtimeStatus.shouldApplyRemoteIdleEvent({
      eventRunKey: "",
      activeRunKey: "new-run",
    }),
    true,
  );
  assert.equal(
    runtimeStatus.shouldApplyRemoteIdleEvent({
      eventRunKey: "old-run",
      activeRunKey: "",
    }),
    true,
  );
});
